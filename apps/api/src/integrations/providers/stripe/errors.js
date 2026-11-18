/**
 * Typed errors for the Stripe client.
 *
 * Every error the client throws is a StripeError with:
 *   - category: stable, provider-neutral reason (see ERROR_CATEGORIES)
 *   - retryable: true when repeating the same call (same idempotency key) may succeed
 * Messages never contain API keys or webhook secrets: everything passes through redact().
 */

/** @typedef {'config'|'authentication'|'permission'|'card'|'invalid_request'|'not_found'|'idempotency'|'conflict'|'rate_limit'|'api'|'external_dependency'|'connection'|'timeout'|'aborted'|'invalid_response'|'signature'|'invalid_event'} StripeErrorCategory */

export const ERROR_CATEGORIES = Object.freeze([
  'config',
  'authentication',
  'permission',
  'card',
  'invalid_request',
  'not_found',
  'idempotency',
  'conflict',
  'rate_limit',
  'api',
  'external_dependency',
  'connection',
  'timeout',
  'aborted',
  'invalid_response',
  'signature',
  'invalid_event',
]);

const KEY_PATTERN = /\b(sk|rk|pk)_(test|live)_[A-Za-z0-9]+/g;
const WHSEC_PATTERN = /\bwhsec_[A-Za-z0-9_]+/g;

/**
 * Removes secrets from text. Known secrets are replaced exactly; anything that merely looks
 * like a Stripe key or signing secret is masked too, so a key echoed back by a proxy never leaks.
 * @param {unknown} text
 * @param {Array<string|undefined|null>} [secrets]
 * @returns {string}
 */
export function redact(text, secrets = []) {
  let out = String(text ?? '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 6) out = out.split(secret).join('[redacted]');
  }
  return out
    .replace(KEY_PATTERN, (_m, kind, mode) => `${kind}_${mode}_[redacted]`)
    .replace(WHSEC_PATTERN, 'whsec_[redacted]');
}

export class StripeError extends Error {
  /**
   * @param {string} message
   * @param {{
   *   category: StripeErrorCategory, retryable?: boolean, status?: number, type?: string,
   *   code?: string, declineCode?: string, param?: string, requestId?: string,
   *   retryAfterMs?: number, docUrl?: string, details?: unknown, cause?: unknown,
   * }} info
   */
  constructor(message, info) {
    super(message, info.cause === undefined ? undefined : { cause: info.cause });
    this.name = 'StripeError';
    this.provider = 'stripe';
    this.category = info.category;
    this.retryable = Boolean(info.retryable);
    this.status = info.status;
    this.type = info.type;
    this.code = info.code;
    this.declineCode = info.declineCode;
    this.param = info.param;
    this.requestId = info.requestId;
    this.retryAfterMs = info.retryAfterMs;
    this.docUrl = info.docUrl;
    this.details = info.details;
  }

  /** Safe for logs and API responses: no stack, no secrets, no request body. */
  toJSON() {
    return {
      name: this.name,
      provider: this.provider,
      category: this.category,
      retryable: this.retryable,
      message: this.message,
      status: this.status,
      type: this.type,
      code: this.code,
      declineCode: this.declineCode,
      param: this.param,
      requestId: this.requestId,
    };
  }
}

/** Invalid client configuration or invalid input to a client method (nothing was sent). */
export class StripeConfigError extends StripeError {
  /** @param {string} message @param {unknown} [details] */
  constructor(message, details) {
    super(message, { category: 'config', retryable: false, details });
    this.name = 'StripeConfigError';
  }
}

/** Stripe answered with a non-2xx status. */
export class StripeRequestError extends StripeError {
  /** @param {string} message @param {ConstructorParameters<typeof StripeError>[1]} info */
  constructor(message, info) {
    super(message, info);
    this.name = 'StripeRequestError';
  }
}

/** The request never produced a usable response (DNS, TLS, reset, timeout, abort). */
export class StripeConnectionError extends StripeError {
  /** @param {string} message @param {ConstructorParameters<typeof StripeError>[1]} info */
  constructor(message, info) {
    super(message, info);
    this.name = 'StripeConnectionError';
  }
}

/** A webhook failed verification. Respond 400 and do not process it. */
export class StripeSignatureError extends StripeError {
  /** @param {string} message @param {string} code */
  constructor(message, code) {
    super(message, { category: 'signature', retryable: false, code });
    this.name = 'StripeSignatureError';
  }
}

/** A webhook body that verified but isn't a Stripe event we can read. */
export class StripeEventError extends StripeError {
  /** @param {string} message @param {string} code */
  constructor(message, code) {
    super(message, { category: 'invalid_event', retryable: false, code });
    this.name = 'StripeEventError';
  }
}

/**
 * Maps an HTTP status and Stripe error body to a category.
 * @param {number} status
 * @param {string|undefined} type Stripe error type
 * @returns {StripeErrorCategory}
 */
export function categorize(status, type) {
  if (type === 'card_error' || status === 402) return 'card';
  if (type === 'idempotency_error') return 'idempotency';
  if (status === 401) return 'authentication';
  if (status === 403) return 'permission';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 424) return 'external_dependency';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'api';
  return 'invalid_request';
}

/**
 * Stripe's guidance: honour Stripe-Should-Retry when present; otherwise 409 (concurrent use
 * of a key), 429 (rate limit or lock_timeout) and 5xx can be retried with the same key.
 * @param {number} status
 * @param {string|null} shouldRetryHeader
 */
export function isRetryableStatus(status, shouldRetryHeader) {
  if (shouldRetryHeader === 'true') return true;
  if (shouldRetryHeader === 'false') return false;
  return status === 409 || status === 429 || status >= 500;
}

/**
 * Parses Retry-After (seconds or HTTP date) into milliseconds.
 * @param {string|null} value
 * @param {number} nowMs
 * @returns {number|undefined}
 */
export function parseRetryAfter(value, nowMs) {
  if (!value) return undefined;
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - nowMs);
}

/**
 * Builds the error for a non-2xx Stripe response.
 * @param {{ status: number, body: any, headers: Headers, secrets: string[], nowMs: number }} input
 */
export function errorFromResponse({ status, body, headers, secrets, nowMs }) {
  const e = body && typeof body === 'object' && body.error && typeof body.error === 'object' ? body.error : {};
  const type = typeof e.type === 'string' ? e.type : undefined;
  const category = categorize(status, type);
  const rateReason = headers.get('stripe-rate-limited-reason') ?? undefined;
  const detail = typeof e.message === 'string' && e.message ? e.message : `HTTP ${status}`;
  return new StripeRequestError(redact(`Stripe ${category} error: ${detail}`, secrets), {
    category,
    retryable: isRetryableStatus(status, headers.get('stripe-should-retry')),
    status,
    type,
    code: typeof e.code === 'string' ? e.code : rateReason,
    declineCode: typeof e.decline_code === 'string' ? e.decline_code : undefined,
    param: typeof e.param === 'string' ? e.param : undefined,
    docUrl: typeof e.doc_url === 'string' ? e.doc_url : undefined,
    requestId: headers.get('request-id') ?? undefined,
    retryAfterMs: parseRetryAfter(headers.get('retry-after'), nowMs),
    details: rateReason ? { rateLimitedReason: rateReason } : undefined,
  });
}
