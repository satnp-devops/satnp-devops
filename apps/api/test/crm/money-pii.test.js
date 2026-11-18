import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currencyExponent, formatMoney, fromMinor, isCurrencyCode, MAX_VALUE_MINOR, minorFromDb, sumByCurrency, toMinor } from '../../src/core/crm/money.js';
import { maskEmail, maskPhone, presentContactMethod, presentContactPii } from '../../src/core/crm/pii.js';

test('currency exponents follow ISO 4217', () => {
  assert.equal(currencyExponent('INR'), 2);
  assert.equal(currencyExponent('USD'), 2);
  assert.equal(currencyExponent('JPY'), 0);
  assert.equal(currencyExponent('KWD'), 3);
  assert.equal(currencyExponent('AED'), 2);
  assert.throws(() => currencyExponent('inr'));
  assert.throws(() => currencyExponent('RUPEES'));
  assert.ok(isCurrencyCode('SGD'));
  assert.ok(!isCurrencyCode('sg'));
});

test('amounts convert to minor units without floating-point drift', () => {
  assert.equal(toMinor('1250.5', 'INR'), 125050);
  assert.equal(toMinor('45,000', 'INR'), 4500000);
  assert.equal(toMinor(0.1 + 0.2, 'USD'), 30);
  assert.equal(toMinor(19.999, 'USD'), 2000, 'rounds half away from zero');
  assert.equal(toMinor('19.995', 'USD'), 2000);
  assert.equal(toMinor('-19.995', 'USD'), -2000);
  assert.equal(toMinor('100', 'JPY'), 100);
  assert.equal(toMinor('1.2345', 'KWD'), 1235);
  assert.equal(toMinor('.5', 'INR'), 50);
  assert.throws(() => toMinor('abc', 'INR'));
  assert.throws(() => toMinor('', 'INR'));
  assert.throws(() => toMinor(Number.NaN, 'INR'));
});

test('minor units convert back and format for people', () => {
  assert.equal(fromMinor(125050, 'INR'), '1250.50');
  assert.equal(fromMinor(5, 'INR'), '0.05');
  assert.equal(fromMinor(-5, 'INR'), '-0.05');
  assert.equal(fromMinor(100, 'JPY'), '100');
  assert.equal(fromMinor(1235, 'KWD'), '1.235');
  assert.equal(formatMoney(1250000, 'INR'), '₹12,500');
  assert.equal(formatMoney(125050, 'INR'), '₹1,250.50');
  assert.equal(formatMoney(1250000000, 'INR'), '₹1,25,00,000', 'Indian digit grouping');
  assert.match(formatMoney(240000, 'USD', 'en-US'), /^\$2,400$/);
  assert.equal(minorFromDb('4500000'), 4500000);
  assert.equal(minorFromDb(null), 0);
  assert.ok(Number.isSafeInteger(MAX_VALUE_MINOR));
});

test('totals are kept per currency', () => {
  assert.deepEqual(
    sumByCurrency([
      { currency: 'INR', valueMinor: 100 },
      { currency: 'USD', value_minor: '250' },
      { currency: 'INR', valueMinor: 50 },
    ]),
    [
      { currency: 'INR', valueMinor: 150 },
      { currency: 'USD', valueMinor: 250 },
    ],
  );
});

test('phones and emails are masked, keeping just enough to recognise them', () => {
  assert.equal(maskPhone('+919812345678'), '+91 •••••••678');
  assert.equal(maskPhone('+971501234567'), '+971 ••••••567');
  assert.equal(maskPhone('9812345678'), '•••••••678');
  assert.equal(maskPhone('12'), '••••');
  assert.equal(maskPhone(null), null);
  assert.equal(maskEmail('priya.sharma@example.com'), 'p•••@example.com');
  assert.equal(maskEmail('not-an-email'), null);
});

test('contact methods and personal fields are masked without contacts.view_pii', () => {
  const method = { id: 'm1', kind: 'phone', value: '98123 45678', normalized: '+919812345678', label: 'Mobile', is_primary: true, verified_at: null, opted_out_at: null };
  assert.deepEqual(presentContactMethod(method, false), {
    id: 'm1',
    kind: 'phone',
    value: '+91 •••••••678',
    normalized: null,
    label: 'Mobile',
    isPrimary: true,
    verifiedAt: null,
    optedOutAt: null,
    masked: true,
  });
  assert.equal(presentContactMethod(method, true).value, '98123 45678');
  assert.equal(presentContactMethod({ ...method, kind: 'email', value: 'A@Example.com', normalized: 'a@example.com' }, false).value, 'a•••@example.com');

  const contact = { primary_phone: '+919812345678', primary_email: 'priya@example.com', date_of_birth: '2009-04-12', address: { city: 'Pune' } };
  assert.deepEqual(presentContactPii(contact, false), {
    primaryPhone: '+91 •••••••678',
    primaryEmail: 'p•••@example.com',
    dateOfBirth: null,
    address: null,
    piiMasked: true,
  });
  assert.deepEqual(presentContactPii(contact, true), {
    primaryPhone: '+919812345678',
    primaryEmail: 'priya@example.com',
    dateOfBirth: '2009-04-12',
    address: { city: 'Pune' },
    piiMasked: false,
  });
});
