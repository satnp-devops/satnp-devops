/**
 * Typed errors for the Digio client. Every failure the client raises is a DigioError with a
 * stable `code`, a `retryable` flag and no secrets: messages and details pass through
 * `redact()` before they are stored.
 */

/**
 * @typedef {'config_invalid' | 'validation' | 'minor_signer' | 'auth' | 'forbidden' | 'not_found'
 *   | 'conflict' | 'duplicate_request' | 'insufficient_credits' | 'bad_request' | 'rate_limited'
 *   | 'provider_unavailable' | 'timeout' | 'network' | 'aborted' | 'invalid_response'} DigioErrorCode
 */

export class DigioError extends Error {
  /**
   * @param {DigioErrorCode} code stable machine-readable code
   * @param {string} message message safe to log (already redacted)
   * @param {{ retryable?: boolean, status?: number, providerCode?: string | null,
   *   providerReference?: string | null, details?: unknown, cause?: unknown }} [extra]
   */
  constructor(code, message, extra = {}) {
    super(message, extra.cause === undefined ? undefined : { cause: extra.cause });
    this.name = 'DigioError';
    this.provider = 'digio';
    this.code = code;
    this.retryable = extra.retryable ?? false;
    this.status = extra.status ?? null;
    /** Digio's own error code, e.g. "REQUEST_VALIDATION_FAILED" or "1128". */
    this.providerCode = extra.providerCode ?? null;
    /** Digio's exception reference ("details": "EX..."), useful when raising a ticket. */
    this.providerReference = extra.providerReference ?? null;
    this.details = extra.details;
  }

  toJSON() {
    return {
      name: this.name,
      provider: this.provider,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      status: this.status,
      providerCode: this.providerCode,
      providerReference: this.providerReference,
      details: this.details,
    };
  }
}

/** @param {unknown} error */
export function isRetryable(error) {
  return error instanceof DigioError && error.retryable;
}

/**
 * Replace every occurrence of the given secrets (and their Basic-auth encoding) in a string.
 * @param {string} text
 * @param {readonly string[]} secrets
 */
export function redact(text, secrets) {
  let out = String(text);
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 4) out = out.split(secret).join('[redacted]');
  }
  return out;
}

/**
 * Deep-redact a JSON-like value (strings only; structure kept).
 * @param {unknown} value
 * @param {readonly string[]} secrets
 * @returns {unknown}
 */
export function redactDeep(value, secrets) {
  if (typeof value === 'string') return redact(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, secrets)]));
  }
  return value;
}

/**
 * Digio numeric error codes (documentation.digio.in/digisign/error_codes) that mean "try again
 * later" rather than "the request is wrong".
 */
const RETRYABLE_PROVIDER_CODES = new Set(['1001', '1017', '1199', '1205', '1208']);
const CONFLICT_PROVIDER_CODES = new Set(['1021', '1047', '1055', '1082', '1107', '1108', '1152', '1155']);
const NOT_FOUND_PROVIDER_CODES = new Set(['1016', '1006', '1078', '1094']);
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Map an HTTP error response from Digio to a DigioError.
 * Body shape (OpenAPI): { details: "EX...", code: "REQUEST_VALIDATION_FAILED", message, errors? }.
 * @param {{ status: number, body: unknown, method: string, path: string, retryAfterMs?: number | null,
 *   secrets: readonly string[] }} input
 */
export function mapHttpError({ status, body, method, path, retryAfterMs = null, secrets }) {
  const obj = body && typeof body === 'object' ? /** @type {Record<string, unknown>} */ (body) : {};
  const providerCode = obj.code === undefined || obj.code === null ? null : String(obj.code);
  const providerMessage = typeof obj.message === 'string' ? obj.message : null;
  const providerReference = typeof obj.details === 'string' ? obj.details : null;
  const details = redactDeep(
    { method, path, providerMessage, errors: obj.errors ?? null, retryAfterMs },
    secrets,
  );
  const base = `Digio ${method} ${path} failed with HTTP ${status}`;
  const message = redact(providerMessage ? `${base}: ${providerMessage}` : base, secrets);
  const extra = { status, providerCode, providerReference, details };

  if (providerCode === '1128') return new DigioError('duplicate_request', message, extra);
  if (providerCode === '1015' || providerCode === '1073') {
    return new DigioError('insufficient_credits', message, extra);
  }
  if (status === 401) return new DigioError('auth', message, extra);
  if (status === 403) return new DigioError('forbidden', message, extra);
  if (status === 404 || (providerCode && NOT_FOUND_PROVIDER_CODES.has(providerCode))) {
    return new DigioError('not_found', message, extra);
  }
  if (status === 409 || (providerCode && CONFLICT_PROVIDER_CODES.has(providerCode))) {
    return new DigioError('conflict', message, extra);
  }
  if (status === 429) return new DigioError('rate_limited', message, { ...extra, retryable: true });
  if (RETRYABLE_STATUSES.has(status) || status >= 500 || (providerCode && RETRYABLE_PROVIDER_CODES.has(providerCode))) {
    return new DigioError('provider_unavailable', message, { ...extra, retryable: true });
  }
  return new DigioError('bad_request', message, extra);
}
