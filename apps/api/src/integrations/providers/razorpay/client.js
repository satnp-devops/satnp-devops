import { randomUUID } from 'node:crypto';
import { parseConfig } from './config.js';
import { RazorpayError } from './errors.js';
import { createTransport } from './http.js';
import {
  normalizeOrder,
  normalizePayment,
  normalizePaymentLink,
  normalizePlan,
  normalizeRefund,
  normalizeSubscription,
} from './normalize.js';
import {
  cancelSubscriptionInput,
  createOrderInput,
  createPaymentLinkInput,
  createPlanInput,
  createRefundInput,
  createSubscriptionInput,
  ids,
} from './schemas.js';
import { verifyPaymentLinkSignature, verifyPaymentSignature, verifySubscriptionSignature } from './signatures.js';
import { compact, defaultSleep, silentLogger } from './util.js';
import { parseWebhook, verifyWebhook } from './webhooks.js';

export const CAPABILITIES = Object.freeze([
  'orders.create',
  'orders.fetch',
  'payments.fetch',
  'payment_links.create',
  'payment_links.fetch',
  'payment_links.cancel',
  'refunds.create',
  'refunds.fetch',
  'plans.create',
  'plans.fetch',
  'subscriptions.create',
  'subscriptions.fetch',
  'subscriptions.cancel',
  'checkout.verify_signature',
  'webhooks.verify',
  'webhooks.parse',
]);

/** @typedef {{ signal?: AbortSignal }} CallOptions */

/**
 * Validate input with a zod schema; failures become RazorpayError('validation') naming fields only.
 * @template T
 * @param {import('zod').ZodType<T>} schema
 * @param {unknown} input
 * @param {string} op
 * @returns {T}
 */
function check(schema, input, op) {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const details = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
  throw new RazorpayError('validation', `Razorpay ${op}: invalid input (${details.map((d) => d.path || 'input').join(', ')})`, {
    op,
    details,
  });
}

/**
 * Create a Razorpay client for one account.
 *
 * @param {import('./config.js').RazorpayConfigInput} configInput
 * @param {{
 *   fetch?: typeof fetch,
 *   now?: () => number|Date,
 *   logger?: { debug: Function, info: Function, warn: Function, error: Function },
 *   sleep?: (ms: number) => Promise<void>,
 *   random?: () => number,
 *   idempotencyKey?: () => string,
 * }} [deps] all optional; tests inject fetch/now/sleep/random/idempotencyKey
 */
