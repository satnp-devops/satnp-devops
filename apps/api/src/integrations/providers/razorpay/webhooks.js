import { createHash } from 'node:crypto';
import { RazorpayError } from './errors.js';
import { matchesAnySecret } from './signatures.js';
import {
  normalizeOrder,
  normalizePayment,
  normalizePaymentLink,
  normalizeRefund,
  normalizeSubscription,
} from './normalize.js';
import { getHeader, unixToIso } from './util.js';

/**
 * Razorpay webhooks (docs: webhooks/validate-test, webhooks/best-practices, fetched 2026-11-05):
 * - `X-Razorpay-Signature`: hex HMAC-SHA256 of the raw request body, keyed with the webhook secret.
 * - `X-Razorpay-Event-Id`: unique per event; the same event can arrive more than once
 *   (at-least-once delivery, retries with backoff for 24 hours). Use it to de-duplicate.
 * - No timestamp header and no signed timestamp. The body carries `created_at` (unix seconds),
 *   which is covered by the signature. `maxAgeSeconds` is an optional platform policy on it.
 * - Respond 2xx within 5 seconds or Razorpay treats the delivery as failed and retries.
 */

export const SIGNATURE_HEADER = 'x-razorpay-signature';
export const EVENT_ID_HEADER = 'x-razorpay-event-id';

/**
 * Provider event → platform-neutral kind. Anything not listed maps to 'other'.
 * `payment.captured` is the money-received signal; `order.paid` and `payment_link.paid` are
 * the "this order/link is fully paid" signals and normally arrive alongside it.
 */
export const EVENT_KINDS = Object.freeze({
  'payment.authorized': 'payment.authorized',
  'payment.captured': 'payment.succeeded',
  'payment.failed': 'payment.failed',
  'payment.pending': 'payment.pending',
  'order.paid': 'order.paid',
  'payment_link.paid': 'payment_link.paid',
  'payment_link.partially_paid': 'payment_link.partially_paid',
  'payment_link.cancelled': 'payment_link.cancelled',
  'payment_link.expired': 'payment_link.expired',
  'refund.created': 'refund.created',
  'refund.processed': 'refund.succeeded',
  'refund.failed': 'refund.failed',
  'refund.speed_changed': 'refund.updated',
  'subscription.authenticated': 'subscription.authenticated',
  'subscription.activated': 'subscription.activated',
  'subscription.charged': 'subscription.charged',
  'subscription.completed': 'subscription.completed',
  'subscription.updated': 'subscription.updated',
  'subscription.pending': 'subscription.pending',
  'subscription.halted': 'subscription.halted',
  'subscription.paused': 'subscription.paused',
  'subscription.resumed': 'subscription.resumed',
  'subscription.cancelled': 'subscription.cancelled',
});

/** @param {unknown} body */
function isRawBody(body) {
  return typeof body === 'string' || body instanceof Uint8Array; // Buffer is a Uint8Array
}

/**
 * @typedef {{ valid: true, eventId: string|null } | { valid: false, reason: 'missing_secret'|'raw_body_required'|'missing_signature'|'malformed_signature'|'signature_mismatch'|'invalid_json'|'missing_timestamp'|'expired'|'from_future', eventId: string|null }} WebhookVerification
 */

/**
 * Verify a Razorpay webhook. Pass the body exactly as received (string or Buffer), before any
 * JSON parsing: re-serialising a parsed body changes bytes and breaks the signature.
 *
 * @param {string|Uint8Array} rawBody
 * @param {unknown} headers request headers (plain object, Map or Headers)
 * @param {string|string[]} secret webhook secret, or [current, previous] while rotating
 * @param {{ maxAgeSeconds?: number, now?: () => number|Date, clockSkewSeconds?: number }} [options]
 *   maxAgeSeconds: reject events whose signed `created_at` is older than this (off by default;
 *   Razorpay itself defines no tolerance and retries for 24h, so pick more than 86400).
 * @returns {WebhookVerification}
 */
