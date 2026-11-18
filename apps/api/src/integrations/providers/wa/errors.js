/**
 * Typed errors for the WhatsApp Cloud API client.
 *
 * Every failure the client surfaces is a WaError with a stable `kind`, a `retryable` flag and,
 * when the call may already have reached Meta, `ambiguous: true`. Callers (the outbox, the
 * adapter) decide what to do from those three fields alone; they never parse messages.
 *
 * Error codes come from Meta's error code reference:
 * https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes (read 2026-11-05).
 */

/**
 * @typedef {'auth' | 'permission' | 'rate_limited' | 'transient' | 'network' | 'timeout' | 'aborted'
 *   | 'invalid_request' | 'not_found' | 'window_closed' | 'recipient' | 'template' | 'media'
 *   | 'policy' | 'account' | 'invalid_payload' | 'config' | 'unknown'} WaErrorKind
 */

/**
 * @typedef {object} WaErrorInit
 * @property {WaErrorKind} kind
 * @property {boolean} retryable    true when trying again later can succeed without changing the request
 * @property {boolean} [ambiguous]  true when the request may have been processed (timeout, network error, 5xx on a send)
 * @property {number | null} [code]        Meta error code (`error.code`)
 * @property {number | null} [httpStatus]
 * @property {number | null} [retryAfterMs] suggested wait before retrying
 * @property {string | null} [title]
 * @property {string | null} [details]     Meta `error.error_data.details`
 * @property {string | null} [fbtraceId]   quote this to Meta support
 * @property {unknown} [cause]
 */

export class WaError extends Error {
  /**
   * @param {string} message safe to log: never contains secrets (see redact())
   * @param {WaErrorInit} init
   */
  constructor(message, init) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'WaError';
    this.provider = 'whatsapp';
    this.kind = init.kind;
    this.retryable = init.retryable;
    this.ambiguous = init.ambiguous ?? false;
    this.code = init.code ?? null;
    this.httpStatus = init.httpStatus ?? null;
    this.retryAfterMs = init.retryAfterMs ?? null;
    this.title = init.title ?? null;
    this.details = init.details ?? null;
    this.fbtraceId = init.fbtraceId ?? null;
  }

  toJSON() {
    return {
      name: this.name,
      provider: this.provider,
      kind: this.kind,
      message: this.message,
      retryable: this.retryable,
      ambiguous: this.ambiguous,
      code: this.code,
      httpStatus: this.httpStatus,
      retryAfterMs: this.retryAfterMs,
      title: this.title,
      details: this.details,
      fbtraceId: this.fbtraceId,
    };
  }
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * How each documented Meta error code is handled.
 * `rejected: true` means Meta refused the request before doing anything, so even a
 * non-idempotent send can be retried without risking a duplicate message.
 * @type {Record<number, { kind: WaErrorKind, retryable: boolean, rejected?: boolean, retryAfterMs?: number }>}
 */
