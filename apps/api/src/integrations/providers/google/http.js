import { GoogleError, errorFromResponse, parseRetryAfter, redact } from './errors.js';

/**
 * @typedef {object} HttpDeps
 * @property {typeof fetch} fetch
 * @property {() => number} now epoch milliseconds
 * @property {{ debug?: Function, warn?: Function }} [logger]
 * @property {(ms: number) => Promise<void>} sleep
 * @property {() => number} random 0 <= x < 1, for jitter
 */

/**
 * @typedef {object} RequestOptions
 * @property {string} operation short name used in errors and logs, e.g. "events.insert"
 * @property {'GET'|'POST'|'PATCH'|'PUT'|'DELETE'} method
 * @property {string} url absolute URL without query
 * @property {Record<string, string|number|boolean|Array<string|number>|undefined|null>} [query]
 * @property {unknown} [json] JSON request body
 * @property {URLSearchParams} [form] form request body (token endpoint)
 * @property {boolean} [idempotent] retry on 5xx, 429, timeouts and network errors
 * @property {boolean} [authenticated] add a bearer token (default true)
 * @property {boolean} [tokenEndpoint] map errors with OAuth semantics
 * @property {AbortSignal} [signal] caller cancellation
 */

/** @param {string} base @param {RequestOptions['query']} query */
export function buildUrl(base, query) {
  const url = new URL(base);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(item));
  }
  return url.toString();
}

/**
 * Truncated exponential backoff with jitter, as Google recommends: base * 2^attempt + up to 1s.
 * @param {number} attempt 0-based retry number
 * @param {{ backoffBaseMs: number, maxBackoffMs: number }} config
 * @param {() => number} random
 */
export function backoffDelay(attempt, config, random) {
  return Math.min(config.maxBackoffMs, config.backoffBaseMs * 2 ** attempt + Math.floor(random() * 1000));
}

/**
 * Create the transport used by every API call: timeouts, retries, auth header, error mapping.
 * @param {{ config: import('./config.js').GoogleConfig, deps: HttpDeps, secrets: () => string[],
 *   tokens?: { getAccessToken: () => Promise<string>, invalidate: () => void } }} input
 */
export function createHttp({ config, deps, secrets, tokens }) {
  const { logger } = deps;

  /** @param {RequestOptions} options @param {string|null} accessToken @param {number} attempt */
  async function once(options, accessToken, attempt) {
    const headers = { accept: 'application/json' };
    let body;
    if (options.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.json);
    } else if (options.form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = options.form.toString();
    }
    if (accessToken) headers.authorization = `Bearer ${accessToken}`;
    if (config.quotaUser && options.authenticated !== false) headers['x-goog-quota-user'] = config.quotaUser;

    const timeout = AbortSignal.timeout(config.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const started = deps.now();
    let response;
    try {
      response = await deps.fetch(buildUrl(options.url, options.query), { method: options.method, headers, body, signal });
    } catch (cause) {
      if (options.signal?.aborted) {
        throw new GoogleError('timeout', `Google ${options.operation} was cancelled`, {
          operation: options.operation,
          reason: 'aborted',
          retryable: false,
        });
      }
      const timedOut = timeout.aborted || /** @type {any} */ (cause)?.name === 'TimeoutError';
      throw new GoogleError(
        timedOut ? 'timeout' : 'network',
        redact(`Google ${options.operation} ${timedOut ? `timed out after ${config.timeoutMs}ms` : `network error: ${/** @type {any} */ (cause)?.message ?? cause}`}`, secrets()),
        { operation: options.operation, retryable: true },
      );
    }
    const text = await response.text();
    logger?.debug?.(
      { provider: 'google', operation: options.operation, status: response.status, attempt, ms: deps.now() - started },
      'google api call',
    );
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    if (response.ok) {
      if (text && parsed === null) {
        throw new GoogleError('invalid_response', `Google ${options.operation} returned a non-JSON body`, {
          operation: options.operation,
          status: response.status,
        });
      }
      return parsed;
    }
    throw errorFromResponse({
      status: response.status,
      body: parsed,
      operation: options.operation,
      retryAfterMs: parseRetryAfter(response.headers?.get?.('retry-after'), deps.now()),
      secrets: secrets(),
      tokenEndpoint: options.tokenEndpoint,
    });
  }

  /**
   * @param {RequestOptions} options
   * @returns {Promise<any>} parsed JSON (null for empty bodies)
   */
  async function request(options) {
    const authenticated = options.authenticated !== false;
    let refreshedAfter401 = false;
    let attempt = 0;
    for (;;) {
      const token = authenticated && tokens ? await tokens.getAccessToken() : null;
      try {
        return await once(options, token, attempt);
      } catch (error) {
        if (!(error instanceof GoogleError)) throw error;
        // A 401 means the request was rejected before it ran: refresh the token once and resend.
        if (error.status === 401 && authenticated && tokens && !refreshedAfter401) {
          refreshedAfter401 = true;
          tokens.invalidate();
          continue;
        }
        const canRetry = error.retryable && options.idempotent && attempt < config.maxRetries;
        if (!canRetry) throw error;
        const delay = error.retryAfterMs ?? backoffDelay(attempt, config, deps.random);
        if (delay > config.maxBackoffMs) throw error;
        logger?.warn?.(
          { provider: 'google', operation: options.operation, code: error.code, status: error.status, attempt, delayMs: delay },
          'google api call failed, retrying',
        );
        attempt += 1;
        await deps.sleep(delay);
      }
    }
  }

  /** Token endpoint helper (form POST, no bearer). Minting a token has no side effects, so it is retried. */
  async function postForm(url, form, operation) {
    return request({ operation, method: 'POST', url, form, idempotent: true, authenticated: false, tokenEndpoint: true });
  }

  return { request, postForm };
}
