import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { IST_OFFSET_MINUTES } from './dlt.js';
import { Msg91Error } from './errors.js';

/**
 * MSG91 delivery-report webhooks: authentication and parsing. Pure functions.
 *
 * Authentication. MSG91 does not sign webhooks (no HMAC, no timestamp header) — checked against
 * msg91.com/help/webhook-new and its SMS/OTP sub-pages on 2026-11-05. What "Webhook (New)" does
 * offer is custom request headers, so the scheme is a shared secret:
 *   1. generate a random secret (≥ 16 chars; e.g. deriveWebhookToken(masterKey, connectionId)),
 *   2. add it in MSG91 → Webhook (New) → Headers as `x-phoenix-webhook-token: <secret>`,
 *   3. verifyWebhook() compares the header with the secret in constant time.
 * Legacy webhooks (v2/v3/v4) cannot send headers; for those the secret may be put in the callback
 * URL query (`?token=<secret>`), which is weaker (URLs end up in access logs).
 * There is no provider timestamp to enforce a tolerance on, and MSG91 retries a webhook up to 4
 * times when the endpoint does not answer within 8 s — so replay/duplicate protection is done by
 * deduplicating on the deterministic `eventId` that parseWebhook() returns.
 */

/** Largest webhook body accepted (one event per recipient, so real payloads are ~1 KB). */
export const MAX_WEBHOOK_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------------------------

/**
 * Derive a per-connection webhook secret from a master key, so one stored key yields a distinct
 * header value per MSG91 account: base64url(HMAC-SHA256(masterKey, "msg91-webhook:v1:" + scope)).
 * @param {string | Buffer} masterKey
 * @param {string} scope e.g. the integration connection id
 */
export function deriveWebhookToken(masterKey, scope) {
  if (!masterKey || String(masterKey).length < 16) throw new TypeError('masterKey must be at least 16 characters');
  if (!scope) throw new TypeError('scope is required');
  return createHmac('sha256', masterKey).update(`msg91-webhook:v1:${scope}`).digest('base64url');
}

/**
 * Constant-time string equality (hashing first, so length differences do not leak either).
 * @param {string} a @param {string} b
 */
export function safeEqual(a, b) {
  const ha = createHash('sha256').update(String(a), 'utf8').digest();
  const hb = createHash('sha256').update(String(b), 'utf8').digest();
  return timingSafeEqual(ha, hb) && String(a).length === String(b).length;
}

/**
 * Read a header from a plain object (any case) or a Fetch Headers instance.
 * @param {Headers | Record<string, string | string[] | undefined> | undefined} headers @param {string} name
 * @returns {string | string[] | undefined}
 */
function getHeader(headers, name) {
  if (!headers) return undefined;
  if (typeof (/** @type {any} */ (headers).get) === 'function') return /** @type {Headers} */ (headers).get(name) ?? undefined;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === lower) return value;
  return undefined;
}

/**
 * Authenticate an incoming MSG91 webhook.
 *
 * @param {string | Buffer | Uint8Array} rawBody the exact bytes received (must be non-empty)
 * @param {Headers | Record<string, string | string[] | undefined>} headers
 * @param {string | string[]} secret the configured secret; pass [current, previous] while rotating
 * @param {{ headerName?: string, url?: string, queryParam?: string, allowQueryToken?: boolean }} [options]
 *   `url` is the request URL (path + query) — only consulted when `allowQueryToken` is true.
 * @returns {{ ok: true, method: 'header' | 'query' } | { ok: false, reason: 'secret_not_configured' | 'invalid_body' | 'body_too_large' | 'missing_token' | 'ambiguous_token' | 'mismatch' }}
 */