export function createRazorpayClient(configInput, deps = {}) {
  const config = parseConfig(configInput);
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new RazorpayError('config', 'No fetch implementation available');
  const nowMs = () => {
    const value = deps.now ? deps.now() : Date.now();
    return value instanceof Date ? value.getTime() : value;
  };
  const logger = deps.logger ?? silentLogger;
  const newIdempotencyKey = deps.idempotencyKey ?? (() => randomUUID());
  const { request } = createTransport({
    config,
    fetch: fetchImpl,
    logger,
    sleep: deps.sleep ?? defaultSleep,
    random: deps.random ?? Math.random,
    now: nowMs,
    userAgent: 'phoenix-crm-razorpay/1.0',
  });

  const pathId = (schema, value, op) => encodeURIComponent(check(schema, value, op));
  const nowSeconds = () => Math.floor(nowMs() / 1000);

  // ---- Orders -------------------------------------------------------------------------------

  /**
   * POST /orders. Not idempotent at Razorpay, so only 429s are retried; use a unique `receipt`
   * to find the order if a call ends with `outcomeUnknown`.
   * @param {import('zod').input<typeof createOrderInput>} input
   * @param {CallOptions} [options]
   */
  async function createOrder(input, options = {}) {
    const v = check(createOrderInput, input, 'orders.create');
    const body = compact({
      amount: v.amount,
      currency: v.currency,
      receipt: v.receipt,
      notes: v.notes,
      partial_payment: v.partialPayment,
      first_payment_min_amount: v.firstPaymentMinAmount,
    });
    const raw = await request({ op: 'orders.create', method: 'POST', path: '/orders', body, retry: 'unsafe', signal: options.signal });
    return { ...normalizeOrder(raw), raw };
  }

  /** GET /orders/:id @param {string} orderId @param {CallOptions} [options] */
  async function fetchOrder(orderId, options = {}) {
    const path = `/orders/${pathId(ids.order, orderId, 'orders.fetch')}`;
    const raw = await request({ op: 'orders.fetch', method: 'GET', path, retry: 'safe', signal: options.signal });
    return { ...normalizeOrder(raw), raw };
  }

  // ---- Payments ------------------------------------------------------------------------------

  /** GET /payments/:id; use it to confirm status when a webhook is late. @param {string} paymentId @param {CallOptions} [options] */
  async function fetchPayment(paymentId, options = {}) {
    const path = `/payments/${pathId(ids.payment, paymentId, 'payments.fetch')}`;
    const raw = await request({ op: 'payments.fetch', method: 'GET', path, retry: 'safe', signal: options.signal });
    return { ...normalizePayment(raw), raw };
  }

  // ---- Payment Links -------------------------------------------------------------------------

  /**
   * POST /payment_links/ (standard link). `referenceId` must be unique per link at Razorpay,
   * which also makes it the lookup key if a call ends with `outcomeUnknown`.
   * @param {import('zod').input<typeof createPaymentLinkInput>} input
   * @param {CallOptions} [options]
   */
  async function createPaymentLink(input, options = {}) {
    const v = check(createPaymentLinkInput, input, 'payment_links.create');
    if (v.expireBy !== undefined && v.expireBy <= nowSeconds()) {
      throw new RazorpayError('validation', 'Razorpay payment_links.create: expireBy must be in the future', {
        op: 'payment_links.create',
        details: [{ path: 'expireBy', message: 'Must be in the future' }],
      });
    }
    const body = compact({
      amount: v.amount,
      currency: v.currency,
      description: v.description,
      customer: v.customer ? compact(v.customer) : undefined,
      notify: v.notify ? compact(v.notify) : undefined,
      reminder_enable: v.reminderEnable,
      expire_by: v.expireBy,
      reference_id: v.referenceId,
      notes: v.notes,
      callback_url: v.callbackUrl,
      callback_method: v.callbackUrl ? 'get' : undefined, // required with callback_url; only 'get' is accepted
      accept_partial: v.acceptPartial,
      first_min_partial_amount: v.firstMinPartialAmount,
    });
    const raw = await request({
      op: 'payment_links.create',
      method: 'POST',
      path: '/payment_links/',
      body,
      retry: 'unsafe',
      signal: options.signal,
    });
    return { ...normalizePaymentLink(raw), raw };
  }

  /** GET /payment_links/:id @param {string} paymentLinkId @param {CallOptions} [options] */
  async function fetchPaymentLink(paymentLinkId, options = {}) {
    const path = `/payment_links/${pathId(ids.paymentLink, paymentLinkId, 'payment_links.fetch')}`;
    const raw = await request({ op: 'payment_links.fetch', method: 'GET', path, retry: 'safe', signal: options.signal });
    return { ...normalizePaymentLink(raw), raw };
  }

  /** POST /payment_links/:id/cancel (only links in `created` state can be cancelled). @param {string} paymentLinkId @param {CallOptions} [options] */
  async function cancelPaymentLink(paymentLinkId, options = {}) {
    const path = `/payment_links/${pathId(ids.paymentLink, paymentLinkId, 'payment_links.cancel')}/cancel`;
    const raw = await request({ op: 'payment_links.cancel', method: 'POST', path, retry: 'unsafe', signal: options.signal });
    return { ...normalizePaymentLink(raw), raw };
  }

  // ---- Refunds -------------------------------------------------------------------------------

  /**
   * POST /payments/:id/refund with `X-Refund-Idempotency`. A key is generated when none is
   * given, so retries are safe; store `idempotencyKey` from the result to retry later.
   * Omit `amount` for a full refund. speed 'optimum' = instant when possible, else normal.
   * @param {string} paymentId
   * @param {import('zod').input<typeof createRefundInput>} [input]
   * @param {CallOptions} [options]
   */
  async function createRefund(paymentId, input = {}, options = {}) {
    const path = `/payments/${pathId(ids.payment, paymentId, 'refunds.create')}/refund`;
    const v = check(createRefundInput, input, 'refunds.create');
    const idempotencyKey = v.idempotencyKey ?? newIdempotencyKey();
    const body = compact({ amount: v.amount, speed: v.speed, receipt: v.receipt, notes: v.notes });
    const raw = await request({
      op: 'refunds.create',
      method: 'POST',
      path,
      body,
      headers: { 'X-Refund-Idempotency': idempotencyKey },
      retry: 'safe',
      signal: options.signal,
    });
    return { ...normalizeRefund(raw), idempotencyKey, raw };
  }

  /** GET /refunds/:id @param {string} refundId @param {CallOptions} [options] */
  async function fetchRefund(refundId, options = {}) {
    const path = `/refunds/${pathId(ids.refund, refundId, 'refunds.fetch')}`;
    const raw = await request({ op: 'refunds.fetch', method: 'GET', path, retry: 'safe', signal: options.signal });
    return { ...normalizeRefund(raw), raw };
  }

  // ---- Plans & Subscriptions -----------------------------------------------------------------

  /** POST /plans @param {import('zod').input<typeof createPlanInput>} input @param {CallOptions} [options] */
  async function createPlan(input, options = {}) {
    const v = check(createPlanInput, input, 'plans.create');
    const body = compact({ period: v.period, interval: v.interval, item: compact(v.item), notes: v.notes });
    const raw = await request({ op: 'plans.create', method: 'POST', path: '/plans', body, retry: 'unsafe', signal: options.signal });
    return { ...normalizePlan(raw), raw };
  }

  /** GET /plans/:id @param {string} planId @param {CallOptions} [options] */
  async function fetchPlan(planId, options = {}) {
    const path = `/plans/${pathId(ids.plan, planId, 'plans.fetch')}`;
    const raw = await request({ op: 'plans.fetch', method: 'GET', path, retry: 'safe', signal: options.signal });
    return { ...normalizePlan(raw), raw };
  }

  /** POST /subscriptions @param {import('zod').input<typeof createSubscriptionInput>} input @param {CallOptions} [options] */
  async function createSubscription(input, options = {}) {
    const v = check(createSubscriptionInput, input, 'subscriptions.create');
    const body = compact({
      plan_id: v.planId,
      total_count: v.totalCount,
      quantity: v.quantity,
      start_at: v.startAt,
      expire_by: v.expireBy,
      customer_notify: v.customerNotify,
      addons: v.addons?.map((a) => ({ item: { name: a.name, amount: a.amount, currency: a.currency } })),
      offer_id: v.offerId,
      notes: v.notes,
    });
    const raw = await request({
      op: 'subscriptions.create',
      method: 'POST',
      path: '/subscriptions',
      body,
      retry: 'unsafe',
      signal: options.signal,
    });
    return { ...normalizeSubscription(raw), raw };
  }

  /** GET /subscriptions/:id; `status` is the subscription state. @param {string} subscriptionId @param {CallOptions} [options] */
  async function fetchSubscription(subscriptionId, options = {}) {
    const path = `/subscriptions/${pathId(ids.subscription, subscriptionId, 'subscriptions.fetch')}`;
    const raw = await request({ op: 'subscriptions.fetch', method: 'GET', path, retry: 'safe', signal: options.signal });
    return { ...normalizeSubscription(raw), raw };
  }

  /**
   * POST /subscriptions/:id/cancel. `atCycleEnd: true` cancels at the end of the current
   * billing cycle instead of immediately.
   * @param {string} subscriptionId
   * @param {import('zod').input<typeof cancelSubscriptionInput>} [input]
   * @param {CallOptions} [options]
   */
  async function cancelSubscription(subscriptionId, input = {}, options = {}) {
    const path = `/subscriptions/${pathId(ids.subscription, subscriptionId, 'subscriptions.cancel')}/cancel`;
    const v = check(cancelSubscriptionInput, input, 'subscriptions.cancel');
    const raw = await request({
      op: 'subscriptions.cancel',
      method: 'POST',
      path,
      body: { cancel_at_cycle_end: v.atCycleEnd },
      retry: 'unsafe',
      signal: options.signal,
    });
    return { ...normalizeSubscription(raw), raw };
  }

  // ---- Checkout & webhooks -------------------------------------------------------------------

  /**
   * Options for Razorpay Standard Checkout in the browser. Only the public key id is included.
   * @param {{ orderId: string, amount: number, currency?: string, name?: string, description?: string,
   *   prefill?: { name?: string, email?: string, contact?: string }, notes?: Record<string, string>, callbackUrl?: string }} input
   */
  function checkoutOptions(input) {
    return compact({
      key: config.keyId,
      order_id: check(ids.order, input.orderId, 'checkout.options'),
      amount: input.amount,
      currency: input.currency ?? 'INR',
      name: input.name,
      description: input.description,
      prefill: input.prefill,
      notes: input.notes,
      callback_url: input.callbackUrl,
    });
  }

  /**
   * Verify a webhook with the configured secret(s) and parse it. Throws
   * RazorpayError('signature') when it does not verify, and when `accountId` is configured and
   * the event belongs to another account.
   * @param {string|Uint8Array} rawBody
   * @param {unknown} headers
   */
  function handleWebhook(rawBody, headers) {
    const result = verifyWebhook(rawBody, headers, config.webhookSecrets, {
      maxAgeSeconds: config.webhookMaxAgeSeconds,
      now: nowMs,
    });
    if (!result.valid) {
      throw new RazorpayError('signature', `Razorpay webhook rejected: ${result.reason}`, { op: 'webhooks.verify', reason: result.reason });
    }
    const event = parseWebhook(rawBody, headers);
    if (config.accountId && event.accountId !== config.accountId) {
      throw new RazorpayError('signature', 'Razorpay webhook rejected: account_mismatch', { op: 'webhooks.verify', reason: 'account_mismatch' });
    }
    return event;
  }

  return Object.freeze({
    provider: 'razorpay',
    mode: config.mode,
    isTestMode: config.mode === 'test',
    keyId: config.keyId,
    capabilities: CAPABILITIES,
    createOrder,
    fetchOrder,
    fetchPayment,
    createPaymentLink,
    fetchPaymentLink,
    cancelPaymentLink,
    createRefund,
    fetchRefund,
    createPlan,
    fetchPlan,
    createSubscription,
    fetchSubscription,
    /** Just the subscription state (created | authenticated | active | pending | halted | cancelled | completed | expired). */
    getSubscriptionStatus: async (id, options) => (await fetchSubscription(id, options)).status,
    cancelSubscription,
    checkoutOptions,
    /** @param {{ orderId: string, paymentId: string, signature: string }} input */
    verifyPaymentSignature: (input) => verifyPaymentSignature(input, config.keySecret),
    /** @param {{ subscriptionId: string, paymentId: string, signature: string }} input */
    verifySubscriptionSignature: (input) => verifySubscriptionSignature(input, config.keySecret),
    /** @param {{ paymentLinkId: string, referenceId?: string|null, status: string, paymentId: string, signature: string }} input */
    verifyPaymentLinkSignature: (input) => verifyPaymentLinkSignature(input, config.keySecret),
    /** @param {string|Uint8Array} rawBody @param {unknown} headers */
    verifyWebhook: (rawBody, headers) =>
      verifyWebhook(rawBody, headers, config.webhookSecrets, { maxAgeSeconds: config.webhookMaxAgeSeconds, now: nowMs }),
    parseWebhook,
    handleWebhook,
    toJSON: () => ({ provider: 'razorpay', mode: config.mode, keyId: config.keyId }),
  });
}