export const ERROR_CODES = Object.freeze({
  // Authorization
  0: { kind: 'auth', retryable: false },
  3: { kind: 'permission', retryable: false },
  10: { kind: 'permission', retryable: false },
  190: { kind: 'auth', retryable: false },
  131005: { kind: 'permission', retryable: false },
  // Throttling: Meta rejected the call, nothing was sent.
  4: { kind: 'rate_limited', retryable: true, rejected: true, retryAfterMs: MINUTE },
  80007: { kind: 'rate_limited', retryable: true, rejected: true, retryAfterMs: MINUTE },
  130429: { kind: 'rate_limited', retryable: true, rejected: true, retryAfterMs: 1000 },
  131056: { kind: 'rate_limited', retryable: true, rejected: true, retryAfterMs: 6000 },
  131048: { kind: 'policy', retryable: false },
  131064: { kind: 'policy', retryable: false },
  133016: { kind: 'account', retryable: true, rejected: true, retryAfterMs: HOUR },
  // Temporary platform problems
  2: { kind: 'transient', retryable: true },
  131000: { kind: 'transient', retryable: true },
  131016: { kind: 'transient', retryable: true },
  133004: { kind: 'transient', retryable: true },
  131057: { kind: 'transient', retryable: true, rejected: true, retryAfterMs: MINUTE },
  2494100: { kind: 'transient', retryable: true, rejected: true, retryAfterMs: 5 * MINUTE },
  // Request problems: fix the request, do not retry
  1: { kind: 'invalid_request', retryable: false },
  33: { kind: 'not_found', retryable: false },
  100: { kind: 'invalid_request', retryable: false },
  803: { kind: 'not_found', retryable: false },
  131008: { kind: 'invalid_request', retryable: false },
  131009: { kind: 'invalid_request', retryable: false },
  131021: { kind: 'invalid_request', retryable: false },
  131051: { kind: 'invalid_request', retryable: false },
  135000: { kind: 'invalid_request', retryable: false },
  // Customer service window closed: send a template instead
  131047: { kind: 'window_closed', retryable: false },
  // Recipient-side outcomes
  130403: { kind: 'recipient', retryable: false },
  130472: { kind: 'recipient', retryable: false },
  131026: { kind: 'recipient', retryable: false },
  131049: { kind: 'recipient', retryable: true, retryAfterMs: 24 * HOUR },
  131050: { kind: 'recipient', retryable: false },
  // Templates
  132000: { kind: 'template', retryable: false },
  132001: { kind: 'template', retryable: false },
  132005: { kind: 'template', retryable: false },
  132007: { kind: 'template', retryable: false },
  132012: { kind: 'template', retryable: false },
  132015: { kind: 'template', retryable: false },
  132016: { kind: 'template', retryable: false },
  132018: { kind: 'template', retryable: false },
  132068: { kind: 'template', retryable: false },
  132069: { kind: 'template', retryable: true, rejected: true, retryAfterMs: HOUR },
  2388019: { kind: 'template', retryable: false },
  2388039: { kind: 'template', retryable: false },
  2388040: { kind: 'template', retryable: false },
  2388047: { kind: 'template', retryable: false },
  2388072: { kind: 'template', retryable: false },
  2388073: { kind: 'template', retryable: false },
  2388293: { kind: 'template', retryable: false },
  2388299: { kind: 'template', retryable: false },
  // Media
  131052: { kind: 'media', retryable: false },
  131053: { kind: 'media', retryable: false },
  // Account, number and policy state
  368: { kind: 'policy', retryable: false },
  130497: { kind: 'policy', retryable: false },
  131031: { kind: 'policy', retryable: false },
  131063: { kind: 'policy', retryable: false },
  131037: { kind: 'account', retryable: false },
  131042: { kind: 'account', retryable: false },
  131045: { kind: 'account', retryable: false },
  133010: { kind: 'account', retryable: false },
  133015: { kind: 'account', retryable: true, rejected: true, retryAfterMs: 5 * MINUTE },
});

/**
 * Classify a Meta error code (plus HTTP status and `is_transient`) into kind/retryable.
 * Unknown codes fall back to the HTTP status: 429 and 5xx are retryable, 4xx are not.
 * `is_transient: true` from Meta makes any error retryable.
 * @param {{ code?: number | null, httpStatus?: number | null, isTransient?: boolean }} input
 * @returns {{ kind: WaErrorKind, retryable: boolean, rejected: boolean, retryAfterMs: number | null }}
 */
