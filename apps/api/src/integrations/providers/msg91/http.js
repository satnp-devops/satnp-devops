import { Msg91Error, classifyProviderError, redact } from './errors.js';

/**
 * Minimal HTTP transport for MSG91: auth header, per-attempt timeout, bounded retries.
 *
 * Retry policy
 *   - idempotent calls (reads: logs, templates): network errors, timeouts, 429 and 5xx.
 *   - non-idempotent calls (send SMS, send/resend/verify OTP): only when MSG91 certainly did not
 *     process the request — 429, or a connection that never opened (DNS failure, refused).
 *     MSG91 has no idempotency key, so a timeout or 5xx on a send is surfaced with
 *     `delivery: 'unknown'` instead of being retried blindly.
 * Logs carry operation, method, path, status, attempt and duration — never the query string
 * (phone numbers, OTPs) or headers (auth key).
 */

/** Connection errors that mean the request never left this machine. */
const CONNECT_ERROR_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'ENETUNREACH', 'EHOSTUNREACH']);

/**
 * @typedef {{ debug?: Function, info?: Function, warn?: Function, error?: Function }} Logger
 * @typedef {{ method: 'GET' | 'POST', path: string, query?: Record<string, string | number | undefined>,
 *   body?: unknown, idempotent: boolean, operation: string, signal?: AbortSignal }} TransportRequest
 * @typedef {{ status: number, body: any, text: string, headers: Headers }} TransportResponse
 */

/**
 * @param {{ baseUrl: string, authKey: string, timeoutMs: number, maxRetries: number, retryBaseDelayMs: number,
 *   retryMaxDelayMs: number, fetch: typeof fetch, sleep: (ms: number) => Promise<void>, random: () => number,
 *   now: () => Date, logger?: Logger, secrets: string[] }} options
 */
export function createTransport(options) {
  const { fetch: fetchImpl, logger, secrets } = options;

  /** @param {TransportRequest} req @returns {Promise<TransportResponse>} */
  async function request(req) {
    const url = buildUrl(options.baseUrl, req.path, req.query);
    const init = buildInit(req, options.authKey);
    for (let attempt = 0; ; attempt += 1) {
      const started = Date.now();
      const outcome = await attemptOnce(fetchImpl, url, init, req, options.timeoutMs, secrets);
      log(logger, req, url, attempt, started, outcome);
      if (outcome.kind === 'response' && !isRetryableStatus(outcome.response.status)) return outcome.response;
      const failure = toError(outcome, req, options, secrets);
      const delay = retryDelay(failure, outcome, attempt, req, options);
      if (delay === null) throw failure;
      await options.sleep(delay);
    }
  }

  return { request };
}

/** @param {string} baseUrl @param {string} path @param {TransportRequest['query']} query */
function buildUrl(baseUrl, path, query) {
  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  return url;
}

/** @param {TransportRequest} req @param {string} authKey @returns {RequestInit} */
function buildInit(req, authKey) {
  /** @type {Record<string, string>} */
  const headers = { authkey: authKey, accept: 'application/json' };
  if (req.body !== undefined) headers['content-type'] = 'application/json';
  return { method: req.method, headers, body: req.body === undefined ? undefined : JSON.stringify(req.body) };
}

/**
 * @returns {Promise<{ kind: 'response', response: TransportResponse } | { kind: 'error', error: any, timedOut: boolean, aborted: boolean }>}
 */
async function attemptOnce(fetchImpl, url, init, req, timeoutMs, secrets) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
  try {
    const res = await fetchImpl(url, { ...init, signal });
    const text = await res.text();
    return { kind: 'response', response: { status: res.status, body: parseJson(text), text: redact(text, secrets), headers: res.headers } };
  } catch (error) {
    const aborted = Boolean(req.signal?.aborted);
    const timedOut = !aborted && (timeout.aborted || error?.name === 'TimeoutError');
    return { kind: 'error', error, timedOut, aborted };
  }
}

