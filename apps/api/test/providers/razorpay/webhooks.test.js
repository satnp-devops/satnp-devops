import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  createRazorpayClient,
  parseWebhook,
  RazorpayError,
  verifyWebhook,
} from '../../../src/integrations/providers/razorpay/index.js';
import { fixture, KEY_ID, KEY_SECRET, WEBHOOK_SECRET } from './fake-fetch.js';

// Our vector: computed with node:crypto, cross-checked with `openssl dgst -sha256 -hmac phoenix_webhook_secret_v1`.
const BODY =
  '{"entity":"event","account_id":"acc_TestPhoenix01","event":"payment.captured","contains":["payment"],"payload":{"payment":{"entity":{"id":"pay_TestPhoenix0001","entity":"payment","amount":150000,"currency":"INR","status":"captured","order_id":"order_TestPhoenix001","method":"upi","captured":true,"notes":{"admission_id":"adm_42"},"created_at":1762300000}}},"created_at":1762300005}';
const SIG_V1 = '9bf22bc471093d8322ced00b8eb3ac9acae6761a3c049748c418caba0d08b844';
const SIG_V0 = 'cf2512bba23ba7c5ecb9b03ca751788173b56038b7896440798e2d5d7bb3ce0d'; // same body, secret phoenix_webhook_secret_v0
const EVENT_ID = 'Fq0c7zSxiKSAlw'; // shape of x-razorpay-event-id is not documented; any string works
const headers = (sig = SIG_V1) => ({ 'x-razorpay-signature': sig, 'x-razorpay-event-id': EVENT_ID, 'content-type': 'application/json' });
const sign = (raw, secret) => createHmac('sha256', secret).update(raw).digest('hex');

test('valid webhook verifies from a string, a Buffer and a Headers object', () => {
  assert.deepEqual(verifyWebhook(BODY, headers(), WEBHOOK_SECRET), { valid: true, eventId: EVENT_ID });
  assert.equal(verifyWebhook(Buffer.from(BODY), headers(), WEBHOOK_SECRET).valid, true);
  const h = new Headers({ 'X-Razorpay-Signature': SIG_V1, 'X-Razorpay-Event-Id': EVENT_ID });
  assert.deepEqual(verifyWebhook(BODY, h, WEBHOOK_SECRET), { valid: true, eventId: EVENT_ID });
  assert.equal(verifyWebhook(BODY, { 'X-Razorpay-Signature': SIG_V1 }, WEBHOOK_SECRET).valid, true);
});

test('tampered body, tampered signature and wrong secret are rejected', () => {
  const tamperedBody = BODY.replace('"amount":150000', '"amount":150001');
  assert.deepEqual(verifyWebhook(tamperedBody, headers(), WEBHOOK_SECRET), {
    valid: false,
    reason: 'signature_mismatch',
    eventId: EVENT_ID,
  });
  // Whitespace changes (re-serialising a parsed body) also break the signature.
  assert.equal(verifyWebhook(JSON.stringify(JSON.parse(BODY), null, 2), headers(), WEBHOOK_SECRET).valid, false);
  const flipped = `${SIG_V1.slice(0, -1)}${SIG_V1.endsWith('4') ? '5' : '4'}`;
  assert.equal(verifyWebhook(BODY, headers(flipped), WEBHOOK_SECRET).reason, 'signature_mismatch');
  assert.equal(verifyWebhook(BODY, headers(), 'phoenix_webhook_secret_v2').reason, 'signature_mismatch');
  assert.equal(verifyWebhook(BODY, headers(), KEY_SECRET).reason, 'signature_mismatch');
});

test('missing or malformed signature, parsed body and missing secret are rejected', () => {
  assert.equal(verifyWebhook(BODY, {}, WEBHOOK_SECRET).reason, 'missing_signature');
  assert.equal(verifyWebhook(BODY, headers(''), WEBHOOK_SECRET).reason, 'missing_signature');
  assert.equal(verifyWebhook(BODY, headers('sha256=abc'), WEBHOOK_SECRET).reason, 'malformed_signature');
  assert.equal(verifyWebhook(BODY, headers(SIG_V1.slice(2)), WEBHOOK_SECRET).reason, 'malformed_signature');
  assert.equal(verifyWebhook(BODY, { 'x-razorpay-signature': [SIG_V1, SIG_V1] }, WEBHOOK_SECRET).reason, 'malformed_signature');
  assert.equal(verifyWebhook(JSON.parse(BODY), headers(), WEBHOOK_SECRET).reason, 'raw_body_required');
  assert.equal(verifyWebhook(BODY, headers(), '').reason, 'missing_secret');
  assert.equal(verifyWebhook(BODY, headers(), undefined).reason, 'missing_secret');
});

test('secret rotation: old and new secrets both verify when both are configured', () => {
  const secrets = [WEBHOOK_SECRET, 'phoenix_webhook_secret_v0'];
  assert.equal(verifyWebhook(BODY, headers(SIG_V1), secrets).valid, true);
  assert.equal(verifyWebhook(BODY, headers(SIG_V0), secrets).valid, true);
  assert.equal(verifyWebhook(BODY, headers(SIG_V0), WEBHOOK_SECRET).valid, false);
});

