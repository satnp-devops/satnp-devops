import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hmacSha256Hex,
  signatureMatches,
  verifyPaymentLinkSignature,
  verifyPaymentSignature,
  verifySubscriptionSignature,
} from '../../../src/integrations/providers/razorpay/index.js';

// Vectors marked "ours" were computed with node:crypto and cross-checked with `openssl dgst -sha256 -hmac`.
const OUR_SECRET = 'phoenix_key_secret_123';

test('HMAC helper matches RFC 4231 test case 2', () => {
  assert.equal(
    hmacSha256Hex('what do ya want for nothing?', 'Jefe'),
    '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
  );
});

test('checkout signature: official Razorpay example verifies', () => {
  // razorpay.com/docs/payments/payment-gateway/web-integration/standard/build-integration (Java/Go samples)
  const input = {
    orderId: 'order_IEIaMR65cu6nz3',
    paymentId: 'pay_IH4NVgf4Dreq1l',
    signature: '0d4e745a1838664ad6c9c9902212a32d627d68e917290b0ad5f08ff4561bc50f',
  };
  assert.equal(verifyPaymentSignature(input, 'EnLs21M47BllR3X8PSFtjtbd'), true);
  assert.equal(verifyPaymentSignature(input, 'wrong-secret'), false);
  assert.equal(verifyPaymentSignature({ ...input, orderId: 'order_IEIaMR65cu6nz4' }, 'EnLs21M47BllR3X8PSFtjtbd'), false);
  // The message is order_id|payment_id: swapping the parts must fail.
  assert.equal(
    verifyPaymentSignature({ ...input, orderId: input.paymentId, paymentId: input.orderId }, 'EnLs21M47BllR3X8PSFtjtbd'),
    false,
  );
});

test('checkout signature: our vector', () => {
  const ok = {
    orderId: 'order_TestPhoenix001',
    paymentId: 'pay_TestPhoenix0001',
    signature: '7a9bcde0015053e36f2190ca777e7f5beb53ece53bfcd841ad40ceebdc01f259',
  };
  assert.equal(verifyPaymentSignature(ok, OUR_SECRET), true);
  assert.equal(verifyPaymentSignature({ ...ok, signature: ok.signature.toUpperCase() }, OUR_SECRET), true);
  assert.equal(verifyPaymentSignature({ ...ok, signature: `${ok.signature.slice(0, 63)}0` }, OUR_SECRET), false);
});

test('payment link callback signature: official example verifies', () => {
  // razorpay.com/docs/payments/payment-links/apis#verify-signature (Java sample)
  const input = {
    paymentLinkId: 'plink_IH3cNucfVEgV68',
    referenceId: 'TSsd1989',
    status: 'paid',
    paymentId: 'pay_IH3d0ara9bSsjQ',
    signature: '07ae18789e35093e51d0a491eb9922646f3f82773547e5b0f67ee3f2d3bf7d5b',
  };
  assert.equal(verifyPaymentLinkSignature(input, 'EnLs21M47BllR3X8PSFtjtbd'), true);
  assert.equal(verifyPaymentLinkSignature({ ...input, status: 'partially_paid' }, 'EnLs21M47BllR3X8PSFtjtbd'), false);
});

test('payment link callback signature without reference id uses an empty segment (ours)', () => {
  const input = {
    paymentLinkId: 'plink_TestPhoenix001',
    referenceId: null,
    status: 'paid',
    paymentId: 'pay_TestPhoenix0001',
    signature: 'd6be68252db3a948d12ca70cb8ee236c1521fb58d788c883467f440d64bbe7ac',
  };
  assert.equal(verifyPaymentLinkSignature(input, OUR_SECRET), true);
  assert.equal(verifyPaymentLinkSignature({ ...input, referenceId: '' }, OUR_SECRET), true);
});

test('subscription checkout signature is payment_id|subscription_id (ours)', () => {
  const input = {
    subscriptionId: 'sub_TestPhoenix0001',
    paymentId: 'pay_TestPhoenix0001',
    signature: '87a3631f4b3cc8734b2e983906830b9babdd773865cebc1d03bae9b2cd77e043',
  };
  assert.equal(verifySubscriptionSignature(input, OUR_SECRET), true);
  assert.equal(verifySubscriptionSignature({ ...input, subscriptionId: 'sub_TestPhoenix0002' }, OUR_SECRET), false);
});

test('malformed signatures and missing parts are rejected without throwing', () => {
  const expected = hmacSha256Hex('a|b', 's');
  assert.equal(signatureMatches(expected, expected), true);
  for (const bad of [undefined, null, 42, '', 'zz'.repeat(32), expected.slice(0, 62), `${expected}00`, ` ${expected}`]) {
    assert.equal(signatureMatches(bad, expected), false, String(bad));
  }
  assert.equal(verifyPaymentSignature({ orderId: '', paymentId: 'pay_x', signature: expected }, 's'), false);
  assert.equal(verifyPaymentSignature({ orderId: 'order_x', paymentId: 'pay_x', signature: expected }, ''), false);
});
