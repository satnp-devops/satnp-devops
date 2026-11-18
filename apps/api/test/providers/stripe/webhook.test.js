import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  StripeSignatureError,
  computeSignature,
  constructEvent,
  generateTestSignatureHeader,
  getSignatureHeader,
  parseSignatureHeader,
  verifyWebhook,
} from '../../../src/integrations/providers/stripe/index.js';
import { CREATED, paymentIntentSucceeded, snapshotEvent } from './fixtures.js';

// Self-computed vectors. Each expected digest was produced twice, independently, with
// node:crypto and with `openssl dgst -sha256 -hmac` over the bytes `${t}.${payload}`.
// Stripe publishes no official vector with a secret; its docs example header is parsed below.
const SECRET = 'whsec_phoenix_test_vector_secret';
const ROTATED_SECRET = 'whsec_phoenix_rotated_secret_2';
const T = 1762300800; // 2025-11-05T00:00:00Z
const PAYLOAD = '{"id":"evt_test_vector_1","object":"event","type":"payment_intent.succeeded"}';
const VECTOR_1 = 'b8aab76570afbca27372f612ad44d5c25307f4149e3a7b8e3673106a7ee8784b';
const VECTOR_ROTATED = '2835c30c789534011c623db4010df091176a2918278311130aa559b40e472543';
const UTF8_PAYLOAD =
  '{"id":"evt_unicode","object":"event","type":"charge.refunded","data":{"object":{"object":"charge","description":"Fees ₹ – café"}}}';
const VECTOR_UTF8 = 'fabd69d8790cd5c0938be58cc168199c88e3279696d2893440ea2b1f20dc8759';

const at = (seconds) => () => seconds * 1000;
const header = (sigs, t = T) => [`t=${t}`, ...sigs].join(',');

test('computeSignature matches the self-computed HMAC-SHA256 vectors', () => {
  assert.equal(computeSignature(T, PAYLOAD, SECRET), VECTOR_1);
  assert.equal(computeSignature(T, Buffer.from(PAYLOAD), SECRET), VECTOR_1);
  assert.equal(computeSignature(String(T), new Uint8Array(Buffer.from(PAYLOAD)), SECRET), VECTOR_1);
  assert.equal(computeSignature(T, PAYLOAD, ROTATED_SECRET), VECTOR_ROTATED);
  assert.equal(computeSignature(T, UTF8_PAYLOAD, SECRET), VECTOR_UTF8);
  // And the scheme itself, spelled out with node:crypto: key = whole whsec_ string, message = "t.body".
  const direct = createHmac('sha256', SECRET).update(`${T}.${PAYLOAD}`).digest('hex');
  assert.equal(direct, VECTOR_1);
});

test('parses the example header from Stripe docs and ignores v0', () => {
  const docsHeader =
    't=1492774577,v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd,v0=6ffbb59b2300aae63f272406069a9788598b792a944a07aba816edb039989a39';
  assert.deepEqual(parseSignatureHeader(docsHeader), {
    timestamp: 1492774577,
    signatures: ['5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd'],
  });
  assert.deepEqual(parseSignatureHeader(' t = 5 , v1 = abc , junk, =x, v2=zzz'), { timestamp: 5, signatures: ['abc'] });
});

test('accepts a valid signature (string, Buffer, Uint8Array bodies; header object, Headers, raw value)', () => {
  const value = header([`v1=${VECTOR_1}`]);
  for (const body of [PAYLOAD, Buffer.from(PAYLOAD), new Uint8Array(Buffer.from(PAYLOAD))]) {
    const result = verifyWebhook(body, { 'stripe-signature': value }, SECRET, { now: at(T + 10) });
    assert.deepEqual(result, { timestamp: T, signedAt: '2025-11-05T00:00:00.000Z', secretIndex: 0 });
  }
  assert.ok(verifyWebhook(PAYLOAD, new Headers({ 'Stripe-Signature': value }), SECRET, { now: at(T) }));
  assert.ok(verifyWebhook(PAYLOAD, { 'Stripe-Signature': value }, SECRET, { now: at(T) }));
  assert.ok(verifyWebhook(PAYLOAD, value, SECRET, { now: () => new Date(T * 1000) }));
  assert.ok(verifyWebhook(UTF8_PAYLOAD, header([`v1=${VECTOR_UTF8}`]), SECRET, { now: at(T) }));
});

test('multiple v1 signatures: any match passes, with one or several of our secrets', () => {
  const both = header([`v1=${'0'.repeat(64)}`, `v1=${VECTOR_ROTATED}`, `v0=${VECTOR_1}`]);
  assert.equal(verifyWebhook(PAYLOAD, both, ROTATED_SECRET, { now: at(T) }).secretIndex, 0);
  assert.equal(verifyWebhook(PAYLOAD, both, [SECRET, ROTATED_SECRET], { now: at(T) }).secretIndex, 1);
  // Uppercase hex is the same digest.
  assert.ok(verifyWebhook(PAYLOAD, header([`v1=${VECTOR_1.toUpperCase()}`]), SECRET, { now: at(T) }));
});

/** @param {() => unknown} fn @param {string} code */
function rejects(fn, code) {
  assert.throws(fn, (error) => error instanceof StripeSignatureError && error.code === code && error.retryable === false);
}

