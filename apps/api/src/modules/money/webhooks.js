import { createHmac, randomUUID } from 'node:crypto';
import { db } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { env } from '../../config/env.js';
import { loadBillingRecord } from './access.js';
import { logger } from '../../lib/logger.js';
import { generateTestSignatureHeader } from '../../integrations/providers/stripe/index.js';
import { WebhookPayloadError } from './gateways.js';
import { applyPaymentFailure, applyPaymentSuccess } from './payments.js';
import { markRefundFailed, markRefundProcessed } from './refunds.js';
import { DEV_WEBHOOK_SECRETS, ports } from './ports.js';
import { minor } from './util.js';

// Payment webhook handler functions. The platform's webhook receiver (integration framework)
// calls handlePaymentWebhook with the exact raw body and headers of a delivery to the URL it
// registered for a payment account, e.g. POST /webhooks/money/razorpay/<accountId>. Steps:
//   1. verify with the provider client of that account (gateway.parseWebhook): 401 on failure
//   2. record the provider event id in billing_provider_events in the same transaction that
//      applies it: a redelivery (or a concurrent duplicate) finds the row and changes nothing
//   3. apply: payment.succeeded / payment.failed / refund.processed (+ invoice, credit note)
// Answer 2xx for every verified event, including ones that are ignored, so the provider stops
// retrying; answer 401 for signature failures and 400 for bodies that are not events.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @param {{ accountId: string, rawBody: Buffer | string, headers: Record<string, string | string[] | undefined> }} input
 * @returns {Promise<{ outcome: 'applied' | 'duplicate' | 'ignored' | 'unmatched', dedupeKey: string, paymentId?: string | null, refundId?: string | null }>}
 */
export async function handlePaymentWebhook({ accountId, rawBody, headers }) {
  if (!UUID.test(String(accountId ?? ''))) throw new WebhookPayloadError('Unknown payment account');
  const account = await db('billing_payment_accounts').where({ id: accountId }).first();
  if (!account) throw new WebhookPayloadError('Unknown payment account');
  const gateway = await ports.paymentGateway({ companyId: account.company_id, provider: account.provider, account });
  const event = gateway.parseWebhook(rawBody, headers); // throws WebhookSignatureError (401)

  return db.transaction(async (trx) => {
    const inserted = await trx('billing_provider_events')
      .insert({ dedupe_key: event.dedupeKey, provider: event.provider, event_type: event.type, kind: event.action, company_id: account.company_id, outcome: 'received' })
      .onConflict('dedupe_key')
      .ignore()
      .returning('dedupe_key');
    if (!inserted.length) return { outcome: 'duplicate', dedupeKey: event.dedupeKey };

    const result = await applyMoneyEvent(trx, account, event);
    await trx('billing_provider_events')
      .where({ dedupe_key: event.dedupeKey })
      .update({ outcome: result.outcome, payment_id: result.paymentId ?? null, refund_id: result.refundId ?? null });
    if (result.outcome === 'unmatched') logger.warn({ dedupeKey: event.dedupeKey, type: event.type, accountId }, 'money: webhook matched no payment');
    return { ...result, dedupeKey: event.dedupeKey };
  });
}

async function findPayment(trx, account, event) {
  const byId = event.reference && UUID.test(event.reference) ? await trx('payments').where({ id: event.reference }).forUpdate().first() : null;
  const payment =
    byId ??
    (event.linkId ? await trx('payments').where({ provider: account.provider, provider_link_id: event.linkId }).forUpdate().first() : null) ??
    (event.payment?.id ? await trx('payments').where({ provider: account.provider, provider_payment_id: event.payment.id }).forUpdate().first() : null);
  // A payment of another company or provider is never touched by this account's webhook.
  if (!payment || payment.company_id !== account.company_id || payment.provider !== account.provider) return null;
  return payment;
}

async function findRefund(trx, account, event) {
  const ref = event.refund?.reference;
  let refund = ref && UUID.test(ref) ? await trx('refunds').where({ id: ref }).forUpdate().first() : null;
  if (!refund && event.refund?.id) refund = await trx('refunds').where({ provider: account.provider, provider_refund_id: event.refund.id }).forUpdate().first();
  if (!refund && event.refund?.paymentId) {
    // Stripe's refund events name the payment intent only: take its oldest refund in flight.
    const payment = await trx('payments').where({ provider: account.provider, provider_payment_id: event.refund.paymentId }).first('id');
    if (payment) refund = await trx('refunds').where({ payment_id: payment.id, status: 'processing' }).orderBy('created_at').forUpdate().first();
  }
  if (!refund || refund.company_id !== account.company_id) return null;
  return refund;
}