export function verifyWebhook(rawBody, headers, secret, options = {}) {
  const secrets = (Array.isArray(secret) ? secret : [secret]).filter((s) => typeof s === 'string' && s.length >= 16);
  if (secrets.length === 0) return { ok: false, reason: 'secret_not_configured' };
  const size = typeof rawBody === 'string' ? Buffer.byteLength(rawBody) : rawBody?.byteLength;
  if (!size) return { ok: false, reason: 'invalid_body' };
  if (size > MAX_WEBHOOK_BYTES) return { ok: false, reason: 'body_too_large' };

  const found = findToken(headers, options);
  if (found.error) return { ok: false, reason: found.error };
  // Compare against every candidate so timing does not reveal which one matched.
  let matched = false;
  for (const candidate of secrets) matched = safeEqual(found.token, candidate) || matched;
  return matched ? { ok: true, method: found.method } : { ok: false, reason: 'mismatch' };
}

/**
 * @param {Headers | Record<string, string | string[] | undefined>} headers
 * @param {{ headerName?: string, url?: string, queryParam?: string, allowQueryToken?: boolean }} options
 * @returns {{ token: string, method: 'header' | 'query', error?: undefined } | { error: 'missing_token' | 'ambiguous_token' }}
 */
function findToken(headers, options) {
  const value = getHeader(headers, options.headerName ?? 'x-phoenix-webhook-token');
  if (Array.isArray(value)) return { error: 'ambiguous_token' };
  if (typeof value === 'string' && value !== '') return { token: value.trim(), method: 'header' };
  if (options.allowQueryToken && options.url) {
    const params = new URL(options.url, 'http://localhost').searchParams.getAll(options.queryParam ?? 'token');
    if (params.length > 1) return { error: 'ambiguous_token' };
    if (params.length === 1 && params[0] !== '') return { token: params[0], method: 'query' };
  }
  return { error: 'missing_token' };
}

// ---------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------

/**
 * MSG91 numeric delivery status → normalised status. Source: msg91.com/help/webhook-new/
 * how-to-receive-sms-delivery-reports-via-webhook-new and .../webhooks/how-can-i-get-the-delivery-
 * reports-on-my-webhook-url (read 2026-11-05).
 * @type {Record<string, { status: string, final: boolean, reason?: string }>}
 */
export const DELIVERY_STATUS_CODES = {
  0: { status: 'sent', final: false },
  1: { status: 'delivered', final: true },
  2: { status: 'failed', final: true },
  9: { status: 'rejected', final: true, reason: 'ndnc' },
  16: { status: 'rejected', final: true },
  17: { status: 'blocked', final: true, reason: 'blocked_number' },
  20: { status: 'blocked', final: true, reason: 'country_blocked' },
  25: { status: 'rejected', final: true },
};

const TYPE_BY_STATUS = {
  sent: 'message.sent',
  delivered: 'message.delivered',
  failed: 'message.failed',
  rejected: 'message.rejected',
  blocked: 'message.blocked',
  clicked: 'message.clicked',
  requested: 'message.requested',
  api_failed: 'message.api_failed',
  template: 'template.status_changed',
  unknown: 'message.unknown',
};

/** Failure-reason text (MSG91 "Reasons behind a failed SMS") → category; first match wins. */
const FAILURE_CATEGORIES = [
  [/preference|dnd|ndnc/i, 'dnd', true],
  [/dlt|template|cta|header|entity|consent|scrub|whitelist/i, 'dlt', true],
  [/blacklist|spam|flooding|duplicate|multiple submissions/i, 'spam_or_duplicate', true],
  [/invalid number|unknown subscriber|teleservice not supported|not recogni[sz]ed/i, 'invalid_number', true],
  [/blackout/i, 'blackout_time', false],
  [/absent|busy|memory|call barred|roaming|validity expired|service not supported|not reachable/i, 'subscriber_unavailable', false],
  [/network|congestion|timeout|time out|resource|protocol|not submitted|multipart/i, 'network', false],
];

