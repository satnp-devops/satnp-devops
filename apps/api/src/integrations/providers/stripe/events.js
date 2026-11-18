import { StripeEventError } from './errors.js';

/**
 * Turns a Stripe webhook body into a provider-neutral event.
 *
 * Stripe sends "snapshot" events (object: 'event', the resource in data.object, shape set by
 * the endpoint's API version) or "thin" events (object: 'v2.core.event', only related_object).
 * Deduplicate on `id` (Stripe may deliver an event more than once and in any order).
 */

/** Stripe event type -> platform event kind. Anything else parses with kind null. */
export const EVENT_KINDS = Object.freeze({
  'checkout.session.completed': 'checkout.completed',
  'checkout.session.async_payment_succeeded': 'checkout.async_payment_succeeded',
  'checkout.session.async_payment_failed': 'checkout.async_payment_failed',
  'checkout.session.expired': 'checkout.expired',
  'payment_intent.succeeded': 'payment.succeeded',
  'payment_intent.payment_failed': 'payment.failed',
  'payment_intent.canceled': 'payment.canceled',
  'invoice.paid': 'invoice.paid',
  'invoice.payment_failed': 'invoice.payment_failed',
  'charge.refunded': 'refund.updated',
  'customer.subscription.created': 'subscription.created',
  'customer.subscription.updated': 'subscription.updated',
  'customer.subscription.deleted': 'subscription.deleted',
});

/** Event types the platform should subscribe the endpoint to. */
export const RECOMMENDED_EVENT_TYPES = Object.freeze(Object.keys(EVENT_KINDS));

/**
 * @typedef {object} PaymentDetails
 * @property {number|null} amount integer, Stripe smallest unit (see currency.js)
 * @property {string|null} currency uppercase ISO 4217
 * @property {string|null} status Stripe status of the object
 * @property {boolean|null} paid
 * @property {string|null} customerId
 * @property {string|null} customerEmail
 * @property {string|null} checkoutSessionId
 * @property {string|null} paymentIntentId
 * @property {string|null} chargeId
 * @property {string|null} invoiceId
 * @property {string|null} subscriptionId
 * @property {string|null} paymentLinkId
 * @property {string|null} clientReferenceId
 * @property {Record<string, string>} metadata
 * @property {{ code: string|null, declineCode: string|null, message: string|null }|null} failure
 * @property {{ amountRefunded: number, fullyRefunded: boolean }|null} refund
 * @property {{ number: string|null, hostedUrl: string|null, billingReason: string|null, attemptCount: number|null, nextPaymentAttemptAt: string|null }|null} invoice
 * @property {{ cancelAtPeriodEnd: boolean, currentPeriodEnd: string|null, canceledAt: string|null }|null} subscription
 */

/**
 * @typedef {object} NormalizedEvent
 * @property {'stripe'} provider
 * @property {string} id Stripe event id (evt_...), the dedupe key
 * @property {string} type Stripe event type
 * @property {string|null} kind platform kind from EVENT_KINDS, null when unmapped
 * @property {'snapshot'|'thin'} format
 * @property {boolean} livemode
 * @property {string|null} createdAt ISO 8601 UTC
 * @property {string|null} apiVersion
 * @property {string|null} account connected account id (Connect), else null
 * @property {string|null} requestId
 * @property {string|null} idempotencyKey
 * @property {{ type: string|null, id: string|null }} object the resource the event is about
 * @property {PaymentDetails|null} payment
 * @property {any} data raw data.object for snapshot events, null for thin events
 */

/** @param {unknown} value */
const str = (value) => (typeof value === 'string' && value ? value : null);
/** Stripe fields can be an id string or an expanded object. @param {unknown} value */
const idOf = (value) => str(value) ?? (value && typeof value === 'object' ? str(/** @type {any} */ (value).id) : null);
/** @param {unknown} value */
const int = (value) => (Number.isSafeInteger(value) ? /** @type {number} */ (value) : null);
/** @param {unknown} value */
const upper = (value) => (str(value) ? /** @type {string} */ (value).toUpperCase() : null);
/** @param {unknown} seconds */
const isoFromUnix = (seconds) => (Number.isSafeInteger(seconds) ? new Date(Number(seconds) * 1000).toISOString() : null);

/** @param {unknown} value @returns {Record<string, string>} */
function metadataOf(value) {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === 'string'));
}