test('rejects tampered bodies, wrong secrets, and v0-only headers', () => {
  const value = header([`v1=${VECTOR_1}`]);
  rejects(() => verifyWebhook(PAYLOAD.replace('succeeded', 'failed'), value, SECRET, { now: at(T) }), 'signature_mismatch');
  rejects(() => verifyWebhook(`${PAYLOAD}\n`, value, SECRET, { now: at(T) }), 'signature_mismatch');
  rejects(() => verifyWebhook(JSON.stringify(JSON.parse(PAYLOAD), null, 2), value, SECRET, { now: at(T) }), 'signature_mismatch');
  rejects(() => verifyWebhook(PAYLOAD, value, 'whsec_someone_else', { now: at(T) }), 'signature_mismatch');
  // Changing the timestamp invalidates the signature (the timestamp is signed).
  rejects(() => verifyWebhook(PAYLOAD, header([`v1=${VECTOR_1}`], T + 1), SECRET, { now: at(T) }), 'signature_mismatch');
  // A valid digest under the v0 scheme must not count (downgrade protection).
  rejects(() => verifyWebhook(PAYLOAD, header([`v0=${VECTOR_1}`]), SECRET, { now: at(T) }), 'no_v1_signature');
  rejects(() => verifyWebhook(PAYLOAD, header(['v1=not-hex']), SECRET, { now: at(T) }), 'signature_mismatch');
  rejects(() => verifyWebhook(PAYLOAD, header([`v1=${VECTOR_1.slice(0, 63)}`]), SECRET, { now: at(T) }), 'signature_mismatch');
});

test('rejects expired and far-future timestamps (300 s default tolerance, both directions)', () => {
  const value = header([`v1=${VECTOR_1}`]);
  assert.ok(verifyWebhook(PAYLOAD, value, SECRET, { now: at(T + 300) }));
  assert.ok(verifyWebhook(PAYLOAD, value, SECRET, { now: at(T - 300) }));
  rejects(() => verifyWebhook(PAYLOAD, value, SECRET, { now: at(T + 301) }), 'timestamp_outside_tolerance');
  rejects(() => verifyWebhook(PAYLOAD, value, SECRET, { now: at(T - 301) }), 'timestamp_outside_tolerance');
  assert.ok(verifyWebhook(PAYLOAD, value, SECRET, { now: at(T + 3000), toleranceSec: 3600 }));
  rejects(() => verifyWebhook(PAYLOAD, value, SECRET, { now: at(T), toleranceSec: 0 }), 'invalid_tolerance');
});

test('rejects missing or malformed input with specific codes and no secret in the message', () => {
  rejects(() => verifyWebhook(PAYLOAD, {}, SECRET), 'missing_header');
  rejects(() => verifyWebhook(PAYLOAD, undefined, SECRET), 'missing_header');
  rejects(() => verifyWebhook(PAYLOAD, `v1=${VECTOR_1}`, SECRET), 'malformed_header');
  rejects(() => verifyWebhook(PAYLOAD, `t=abc,v1=${VECTOR_1}`, SECRET), 'malformed_header');
  rejects(() => verifyWebhook(PAYLOAD, `t=${T}`, SECRET), 'no_v1_signature');
  rejects(() => verifyWebhook(JSON.parse(PAYLOAD), header([`v1=${VECTOR_1}`]), SECRET), 'invalid_body');
  rejects(() => verifyWebhook(PAYLOAD, header([`v1=${VECTOR_1}`]), ''), 'missing_secret');
  rejects(() => verifyWebhook(PAYLOAD, header([`v1=${VECTOR_1}`]), []), 'missing_secret');
  try {
    verifyWebhook(PAYLOAD, header([`v1=${'1'.repeat(64)}`]), SECRET, { now: at(T) });
  } catch (error) {
    assert.ok(!String(error.message).includes(SECRET));
    assert.ok(!JSON.stringify(error).includes(SECRET));
  }
});

test('Node joins duplicate headers; arrays from header objects are joined too', () => {
  const value = getSignatureHeader({ 'stripe-signature': [`t=${T}`, `v1=${VECTOR_1}`] });
  assert.equal(value, `t=${T},v1=${VECTOR_1}`);
  assert.ok(verifyWebhook(PAYLOAD, { 'stripe-signature': [`t=${T}`, `v1=${VECTOR_1}`] }, SECRET, { now: at(T) }));
});

test('generateTestSignatureHeader round-trips and constructEvent returns the normalised event', () => {
  const body = JSON.stringify(snapshotEvent('payment_intent.succeeded', paymentIntentSucceeded));
  const signature = generateTestSignatureHeader({ payload: body, secret: SECRET, timestamp: CREATED });
  assert.match(signature, /^t=1762300800,v1=[0-9a-f]{64}$/);
  const event = constructEvent(Buffer.from(body), { 'stripe-signature': signature }, SECRET, { now: at(CREATED + 5) });
  assert.equal(event.kind, 'payment.succeeded');
  assert.equal(event.payment.amount, 250000);
  assert.throws(
    () => constructEvent(body.replace('250000', '1'), { 'stripe-signature': signature }, SECRET, { now: at(CREATED) }),
    StripeSignatureError,
  );
});
