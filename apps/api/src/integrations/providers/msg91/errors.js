/**
 * Typed errors for the MSG91 client.
 *
 * Every error the client throws is an Msg91Error with a stable `code`, a `retryable` flag and a
 * `delivery` hint:
 *   - 'not_sent'  the provider certainly did not accept the message (safe to retry if retryable)
 *   - 'unknown'   the request may have reached MSG91 (timeout, 5xx on a send): retrying can
 *                 produce a duplicate SMS, so callers should reconcile (SMS logs / webhook) first
 *   - 'n/a'       the call was not a send (logs, template lookups, OTP verify)
 *
 * Messages never contain the auth key: `redact()` scrubs every known secret before an error is
 * constructed from provider text.
 */

/** @typedef {'not_sent' | 'unknown' | 'n/a'} DeliveryHint */

export class Msg91Error extends Error {
  /**
   * @param {string} message
   * @param {{ code: string, retryable?: boolean, status?: number | null, providerCode?: string | null,
   *   delivery?: DeliveryHint, retryAfterMs?: number | null, details?: unknown, cause?: unknown }} info
   */
  constructor(message, info) {
    super(message, info.cause === undefined ? undefined : { cause: info.cause });
    this.name = 'Msg91Error';
    this.provider = 'msg91';
    this.code = info.code;
    this.retryable = info.retryable ?? false;
    this.status = info.status ?? null;
    this.providerCode = info.providerCode ?? null;
    this.delivery = info.delivery ?? 'n/a';
    this.retryAfterMs = info.retryAfterMs ?? null;
    this.details = info.details;
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
      delivery: this.delivery,
      retryAfterMs: this.retryAfterMs,
    };
  }
}

/** Invalid client configuration (thrown by createMsg91Client / parseMsg91Config). Never retryable. */
export class Msg91ConfigError extends Msg91Error {
  /** @param {string} message @param {Array<{path: string, message: string}>} issues */
  constructor(message, issues) {
    super(message, { code: 'invalid_config', details: issues });
    this.name = 'Msg91ConfigError';
    this.issues = issues;
  }
}

/**
 * Client-side validation failure (DLT rules, phone numbers, variables, promotional window...).
 * Nothing was sent. Never retryable as-is, except `outside_promotional_window`, which carries
 * `details.nextAllowedAt` so a scheduler can defer the send.
 */
export class Msg91ValidationError extends Msg91Error {
  /** @param {string} message @param {Array<Issue>} issues */
  constructor(message, issues) {
    super(message, { code: 'validation_failed', delivery: 'not_sent', details: issues });
    this.name = 'Msg91ValidationError';
    this.issues = issues;
  }
}

/** @typedef {{ code: string, message: string, path?: string, severity?: 'error' | 'warning', [k: string]: unknown }} Issue */

/**
 * MSG91 API error codes (https://msg91.com/help/api/what-are-the-reason-for-error-codes-received-under-the-api-failed,
 * read 2026-11-05) mapped to a stable code and retryability. Codes that are about the account or
 * the request content are permanent; route/internal failures are retryable later.
 * @type {Record<string, { code: string, retryable: boolean }>}
 */
export const PROVIDER_ERROR_CODES = {
  101: { code: 'invalid_recipient', retryable: false },
  102: { code: 'invalid_request', retryable: false },
  201: { code: 'auth_failed', retryable: false },
  202: { code: 'invalid_recipient', retryable: false },
  203: { code: 'invalid_sender', retryable: false },
  204: { code: 'permission_denied', retryable: false },
  207: { code: 'auth_failed', retryable: false },
  208: { code: 'ip_not_allowed', retryable: false },
  209: { code: 'route_unavailable', retryable: true },
  210: { code: 'route_unavailable', retryable: true },
  211: { code: 'template_invalid', retryable: false },
  301: { code: 'insufficient_balance', retryable: false },
  302: { code: 'account_inactive', retryable: false },
  303: { code: 'account_inactive', retryable: false },
  306: { code: 'route_unavailable', retryable: true },
  307: { code: 'invalid_schedule', retryable: false },
  308: { code: 'invalid_request', retryable: false },
  310: { code: 'message_too_long', retryable: false },
  311: { code: 'duplicate_message', retryable: false },
  400: { code: 'template_invalid', retryable: false },
  401: { code: 'template_not_approved', retryable: false },
  402: { code: 'content_blocked', retryable: false },
  403: { code: 'template_disabled', retryable: false },
  407: { code: 'international_blocked', retryable: false },
  418: { code: 'ip_not_allowed', retryable: false },
  421: { code: 'account_inactive', retryable: false },
  506: { code: 'provider_error', retryable: true },
  601: { code: 'provider_error', retryable: true },
  602: { code: 'route_unavailable', retryable: true },
  603: { code: 'sender_blacklisted', retryable: false },
  604: { code: 'invalid_recipient', retryable: false },
  606: { code: 'invalid_schedule', retryable: false },
  607: { code: 'invalid_request', retryable: false },
  608: { code: 'invalid_schedule', retryable: false },
};

/**
 * Message patterns for provider errors that arrive without a numeric code (HTTP 200, type: error).
 * Order matters: first match wins.
 * @type {Array<[RegExp, { code: string, retryable: boolean }]>}
 */
const MESSAGE_PATTERNS = [
  [/auth\s*key|authkey|unauthori[sz]ed/i, { code: 'auth_failed', retryable: false }],
  [/ip.*(whitelist|blacklist)/i, { code: 'ip_not_allowed', retryable: false }],
  [/(flow|template)\s*id.*(invalid|missing)|invalid.*(flow|template)/i, { code: 'template_invalid', retryable: false }],
  [/not\s*(yet\s*)?approved/i, { code: 'template_not_approved', retryable: false }],
  [/balance/i, { code: 'insufficient_balance', retryable: false }],
  [/number|mobile/i, { code: 'invalid_recipient', retryable: false }],
  [/sender/i, { code: 'invalid_sender', retryable: false }],
  [/dlt|entity/i, { code: 'dlt_rejected', retryable: false }],
  [/schedul/i, { code: 'invalid_schedule', retryable: false }],
  [/date|duration/i, { code: 'invalid_request', retryable: false }],
];

/**
 * Classify a provider error from its numeric code and/or message.
 * @param {{ providerCode?: string | number | null, message?: string, status?: number }} input
 * @returns {{ code: string, retryable: boolean }}
 */
export function classifyProviderError({ providerCode, message = '', status }) {
  const known = providerCode != null ? PROVIDER_ERROR_CODES[String(providerCode)] : undefined;
  if (known) return known;
  if (status === 401 || status === 403) return { code: 'auth_failed', retryable: false };
  if (status === 429) return { code: 'rate_limited', retryable: true };
  if (status != null && status >= 500) return { code: 'provider_unavailable', retryable: true };
  for (const [pattern, result] of MESSAGE_PATTERNS) if (pattern.test(message)) return result;
  return { code: 'provider_rejected', retryable: false };
}

/**
 * Replace every secret occurrence in a string. Secrets shorter than 8 characters are ignored so
 * that redaction cannot mangle ordinary text.
 * @param {string} text
 * @param {Array<string | undefined | null>} secrets
 */
export function redact(text, secrets) {
  let out = String(text ?? '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 8) out = out.split(secret).join('[REDACTED]');
  }
  return out;
}
