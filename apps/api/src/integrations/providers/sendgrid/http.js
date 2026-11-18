import { SendgridError, codeForStatus, providerErrorsFrom, redactSecrets } from './errors.js';
import { apiBaseUrl } from './config.js';

/**
 * Low-level HTTP for the v3 API: auth header, timeout, retries with backoff, typed errors.
 *
 * Retry policy per call:
 * - 'idempotent' (GET and other safe reads): retried on 429, 5xx, timeouts and network errors.
 * - 'unsafe' (mail send, create batch): SendGrid offers no idempotency key, so these are retried
 *   only when the request certainly was not acted on: HTTP 429 (rejected by the rate limiter) and
 *   connection failures before any byte was sent (DNS failure, connection refused).
 */

/** Errors raised by undici before the request reached the server. */
const PRE_CONNECT_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

const MAX_BACKOFF_MS = 8_000;
/** Longest rate-limit wait we sit through inside one call; longer waits go back to the caller. */
const MAX_RATE_LIMIT_WAIT_MS = 30_000;

/** @typedef {{ limit: number|null, remaining: number|null, resetAt: string|null }} RateLimit */
/** @typedef {{ status: number, headers: Headers, body: unknown, rateLimit: RateLimit, attempts: number }} HttpResult */

/**
 * @param {{ config: import('./config.js').SendgridConfig, fetch: typeof globalThis.fetch, now: () => number,
 *   sleep: (ms: number) => Promise<void>, random: () => number, logger: any }} deps
 */
export function createHttp({ config, fetch, now, sleep, random, logger }) {
  const secrets = [config.apiKey];
  const base = apiBaseUrl(config);

  /**
   * @param {{ method: string, path: string, body?: unknown, policy: 'idempotent'|'unsafe', onBehalfOf?: boolean,
   *   signal?: AbortSignal, expect?: number[] }} req
   * @returns {Promise<HttpResult>}
   */
  return async function request(req) {
    const url = `${base}${req.path}`;
    /** @type {Record<string, string>} */
    const headers = {
      Authorization: `Bearer ${config.apiKey}`,
      Accept: 'application/json',
      'User-Agent': 'phoenix-crm-sendgrid/1.0',
    };
    if (req.body !== undefined) headers['Content-Type'] = 'application/json';
    if (req.onBehalfOf && config.onBehalfOf) headers['on-behalf-of'] = config.onBehalfOf;
    const payload = req.body === undefined ? undefined : JSON.stringify(req.body);

    for (let attempt = 1; ; attempt += 1) {
      const started = now();
      let error;
      try {
        const result = await attemptOnce({ url, method: req.method, headers, payload, signal: req.signal });
        logger.debug?.(
          { provider: 'sendgrid', method: req.method, path: req.path, status: result.status, attempt, ms: now() - started },
          'sendgrid request',
        );
        if (result.status >= 200 && result.status < 300) return { ...result, attempts: attempt };
        error = httpError(result, req.policy, secrets, now);
      } catch (caught) {
        error = transportError(caught, req, secrets);
      }
      const waitMs = retryDelay(error, req.policy, attempt, config.maxRetries, random);
      if (waitMs === null) throw error;
      logger.warn?.(
        { provider: 'sendgrid', method: req.method, path: req.path, code: error.code, status: error.status, attempt, waitMs },
        'sendgrid request retry',
      );
      await sleep(waitMs);
    }
  };

  /**
   * @param {{ url: string, method: string, headers: Record<string, string>, payload?: string, signal?: AbortSignal }} args
   */
  async function attemptOnce({ url, method, headers, payload, signal }) {
    const timeout = AbortSignal.timeout(config.timeoutMs);
    const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
    const response = await fetch(url, { method, headers, body: payload, signal: combined });
    const text = await response.text();
    let body = text;
    if (text && (response.headers.get('content-type') ?? '').includes('json')) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { status: response.status, headers: response.headers, body, rateLimit: rateLimitFrom(response.headers) };
  }
}

/**
 * @param {Headers} headers
 * @returns {RateLimit}
 */
