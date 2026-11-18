import { MsgraphError, isRetryableStatus, parseRetryAfter, redact } from './errors.js';
import { attemptSignal, backoffDelay, fetchFailure, readJson } from './http.js';

/**
 * App-only access tokens from the Microsoft identity platform (OAuth 2.0 client credentials).
 *
 *   POST {authorityHost}/{tenant}/oauth2/v2.0/token
 *   Content-Type: application/x-www-form-urlencoded
 *   client_id=...&scope=https://graph.microsoft.com/.default&client_secret=...&grant_type=client_credentials
 *
 * Tokens are cached until `tokenRefreshSkewMs` before expiry and concurrent callers share one
 * request. Requesting a token has no side effects, so failures with transient status are retried.
 */

/**
 * @param {{
 *   config: import('./config.js').MsgraphConfig,
 *   fetch: import('./http.js').FetchLike,
 *   now: () => number,
 *   sleep: (ms: number, signal?: AbortSignal) => Promise<unknown>,
 *   random: () => number,
 *   logger: import('./http.js').Logger,
 *   secrets: string[],
 * }} deps
 */
export function createTokenProvider(deps) {
  const { config, fetch, now, sleep, random, logger, secrets } = deps;
  const tokenUrl = `${config.authorityHost.replace(/\/+$/, '')}/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/token`;
  const scope = `${new URL(config.graphBaseUrl).origin}/.default`;
  /** @type {{ token: string, expiresAtMs: number } | null} */
  let cached = null;
  /** @type {Promise<string> | null} */
  let inflight = null;

  /**
   * The shared token request is not tied to any one caller's AbortSignal, so one caller
   * aborting never fails the others; it is bounded by its own timeout and retry budget.
   * @param {{ forceRefresh?: boolean }} [options]
   */
  async function getToken({ forceRefresh = false } = {}) {
    if (!forceRefresh && cached && now() < cached.expiresAtMs - config.tokenRefreshSkewMs) return cached.token;
    if (!inflight) {
      inflight = requestWithRetry(undefined).finally(() => {
        inflight = null;
      });
    }
    return inflight;
  }

  function invalidate() {
    cached = null;
  }

  /** @param {AbortSignal | undefined} callerSignal */
  async function requestWithRetry(callerSignal) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await requestOnce(callerSignal);
      } catch (err) {
        const error = /** @type {MsgraphError} */ (err);
        if (!error.retryable || attempt >= config.maxRetries) throw error;
        const delay =
          error.retryAfterMs ??
          backoffDelay(attempt, { baseMs: config.retryBaseDelayMs, maxMs: config.maxRetryDelayMs, random });
        if (delay > config.maxRetryDelayMs) throw error;
        logger.warn?.({ provider: 'msgraph', operation: 'token', kind: error.kind, attempt, retryInMs: delay }, 'msgraph token retry');
        await sleep(delay, callerSignal);
      }
    }
  }

  /** @param {AbortSignal | undefined} callerSignal */
  async function requestOnce(callerSignal) {
    const form = new URLSearchParams({
      client_id: config.clientId,
      scope,
      client_secret: config.clientSecret,
      grant_type: 'client_credentials',
    });
    const { signal, timeout } = attemptSignal(callerSignal, config.requestTimeoutMs);
    const requestedAt = now();
    /** @type {Response} */
    let res;
    try {
      res = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: form.toString(),
        signal,
      });
    } catch (err) {
      throw fetchFailure(err, {
        operation: 'token',
        callerSignal,
        timeout,
        timeoutMs: config.requestTimeoutMs,
        idempotent: true,
        secrets,
      });
    }
    const body = /** @type {any} */ (await readJson(res));
    if (!res.ok) throw tokenError(res, body);
    const expiresIn = Number(body?.expires_in);
    if (typeof body?.access_token !== 'string' || !body.access_token || !Number.isFinite(expiresIn)) {
      throw new MsgraphError('token response is missing access_token or expires_in', {
        kind: 'unexpected',
        code: 'invalid_token_response',
        status: res.status,
        operation: 'token',
      });
    }
    cached = { token: body.access_token, expiresAtMs: requestedAt + expiresIn * 1000 };
    return body.access_token;
  }

  /**
   * Identity-platform errors: { error, error_description, error_codes, trace_id, correlation_id }.
   * @param {Response} res
   * @param {any} body
   */
  function tokenError(res, body) {
    const code = typeof body?.error === 'string' ? body.error : `http_${res.status}`;
    // error_description carries AADSTS text; keep only its first line (trace IDs follow) and redact.
    const description = typeof body?.error_description === 'string' ? body.error_description.split(/\r?\n/)[0] : '';
    const retryable = isRetryableStatus(res.status) || code === 'temporarily_unavailable';
    return new MsgraphError(`token request failed: ${redact(description || `HTTP ${res.status}`, secrets)} (${code})`, {
      kind: retryable ? (res.status === 429 ? 'throttled' : 'unavailable') : 'auth',
      code,
      status: res.status,
      retryable,
      retryAfterMs: parseRetryAfter(res.headers.get('retry-after'), now()),
      requestId: typeof body?.trace_id === 'string' ? body.trace_id : null,
      operation: 'token',
      details: {
        errorCodes: Array.isArray(body?.error_codes) ? body.error_codes : [],
        correlationId: typeof body?.correlation_id === 'string' ? body.correlation_id : null,
      },
    });
  }

  return { getToken, invalidate };
}
