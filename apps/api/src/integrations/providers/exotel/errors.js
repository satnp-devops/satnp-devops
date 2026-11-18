/**
 * Typed errors for the Exotel client.
 *
 * Every error carries `retryable` (and the derived `kind`: 'retryable' | 'permanent') so the
 * adapter layer can decide between "reschedule the job" and "mark it failed" without parsing
 * messages. Messages are always passed through a redactor, so API keys, tokens and webhook
 * secrets never end up in logs or error trackers.
 */

/**
 * @typedef {object} ExotelErrorOptions
 * @property {string} code machine-readable code, e.g. 'rate_limited'
 * @property {boolean} [retryable]
 * @property {number} [status] HTTP status returned by Exotel, when there was one
 * @property {string} [operation] client operation, e.g. 'connectCall'
 * @property {string|number} [providerCode] Exotel's own error code, when it sent one
 * @property {string} [providerMessage] Exotel's message (already redacted)
 * @property {number} [retryAfterMs] server-suggested wait before retrying
 * @property {boolean} [outcomeUnknown] true when a non-idempotent request may have been executed
 * @property {Record<string, unknown>} [details] extra non-sensitive context
 * @property {unknown} [cause]
 */

export class ExotelError extends Error {
  /**
   * @param {string} message
   * @param {ExotelErrorOptions} options
   */
  constructor(message, options) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ExotelError';
    this.provider = 'exotel';
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    this.status = options.status ?? null;
    this.operation = options.operation ?? null;
    this.providerCode = options.providerCode ?? null;
    this.providerMessage = options.providerMessage ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.outcomeUnknown = options.outcomeUnknown ?? false;
    this.details = options.details ?? null;
  }

  /** @returns {'retryable' | 'permanent'} */
  get kind() {
    return this.retryable ? 'retryable' : 'permanent';
  }

  /** Safe, serialisable view (no cause chain, which might hold request objects). */
  toJSON() {
    return {
      name: this.name,
      provider: this.provider,
      code: this.code,
      kind: this.kind,
      retryable: this.retryable,
      status: this.status,
      operation: this.operation,
      providerCode: this.providerCode,
      providerMessage: this.providerMessage,
      retryAfterMs: this.retryAfterMs,
      outcomeUnknown: this.outcomeUnknown,
      details: this.details,
      message: this.message,
    };
  }
}

/** Invalid client configuration. Permanent. */
export class ExotelConfigError extends ExotelError {
  /** @param {string} message @param {Partial<ExotelErrorOptions>} [options] */
  constructor(message, options = {}) {
    super(message, { code: 'config_invalid', ...options, retryable: false });
    this.name = 'ExotelConfigError';
  }
}

/** The request was rejected before or by Exotel because its input is invalid. Permanent. */
export class ExotelValidationError extends ExotelError {
  /** @param {string} message @param {Partial<ExotelErrorOptions>} [options] */
  constructor(message, options = {}) {
    super(message, { code: 'invalid_request', ...options, retryable: false });
    this.name = 'ExotelValidationError';
  }
}

/** 401/403: bad API key/token, or the key lacks permission. Permanent until credentials change. */
export class ExotelAuthError extends ExotelError {
  /** @param {string} message @param {Partial<ExotelErrorOptions>} [options] */
  constructor(message, options = {}) {
    super(message, { code: 'unauthorized', ...options, retryable: false });
    this.name = 'ExotelAuthError';
  }
}

/** 404. Permanent for API resources; recordings use retryable=true because they appear late. */
export class ExotelNotFoundError extends ExotelError {
  /** @param {string} message @param {Partial<ExotelErrorOptions>} [options] */
  constructor(message, options = {}) {
    super(message, { code: 'not_found', retryable: false, ...options });
    this.name = 'ExotelNotFoundError';
  }
}

/** 429: Exotel documents 200 requests/minute per account. Retryable. */
export class ExotelRateLimitError extends ExotelError {
  /** @param {string} message @param {Partial<ExotelErrorOptions>} [options] */
  constructor(message, options = {}) {
    super(message, { code: 'rate_limited', ...options, retryable: true });
    this.name = 'ExotelRateLimitError';
  }
}

/** Other provider-side failures (5xx retryable, 402/409/unknown 4xx permanent). */
export class ExotelProviderError extends ExotelError {
  /** @param {string} message @param {ExotelErrorOptions} options */
  constructor(message, options) {
    super(message, options);
    this.name = 'ExotelProviderError';
  }
}

/** Network failure, timeout or caller abort. Timeouts and network errors are retryable. */
export class ExotelNetworkError extends ExotelError {
  /** @param {string} message @param {Partial<ExotelErrorOptions>} [options] */
  constructor(message, options = {}) {
    super(message, { code: 'network_error', retryable: true, ...options });
    this.name = 'ExotelNetworkError';
  }
}

