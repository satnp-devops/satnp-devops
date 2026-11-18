/**
 * Typed errors for the Razorpay client.
 *
 * Every failure is a RazorpayError with a stable `kind`. Wrappers decide what to do from
 * `kind` and `retryable` only, never from the message text.
 *
 * - `retryable: true` means the same call can be sent again safely (now or later).
 * - `outcomeUnknown: true` means the request may have reached Razorpay and been applied
 *   (a timeout or 5xx on a call Razorpay cannot de-duplicate). Do not blindly retry: look
 *   the object up first (for example by `receipt` or `reference_id`).
 *
 * Messages never contain secrets: they pass through `redact()` with the configured secrets.
 */

/** @typedef {'config'|'validation'|'auth'|'forbidden'|'not_found'|'bad_request'|'conflict'|'rate_limited'|'server'|'network'|'timeout'|'aborted'|'invalid_response'|'signature'|'invalid_payload'|'unexpected'} RazorpayErrorKind */

/** Kinds that are always safe to retry (the provider rejected the request before acting on it). */
const ALWAYS_RETRYABLE = new Set(['rate_limited']);

export class RazorpayError extends Error {
  /**
   * @param {RazorpayErrorKind} kind
   * @param {string} message message without secrets
   * @param {{
   *   status?: number|null, retryable?: boolean, outcomeUnknown?: boolean, op?: string|null,
   *   providerCode?: string|null, description?: string|null, field?: string|null, source?: string|null,
   *   step?: string|null, reason?: string|null, metadata?: Record<string, unknown>|null,
   *   retryAfterMs?: number|null, details?: unknown, cause?: unknown
   * }} [info]
   */
  constructor(kind, message, info = {}) {
    super(message, info.cause === undefined ? undefined : { cause: info.cause });
    this.name = 'RazorpayError';
    this.provider = 'razorpay';
    this.kind = kind;
    this.status = info.status ?? null;
    this.retryable = info.retryable ?? ALWAYS_RETRYABLE.has(kind);
    this.outcomeUnknown = info.outcomeUnknown ?? false;
    this.op = info.op ?? null;
    this.providerCode = info.providerCode ?? null;
    this.description = info.description ?? null;
    this.field = info.field ?? null;
    this.source = info.source ?? null;
    this.step = info.step ?? null;
    this.reason = info.reason ?? null;
    this.metadata = info.metadata ?? null;
    this.retryAfterMs = info.retryAfterMs ?? null;
    this.details = info.details ?? null;
  }

  /** Safe to log: no secrets, no request bodies. */
  toJSON() {
    return {
      name: this.name,
      provider: this.provider,
      kind: this.kind,
      message: this.message,
      status: this.status,
      retryable: this.retryable,
      outcomeUnknown: this.outcomeUnknown,
      op: this.op,
      providerCode: this.providerCode,
      field: this.field,
      source: this.source,
      step: this.step,
      reason: this.reason,
      retryAfterMs: this.retryAfterMs,
      details: this.details,
    };
  }
}

/** @param {unknown} error */
export function isRazorpayError(error) {
  return error instanceof RazorpayError;
}

/** @param {unknown} error */
export function isRetryable(error) {
  return error instanceof RazorpayError && error.retryable;
}

/**
 * Replace every occurrence of the given secrets (and their Basic-auth encodings) in a string.
 * @param {unknown} text
 * @param {Array<string|undefined|null>} secrets
 */
export function redact(text, secrets) {
  let out = String(text ?? '');
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 4) continue;
    out = out.split(secret).join('[REDACTED]');
  }
  return out;
}

/** Description text that Razorpay uses when an id does not exist (it answers 400, not 404). */
const NOT_FOUND_TEXT = /does not exist|not found|no such/i;

/**
 * Map an HTTP error response from Razorpay to a RazorpayError.
 * Razorpay error bodies look like `{ error: { code, description, field, source, step, reason, metadata } }`.
 *
 * @param {{ status: number, body: unknown, op: string, safeToRetry: boolean, retryAfterMs?: number|null, secrets: string[] }} input
 *   `safeToRetry` is true for GETs and for POSTs sent with an idempotency key.
 */
export function mapHttpError({ status, body, op, safeToRetry, retryAfterMs = null, secrets }) {
  const err = body && typeof body === 'object' && 'error' in body && body.error && typeof body.error === 'object'
    ? /** @type {Record<string, any>} */ (body.error)
    : {};
  const clean = (v) => (typeof v === 'string' && v !== 'NA' ? redact(v, secrets) : null);
  const description = clean(err.description);
  const providerCode = clean(err.code);

  /** @type {RazorpayErrorKind} */
  let kind;
  let retryable = false;
  let outcomeUnknown = false;
  if (status === 401) kind = 'auth';
  else if (status === 403) kind = 'forbidden';
  else if (status === 404) kind = 'not_found';
  else if (status === 409) {
    // Documented for idempotent refunds: "a prior request is still being processed".
    kind = 'conflict';
    retryable = safeToRetry;
  } else if (status === 429) {
    kind = 'rate_limited';
    retryable = true;
  } else if (status >= 500) {
    kind = 'server';
    retryable = safeToRetry;
    outcomeUnknown = !safeToRetry;
  } else if (status === 400 && description && NOT_FOUND_TEXT.test(description)) kind = 'not_found';
  else if (status >= 400) kind = 'bad_request';
  else kind = 'unexpected';

  const message = `Razorpay ${op} failed (HTTP ${status}${providerCode ? ` ${providerCode}` : ''})${description ? `: ${description}` : ''}`;
  return new RazorpayError(kind, message, {
    status,
    retryable,
    outcomeUnknown,
    op,
    providerCode,
    description,
    field: clean(err.field),
    source: clean(err.source),
    step: clean(err.step),
    reason: clean(err.reason),
    metadata: err.metadata && typeof err.metadata === 'object' ? err.metadata : null,
    retryAfterMs,
  });
}