/**
 * @typedef {{
 *   provider: 'msg91', eventId: string, type: string, status: string, final: boolean,
 *   providerStatusCode: string | null, providerStatus: string | null, format: string,
 *   requestId: string | null, providerMessageId: string | null, to: string | null,
 *   reference: string | null, uuid: string | null, clientId: string | null,
 *   senderId: string | null, dltTemplateId: string | null, templateId: string | null,
 *   route: 'transactional' | 'promotional' | null,
 *   occurredAt: string | null, requestedAt: string | null,
 *   failure: { reason: string | null, category: string, permanent: boolean } | null,
 *   segments: number | null,
 *   cost: { amountMinor: number, currency: string, exact: boolean } | null,
 *   raw: Record<string, unknown>
 * }} Msg91WebhookEvent
 */

/**
 * Parse any MSG91 SMS/OTP webhook body into normalised events (one per recipient report).
 * Accepts the raw body (string / Buffer, JSON or x-www-form-urlencoded) or an already-parsed
 * object. Handles Webhook (New) SMS and SendOTP payloads and legacy v2 (form `data=` JSON string
 * with `report[]`), v3 (flat JSON) and v4 (CleverTap style) payloads.
 *
 * `eventId` is deterministic (MSG91 sends no event id): msg91:<requestId>:<mobile>:<status>
 * (plus the click time for click events), or a SHA-256 of the payload when no request id exists.
 * Times are returned as UTC ISO strings; MSG91 times without an offset are read as IST.
 *
 * @param {unknown} body
 * @param {{ currency?: string, naiveOffsetMinutes?: number }} [options]
 * @returns {Msg91WebhookEvent[]}
 */
export function parseWebhook(body, options = {}) {
  const ctx = { currency: options.currency ?? 'INR', naiveOffsetMinutes: options.naiveOffsetMinutes ?? IST_OFFSET_MINUTES };
  const decoded = decodeBody(body);
  const items = Array.isArray(decoded) ? decoded : [decoded];
  return items.flatMap((item) => parseItem(item, ctx));
}

/** @param {unknown} body */
function decodeBody(body) {
  if (body instanceof Uint8Array) return decodeBody(Buffer.from(body).toString('utf8'));
  if (typeof body === 'string') {
    const text = body.trim();
    if (text.startsWith('{') || text.startsWith('[')) return parseJsonOrThrow(text);
    const form = new URLSearchParams(text);
    if (form.has('data')) return parseJsonOrThrow(form.get('data') ?? '');
    throw invalidPayload('body is neither JSON nor a form with a data field');
  }
  if (body && typeof body === 'object') {
    const obj = /** @type {Record<string, unknown>} */ (body);
    if (typeof obj.data === 'string' && Object.keys(obj).length === 1) return parseJsonOrThrow(obj.data);
    return obj;
  }
  throw invalidPayload('unsupported webhook body');
}

/** @param {string} text */
function parseJsonOrThrow(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw invalidPayload('webhook body is not valid JSON');
  }
}

/** @param {string} message */
const invalidPayload = (message) => new Msg91Error(message, { code: 'invalid_webhook_payload' });

/** @param {any} item @param {{ currency: string, naiveOffsetMinutes: number }} ctx @returns {Msg91WebhookEvent[]} */
function parseItem(item, ctx) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw invalidPayload('webhook item is not an object');
  if (Array.isArray(item.report)) {
    const { report, ...parent } = item;
    return report.map((r) => normalise({ ...parent, ...r }, 'v2', ctx));
  }
  if (Array.isArray(item.data) && item.event !== undefined) {
    return item.data.map((d) => normalise({ ...d, event: item.event }, 'v4', ctx));
  }
  return [normalise(item, detectFlatFormat(item), ctx)];
}

/** @param {Record<string, unknown>} item */
function detectFlatFormat(item) {
  if ('flowID' in item || 'otpRetry' in item || 'verified' in item) return 'otp';
  if ('telNum' in item || 'eventName' in item || 'upperCaseEventName' in item) return 'webhook_new';
  return 'v3';
}