test('optional max age on the signed created_at: fresh, expired, future, missing', () => {
  const at = (iso) => () => Date.parse(iso); // BODY created_at = 1762300005 = 2025-11-04T23:46:45Z
  const opts = (iso) => ({ maxAgeSeconds: 26 * 3600, now: at(iso) });
  assert.equal(verifyWebhook(BODY, headers(), WEBHOOK_SECRET, opts('2025-11-05T10:00:00Z')).valid, true);
  assert.equal(verifyWebhook(BODY, headers(), WEBHOOK_SECRET, opts('2025-11-06T02:00:00Z')).reason, 'expired');
  assert.equal(verifyWebhook(BODY, headers(), WEBHOOK_SECRET, opts('2025-11-04T20:00:00Z')).reason, 'from_future');
  // No tolerance by default: Razorpay defines none and retries for 24 hours.
  assert.equal(verifyWebhook(BODY, headers(), WEBHOOK_SECRET, { now: at('2030-01-01T00:00:00Z') }).valid, true);
  const noTs = '{"entity":"event","event":"payment.captured","payload":{}}';
  assert.equal(verifyWebhook(noTs, headers(sign(noTs, WEBHOOK_SECRET)), WEBHOOK_SECRET, opts('2025-11-05T10:00:00Z')).reason, 'missing_timestamp');
  // Expiry is checked only after the signature, so an attacker cannot probe it with a bad signature.
  assert.equal(verifyWebhook(BODY, headers(SIG_V0), WEBHOOK_SECRET, opts('2025-11-06T02:00:00Z')).reason, 'signature_mismatch');
});

test('official sample payloads verify byte-for-byte and parse', () => {
  const raw = fixture('payment.captured');
  const sig = sign(raw, WEBHOOK_SECRET);
  assert.equal(verifyWebhook(raw, { 'x-razorpay-signature': sig }, WEBHOOK_SECRET).valid, true);
  assert.equal(verifyWebhook(Buffer.concat([raw, Buffer.from('\n')]), { 'x-razorpay-signature': sig }, WEBHOOK_SECRET).valid, false);
});

test('parse payment.captured', () => {
  const e = parseWebhook(fixture('payment.captured'), { 'x-razorpay-event-id': 'evt_1' });
  assert.equal(e.provider, 'razorpay');
  assert.equal(e.eventId, 'evt_1');
  assert.equal(e.dedupeKey, 'razorpay:evt_1');
  assert.equal(e.type, 'payment.captured');
  assert.equal(e.kind, 'payment.succeeded');
  assert.equal(e.accountId, 'acc_BFQ7uQEaa7j2z7');
  assert.equal(e.occurredAt, '2019-09-05T09:10:06.000Z');
  assert.deepEqual(e.contains, ['payment']);
  assert.equal(e.payment.id, 'pay_DESlfW9H8K9uqM');
  assert.equal(e.payment.orderId, 'order_DESlLckIVRkHWj');
  assert.equal(e.payment.amount, 100);
  assert.equal(e.payment.currency, 'INR');
  assert.equal(e.payment.status, 'captured');
  assert.equal(e.payment.captured, true);
  assert.equal(e.payment.method, 'netbanking');
  assert.deepEqual(e.payment.notes, {}); // Razorpay sends [] for empty notes
  assert.equal(e.payment.error, null);
  assert.equal(e.order, null);
  assert.equal(e.refund, null);
});

test('parse payment.failed keeps the error details', () => {
  const e = parseWebhook(fixture('payment.failed'));
  assert.equal(e.kind, 'payment.failed');
  assert.equal(e.eventId, null);
  assert.match(e.dedupeKey, /^razorpay:derived:[0-9a-f]{32}$/);
  assert.equal(e.payment.status, 'failed');
  assert.equal(e.payment.amount, 50000);
  assert.equal(e.payment.error.code, 'BAD_REQUEST_ERROR');
  assert.equal(typeof e.payment.error.description, 'string');
  // Derived keys are stable for the same delivery.
  assert.equal(parseWebhook(fixture('payment.failed')).dedupeKey, e.dedupeKey);
});

test('parse order.paid carries both order and payment', () => {
  const e = parseWebhook(JSON.parse(fixture('order.paid').toString()));
  assert.equal(e.kind, 'order.paid');
  assert.equal(e.order.id, 'order_DESlLckIVRkHWj');
  assert.equal(e.order.status, 'paid');
  assert.equal(e.order.amountPaid, 100);
  assert.equal(e.order.amountDue, 0);
  assert.equal(e.payment.id, 'pay_DESlfW9H8K9uqM');
});

