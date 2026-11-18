/**
 * Typed errors for the Google Calendar + Meet client.
 *
 * Every error the client throws is a GoogleError with a stable `code` and a `retryable` flag,
 * so the adapter layer (and the job queue behind it) can decide whether to try again without
 * parsing provider messages. Messages are passed through `redact` before they are stored, so
 * a secret that Google echoes back never reaches logs or API responses.
 */

/**
 * @typedef {'config_invalid'|'auth_failed'|'permission_denied'|'rate_limited'|'quota_exceeded'
 *   |'bad_request'|'not_found'|'duplicate'|'conflict'|'gone'|'full_sync_required'
 *   |'precondition_failed'|'server_error'|'timeout'|'network'|'invalid_response'} GoogleErrorCode
 */

export class GoogleError extends Error {
  /**
   * @param {GoogleErrorCode} code stable machine-readable code
   * @param {string} message human-readable, already redacted
   * @param {{ status?: number, reason?: string, retryable?: boolean, retryAfterMs?: number,
   *   operation?: string, details?: unknown, cause?: unknown }} [info]
   */
  constructor(code, message, info = {}) {
    super(message, info.cause === undefined ? undefined : { cause: info.cause });
    this.name = 'GoogleError';
    this.provider = 'google';
    this.code = code;
    this.status = info.status ?? null;
    this.reason = info.reason ?? null;
    this.retryable = info.retryable ?? false;
    this.retryAfterMs = info.retryAfterMs ?? null;
    this.operation = info.operation ?? null;
    this.details = info.details ?? null;
  }

  toJSON() {
    return {
      name: this.name,
      provider: this.provider,
      code: this.code,
      message: this.message,
      status: this.status,
      reason: this.reason,
      retryable: this.retryable,
      retryAfterMs: this.retryAfterMs,
      operation: this.operation,
    };
  }
}

/** Raised when a stored sync token is no longer valid (HTTP 410). Wipe local state and run a full sync. */
export class FullSyncRequiredError extends GoogleError {
  /** @param {string} message @param {{ status?: number, reason?: string, operation?: string }} [info] */
  constructor(message, info = {}) {
    super('full_sync_required', message, { ...info, retryable: false });
    this.name = 'FullSyncRequiredError';
  }
}

const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded']);
const QUOTA_REASONS = new Set(['quotaExceeded', 'dailyLimitExceeded']);
const FULL_SYNC_REASONS = new Set(['fullSyncRequired', 'updatedMinTooLongAgo']);

/**
 * Replace every configured secret (and anything that looks like a bearer token or PEM key)
 * with [REDACTED].
 * @param {unknown} text
 * @param {string[]} [secrets]
 * @returns {string}
 */
export function redact(text, secrets = []) {
  let out = typeof text === 'string' ? text : String(text ?? '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 6) out = out.split(secret).join('[REDACTED]');
  }
  return out
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [REDACTED]')
    .replace(/\bya29\.[A-Za-z0-9._-]+/g, '[REDACTED]')
    .replace(/\b1\/\/[A-Za-z0-9._-]{20,}/g, '[REDACTED]');
}

/**
 * Parse a Retry-After header (seconds or HTTP date) into milliseconds.
 * @param {string|null|undefined} value
 * @param {number} nowMs
 */
export function parseRetryAfter(value, nowMs) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : null;
}

/**
 * Pull `{ message, reason }` out of a Google error body. Handles the API shape
 * `{ error: { code, message, errors: [{ domain, reason, message }], status } }` and the OAuth
 * token endpoint shape `{ error: 'invalid_grant', error_description: '...' }`.
 * @param {unknown} body
 */
export function describeErrorBody(body) {
  if (!body || typeof body !== 'object') return { message: null, reason: null, domain: null };
  const error = /** @type {any} */ (body).error;
  if (typeof error === 'string') {
    return { message: /** @type {any} */ (body).error_description ?? error, reason: error, domain: 'oauth' };
  }
  if (error && typeof error === 'object') {
    const first = Array.isArray(error.errors) ? error.errors[0] : undefined;
    const detailReason = Array.isArray(error.details)
      ? error.details.find((d) => d && typeof d.reason === 'string')?.reason
      : undefined;
    return {
      message: error.message ?? first?.message ?? null,
      reason: first?.reason ?? detailReason ?? error.status ?? null,
      domain: first?.domain ?? null,
    };
  }
  return { message: null, reason: null, domain: null };
}

/**
 * Map an HTTP error response to a GoogleError. See docs/providers/google.md for the table.
 * @param {{ status: number, body: unknown, operation: string, retryAfterMs?: number|null, secrets?: string[], tokenEndpoint?: boolean }} input
 */
export function errorFromResponse({ status, body, operation, retryAfterMs = null, secrets = [], tokenEndpoint = false }) {
  const { message: rawMessage, reason, domain } = describeErrorBody(body);
  const message = redact(`Google ${operation} failed (${status}): ${rawMessage ?? 'no error message'}`, secrets);
  const info = { status, reason: reason ?? undefined, operation, retryAfterMs: retryAfterMs ?? undefined };

  if (tokenEndpoint) {
    // OAuth errors: invalid_grant, invalid_client, unauthorized_client, access_denied, ... are permanent
    // until someone fixes the credentials; 5xx and 429 from the token endpoint are transient.
    if (status === 429) return new GoogleError('rate_limited', message, { ...info, retryable: true });
    if (status >= 500) return new GoogleError('server_error', message, { ...info, retryable: true });
    return new GoogleError('auth_failed', message, { ...info, retryable: false });
  }
  if (status === 429 || (status === 403 && (RATE_LIMIT_REASONS.has(reason ?? '') || domain === 'usageLimits') && !QUOTA_REASONS.has(reason ?? ''))) {
    return new GoogleError('rate_limited', message, { ...info, retryable: true });
  }
  if (status === 403 && QUOTA_REASONS.has(reason ?? '')) {
    return new GoogleError('quota_exceeded', message, { ...info, retryable: false });
  }
  if (status === 401) return new GoogleError('auth_failed', message, { ...info, retryable: false });
  if (status === 403) return new GoogleError('permission_denied', message, { ...info, retryable: false });
  if (status === 404) return new GoogleError('not_found', message, { ...info, retryable: false });
  if (status === 409) {
    return new GoogleError(reason === 'duplicate' ? 'duplicate' : 'conflict', message, { ...info, retryable: false });
  }
  if (status === 410) {
    if (FULL_SYNC_REASONS.has(reason ?? '')) return new FullSyncRequiredError(message, info);
    return new GoogleError('gone', message, { ...info, retryable: false });
  }
  if (status === 412) return new GoogleError('precondition_failed', message, { ...info, retryable: false });
  if (status >= 500) return new GoogleError('server_error', message, { ...info, retryable: true });
  return new GoogleError('bad_request', message, { ...info, retryable: false });
}