export function rateLimitFrom(headers) {
  const num = (/** @type {string} */ name) => {
    const value = headers.get(name);
    return value === null || value === '' || Number.isNaN(Number(value)) ? null : Number(value);
  };
  const reset = num('x-ratelimit-reset');
  return {
    limit: num('x-ratelimit-limit'),
    remaining: num('x-ratelimit-remaining'),
    resetAt: reset === null ? null : new Date(reset * 1000).toISOString(),
  };
}

/**
 * @param {{ status: number, headers: Headers, body: unknown }} result
 * @param {'idempotent'|'unsafe'} policy
 * @param {string[]} secrets
 * @param {() => number} now
 */
function httpError(result, policy, secrets, now) {
  const code = codeForStatus(result.status);
  const providerErrors = providerErrorsFrom(result.body, secrets);
  const summary = providerErrors.map((e) => (e.field ? `${e.field}: ${e.message}` : e.message)).join('; ');
  return new SendgridError(code, `SendGrid responded ${result.status}${summary ? `: ${summary}` : ''}`, {
    status: result.status,
    providerErrors,
    retryAfterMs: code === 'rate_limited' ? retryAfterFrom(result.headers, now) : null,
    // A 5xx on mail send may or may not have queued the email.
    outcomeUnknown: code === 'provider_error' && policy === 'unsafe',
    requestId: result.headers.get('x-request-id') ?? null,
  });
}

/**
 * Wait hint from Retry-After (seconds or HTTP date) or X-RateLimit-Reset (unix seconds).
 * @param {Headers} headers
 * @param {() => number} now
 */
export function retryAfterFrom(headers, now) {
  const retryAfter = headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (!Number.isNaN(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.max(0, date - now());
  }
  const reset = Number(headers.get('x-ratelimit-reset'));
  if (headers.get('x-ratelimit-reset') && !Number.isNaN(reset)) return Math.max(0, reset * 1000 - now());
  return null;
}

/**
 * @param {unknown} caught
 * @param {{ policy: 'idempotent'|'unsafe', signal?: AbortSignal }} req
 * @param {string[]} secrets
 */
function transportError(caught, req, secrets) {
  if (caught instanceof SendgridError) return caught;
  const err = /** @type {any} */ (caught);
  if (req.signal?.aborted) {
    return new SendgridError('network', 'SendGrid request aborted by caller', {
      retryable: false,
      outcomeUnknown: req.policy === 'unsafe',
      cause: caught,
    });
  }
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
    return new SendgridError('timeout', 'SendGrid request timed out', {
      outcomeUnknown: req.policy === 'unsafe',
      cause: caught,
    });
  }
  const causeCode = err?.cause?.code ?? err?.code;
  const preConnect = PRE_CONNECT_CODES.has(causeCode);
  const message = redactSecrets(err?.cause?.message ?? err?.message ?? 'network error', secrets);
  const sgError = new SendgridError('network', `SendGrid request failed: ${message}`, {
    outcomeUnknown: req.policy === 'unsafe' && !preConnect,
  });
  /** @type {any} */ (sgError).preConnect = preConnect;
  return sgError;
}

/**
 * Milliseconds to wait before the next attempt, or null to give up.
 * @param {SendgridError} error
 * @param {'idempotent'|'unsafe'} policy
 * @param {number} attempt 1-based attempt that just failed
 * @param {number} maxRetries
 * @param {() => number} random
 */
export function retryDelay(error, policy, attempt, maxRetries, random) {
  if (attempt > maxRetries || !error.retryable) return null;
  const safe =
    policy === 'idempotent' || error.code === 'rate_limited' || /** @type {any} */ (error).preConnect === true;
  if (!safe) return null;
  if (error.code === 'rate_limited' && error.retryAfterMs !== null) {
    return error.retryAfterMs > MAX_RATE_LIMIT_WAIT_MS ? null : error.retryAfterMs;
  }
  const exp = Math.min(MAX_BACKOFF_MS, 500 * 2 ** (attempt - 1));
  return Math.round(exp * (0.5 + random() * 0.5));
}