/** @param {any} error */
function failureOf(error) {
  if (!error || typeof error !== 'object') return null;
  return { code: str(error.code), declineCode: str(error.decline_code), message: str(error.message) };
}

/** @returns {PaymentDetails} */
function emptyDetails() {
  return {
    amount: null,
    currency: null,
    status: null,
    paid: null,
    customerId: null,
    customerEmail: null,
    checkoutSessionId: null,
    paymentIntentId: null,
    chargeId: null,
    invoiceId: null,
    subscriptionId: null,
    paymentLinkId: null,
    clientReferenceId: null,
    metadata: {},
    failure: null,
    refund: null,
    invoice: null,
    subscription: null,
  };
}

/** @param {any} s checkout.session */
function fromCheckoutSession(s) {
  return {
    ...emptyDetails(),
    amount: int(s.amount_total),
    currency: upper(s.currency),
    status: str(s.payment_status) ?? str(s.status),
    // 'unpaid' happens with delayed methods: wait for checkout.session.async_payment_succeeded.
    paid: s.payment_status === 'paid' || s.payment_status === 'no_payment_required',
    customerId: idOf(s.customer),
    customerEmail: str(s.customer_details?.email) ?? str(s.customer_email),
    checkoutSessionId: str(s.id),
    paymentIntentId: idOf(s.payment_intent),
    invoiceId: idOf(s.invoice),
    subscriptionId: idOf(s.subscription),
    paymentLinkId: idOf(s.payment_link),
    clientReferenceId: str(s.client_reference_id),
    metadata: metadataOf(s.metadata),
  };
}

/** @param {any} pi payment_intent */
function fromPaymentIntent(pi) {
  return {
    ...emptyDetails(),
    amount: pi.status === 'succeeded' ? (int(pi.amount_received) ?? int(pi.amount)) : int(pi.amount),
    currency: upper(pi.currency),
    status: str(pi.status),
    paid: pi.status === 'succeeded',
    customerId: idOf(pi.customer),
    paymentIntentId: str(pi.id),
    chargeId: idOf(pi.latest_charge),
    invoiceId: idOf(pi.invoice), // removed from PaymentIntent in 2025-03-31.basil; kept for older endpoints
    metadata: metadataOf(pi.metadata),
    failure: failureOf(pi.last_payment_error),
  };
}

/** @param {any} inv invoice; handles pre- and post-2025-03-31.basil shapes */
function fromInvoice(inv) {
  const subscription = inv.parent?.subscription_details?.subscription ?? inv.subscription;
  const firstPayment = Array.isArray(inv.payments?.data) ? inv.payments.data[0]?.payment : undefined;
  return {
    ...emptyDetails(),
    amount: inv.status === 'paid' ? (int(inv.amount_paid) ?? int(inv.amount_due)) : int(inv.amount_due),
    currency: upper(inv.currency),
    status: str(inv.status),
    paid: inv.status === 'paid' || inv.paid === true,
    customerId: idOf(inv.customer),
    customerEmail: str(inv.customer_email),
    invoiceId: str(inv.id),
    subscriptionId: idOf(subscription),
    paymentIntentId: idOf(firstPayment?.payment_intent) ?? idOf(inv.payment_intent),
    chargeId: idOf(firstPayment?.charge) ?? idOf(inv.charge),
    metadata: metadataOf(inv.metadata),
    // Decline details live on the PaymentIntent/charge; fetch them if the CRM needs the reason.
    invoice: {
      number: str(inv.number),
      hostedUrl: str(inv.hosted_invoice_url),
      billingReason: str(inv.billing_reason),
      attemptCount: int(inv.attempt_count),
      nextPaymentAttemptAt: isoFromUnix(inv.next_payment_attempt),
    },
  };
}

/** @param {any} ch charge (charge.refunded) */
function fromCharge(ch) {
  const amount = int(ch.amount);
  const amountRefunded = int(ch.amount_refunded) ?? 0;
  return {
    ...emptyDetails(),
    amount,
    currency: upper(ch.currency),
    status: str(ch.status),
    paid: ch.paid === true,
    customerId: idOf(ch.customer),
    customerEmail: str(ch.billing_details?.email) ?? str(ch.receipt_email),
    paymentIntentId: idOf(ch.payment_intent),
    chargeId: str(ch.id),
    invoiceId: idOf(ch.invoice),
    metadata: metadataOf(ch.metadata),
    failure: ch.failure_code ? { code: str(ch.failure_code), declineCode: null, message: str(ch.failure_message) } : null,
    refund: { amountRefunded, fullyRefunded: ch.refunded === true || (amount !== null && amountRefunded >= amount) },
  };
}

