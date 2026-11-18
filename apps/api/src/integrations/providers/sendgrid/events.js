import { createHash } from 'node:crypto';
import { SendgridError } from './errors.js';

/**
 * Event Webhook payload (a JSON array of events) -> normalised delivery events.
 *
 * - `providerEventId` is `sg_event_id`, which SendGrid says to use for de-duplication (events
 *   can arrive more than once and are retried for up to 24 hours). Events without one (for
 *   example hand-made curl tests) get a stable `synthetic:<sha256>` id instead.
 * - `messageId` is our id, read back from the custom_args key we set on send. SendGrid posts
 *   custom args as top-level keys of each event.
 * - `providerMessageId` is `sg_message_id`; `xMessageId` is its part before the first "."
 *   which matches the X-Message-Id returned on send (observed format, not documented).
 */

/** Our normalised types. Keys are SendGrid's `event` values. */
export const EVENT_TYPES = Object.freeze({
  processed: 'processed',
  deferred: 'deferred',
  delivered: 'delivered',
  bounce: 'bounced',
  dropped: 'dropped',
  open: 'opened',
  click: 'clicked',
  spamreport: 'spam_reported',
  unsubscribe: 'unsubscribed',
  group_unsubscribe: 'group_unsubscribed',
  group_resubscribe: 'group_resubscribed',
  account_status_change: 'account_status_changed',
});

/** Properties SendGrid documents on events; anything else at top level is a custom arg. */
const KNOWN_FIELDS = new Set([
  'email', 'timestamp', 'event', 'sg_event_id', 'sg_message_id', 'smtp-id', 'category', 'asm_group_id',
  'attempt', 'bounce_classification', 'ip', 'marketing_campaign_id', 'marketing_campaign_name',
  'marketing_campaign_version', 'marketing_campaign_split_id', 'mc_stats', 'phase_id', 'singlesend_id',
  'singlesend_name', 'template_id', 'template_name', 'template_version_id', 'template_hash', 'send_at',
  'pool', 'reason', 'response', 'status', 'tls', 'type', 'url', 'url_offset', 'useragent', 'sg_machine_open',
  'sg_content_type', 'sg_template_id', 'sg_template_name', 'unique_args', 'newsletter', 'cert_err',
  'domain', 'from', 'nlvx_campaign_id', 'nlvx_user_id', 'post_type', 'sg_user_id',
]);

/** Delivery outcomes that mean the address should not be mailed again. */
const SUPPRESSING = new Set(['bounced', 'dropped', 'spam_reported', 'unsubscribed', 'group_unsubscribed']);

/**
 * @typedef {{
 *   provider: 'sendgrid', providerEventId: string, syntheticId: boolean, type: string, providerType: string,
 *   messageId: string|null, providerMessageId: string|null, xMessageId: string|null, email: string|null,
 *   occurredAt: string|null, categories: string[], customArgs: Record<string, string>,
 *   bounce: { kind: 'hard'|'soft', classification: string|null, reason: string|null, status: string|null } | null,
 *   reason: string|null, response: string|null, attempt: number|null, url: string|null,
 *   userAgent: string|null, ip: string|null, machineOpen: boolean|null, asmGroupId: number|null,
 *   accountStatus: string|null, suppressRecipient: boolean, raw: Record<string, unknown>
 * }} NormalisedEvent
 */

/**
 * @param {Buffer|string|unknown[]} body raw body bytes/text, or an already parsed array
 * @param {{ messageIdArg?: string }} [options]
 * @returns {NormalisedEvent[]}
 */
export function parseWebhook(body, { messageIdArg = 'phoenix_message_id' } = {}) {
  let events = body;
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) events = Buffer.from(body).toString('utf8');
  if (typeof events === 'string') {
    try {
      events = JSON.parse(events);
    } catch {
      throw new SendgridError('invalid_payload', 'Event Webhook body is not valid JSON', { retryable: false });
    }
  }
  if (!Array.isArray(events)) throw new SendgridError('invalid_payload', 'Event Webhook body must be a JSON array', { retryable: false });
  return events
    .filter((e) => e && typeof e === 'object' && !Array.isArray(e))
    .map((e) => normaliseEvent(/** @type {Record<string, unknown>} */ (e), messageIdArg));
}

/**
 * @param {Record<string, any>} e
 * @param {string} messageIdArg
 * @returns {NormalisedEvent}
 */
export function normaliseEvent(e, messageIdArg) {
  const providerType = typeof e.event === 'string' ? e.event : 'unknown';
  const type = EVENT_TYPES[/** @type {keyof typeof EVENT_TYPES} */ (providerType)] ?? 'unknown';
  const customArgs = customArgsOf(e);
  const sgMessageId = str(e.sg_message_id)?.trim() || null;
  const eventId = str(e.sg_event_id)?.trim() || null;
  const ts = Number(e.timestamp);
  return {
    provider: 'sendgrid',
    providerEventId: eventId ?? `synthetic:${createHash('sha256').update(stableStringify(e)).digest('hex')}`,
    syntheticId: eventId === null,
    type,
    providerType,
    messageId: customArgs[messageIdArg] ?? null,
    providerMessageId: sgMessageId,
    xMessageId: sgMessageId ? sgMessageId.split('.')[0] : null,
    email: str(e.email)?.trim().toLowerCase() || null,
    occurredAt: Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000).toISOString() : null,
    categories: e.category == null ? [] : (Array.isArray(e.category) ? e.category : [e.category]).map(String),
    customArgs,
    bounce: type === 'bounced' ? bounceOf(e) : null,
    reason: str(e.reason),
    response: str(e.response),
    attempt: e.attempt == null || Number.isNaN(Number(e.attempt)) ? null : Number(e.attempt),
    url: str(e.url),
    userAgent: str(e.useragent),
    ip: str(e.ip),
    machineOpen: typeof e.sg_machine_open === 'boolean' ? e.sg_machine_open : null,
    asmGroupId: e.asm_group_id == null || Number.isNaN(Number(e.asm_group_id)) ? null : Number(e.asm_group_id),
    accountStatus: type === 'account_status_changed' ? str(e.type) : null,
    suppressRecipient: SUPPRESSING.has(type) && !(type === 'bounced' && e.type === 'blocked'),
    raw: e,
  };
}

/** @param {Record<string, any>} e */
function bounceOf(e) {
  return {
    // "bounce" is a permanent (hard) rejection; "blocked" is temporary (soft).
    kind: /** @type {'hard'|'soft'} */ (e.type === 'blocked' ? 'soft' : 'hard'),
    classification: str(e.bounce_classification),
    reason: str(e.reason),
    status: str(e.status),
  };
}

/** @param {Record<string, any>} e */
function customArgsOf(e) {
  const args = /** @type {Record<string, string>} */ ({});
  if (e.unique_args && typeof e.unique_args === 'object') {
    for (const [k, v] of Object.entries(e.unique_args)) if (typeof v === 'string') args[k] = v;
  }
  for (const [k, v] of Object.entries(e)) {
    if (!KNOWN_FIELDS.has(k) && typeof v === 'string') args[k] = v;
  }
  return args;
}

/** @param {unknown} v */
function str(v) {
  return v == null ? null : typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : null;
}

/** JSON with sorted keys, so the synthetic id does not depend on key order. @param {unknown} v */
function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(/** @type {any} */ (v)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}
