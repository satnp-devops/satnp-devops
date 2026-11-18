import {
  ZoomAuthError,
  ZoomError,
  ZoomNetworkError,
  ZoomNotFoundError,
  ZoomPermissionError,
  ZoomRateLimitError,
  ZoomServerError,
  ZoomValidationError,
  redact,
} from './errors.js';

/**
 * Low-level HTTP for the Zoom client: timeouts, error mapping, bounded retries.
 *
 * Retry policy (see docs/providers/zoom.md#retries):
 * - Only calls marked `idempotent` (GET, PATCH, DELETE, token requests) are retried, on
 *   network errors, timeouts, 5xx and 429 (honouring Retry-After up to maxRetryDelayMs).
 * - Non-idempotent calls (POST create meeting) are never retried here. A failure that may have
 *   reached Zoom is flagged `ambiguous` and `retryable: false` so no queue blindly duplicates it.
 */

/** Zoom error codes that mean "not allowed" even though Zoom answers 400. */
const PERMISSION_CODES = new Set([200, 3161]);
/** Connection errors where the request certainly never reached Zoom. */
const PRE_CONNECT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']);

/**
 * @typedef {object} HttpDeps
 * @property {typeof fetch} fetch
 * @property {() => number} now
 * @property {(ms: number) => Promise<void>} sleep
 * @property {() => number} random
 * @property {{ debug?: Function, warn?: Function }} logger
 * @property {{ timeoutMs: number, maxRetries: number, retryBaseDelayMs: number, maxRetryDelayMs: number }} options
 * @property {() => Array<string|undefined>} secrets  values to scrub from any error message
 */

/**
 * @typedef {object} HttpRequest
 * @property {string} method
 * @property {string} url        absolute URL
 * @property {string} path       for logs and errors (no query string)
 * @property {Record<string,string>} [headers]
 * @property {string} [body]
 * @property {boolean} idempotent
 * @property {AbortSignal} [signal]
 */

/**
 * Parse JSON keeping integers above 2^53 as strings (meeting IDs are int64).
 * Uses the reviver `context.source` when the runtime provides it (Node 21+).
 * @param {string} text
 */
export function parseJson(text) {
  return JSON.parse(text, (key, value, context) =>
    typeof value === 'number' && !Number.isSafeInteger(value) && Number.isInteger(value) && context?.source
      ? context.source
      : value,
  );
}

/**
 * Retry-After is either delta-seconds or a date (Zoom has been seen sending ISO dates on daily limits).
 * @param {string|null} header
 * @param {number} nowMs
 * @returns {number|null} milliseconds to wait
 */
export function parseRetryAfter(header, nowMs) {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? null : Math.max(0, at - nowMs);
}

/** Exponential backoff with jitter in [50%, 100%] of the step. */
export function backoffDelay(attempt, baseMs, maxMs, random) {
  const step = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.round(step * (0.5 + random() * 0.5));
}

function msUntilNextUtcMidnight(nowMs) {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - nowMs;
}

function isPreConnectError(error) {
  const code = error?.cause?.code ?? error?.code;
  return typeof code === 'string' && PRE_CONNECT_CODES.has(code);
}

/**
 * Turn a non-2xx response into a typed error.
 * @param {Response} response
 * @param {unknown} body  parsed JSON or text
 * @param {{ method: string, path: string, idempotent: boolean, nowMs: number, secrets: Array<string|undefined> }} ctx
 */
