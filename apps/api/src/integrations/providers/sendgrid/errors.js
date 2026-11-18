/**
 * Typed errors for the SendGrid client.
 *
 * Every failure the client raises is a SendgridError with a stable `code` and two flags the
 * adapter layer acts on:
 * - `retryable`: trying again later may succeed (rate limits, provider outages, network).
 * - `outcomeUnknown`: the request may already have been acted on by SendGrid (for example a
 *   timeout or 5xx on mail send). SendGrid's mail send has no idempotency key, so a blind
 *   retry can deliver the email twice. Callers decide using their own outbox state.
 *
 * Messages never contain the API key: `redactSecrets` scrubs known secrets and anything that
 * looks like a SendGrid key before an error is built.
 */

/** @typedef {'config'|'validation'|'auth'|'forbidden'|'not_found'|'payload_too_large'|'rate_limited'|'provider_error'|'timeout'|'network'|'invalid_payload'|'signature'} SendgridErrorCode */

/** Codes that are worth retrying later (whether it is safe to do so is a separate question). */
const RETRYABLE_CODES = new Set(['rate_limited', 'provider_error', 'timeout', 'network']);

export class SendgridError extends Error {
  /**
   * @param {SendgridErrorCode} code
   * @param {string} message safe to log; never contains secrets
   * @param {{ status?: number, retryable?: boolean, outcomeUnknown?: boolean, retryAfterMs?: number|null,
   *   providerErrors?: Array<{ message: string, field: string|null, help: unknown }>, requestId?: string|null,
   *   issues?: Array<{ path: string, message: string }>,
   *   cause?: unknown }} [details]
   */
  constructor(code, message, details = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'SendgridError';
    this.provider = 'sendgrid';
    this.code = code;
    this.status = details.status ?? null;
    this.retryable = details.retryable ?? RETRYABLE_CODES.has(code);
    this.outcomeUnknown = details.outcomeUnknown ?? false;
    this.retryAfterMs = details.retryAfterMs ?? null;
    this.providerErrors = details.providerErrors ?? [];
    this.requestId = details.requestId ?? null;
    /** Local validation problems (code 'validation' raised before any request was sent). */
    this.issues = details.issues ?? [];
  }

  /** True when the error is final and the caller should not retry. */
  get permanent() {
    return !this.retryable;
  }

  toJSON() {
    return {
      name: this.name,
      provider: this.provider,
      code: this.code,
      message: this.message,
      status: this.status,
      retryable: this.retryable,
      outcomeUnknown: this.outcomeUnknown,
      retryAfterMs: this.retryAfterMs,
      providerErrors: this.providerErrors,
      requestId: this.requestId,
      issues: this.issues,
    };
  }
}

/** SendGrid API keys look like `SG.<id>.<secret>`; scrub that shape even if it is not ours. */
const KEY_PATTERN = /SG\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g;

/**
 * Remove secrets from a string before it is logged or put in an error.
 * @param {unknown} value
 * @param {Array<string|undefined|null>} [secrets]
 * @returns {string}
 */
export function redactSecrets(value, secrets = []) {
  let text = typeof value === 'string' ? value : String(value ?? '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 4) text = text.split(secret).join('[REDACTED]');
  }
  return text.replace(KEY_PATTERN, '[REDACTED]');
}

/**
 * Map an HTTP status from the v3 API to an error code.
 * @param {number} status
 * @returns {SendgridErrorCode}
 */
export function codeForStatus(status) {
  if (status === 400 || status === 422) return 'validation';
  if (status === 401) return 'auth';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 413) return 'payload_too_large';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'provider_error';
  return 'validation';
}

/**
 * Normalise the `{ errors: [{ message, field, help }] }` body SendGrid returns on failure.
 * @param {unknown} body
 * @param {string[]} secrets
 */
export function providerErrorsFrom(body, secrets = []) {
  const list = body && typeof body === 'object' && Array.isArray(/** @type {any} */ (body).errors) ? /** @type {any} */ (body).errors : [];
  return list.slice(0, 20).map((/** @type {any} */ e) => ({
    message: redactSecrets(e?.message ?? 'unknown error', secrets).slice(0, 500),
    field: e?.field == null || e.field === 'null' ? null : String(e.field),
    help: e?.help ?? null,
  }));
}