/** '' and '0' are MSG91's "not set" for custom fields. @param {unknown} v */
const present = (v) => (v === undefined || v === null || v === '' || v === '0' || v === 0 ? null : String(v));

/**
 * @param {Record<string, any>} r @param {string} format
 * @param {{ currency: string, naiveOffsetMinutes: number }} ctx
 * @returns {Msg91WebhookEvent}
 */
function normalise(r, format, ctx) {
  const statusCode = r.status === undefined || r.status === null || r.status === '' ? null : String(r.status);
  const providerStatus = String(r.desc ?? r.description ?? r.upperCaseEventName ?? r.eventName ?? r.event ?? '').trim() || null;
  const kind = classifyEvent(statusCode, String(r.eventName ?? r.event ?? ''), providerStatus);
  const to = present(r.telNum ?? r.number ?? r.mobile);
  const requestId = present(r.requestId);
  const occurredAt = toUtcIso(r.deliveryTime ?? r.date ?? r.ts, ctx.naiveOffsetMinutes);
  const failureReason = present(r.failureReason ?? r.failedReason);
  const money = r.amount ?? (r.smsLength !== undefined ? r.credit : undefined);
  const segments = toInt(r.smsLength ?? (r.amount !== undefined ? r.credit : undefined));
  return {
    provider: 'msg91',
    eventId: eventIdFor(r, { requestId, to, statusCode, kind, occurredAt }),
    type: TYPE_BY_STATUS[kind.status] ?? TYPE_BY_STATUS.unknown,
    status: kind.status,
    final: kind.final,
    providerStatusCode: statusCode,
    providerStatus,
    format,
    requestId,
    providerMessageId: requestId && to ? `${requestId}:${to}` : null,
    to,
    reference: present(r.CRQID),
    uuid: present(r.UUID),
    clientId: present(r.clientId ?? r.clientid),
    senderId: present(r.senderId),
    dltTemplateId: present(r.DLT_TE_ID),
    templateId: present(r.flowID ?? r.template_id),
    route: r.route === '4' || r.route === 4 ? 'transactional' : r.route === '1' || r.route === 1 ? 'promotional' : null,
    occurredAt,
    requestedAt: toUtcIso(r.requestedAt, ctx.naiveOffsetMinutes),
    failure: failureFor(kind, failureReason),
    segments,
    cost: toMoney(money, ctx.currency),
    raw: r,
  };
}

/**
 * Event kind from the status code, refined by the Webhook (New) event name where it says more
 * (click, template and request events have no delivery status).
 * @param {string | null} statusCode @param {string} eventName @param {string | null} desc
 * @returns {{ status: string, final: boolean, reason?: string }}
 */
function classifyEvent(statusCode, eventName, desc) {
  const name = eventName.toLowerCase();
  if (/click/.test(name)) return { status: 'clicked', final: false };
  if (/template/.test(name)) return { status: 'template', final: false };
  if (/api.?fail/.test(name)) return { status: 'api_failed', final: true };
  if (/request/.test(name)) return { status: 'requested', final: false };
  if (statusCode !== null && DELIVERY_STATUS_CODES[statusCode]) return DELIVERY_STATUS_CODES[statusCode];
  const text = `${name} ${desc ?? ''}`.toLowerCase();
  if (/deliver/.test(text)) return DELIVERY_STATUS_CODES[1];
  if (/reject/.test(text)) return DELIVERY_STATUS_CODES[16];
  if (/fail/.test(text)) return DELIVERY_STATUS_CODES[2];
  if (/ndnc|dnd/.test(text)) return DELIVERY_STATUS_CODES[9];
  if (/block/.test(text)) return DELIVERY_STATUS_CODES[17];
  if (/sent|submit/.test(text)) return DELIVERY_STATUS_CODES[0];
  return { status: 'unknown', final: false };
}

/**
 * @param {{ status: string, reason?: string }} kind @param {string | null} reason
 * @returns {Msg91WebhookEvent['failure']}
 */