/** @param {string} text */
function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** @param {number} status */
const isRetryableStatus = (status) => status === 429 || status >= 500;

/**
 * @param {any} outcome @param {TransportRequest} req
 * @param {{ now: () => Date }} options @param {string[]} secrets
 * @returns {Msg91Error}
 */
function toError(outcome, req, options, secrets) {
  const delivery = req.idempotent ? 'n/a' : 'unknown';
  if (outcome.kind === 'response') {
    const { status, body, text } = outcome.response;
    const retryAfterMs = parseRetryAfter(outcome.response.headers.get('retry-after'), options.now());
    const providerMessage = redact(String(body?.message ?? body?.errors ?? text ?? '').slice(0, 300), secrets);
    const { code } = classifyProviderError({ status });
    const notSent = status === 429;
    return new Msg91Error(`MSG91 ${req.operation} failed with HTTP ${status}${providerMessage ? `: ${providerMessage}` : ''}`, {
      code,
      retryable: true,
      status,
      delivery: notSent ? 'not_sent' : delivery,
      retryAfterMs,
    });
  }
  if (outcome.aborted) return new Msg91Error(`MSG91 ${req.operation} was aborted by the caller`, { code: 'aborted', delivery, cause: outcome.error });
  if (outcome.timedOut) return new Msg91Error(`MSG91 ${req.operation} timed out`, { code: 'timeout', retryable: true, delivery, cause: outcome.error });
  const connectCode = connectErrorCode(outcome.error);
  const message = redact(String(outcome.error?.message ?? outcome.error), secrets);
  return new Msg91Error(`MSG91 ${req.operation} network error: ${message}${connectCode ? ` (${connectCode})` : ''}`, {
    code: 'network_error',
    retryable: true,
    delivery: connectCode ? 'not_sent' : delivery,
    cause: outcome.error,
  });
}

/** @param {any} error */
function connectErrorCode(error) {
  const code = error?.cause?.code ?? error?.code;
  return CONNECT_ERROR_CODES.has(code) ? code : null;
}

/**
 * Delay before the next attempt, or null to stop. Non-idempotent calls retry only when the
 * request certainly did not reach MSG91.
 * @param {Msg91Error} failure @param {any} outcome @param {number} attempt @param {TransportRequest} req
 * @param {{ maxRetries: number, retryBaseDelayMs: number, retryMaxDelayMs: number, random: () => number }} options
 */
function retryDelay(failure, outcome, attempt, req, options) {
  if (attempt >= options.maxRetries || failure.code === 'aborted') return null;
  if (!req.idempotent && failure.delivery !== 'not_sent') return null;
  if (failure.retryAfterMs !== null) return failure.retryAfterMs <= options.retryMaxDelayMs ? failure.retryAfterMs : null;
  const exponential = Math.min(options.retryMaxDelayMs, options.retryBaseDelayMs * 2 ** attempt);
  return Math.round(exponential * (0.5 + options.random() * 0.5));
}

/**
 * Retry-After as milliseconds (delta-seconds or HTTP date).
 * @param {string | null} value @param {Date} now
 */
export function parseRetryAfter(value, now) {
  if (!value) return null;
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - now.getTime());
}

function log(logger, req, url, attempt, started, outcome) {
  const entry = {
    provider: 'msg91',
    operation: req.operation,
    method: req.method,
    path: url.pathname,
    attempt,
    durationMs: Date.now() - started,
    status: outcome.kind === 'response' ? outcome.response.status : null,
    error: outcome.kind === 'error' ? (outcome.timedOut ? 'timeout' : outcome.aborted ? 'aborted' : 'network') : undefined,
  };
  const level = outcome.kind === 'response' && outcome.response.status < 500 ? 'debug' : 'warn';
  logger?.[level]?.(entry, `msg91 ${req.operation}`);
}
