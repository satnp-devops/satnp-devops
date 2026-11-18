import { ExotelError, ExotelNetworkError, mapHttpError } from './errors.js';

/**
 * HTTP transport: per-attempt timeout (AbortSignal.timeout), typed error mapping, and retries
 * with exponential backoff + jitter.
 *
 * Retry policy:
 *  - idempotent requests (GET): retry network errors, timeouts, 408, 429 and 5xx.
 *  - non-idempotent requests (POST connect): retry 429 only, because Exotel rejected the request
 *    without placing the call. Exotel has no idempotency keys, so a timeout or 5xx on connect is
 *    surfaced with `outcomeUnknown: true` instead of risking a second call to the customer.
 */

/**
 * @typedef {object} HttpDeps
 * @property {typeof fetch} fetch
 * @property {() => number} nowMs
 * @property {(ms: number) => Promise<void>} sleep
 * @property {() => number} random
 * @property {any} [logger] pino-style logger (debug/warn); only metadata is logged, never bodies
 * @property {(text: unknown) => string} redact
 * @property {number} timeoutMs
 * @property {number} maxRetries
 * @property {number} retryBaseDelayMs
 * @property {number} maxRetryAfterMs
 */

/**
 * @typedef {object} HttpRequest
 * @property {string} operation name used in errors and logs
 * @property {string} method
 * @property {string} url
 * @property {Record<string, string>} [headers]
 * @property {string} [body]
 * @property {boolean} idempotent
 * @property {AbortSignal} [signal] caller cancellation
 * @property {'follow' | 'manual'} [redirect]
 * @property {boolean} [raw] return the Response (body unread) instead of text
 */

/** @param {HttpDeps} deps */
export function createHttp(deps) {
  /**
   * @param {HttpRequest} req
   * @returns {Promise<{ status: number, headers: Headers, text: string } | Response>}
   */
  async function send(req) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await once(req, attempt);
      } catch (error) {
        const delay = retryDelay(error, req, attempt);
        if (delay === null) throw error;
        deps.logger?.warn?.(
          { provider: 'exotel', operation: req.operation, attempt: attempt + 1, code: error.code, status: error.status, delayMs: delay },
          'exotel request failed, retrying',
        );
        await deps.sleep(delay);
      }
    }
  }

  /**
   * @param {unknown} error
   * @param {HttpRequest} req
   * @param {number} attempt
   * @returns {number | null} delay in ms, or null when the error must be thrown
   */
  function retryDelay(error, req, attempt) {
    if (!(error instanceof ExotelError) || !error.retryable || attempt >= deps.maxRetries) return null;
    if (!req.idempotent && error.code !== 'rate_limited') return null;
    const exp = deps.retryBaseDelayMs * 2 ** attempt;
    const jittered = Math.round(exp / 2 + (exp / 2) * deps.random());
    if (error.retryAfterMs === null) return jittered;
    if (error.retryAfterMs > deps.maxRetryAfterMs) return null;
    return Math.max(jittered, error.retryAfterMs);
  }

  /**
   * @param {HttpRequest} req
   * @param {number} attempt
   */
  async function once(req, attempt) {
    // A clearable timer (not AbortSignal.timeout) so raw responses can be streamed past timeoutMs:
    // the per-attempt timeout covers connect + headers (+ body for non-raw requests).
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new DOMException('Request timed out', 'TimeoutError')), deps.timeoutMs);
    try {
      return await attemptOnce(req, attempt, timeout.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * @param {HttpRequest} req
   * @param {number} attempt
   * @param {AbortSignal} timeout
   */
  async function attemptOnce(req, attempt, timeout) {
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
    const started = deps.nowMs();
    let res;
    try {
      res = await deps.fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        signal,
        redirect: req.redirect ?? 'follow',
      });
    } catch (error) {
      throw transportError(error, req, timeout);
    }
    deps.logger?.debug?.(
      { provider: 'exotel', operation: req.operation, method: req.method, status: res.status, attempt, ms: deps.nowMs() - started },
      'exotel request',
    );
    if (res.status >= 400) {
      const text = await res.text().catch(() => '');
      throw mapHttpError({
        status: res.status,
        text,
        retryAfter: res.headers.get('retry-after'),
        operation: req.operation,
        redact: deps.redact,
        nowMs: deps.nowMs(),
        idempotent: req.idempotent,
      });
    }
    if (req.raw) return res;
    try {
      return { status: res.status, headers: res.headers, text: await res.text() };
    } catch (error) {
      throw transportError(error, req, timeout);
    }
  }

  /**
   * @param {any} error
   * @param {HttpRequest} req
   * @param {AbortSignal} timeout
   */
  function transportError(error, req, timeout) {
    if (error instanceof ExotelError) return error;
    const callerTimedOut = req.signal?.aborted && req.signal.reason?.name === 'TimeoutError';
    if (req.signal?.aborted && !callerTimedOut) {
      return new ExotelNetworkError(`Exotel ${req.operation} aborted by caller`, {
        code: 'aborted',
        retryable: false,
        operation: req.operation,
        outcomeUnknown: !req.idempotent,
      });
    }
    const timedOut = callerTimedOut || timeout.aborted || error?.name === 'TimeoutError';
    return new ExotelNetworkError(
      timedOut
        ? `Exotel ${req.operation} timed out after ${deps.timeoutMs}ms`
        : `Exotel ${req.operation} network error: ${deps.redact(error?.message ?? 'unknown')}`,
      { code: timedOut ? 'timeout' : 'network_error', operation: req.operation, outcomeUnknown: !req.idempotent },
    );
  }

  return { send };
}