export function mapErrorResponse(response, body, ctx) {
  const status = response.status;
  const obj = body && typeof body === 'object' ? /** @type {Record<string, any>} */ (body) : {};
  const providerCode = obj.code ?? obj.error ?? null;
  const rawMessage = obj.message ?? obj.reason ?? obj.error_description ?? (typeof body === 'string' && body ? body.slice(0, 300) : response.statusText);
  const message = redact(`Zoom ${ctx.method} ${ctx.path} failed (${status}${providerCode !== null ? ` code ${providerCode}` : ''}): ${rawMessage || 'no message'}`, ctx.secrets);
  const details = Array.isArray(obj.errors) ? obj.errors.map((e) => ({ field: e.field, message: redact(e.message, ctx.secrets) })) : undefined;
  const info = { status, providerCode, method: ctx.method, path: ctx.path, details };

  if (status === 401) return new ZoomAuthError(message, info);
  if (status === 403 || (status === 400 && PERMISSION_CODES.has(Number(providerCode)))) return new ZoomPermissionError(message, info);
  if (status === 404) return new ZoomNotFoundError(message, info);
  if (status === 409) return new ZoomValidationError(message, { ...info, kind: 'conflict' });
  if (status === 400 || status === 422) return new ZoomValidationError(message, info);
  if (status === 429) {
    const limitType = response.headers.get('x-ratelimit-type');
    // No Retry-After: per-second limits clear in about a second; daily limits reset at 00:00 UTC.
    const retryAfterMs =
      parseRetryAfter(response.headers.get('retry-after'), ctx.nowMs) ??
      (/daily/i.test(`${limitType} ${rawMessage}`) ? msUntilNextUtcMidnight(ctx.nowMs) : 1000);
    return new ZoomRateLimitError(message, {
      ...info,
      retryAfterMs,
      limitType,
      limitCategory: response.headers.get('x-ratelimit-category'),
    });
  }
  if (status >= 500) {
    return new ZoomServerError(message, { ...info, retryable: ctx.idempotent, ambiguous: !ctx.idempotent });
  }
  return new ZoomError(message, { ...info, kind: 'unknown', retryable: false });
}

async function readBody(response) {
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  try {
    return parseJson(text);
  } catch {
    return text;
  }
}

/** @param {HttpDeps} deps */
export function createHttp(deps) {
  const { fetch, now, sleep, random, logger, options } = deps;

  /** One attempt: fetch with timeout, then parse. Throws typed errors. */
  async function attempt(req) {
    const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
    const signal = req.signal ? AbortSignal.any([req.signal, timeoutSignal]) : timeoutSignal;
    let response;
    try {
      response = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body, signal });
    } catch (error) {
      if (req.signal?.aborted) throw new ZoomError(`Zoom ${req.method} ${req.path} aborted by caller`, { kind: 'unknown', method: req.method, path: req.path });
      const timedOut = timeoutSignal.aborted || error?.name === 'TimeoutError';
      const definitelyNotSent = !timedOut && isPreConnectError(error);
      const safe = req.idempotent || definitelyNotSent;
      throw new ZoomNetworkError(
        redact(`Zoom ${req.method} ${req.path} ${timedOut ? `timed out after ${options.timeoutMs}ms` : `network error: ${error?.message ?? error}`}`, deps.secrets()),
        { kind: timedOut ? 'timeout' : 'network', method: req.method, path: req.path, retryable: safe, ambiguous: !safe },
      );
    }
    let body;
    try {
      body = await readBody(response);
    } catch (error) {
      // The body stream failed (timeout or reset mid-response): Zoom may have acted on it.
      const timedOut = timeoutSignal.aborted;
      throw new ZoomNetworkError(`Zoom ${req.method} ${req.path} response body ${timedOut ? 'timed out' : `failed: ${error?.message ?? error}`}`, {
        kind: timedOut ? 'timeout' : 'network',
        status: response.status,
        method: req.method,
        path: req.path,
        retryable: req.idempotent,
        ambiguous: !req.idempotent,
      });
    }
    if (response.ok) return { status: response.status, body, headers: response.headers };
    throw mapErrorResponse(response, body, { method: req.method, path: req.path, idempotent: req.idempotent, nowMs: now(), secrets: deps.secrets() });
  }

  /**
   * Send with bounded retries for idempotent calls.
   * @param {HttpRequest} req
   * @returns {Promise<{ status: number, body: any, headers: Headers }>}
   */
  async function send(req) {
    for (let attemptNo = 0; ; attemptNo += 1) {
      const started = now();
      try {
        const result = await attempt(req);
        logger.debug?.({ zoom: { method: req.method, path: req.path, status: result.status, attempt: attemptNo, ms: now() - started } }, 'zoom request');
        return result;
      } catch (error) {
        const canRetry = req.idempotent && error instanceof ZoomError && error.retryable && attemptNo < options.maxRetries;
        const delay = canRetry ? (error.retryAfterMs ?? backoffDelay(attemptNo, options.retryBaseDelayMs, options.maxRetryDelayMs, random)) : null;
        logger.warn?.(
          { zoom: { method: req.method, path: req.path, status: error.status ?? null, kind: error.kind, attempt: attemptNo, retryInMs: delay } },
          'zoom request failed',
        );
        if (delay === null || delay > options.maxRetryDelayMs) throw error;
        await sleep(delay);
      }
    }
  }

  return { send };
}