/** @param {any} sub subscription */
function fromSubscription(sub) {
  const item = Array.isArray(sub.items?.data) ? sub.items.data[0] : undefined;
  return {
    ...emptyDetails(),
    amount: int(item?.price?.unit_amount),
    currency: upper(sub.currency) ?? upper(item?.price?.currency),
    status: str(sub.status),
    paid: sub.status === 'active' || sub.status === 'trialing',
    customerId: idOf(sub.customer),
    subscriptionId: str(sub.id),
    invoiceId: idOf(sub.latest_invoice),
    metadata: metadataOf(sub.metadata),
    subscription: {
      cancelAtPeriodEnd: sub.cancel_at_period_end === true,
      // Moved from the subscription to its items in 2025-03-31.basil.
      currentPeriodEnd: isoFromUnix(item?.current_period_end ?? sub.current_period_end),
      canceledAt: isoFromUnix(sub.canceled_at),
    },
  };
}

/** @type {Record<string, (object: any) => PaymentDetails>} */
const DETAIL_READERS = {
  'checkout.session': fromCheckoutSession,
  payment_intent: fromPaymentIntent,
  invoice: fromInvoice,
  charge: fromCharge,
  subscription: fromSubscription,
};

/**
 * @param {Buffer|Uint8Array|string|object} body raw webhook body or the parsed JSON
 * @returns {any}
 */
function toJson(body) {
  if (body && typeof body === 'object' && !(body instanceof Uint8Array)) return body;
  const text = typeof body === 'string' ? body : Buffer.from(/** @type {Uint8Array} */ (body ?? [])).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new StripeEventError('Webhook body is not valid JSON', 'invalid_json');
  }
}

/** @param {any} event @returns {NormalizedEvent} */
function parseThin(event) {
  const type = String(event.type);
  const related = event.related_object && typeof event.related_object === 'object' ? event.related_object : {};
  return {
    provider: 'stripe',
    id: event.id,
    type,
    kind: EVENT_KINDS[type.replace(/^v1\./, '')] ?? null,
    format: 'thin',
    livemode: event.livemode === true,
    createdAt: str(event.created) ? new Date(event.created).toISOString() : null,
    apiVersion: null,
    account: str(event.context),
    requestId: str(event.reason?.request?.id),
    idempotencyKey: str(event.reason?.request?.idempotency_key),
    object: { type: str(related.type), id: str(related.id) },
    payment: null,
    data: null,
  };
}

/** @param {any} event @returns {NormalizedEvent} */
function parseSnapshot(event) {
  const object = event.data?.object;
  if (!object || typeof object !== 'object') throw new StripeEventError('Stripe event has no data.object', 'missing_object');
  const reader = DETAIL_READERS[object.object];
  return {
    provider: 'stripe',
    id: event.id,
    type: event.type,
    kind: EVENT_KINDS[event.type] ?? null,
    format: 'snapshot',
    livemode: event.livemode === true,
    createdAt: isoFromUnix(event.created),
    apiVersion: str(event.api_version),
    account: str(event.account),
    requestId: str(event.request?.id),
    idempotencyKey: str(event.request?.idempotency_key),
    object: { type: str(object.object), id: str(object.id) },
    payment: reader ? reader(object) : null,
    data: object,
  };
}

/**
 * Parses a webhook body into a NormalizedEvent. Call verifyWebhook first (or use
 * constructEvent) - this function trusts its input.
 * @param {Buffer|Uint8Array|string|object} body
 * @returns {NormalizedEvent}
 */
export function parseWebhook(body) {
  const event = toJson(body);
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new StripeEventError('Webhook body is not a Stripe event', 'not_an_event');
  }
  if (!str(event.id) || !/^evt_/.test(event.id) || !str(event.type)) {
    throw new StripeEventError('Webhook body is missing a Stripe event id or type', 'not_an_event');
  }
  if (event.object === 'v2.core.event') return parseThin(event);
  if (event.object !== 'event') throw new StripeEventError('Webhook body is not a Stripe event', 'not_an_event');
  return parseSnapshot(event);
}