export function verifyWebhook(rawBody, headers, secret, options = {}) {
  const eventIdHeader = getHeader(headers, EVENT_ID_HEADER);
  const eventId = typeof eventIdHeader === 'string' && eventIdHeader.length > 0 ? eventIdHeader : null;
  const secrets = (Array.isArray(secret) ? secret : [secret]).filter((s) => typeof s === 'string' && s.length > 0);
  if (secrets.length === 0) return { valid: false, reason: 'missing_secret', eventId };
  if (!isRawBody(rawBody)) return { valid: false, reason: 'raw_body_required', eventId };

  const signature = getHeader(headers, SIGNATURE_HEADER);
  if (signature === undefined || signature === '') return { valid: false, reason: 'missing_signature', eventId };
  if (typeof signature !== 'string' || !/^[0-9a-f]{64}$/i.test(signature.trim())) {
    return { valid: false, reason: 'malformed_signature', eventId };
  }
  if (!matchesAnySecret(rawBody, signature.trim(), secrets)) return { valid: false, reason: 'signature_mismatch', eventId };

  if (options.maxAgeSeconds !== undefined) {
    let createdAt;
    try {
      createdAt = JSON.parse(Buffer.from(rawBody).toString('utf8'))?.created_at;
    } catch {
      return { valid: false, reason: 'invalid_json', eventId };
    }
    if (typeof createdAt !== 'number') return { valid: false, reason: 'missing_timestamp', eventId };
    const nowValue = options.now ? options.now() : Date.now();
    const nowSeconds = Math.floor((nowValue instanceof Date ? nowValue.getTime() : nowValue) / 1000);
    const skew = options.clockSkewSeconds ?? 300;
    if (nowSeconds - createdAt > options.maxAgeSeconds) return { valid: false, reason: 'expired', eventId };
    if (createdAt - nowSeconds > skew) return { valid: false, reason: 'from_future', eventId };
  }
  return { valid: true, eventId };
}

/** @param {any} payload @param {string} key */
const entityOf = (payload, key) => payload?.[key]?.entity ?? null;

/**
 * Parse a (verified) webhook body into a normalised event.
 *
 * @param {string|Uint8Array|object} body raw body or already-parsed JSON
 * @param {unknown} [headers] used for `x-razorpay-event-id`
 */
export function parseWebhook(body, headers) {
  let event = body;
  if (isRawBody(body)) {
    try {
      event = JSON.parse(Buffer.from(/** @type {any} */ (body)).toString('utf8'));
    } catch (cause) {
      throw new RazorpayError('invalid_payload', 'Razorpay webhook body is not valid JSON', { cause });
    }
  }
  if (!event || typeof event !== 'object' || typeof (/** @type {any} */ (event).event) !== 'string') {
    throw new RazorpayError('invalid_payload', 'Razorpay webhook body has no event name');
  }
  const e = /** @type {any} */ (event);
  const payload = e.payload && typeof e.payload === 'object' ? e.payload : {};
  const headerId = getHeader(headers, EVENT_ID_HEADER);
  const eventId = typeof headerId === 'string' && headerId.length > 0 ? headerId : null;

  const normalised = {
    provider: 'razorpay',
    eventId,
    type: e.event,
    kind: EVENT_KINDS[e.event] ?? 'other',
    accountId: e.account_id ?? null,
    occurredAt: unixToIso(e.created_at),
    contains: Array.isArray(e.contains) ? [...e.contains] : Object.keys(payload),
    payment: normalizePayment(entityOf(payload, 'payment')),
    order: normalizeOrder(entityOf(payload, 'order')),
    paymentLink: normalizePaymentLink(entityOf(payload, 'payment_link')),
    refund: normalizeRefund(entityOf(payload, 'refund')),
    subscription: normalizeSubscription(entityOf(payload, 'subscription')),
    raw: e,
  };
  return { ...normalised, dedupeKey: dedupeKeyFor(normalised, body) };
}

/**
 * Stable key for idempotent processing: the provider's event id when present; otherwise a
 * hash of the event name, main entity id and timestamp (or of the raw body), prefixed so it
 * can never collide with a real event id.
 * @param {{ eventId: string|null, type: string, raw: any, payment: any, order: any, paymentLink: any, refund: any, subscription: any }} event
 * @param {unknown} body
 */
function dedupeKeyFor(event, body) {
  if (event.eventId) return `razorpay:${event.eventId}`;
  const main = event.refund ?? event.paymentLink ?? event.subscription ?? event.order ?? event.payment;
  const basis = main?.id
    ? `${event.type}|${main.id}|${main.status ?? ''}|${event.raw.created_at ?? ''}`
    : isRawBody(body)
      ? Buffer.from(/** @type {any} */ (body)).toString('utf8')
      : JSON.stringify(event.raw);
  return `razorpay:derived:${createHash('sha256').update(basis).digest('hex').slice(0, 32)}`;
}