/** A webhook could not be decoded or did not look like an Exotel payload. Permanent. */
export class ExotelWebhookError extends ExotelError {
  /** @param {string} message @param {Partial<ExotelErrorOptions>} [options] */
  constructor(message, options = {}) {
    super(message, { code: 'webhook_invalid', ...options, retryable: false });
    this.name = 'ExotelWebhookError';
  }
}

/**
 * Builds a function that removes secrets from any string. Also strips `Basic <base64>` and
 * `user:pass@` URL credentials, in case a provider message or URL echoes them back.
 * @param {Array<string | undefined | null>} secrets
 * @returns {(text: unknown) => string}
 */
export function createRedactor(secrets) {
  const values = [...new Set(secrets.filter((s) => typeof s === 'string' && s.length >= 4))].sort(
    (a, b) => b.length - a.length,
  );
  return (text) => {
    let out = String(text ?? '');
    for (const value of values) out = out.split(value).join('[REDACTED]');
    out = out.replace(/Basic\s+[A-Za-z0-9+/=]{8,}/g, 'Basic [REDACTED]');
    out = out.replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[REDACTED]@');
    return out;
  };
}

/**
 * Pulls Exotel's error message/code out of a response body. v1 APIs answer with
 * `{"RestException": {"Status": 400, "Message": "..."}}`; CCM (v2) APIs with
 * `{"http_code": 409, "code": 1012, "error_data": {"description": "..."}}`. XML is a fallback.
 * @param {string} text
 * @returns {{ providerMessage: string | null, providerCode: string | number | null }}
 */
export function parseProviderError(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return { providerMessage: null, providerCode: null };
  try {
    const json = JSON.parse(trimmed);
    const rest = json?.RestException;
    if (rest && typeof rest === 'object') {
      return {
        providerMessage: truncate(rest.Message ?? rest.message ?? null),
        providerCode: rest.Code ?? rest.code ?? null,
      };
    }
    const data = json?.error_data;
    if (data && typeof data === 'object') {
      return {
        providerMessage: truncate(data.description ?? data.message ?? null),
        providerCode: data.code ?? json.code ?? null,
      };
    }
    return { providerMessage: truncate(json?.message ?? json?.Message ?? null), providerCode: json?.code ?? null };
  } catch {
    const xml = /<Message>([\s\S]*?)<\/Message>/i.exec(trimmed);
    return { providerMessage: truncate(xml ? xml[1] : null), providerCode: null };
  }
}

/** @param {unknown} value */
function truncate(value) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}

/**
 * Parses a Retry-After header (delta-seconds or HTTP date) into milliseconds.
 * @param {string | null} header
 * @param {number} nowMs
 * @returns {number | null}
 */
export function parseRetryAfter(header, nowMs) {
  if (!header) return null;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - nowMs);
}

/**
 * Maps an HTTP error response to a typed error.
 * @param {{ status: number, text: string, retryAfter: string | null, operation: string, redact: (t: unknown) => string, nowMs: number, idempotent: boolean }} input
 * @returns {ExotelError}
 */
export function mapHttpError({ status, text, retryAfter, operation, redact, nowMs, idempotent }) {
  const parsed = parseProviderError(text);
  const providerMessage = parsed.providerMessage === null ? null : redact(parsed.providerMessage);
  const base = {
    status,
    operation,
    providerCode: parsed.providerCode,
    providerMessage,
  };
  const message = `Exotel ${operation} failed with HTTP ${status}${providerMessage ? `: ${providerMessage}` : ''}`;
  if (status === 400 || status === 422) return new ExotelValidationError(message, base);
  if (status === 401) return new ExotelAuthError(message, { ...base, code: 'unauthorized' });
  if (status === 403) return new ExotelAuthError(message, { ...base, code: 'forbidden' });
  if (status === 404) return new ExotelNotFoundError(message, base);
  if (status === 429) {
    return new ExotelRateLimitError(message, { ...base, retryAfterMs: parseRetryAfter(retryAfter, nowMs) });
  }
  if (status === 402) return new ExotelProviderError(message, { ...base, code: 'payment_required', retryable: false });
  if (status === 409) return new ExotelProviderError(message, { ...base, code: 'conflict', retryable: false });
  if (status === 408) {
    return new ExotelProviderError(message, { ...base, code: 'timeout', retryable: true, outcomeUnknown: !idempotent });
  }
  if (status >= 500) {
    return new ExotelProviderError(message, {
      ...base,
      code: 'provider_unavailable',
      retryable: true,
      outcomeUnknown: !idempotent,
      retryAfterMs: parseRetryAfter(retryAfter, nowMs),
    });
  }
  return new ExotelProviderError(message, { ...base, code: 'provider_error', retryable: false });
}
