import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EVENT_KINDS, StripeEventError, parseWebhook } from '../../../src/integrations/providers/stripe/index.js';
import {
  chargeFullyRefunded,
  chargePartiallyRefunded,
  checkoutSessionPaid,
  checkoutSessionUnpaidJpy,
  invoicePaid,
  invoicePaymentFailedLegacy,
  paymentIntentFailed,
  paymentIntentSucceeded,
  snapshotEvent,
  subscriptionDeleted,
  thinEvent,
} from './fixtures.js';

test('checkout.session.completed (paid) normalises ids, amount, customer and metadata', () => {
  const raw = snapshotEvent('checkout.session.completed', checkoutSessionPaid);
  const event = parseWebhook(JSON.stringify(raw));
  assert.equal(event.provider, 'stripe');
  assert.equal(event.id, raw.id);
  assert.equal(event.type, 'checkout.session.completed');
  assert.equal(event.kind, 'checkout.completed');
  assert.equal(event.format, 'snapshot');
  assert.equal(event.livemode, false);
  assert.equal(event.createdAt, '2025-11-05T00:00:00.000Z');
  assert.equal(event.apiVersion, '2026-10-28.endive');
  assert.equal(event.requestId, 'req_8Hd2kLmQx9');
  assert.deepEqual(event.object, { type: 'checkout.session', id: checkoutSessionPaid.id });
  assert.deepEqual(event.data, raw.data.object);
  assert.deepEqual(
    {
      amount: event.payment.amount,
      currency: event.payment.currency,
      paid: event.payment.paid,
      status: event.payment.status,
      customerId: event.payment.customerId,
      customerEmail: event.payment.customerEmail,
      paymentIntentId: event.payment.paymentIntentId,
      clientReferenceId: event.payment.clientReferenceId,
      metadata: event.payment.metadata,
    },
    {
      amount: 250000,
      currency: 'USD',
      paid: true,
      status: 'paid',
      customerId: 'cus_RkT9aBcDeF',
      customerEmail: 'parent@example.com',
      paymentIntentId: 'pi_3SPhxQ2eZvKYlo2C1aBcDeFg',
      clientReferenceId: 'lead_01JBX7',
      metadata: { phoenix_payment_id: 'pay_01JBX8', company: 'phoenix-academy' },
    },
  );
});

test('checkout.session.completed with a delayed method is not paid yet; JPY stays whole yen', () => {
  const event = parseWebhook(Buffer.from(JSON.stringify(snapshotEvent('checkout.session.completed', checkoutSessionUnpaidJpy))));
  assert.equal(event.payment.paid, false);
  assert.equal(event.payment.status, 'unpaid');
  assert.equal(event.payment.amount, 5000);
  assert.equal(event.payment.currency, 'JPY');
  assert.equal(event.payment.paymentLinkId, 'plink_1SPhxQ2eZvKYlo2C');
  assert.equal(event.payment.customerId, null);
  assert.equal(event.payment.customerEmail, 'buyer@example.jp');
});

test('payment_intent.succeeded and payment_intent.payment_failed', () => {
  const ok = parseWebhook(snapshotEvent('payment_intent.succeeded', paymentIntentSucceeded));
  assert.equal(ok.kind, 'payment.succeeded');
  assert.equal(ok.payment.amount, 250000);
  assert.equal(ok.payment.paid, true);
  assert.equal(ok.payment.chargeId, 'ch_3SPhxQ2eZvKYlo2C1xYz');
  assert.equal(ok.payment.failure, null);

  const failed = parseWebhook(snapshotEvent('payment_intent.payment_failed', paymentIntentFailed));
  assert.equal(failed.kind, 'payment.failed');
  assert.equal(failed.payment.paid, false);
  assert.equal(failed.payment.amount, 250000, 'amount attempted, not amount received');
  assert.equal(failed.payment.chargeId, 'ch_3SPhxFAILcharge', 'expanded objects resolve to their id');
  assert.deepEqual(failed.payment.failure, {
    code: 'card_declined',
    declineCode: 'insufficient_funds',
    message: 'Your card has insufficient funds.',
  });
});