export function classifyError({ code, httpStatus, isTransient }) {
  const known = code === null || code === undefined ? undefined : ERROR_CODES[code];
  if (known && isTransient && !known.retryable) {
    // Meta flagged this occurrence as transient (`is_transient: true`): trust it over the table.
    return { kind: 'transient', retryable: true, rejected: false, retryAfterMs: null };
  }
  if (known) {
    return { kind: known.kind, retryable: known.retryable, rejected: known.rejected ?? false, retryAfterMs: known.retryAfterMs ?? null };
  }
  if (typeof code === 'number' && code >= 200 && code <= 299) {
    return { kind: 'permission', retryable: false, rejected: false, retryAfterMs: null };
  }
  if (httpStatus === 429) return { kind: 'rate_limited', retryable: true, rejected: true, retryAfterMs: 1000 };
  if (isTransient || (httpStatus !== null && httpStatus !== undefined && httpStatus >= 500)) {
    return { kind: 'transient', retryable: true, rejected: false, retryAfterMs: null };
  }
  if (httpStatus === 401) return { kind: 'auth', retryable: false, rejected: false, retryAfterMs: null };
  if (httpStatus === 403) return { kind: 'permission', retryable: false, rejected: false, retryAfterMs: null };
  if (httpStatus === 404) return { kind: 'not_found', retryable: false, rejected: false, retryAfterMs: null };
  if (httpStatus !== null && httpStatus !== undefined && httpStatus >= 400) {
    return { kind: 'invalid_request', retryable: false, rejected: false, retryAfterMs: null };
  }
  return { kind: 'unknown', retryable: false, rejected: false, retryAfterMs: null };
}

/**
 * Replace every occurrence of the given secrets in a string.
 * @param {unknown} value
 * @param {ReadonlyArray<string | undefined | null>} secrets
 * @returns {string}
 */
export function redact(value, secrets) {
  let text = typeof value === 'string' ? value : String(value ?? '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 4) text = text.split(secret).join('[REDACTED]');
  }
  // Graph tokens start with EAA; scrub anything token-shaped that slipped into provider text.
  return text.replace(/\bEAA[A-Za-z0-9]{20,}\b/g, '[REDACTED]');
}

/**
 * Build a WaError from a Graph API error body (`{ error: { message, type, code, error_data, fbtrace_id, is_transient } }`).
 * @param {unknown} body parsed JSON (or null when the body was not JSON)
 * @param {number} httpStatus
 * @param {ReadonlyArray<string | undefined | null>} secrets values to scrub from provider text
 * @returns {WaError & { rejected: boolean }}
 */
export function fromGraphError(body, httpStatus, secrets) {
  const err = /** @type {Record<string, any>} */ (body && typeof body === 'object' && 'error' in body ? body.error ?? {} : {});
  const code = Number.isInteger(err.code) ? err.code : null;
  const { kind, retryable, rejected, retryAfterMs } = classifyError({ code, httpStatus, isTransient: err.is_transient === true });
  const providerMessage = typeof err.message === 'string' ? err.message : `HTTP ${httpStatus}`;
  const details = typeof err.error_data?.details === 'string' ? redact(err.error_data.details, secrets) : null;
  const error = new WaError(`WhatsApp API error${code === null ? '' : ` ${code}`}: ${redact(providerMessage, secrets)}`, {
    kind,
    retryable,
    code,
    httpStatus,
    retryAfterMs,
    title: typeof err.error_user_title === 'string' ? redact(err.error_user_title, secrets) : null,
    details,
    fbtraceId: typeof err.fbtrace_id === 'string' ? err.fbtrace_id : null,
  });
  return Object.assign(error, { rejected });
}

/**
 * Classify an error object from a webhook (`statuses[].errors[]`, `messages[].errors[]`, `value.errors[]`).
 * @param {unknown} raw
 */
export function normalizeWebhookError(raw) {
  const e = /** @type {Record<string, any>} */ (raw && typeof raw === 'object' ? raw : {});
  const code = Number.isInteger(e.code) ? e.code : null;
  const { kind, retryable, retryAfterMs } = classifyError({ code, httpStatus: null });
  return {
    code,
    title: typeof e.title === 'string' ? e.title : null,
    message: typeof e.message === 'string' ? e.message : null,
    details: typeof e.error_data?.details === 'string' ? e.error_data.details : null,
    kind,
    retryable,
    retryAfterMs,
  };
}