/** Apply one verified, normalised event inside the webhook transaction. */
export async function applyMoneyEvent(trx, account, event) {
  const sourceEventId = event.dedupeKey;
  switch (event.action) {
    case 'payment_succeeded': {
      const payment = await findPayment(trx, account, event);
      if (!payment) return { outcome: 'unmatched' };
      if (payment.status === 'succeeded') return { outcome: 'ignored', paymentId: payment.id };
      if (['cancelled', 'expired'].includes(payment.status)) logger.warn({ paymentId: payment.id }, 'money: a cancelled link was paid; recording the payment');
      const amount = event.payment?.amountMinor;
      if (amount != null && (amount !== minor(payment.amount_minor) || (event.payment.currency && event.payment.currency !== payment.currency))) {
        // Never invoice a different amount than asked for: hold it for finance to look at.
        await trx('payments')
          .where({ id: payment.id })
          .update({ status: 'pending', failure: JSON.stringify({ code: 'amount_mismatch', message: `Provider reported ${amount} ${event.payment.currency ?? ''}` }), updated_at: trx.fn.now() });
        return { outcome: 'unmatched', paymentId: payment.id };
      }
      const deal = await trx('deals').where({ id: payment.deal_id }).first();
      await applyPaymentSuccess(trx, payment, {
        deal,
        method: event.payment?.method ?? null,
        providerPaymentId: event.payment?.id ?? null,
        paidAt: event.occurredAt ?? new Date().toISOString(),
        feeMinor: event.payment?.feeMinor ?? null,
        taxMinor: event.payment?.taxMinor ?? null,
        sourceEventId,
      });
      return { outcome: 'applied', paymentId: payment.id };
    }
    case 'payment_failed': {
      const payment = await findPayment(trx, account, event);
      if (!payment) return { outcome: 'unmatched' };
      if (!['link_sent', 'pending', 'failed'].includes(payment.status)) return { outcome: 'ignored', paymentId: payment.id };
      const deal = await trx('deals').where({ id: payment.deal_id }).first();
      await applyPaymentFailure(trx, payment, { deal, failure: event.payment?.failure ?? { code: null, message: null }, sourceEventId });
      return { outcome: 'applied', paymentId: payment.id };
    }
    case 'payment_pending': {
      const payment = await findPayment(trx, account, event);
      if (!payment) return { outcome: 'unmatched' };
      if (payment.status !== 'link_sent' && payment.status !== 'failed') return { outcome: 'ignored', paymentId: payment.id };
      await trx('payments').where({ id: payment.id }).update({ status: 'pending', provider_payment_id: event.payment?.id ?? payment.provider_payment_id, updated_at: trx.fn.now() });
      return { outcome: 'applied', paymentId: payment.id };
    }
    case 'link_expired':
    case 'link_cancelled': {
      const payment = await findPayment(trx, account, event);
      if (!payment) return { outcome: 'unmatched' };
      if (!['link_sent', 'failed', 'pending'].includes(payment.status)) return { outcome: 'ignored', paymentId: payment.id };
      await trx('payments')
        .where({ id: payment.id })
        .update({ status: event.action === 'link_expired' ? 'expired' : 'cancelled', updated_at: trx.fn.now() });
      return { outcome: 'applied', paymentId: payment.id };
    }
    case 'refund_processed': {
      const refund = await findRefund(trx, account, event);
      if (!refund) return { outcome: 'unmatched' };
      if (refund.status === 'processed') return { outcome: 'ignored', refundId: refund.id };
      if (!['approved', 'processing', 'failed'].includes(refund.status)) return { outcome: 'ignored', refundId: refund.id };
      await markRefundProcessed(trx, refund, { sourceEventId });
      return { outcome: 'applied', refundId: refund.id, paymentId: refund.payment_id };
    }
    case 'refund_failed': {
      const refund = await findRefund(trx, account, event);
      if (!refund) return { outcome: 'unmatched' };
      await markRefundFailed(trx, refund, { failure: { code: 'provider_failed', message: null }, sourceEventId });
      return { outcome: 'applied', refundId: refund.id };
    }
    default:
      return { outcome: 'ignored' };
  }
}

// ---------- Development: signed provider bodies, so the whole path runs without a gateway ----------