test('invoice.paid (current shape) and invoice.payment_failed (pre-basil shape)', () => {
  const paid = parseWebhook(snapshotEvent('invoice.paid', invoicePaid));
  assert.equal(paid.kind, 'invoice.paid');
  assert.equal(paid.payment.amount, 9900);
  assert.equal(paid.payment.paid, true);
  assert.equal(paid.payment.subscriptionId, 'sub_1SPhxQ2eZvKYlo2CsUb1');
  assert.equal(paid.payment.paymentIntentId, 'pi_3SPhxINV2eZvKYlo2C');
  assert.equal(paid.payment.customerEmail, 'accounts@institute.example');
  assert.deepEqual(paid.payment.invoice, {
    number: 'PHX-0042',
    hostedUrl: 'https://invoice.stripe.com/i/acct_test/test_inv1',
    billingReason: 'subscription_cycle',
    attemptCount: 1,
    nextPaymentAttemptAt: null,
  });

  const failed = parseWebhook(snapshotEvent('invoice.payment_failed', invoicePaymentFailedLegacy, { api_version: '2024-06-20' }));
  assert.equal(failed.kind, 'invoice.payment_failed');
  assert.equal(failed.apiVersion, '2024-06-20');
  assert.equal(failed.payment.paid, false);
  assert.equal(failed.payment.amount, 9900, 'amount still due');
  assert.equal(failed.payment.subscriptionId, 'sub_1SPhxQ2eZvKYlo2CsUb1');
  assert.equal(failed.payment.paymentIntentId, 'pi_3OLDxQ2eZvKYlo2C');
  assert.equal(failed.payment.chargeId, 'ch_3OLDxQ2eZvKYlo2C');
  assert.equal(failed.payment.invoice.attemptCount, 2);
  assert.equal(failed.payment.invoice.nextPaymentAttemptAt, '2025-11-08T00:00:00.000Z');
});

test('charge.refunded reports partial and full refunds', () => {
  const partial = parseWebhook(snapshotEvent('charge.refunded', chargePartiallyRefunded));
  assert.equal(partial.kind, 'refund.updated');
  assert.deepEqual(partial.payment.refund, { amountRefunded: 50000, fullyRefunded: false });
  assert.equal(partial.payment.paymentIntentId, 'pi_3SPhxQ2eZvKYlo2C1aBcDeFg');
  assert.equal(partial.payment.customerEmail, 'parent@example.com');

  const full = parseWebhook(snapshotEvent('charge.refunded', chargeFullyRefunded));
  assert.deepEqual(full.payment.refund, { amountRefunded: 250000, fullyRefunded: true });
});

test('customer.subscription.deleted reads period end from the item (basil and later)', () => {
  const event = parseWebhook(snapshotEvent('customer.subscription.deleted', subscriptionDeleted));
  assert.equal(event.kind, 'subscription.deleted');
  assert.equal(event.payment.status, 'canceled');
  assert.equal(event.payment.paid, false);
  assert.equal(event.payment.amount, 9900);
  assert.deepEqual(event.payment.subscription, {
    cancelAtPeriodEnd: false,
    currentPeriodEnd: '2025-12-05T00:00:00.000Z',
    canceledAt: '2025-11-04T23:59:00.000Z',
  });
});

test('Connect events carry the connected account; unmapped types parse with kind null', () => {
  const connected = parseWebhook(snapshotEvent('payment_intent.succeeded', paymentIntentSucceeded, { account: 'acct_1Conn' }));
  assert.equal(connected.account, 'acct_1Conn');
  const other = parseWebhook(snapshotEvent('customer.created', { id: 'cus_1', object: 'customer' }));
  assert.equal(other.kind, null);
  assert.equal(other.payment, null);
  assert.deepEqual(other.object, { type: 'customer', id: 'cus_1' });
});

test('thin events normalise without data', () => {
  const event = parseWebhook(JSON.stringify(thinEvent));
  assert.equal(event.format, 'thin');
  assert.equal(event.id, thinEvent.id);
  assert.equal(event.kind, null);
  assert.equal(event.createdAt, '2026-03-09T13:00:28.435Z');
  assert.equal(event.idempotencyKey, 'ik_TgmEI3jHxXt8RFw4jS7ve2QcAReDQWBjPAkAEUm');
  assert.deepEqual(event.object, { type: 'v2.core.account', id: 'acct_1T93Q4Pmpb34Vto6' });
  assert.equal(event.data, null);
  const v1Thin = parseWebhook({ ...thinEvent, type: 'v1.checkout.session.completed' });
  assert.equal(v1Thin.kind, 'checkout.completed');
});

test('rejects bodies that are not Stripe events', () => {
  const invalid = ['not json', '[]', '{}', JSON.stringify({ id: 'abc', type: 'x', object: 'event' }), JSON.stringify({ id: 'evt_1', type: 'x', object: 'charge' })];
  for (const body of invalid) assert.throws(() => parseWebhook(body), StripeEventError);
  assert.throws(() => parseWebhook({ id: 'evt_1', type: 'charge.refunded', object: 'event', data: {} }), /data.object/);
});

test('every mapped kind is unique and namespaced', () => {
  const kinds = Object.values(EVENT_KINDS);
  assert.equal(new Set(kinds).size, kinds.length);
  for (const kind of kinds) assert.match(kind, /^[a-z]+\.[a-z_]+$/);
});