function failureFor(kind, reason) {
  if (!['failed', 'rejected', 'blocked', 'api_failed'].includes(kind.status)) return null;
  if (kind.reason === 'ndnc') return { reason: reason ?? 'NDNC', category: 'dnd', permanent: true };
  if (kind.reason) return { reason: reason ?? kind.reason, category: kind.reason, permanent: true };
  return { reason, ...classifyFailureReason(reason) };
}

/**
 * Categorise an MSG91 failure reason ("Absent Subscriber", "Template Inactive on DLT", ...).
 * `permanent` means retrying the same message to the same number will not help.
 * @param {string | null} reason
 * @returns {{ category: string, permanent: boolean }}
 */
export function classifyFailureReason(reason) {
  if (!reason) return { category: 'unknown', permanent: false };
  for (const [pattern, category, permanent] of FAILURE_CATEGORIES) {
    if (/** @type {RegExp} */ (pattern).test(reason)) return { category: /** @type {string} */ (category), permanent: /** @type {boolean} */ (permanent) };
  }
  return { category: 'unknown', permanent: false };
}

/**
 * @param {Record<string, unknown>} r
 * @param {{ requestId: string | null, to: string | null, statusCode: string | null, kind: { status: string }, occurredAt: string | null }} f
 */
function eventIdFor(r, f) {
  if (f.requestId && f.to) {
    const status = f.statusCode ?? f.kind.status;
    const suffix = f.kind.status === 'clicked' ? `:click:${f.occurredAt ?? ''}` : '';
    return `msg91:${f.requestId}:${f.to}:${status}${suffix}`;
  }
  return `msg91:sha256:${createHash('sha256').update(canonicalJson(r)).digest('hex').slice(0, 32)}`;
}

/** Stable JSON (sorted keys) so the same payload always hashes the same. @param {unknown} value @returns {string} */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(/** @type {any} */ (value)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * MSG91 timestamps → UTC ISO. Handles '2025-07-09 11:29:46' and '2025-07-08 08:20:26.259000'
 * (no offset: read as IST by default), ISO strings with Z / +05:30, and epoch seconds or ms.
 * @param {unknown} value @param {number} naiveOffsetMinutes
 */
export function toUtcIso(value, naiveOffsetMinutes = IST_OFFSET_MINUTES) {
  if (value === undefined || value === null || value === '' || value === '0') return null;
  const s = String(value).trim();
  if (/^\d{10}$/.test(s)) return new Date(Number(s) * 1000).toISOString();
  if (/^\d{13}$/.test(s)) return new Date(Number(s)).toISOString();
  const naive = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?$/);
  if (naive) {
    const ms = naive[3] ? Number(`0${naive[3]}`.slice(0, 5)) * 1000 : 0;
    const utc = Date.parse(`${naive[1]}T${naive[2]}Z`) + Math.round(ms) - naiveOffsetMinutes * 60000;
    return Number.isNaN(utc) ? null : new Date(utc).toISOString();
  }
  const parsed = Date.parse(s);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

/** @param {unknown} v */
function toInt(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * Decimal string → integer minor units without floating point ("0.20" → 20). More than two
 * decimals ("0.135") is rounded half-up and flagged `exact: false`.
 * @param {unknown} value @param {string} currency
 * @returns {{ amountMinor: number, currency: string, exact: boolean } | null}
 */
export function toMoney(value, currency) {
  if (value === undefined || value === null || value === '') return null;
  const m = String(value).trim().match(/^(\d+)(?:\.(\d+))?$/);
  if (!m) return null;
  const frac = m[2] ?? '';
  const major = Number(m[1]);
  const minorDigits = Number((frac + '00').slice(0, 2));
  const roundUp = frac.length > 2 && Number(frac[2]) >= 5 ? 1 : 0;
  return { amountMinor: major * 100 + minorDigits + roundUp, currency, exact: frac.length <= 2 || /^0*$/.test(frac.slice(2)) };
}