test('parse payment_link.paid and payment_link.cancelled', () => {
  const paid = parseWebhook(fixture('payment_link.paid'));
  assert.equal(paid.kind, 'payment_link.paid');
  assert.equal(paid.paymentLink.id, 'plink_QflcnnZqCekuvL');
  assert.equal(paid.paymentLink.status, 'paid');
  assert.equal(paid.paymentLink.amount, 1000);
  assert.equal(paid.paymentLink.amountPaid, 1000);
  assert.equal(paid.payment.id, 'pay_Qfldmt5StKZFCB');
  assert.equal(paid.payment.status, 'captured');
  assert.ok(paid.order);
  const cancelled = parseWebhook(fixture('payment_link.cancelled'));
  assert.equal(cancelled.kind, 'payment_link.cancelled');
  assert.equal(cancelled.paymentLink.referenceId, 'NewTestPayment4');
  assert.equal(typeof cancelled.paymentLink.cancelledAt, 'string');
});

test('parse refund.processed and refund.failed', () => {
  const ok = parseWebhook(fixture('refund.processed'));
  assert.equal(ok.kind, 'refund.succeeded');
  assert.equal(ok.refund.id, 'rfnd_FS8TWyPrCsa0OB');
  assert.equal(ok.refund.paymentId, 'pay_FPoJKWQQ8lK13n');
  assert.equal(ok.refund.amount, 50000);
  assert.equal(ok.refund.status, 'processed');
  assert.equal(ok.refund.speedProcessed, 'normal');
  assert.equal(ok.payment.amount, 500000);
  const failed = parseWebhook(fixture('refund.failed'));
  assert.equal(failed.kind, 'refund.failed');
  assert.equal(failed.refund.status, 'failed');
  assert.notEqual(failed.dedupeKey, ok.dedupeKey);
});

test('parse subscription.* events', () => {
  const activated = parseWebhook(fixture('subscription.activated'));
  assert.equal(activated.kind, 'subscription.activated');
  assert.equal(activated.subscription.id, 'sub_DEX6xcJ1HSW4CR');
  assert.equal(activated.subscription.planId, 'plan_BvrFKjSxauOH7N');
  assert.equal(activated.subscription.status, 'active');
  const charged = parseWebhook(fixture('subscription.charged'));
  assert.equal(charged.kind, 'subscription.charged');
  assert.equal(charged.payment.amount, 100000);
  assert.equal(charged.payment.status, 'captured');
  assert.equal(parseWebhook(fixture('subscription.cancelled')).subscription.status, 'cancelled');
  assert.equal(parseWebhook(fixture('subscription.halted')).kind, 'subscription.halted');
  for (const key of ['currentStart', 'currentEnd', 'createdAt']) {
    const v = activated.subscription[key];
    assert.ok(v === null || /Z$/.test(v), `${key} is UTC ISO or null`);
  }
});

test('unknown events parse as kind "other"; bad bodies throw invalid_payload', () => {
  const e = parseWebhook({ entity: 'event', event: 'settlement.processed', payload: {}, created_at: 1 });
  assert.equal(e.kind, 'other');
  assert.throws(() => parseWebhook('{not json'), (err) => err instanceof RazorpayError && err.kind === 'invalid_payload');
  assert.throws(() => parseWebhook({ foo: 1 }), (err) => err.kind === 'invalid_payload');
  assert.throws(() => parseWebhook(null), (err) => err.kind === 'invalid_payload');
});

test('client.handleWebhook verifies, parses and enforces account id', () => {
  const client = createRazorpayClient(
    { keyId: KEY_ID, keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET, accountId: 'acc_TestPhoenix01' },
    { fetch: async () => assert.fail('no network') },
  );
  const e = client.handleWebhook(BODY, headers());
  assert.equal(e.kind, 'payment.succeeded');
  assert.equal(e.payment.amount, 150000);
  assert.deepEqual(e.payment.notes, { admission_id: 'adm_42' });
  assert.throws(
    () => client.handleWebhook(BODY.replace('150000', '1'), headers()),
    (err) => err instanceof RazorpayError && err.kind === 'signature' && err.reason === 'signature_mismatch' && !err.retryable,
  );
  const other = createRazorpayClient(
    { keyId: KEY_ID, keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET, accountId: 'acc_SomeoneElse01' },
    { fetch: async () => assert.fail('no network') },
  );
  assert.throws(() => other.handleWebhook(BODY, headers()), (err) => err.reason === 'account_mismatch');
  const noSecret = createRazorpayClient({ keyId: KEY_ID, keySecret: KEY_SECRET }, { fetch: async () => assert.fail() });
  assert.throws(() => noSecret.handleWebhook(BODY, headers()), (err) => err.reason === 'missing_secret');
});

test('client.handleWebhook applies webhookMaxAgeSeconds with the injected clock', () => {
  const client = createRazorpayClient(
    { keyId: KEY_ID, keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET, webhookMaxAgeSeconds: 3600 },
    { fetch: async () => assert.fail('no network'), now: () => new Date('2025-11-05T02:00:00Z') },
  );
  assert.throws(() => client.handleWebhook(BODY, headers()), (err) => err.reason === 'expired');
  assert.deepEqual(client.verifyWebhook(BODY, headers()), { valid: false, reason: 'expired', eventId: EVENT_ID });
});
