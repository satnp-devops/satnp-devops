/**
 * Typed errors for the Microsoft Graph client.
 *
 * Every failure the client surfaces is an MsgraphError with a stable `kind` and a
 * `retryable` flag, so the adapter (and the job queue behind it) can decide whether to
 * try again without parsing messages. Messages never contain secrets or tokens.
 */

/**
 * @typedef {'config'|'auth'|'permission'|'not_found'|'conflict'|'validation'|'precondition'
 *   |'throttled'|'unavailable'|'timeout'|'network'|'aborted'|'webhook'|'unexpected'} MsgraphErrorKind
 */

export class MsgraphError extends Error {
  /**
   * @param {string} message safe to log; never contains secrets
   * @param {{
   *   kind: MsgraphErrorKind,
   *   code?: string,
   *   status?: number | null,
   *   retryable?: boolean,
   *   retryAfterMs?: number | null,
   *   requestId?: string | null,
   *   clientRequestId?: string | null,
   *   operation?: string | null,
   *   details?: Record<string, unknown>,
   *   cause?: unknown,
   * }} info
   */
  constructor(message, info) {
    super(message, info.cause === undefined ? undefined : { cause: info.cause });
    this.name = 'MsgraphError';
    this.provider = 'msgraph';
    this.kind = info.kind;
    this.code = info.code ?? info.kind;
    this.status = info.status ?? null;
    this.retryable = info.retryable ?? false;
    this.retryAfterMs = info.retryAfterMs ?? null;
    this.requestId = info.requestId ?? null;
    this.clientRequestId = info.clientRequestId ?? null;
    this.operation = info.operation ?? null;
    this.details = info.details ?? {};
  }

  /** Structured form for logs and job failure records. */
  toJSON() {
    return {
      name: this.name,
      provider: this.provider,
      kind: this.kind,
      code: this.code,
      status: this.status,
      retryable: this.retryable,
      retryAfterMs: this.retryAfterMs,
      requestId: this.requestId,
      clientRequestId: this.clientRequestId,
      operation: this.operation,
      message: this.message,
      details: this.details,
    };
  }
}

/** HTTP statuses Graph documents as transient (throttling, maintenance, gateway). */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504, 509]);

/** @param {number} status */
export function isRetryableStatus(status) {
  return RETRYABLE_STATUSES.has(status);
}

/**
 * Kind for an HTTP status from Graph.
 * @param {number} status
 * @returns {MsgraphErrorKind}
 */
export function kindForStatus(status) {
  if (status === 401) return 'auth';
  if (status === 403) return 'permission';
  if (status === 404 || status === 410) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 412) return 'precondition';
  if (status === 429 || status === 509) return 'throttled';
  if (status === 503 || status === 502 || status === 504 || status === 500) return 'unavailable';
  if (status >= 400 && status < 500) return 'validation';
  return 'unexpected';
}

/**
 * Parse a Retry-After header (delta-seconds or HTTP-date) into milliseconds.
 * @param {string | null | undefined} value
 * @param {number} nowMs
 * @returns {number | null}
 */
export function parseRetryAfter(value, nowMs) {
  if (value == null || value === '') return null;
  const trimmed = String(value).trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - nowMs);
}

/**
 * Replace every occurrence of the given secrets in a string.
 * @param {string} text
 * @param {Array<string | undefined | null>} secrets
 */
export function redact(text, secrets) {
  let out = String(text ?? '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 4) out = out.split(secret).join('[REDACTED]');
  }
  // Bearer tokens and JWT-shaped strings never belong in logs or error messages.
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [REDACTED]');
  out = out.replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[REDACTED_JWT]');
  return out;
}

/**
 * Build an MsgraphError from a Graph error response.
 * Graph errors look like { error: { code, message, innerError: { 'request-id', date, ... } } }.
 * @param {{ status: number, body: unknown, headers: Headers, nowMs: number, operation: string, secrets: string[], clientRequestId?: string | null }} input
 */
export function errorFromGraphResponse({ status, body, headers, nowMs, operation, secrets, clientRequestId = null }) {
  const error = /** @type {any} */ (body)?.error ?? {};
  const code = typeof error.code === 'string' && error.code ? error.code : `http_${status}`;
  const rawMessage = typeof error.message === 'string' && error.message ? error.message : `HTTP ${status}`;
  const inner = error.innerError ?? error.innererror ?? {};
  const requestId = headers.get('request-id') ?? inner['request-id'] ?? null;
  const kind = kindForStatus(status);
  const retryAfterMs = parseRetryAfter(headers.get('retry-after'), nowMs);
  /** @type {Record<string, unknown>} */
  const details = {};
  if (typeof inner.code === 'string') details.innerCode = inner.code;
  if (typeof inner.date === 'string') details.date = inner.date;
  // Duplicate subscription: "Subscription Id <guid> already exists for the requested combination".
  const existing = /Subscription Id ([0-9a-f-]{36}) already exists/i.exec(rawMessage);
  if (status === 409 && existing) details.existingSubscriptionId = existing[1];
  return new MsgraphError(`${operation} failed: ${redact(rawMessage, secrets)} (${code})`, {
    kind,
    code,
    status,
    retryable: isRetryableStatus(status),
    retryAfterMs,
    requestId,
    clientRequestId: headers.get('client-request-id') ?? clientRequestId,
    operation,
    details,
  });
}
