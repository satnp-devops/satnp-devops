import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ZERO_DECIMAL_CURRENCIES,
  assertStripeAmount,
  encodeForm,
  isZeroDecimal,
  isoMinorToStripe,
  majorToStripeAmount,
  normalizeCurrency,
  redact,
  stripeAmountToMajor,
  stripeDecimals,
  stripeToIsoMinor,
} from '../../../src/integrations/providers/stripe/index.js';
import { mergeParams } from '../../../src/integrations/providers/stripe/form.js';

test('zero-decimal list matches docs.stripe.com/currencies (2026-11-05), UGX as a special case', () => {
  assert.deepEqual(
    [...ZERO_DECIMAL_CURRENCIES].sort(),
    ['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'vnd', 'vuv', 'xaf', 'xof', 'xpf'],
  );
  assert.equal(isZeroDecimal('JPY'), true);
  assert.equal(stripeDecimals('inr'), 2);
  assert.equal(stripeDecimals('USD'), 2);
  assert.equal(stripeDecimals('isk'), 2);
  assert.equal(stripeDecimals('ugx'), 2);
  assert.equal(stripeDecimals('kwd'), 3);
  assert.equal(normalizeCurrency(' Usd '), 'usd');
  assert.throws(() => normalizeCurrency('US'), RangeError);
});

test('major <-> Stripe amounts use exact decimal arithmetic', () => {
  assert.equal(majorToStripeAmount('10.99', 'usd'), 1099);
  assert.equal(majorToStripeAmount('2500', 'USD'), 250000);
  assert.equal(majorToStripeAmount(19.99, 'inr'), 1999);
  assert.equal(majorToStripeAmount('0.1', 'eur'), 10);
  assert.equal(majorToStripeAmount('500', 'jpy'), 500);
  assert.equal(majorToStripeAmount('500.00', 'jpy'), 500);
  assert.equal(majorToStripeAmount('5', 'isk'), 500);
  assert.throws(() => majorToStripeAmount('5.50', 'isk'), RangeError);
  assert.throws(() => majorToStripeAmount('1.5', 'jpy'), RangeError);
  assert.throws(() => majorToStripeAmount('10.999', 'usd'), RangeError);
  assert.throws(() => majorToStripeAmount('-1', 'usd'), RangeError);
  assert.throws(() => majorToStripeAmount('1e3', 'usd'), RangeError);
  assert.equal(stripeAmountToMajor(1099, 'usd'), '10.99');
  assert.equal(stripeAmountToMajor(5, 'usd'), '0.05');
  assert.equal(stripeAmountToMajor(500, 'jpy'), '500');
  assert.equal(stripeAmountToMajor(1234, 'kwd'), '1.234');
  assert.equal(stripeAmountToMajor(-250, 'usd'), '-2.50');
});

test('ISO minor units convert only for ISK and UGX; invalid amounts are rejected', () => {
  assert.equal(isoMinorToStripe(5, 'ISK'), 500);
  assert.equal(stripeToIsoMinor(500, 'ugx'), 5);
  assert.equal(isoMinorToStripe(1099, 'usd'), 1099);
  assert.equal(isoMinorToStripe(500, 'jpy'), 500);
  assertStripeAmount(0, 'usd');
  assert.throws(() => assertStripeAmount(0, 'usd', { allowZero: false }), RangeError);
  assert.throws(() => assertStripeAmount(10.5, 'usd'), RangeError);
  assert.throws(() => assertStripeAmount(550, 'isk'), RangeError);
  assert.throws(() => assertStripeAmount(Number.MAX_SAFE_INTEGER + 1, 'usd'), RangeError);
});

test('encodeForm follows Stripe bracket notation', () => {
  const body = encodeForm({
    mode: 'payment',
    line_items: [{ price: 'price_1', quantity: 2 }],
    metadata: { lead: 'L 1&2', empty: '' },
    expand: ['payment_intent'],
    expires_at: new Date('2025-11-05T00:30:00Z'),
    allow_promotion_codes: false,
    description: null,
    skipped: undefined,
    nothing: {},
    none: [],
  });
  assert.equal(
    body,
    'mode=payment&line_items[0][price]=price_1&line_items[0][quantity]=2&metadata[lead]=L+1%262&metadata[empty]=&expand[0]=payment_intent&expires_at=1762302600&allow_promotion_codes=false&description=',
  );
  assert.equal(encodeForm(undefined), '');
  assert.throws(() => encodeForm({ amount: Number.NaN }), TypeError);
  assert.throws(() => encodeForm({ when: new Date('nope') }), TypeError);
});

test('mergeParams deep-merges plain objects and ignores prototype keys', () => {
  const merged = mergeParams({ a: { b: 1, c: 2 }, list: [1] }, JSON.parse('{"a":{"c":3},"list":[2],"__proto__":{"polluted":true}}'));
  assert.deepEqual(merged, { a: { b: 1, c: 3 }, list: [2] });
  assert.equal(/** @type {any} */ ({}).polluted, undefined);
});

test('redact masks known secrets and anything shaped like a Stripe key', () => {
  assert.equal(redact('key sk_live_abcDEF123456 and whsec_abc_123', []), 'key sk_live_[redacted] and whsec_[redacted]');
  assert.equal(redact('token=custom-secret-value', ['custom-secret-value']), 'token=[redacted]');
});