/** A Razorpay-shaped webhook body and headers, signed with the development secret. */
export function devRazorpayDelivery({ event, payment, eventId, accountRef = null, secret = DEV_WEBHOOK_SECRETS.razorpay }) {
  const now = Math.floor(Date.now() / 1000);
  const paymentEntity = {
    id: payment.provider_payment_id && payment.provider_payment_id.startsWith('pay_') ? payment.provider_payment_id : `pay_dev${payment.id.replace(/-/g, '').slice(0, 14)}`,
    entity: 'payment',
    amount: minor(payment.amount_minor),
    currency: payment.currency,
    status: event === 'payment.failed' ? 'failed' : 'captured',
    method: payment.method ?? 'upi',
    order_id: payment.provider_order_id ?? null,
    notes: { phoenix_payment_id: payment.id },
    fee: event === 'payment.failed' ? null : Math.round(minor(payment.amount_minor) * 0.0236),
    tax: event === 'payment.failed' ? null : Math.round(minor(payment.amount_minor) * 0.0036),
    error_code: event === 'payment.failed' ? 'BAD_REQUEST_ERROR' : null,
    error_description: event === 'payment.failed' ? 'Payment was declined by the bank' : null,
    error_reason: event === 'payment.failed' ? 'payment_declined' : null,
    created_at: now,
  };
  const payload = { payment: { entity: paymentEntity } };
  if (event === 'payment_link.paid') {
    payload.payment_link = { entity: { id: payment.provider_link_id, entity: 'payment_link', status: 'paid', reference_id: payment.id, amount: minor(payment.amount_minor), amount_paid: minor(payment.amount_minor), currency: payment.currency } };
  }
  const body = JSON.stringify({ entity: 'event', account_id: accountRef, event, contains: Object.keys(payload), payload, created_at: now });
  const headers = { 'x-razorpay-signature': createHmac('sha256', secret).update(body).digest('hex'), 'x-razorpay-event-id': eventId, 'content-type': 'application/json' };
  return { rawBody: Buffer.from(body), headers };
}

/** A Razorpay refund.processed body for a refund, signed with the development secret. */
export function devRazorpayRefundDelivery({ refund, providerPaymentId, eventId, status = 'processed', secret = DEV_WEBHOOK_SECRETS.razorpay }) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    refund: { entity: { id: refund.provider_refund_id, entity: 'refund', amount: minor(refund.amount_minor), currency: refund.currency, payment_id: providerPaymentId, status, notes: { phoenix_refund_id: refund.id }, created_at: now } },
  };
  const body = JSON.stringify({ entity: 'event', account_id: null, event: status === 'processed' ? 'refund.processed' : 'refund.failed', contains: ['refund'], payload, created_at: now });
  const headers = { 'x-razorpay-signature': createHmac('sha256', secret).update(body).digest('hex'), 'x-razorpay-event-id': eventId };
  return { rawBody: Buffer.from(body), headers };
}

/** A Stripe checkout.session.completed (or payment_intent.payment_failed) body signed with the dev secret. */
export function devStripeDelivery({ payment, eventId, failed = false, secret = DEV_WEBHOOK_SECRETS.stripe }) {
  const created = Math.floor(Date.now() / 1000);
  const object = failed
    ? { id: `pi_dev${payment.id.replace(/-/g, '').slice(0, 20)}`, object: 'payment_intent', amount: minor(payment.amount_minor), currency: payment.currency.toLowerCase(), status: 'requires_payment_method', metadata: { phoenix_payment_id: payment.id }, last_payment_error: { code: 'card_declined', decline_code: 'insufficient_funds', message: 'Your card has insufficient funds.' } }
    : {
        id: `cs_dev${payment.id.replace(/-/g, '').slice(0, 20)}`,
        object: 'checkout.session',
        amount_total: minor(payment.amount_minor),
        currency: payment.currency.toLowerCase(),
        payment_status: 'paid',
        status: 'complete',
        payment_intent: `pi_dev${payment.id.replace(/-/g, '').slice(0, 20)}`,
        payment_link: payment.provider_link_id,
        metadata: { phoenix_payment_id: payment.id },
        client_reference_id: payment.id,
      };
  const body = JSON.stringify({ id: eventId, object: 'event', type: failed ? 'payment_intent.payment_failed' : 'checkout.session.completed', created, data: { object }, livemode: false, api_version: '2025-06-30.basil' });
  return { rawBody: Buffer.from(body), headers: { 'stripe-signature': generateTestSignatureHeader({ payload: body, secret, timestamp: created }) } };
}

/**
 * Development only: complete or fail a payment link as the provider would, by signing a provider
 * body with the development secret and passing it through handlePaymentWebhook. Refused in
 * production and for accounts with a real connection.
 */
export async function simulatePayment(req, id, { outcome, method }) {
  if (env.isProd) throw errors.notFound('Route');
  const payment = await loadBillingRecord(req, 'payments', id, { permission: 'billing.manage', notFound: 'Payment' });
  if (!['link_sent', 'failed', 'pending'].includes(payment.status)) throw errors.conflict(`A ${payment.status} payment can't be simulated`);
  const account = payment.account_id ? await db('billing_payment_accounts').where({ id: payment.account_id }).first() : null;
  if (!account) throw errors.conflict('This payment has no payment account');
  const gateway = await ports.paymentGateway({ companyId: account.company_id, provider: account.provider, account });
  if (!gateway.dev) throw errors.conflict('This account uses a real connection: pay through the link');
  const eventId = `evt_dev${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const delivery =
    payment.provider === 'stripe'
      ? devStripeDelivery({ payment, eventId, failed: outcome === 'failed' })
      : devRazorpayDelivery({ event: outcome === 'failed' ? 'payment.failed' : 'payment_link.paid', payment: { ...payment, method }, eventId, accountRef: account.account_ref });
  return handlePaymentWebhook({ accountId: account.id, ...delivery });
}
