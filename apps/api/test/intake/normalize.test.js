import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emailMailboxKey,
  normalizeEmail,
  normalizeName,
  normalizePhone,
  referenceNormalizers,
  resolveNormalizers,
} from '../../src/core/intake/normalize.js';

test('Indian numbers in every common written form become one E.164 number', () => {
  const forms = [
    '9876543210',
    '98765 43210',
    '98765-43210',
    '098765 43210',
    '09876543210',
    '919876543210',
    '+91 98765 43210',
    '+91-98765-43210',
    '(+91) 98765 43210',
    '+91 0 98765 43210',
    '0091 98765 43210',
    '+91.98765.43210',
    ' 9876543210 ',
  ];
  for (const form of forms) assert.equal(normalizePhone(form), '+919876543210', form);
});

test('Indian landlines with an STD code are kept', () => {
  assert.equal(normalizePhone('011 2345 6789'), '+911123456789');
  assert.equal(normalizePhone('080-23456789'), '+918023456789');
});

test('extensions are dropped', () => {
  assert.equal(normalizePhone('080 2345 6789 ext. 204'), '+918023456789');
  assert.equal(normalizePhone('+91 80 2345 6789 x12'), '+918023456789');
});

test('international numbers keep their country code', () => {
  assert.equal(normalizePhone('+971 50 123 4567'), '+971501234567');
  assert.equal(normalizePhone('00971501234567'), '+971501234567');
  assert.equal(normalizePhone('+1 (415) 555-0100'), '+14155550100');
});

test('a default country other than India applies its calling code and drops the trunk zero', () => {
  assert.equal(normalizePhone('050 123 4567', { defaultCountry: 'AE' }), '+971501234567');
  assert.equal(normalizePhone('07911 123456', { defaultCountry: 'GB' }), '+447911123456');
  assert.equal(normalizePhone('12345', { defaultCountry: 'AE' }), null, 'too short');
  assert.equal(normalizePhone('0501234567', { defaultCountry: 'ZZ' }), null, 'unknown country');
});

test('junk and placeholders are rejected', () => {
  for (const junk of [null, undefined, '', '   ', 'call me', '12345', '0000000000', '9999999999', '1234567890', '98765432101234', '+0123', 'abc9876543210', '+91 12345']) {
    assert.equal(normalizePhone(junk), null, String(junk));
  }
});

test('numbers are accepted as numbers too (spreadsheets)', () => {
  assert.equal(normalizePhone(9876543210), '+919876543210');
});

test('emails are trimmed, lower-cased and unwrapped', () => {
  assert.equal(normalizeEmail('  Rahul.Sharma@Gmail.COM '), 'rahul.sharma@gmail.com');
  assert.equal(normalizeEmail('mailto:priya@example.in'), 'priya@example.in');
  assert.equal(normalizeEmail('Priya Iyer <Priya@Example.in>'), 'priya@example.in');
  assert.equal(normalizeEmail('priya@example.in.'), 'priya@example.in');
});

test('things that are not addresses are rejected', () => {
  for (const bad of [null, undefined, '', 'priya', 'priya@', '@example.com', 'priya@example', 'priya @example.com', 'a@b.c', 'pri,ya@example.com', `${'a'.repeat(250)}@x.com`]) {
    assert.equal(normalizeEmail(bad), null, String(bad));
  }
});

test('mailbox keys see Gmail dots, googlemail and +tags as the same mailbox', () => {
  assert.equal(emailMailboxKey('rahul.sharma@gmail.com'), 'rahulsharma@gmail.com');
  assert.equal(emailMailboxKey('rahulsharma+jee@googlemail.com'), 'rahulsharma@gmail.com');
  assert.equal(emailMailboxKey('rahul.sharma+jee@outlook.com'), 'rahul.sharma@outlook.com', 'dots matter outside Gmail');
  assert.equal(emailMailboxKey('nonsense'), 'nonsense');
});

test('names are display-cleaned', () => {
  assert.equal(normalizeName('  RAHUL   SHARMA '), 'Rahul Sharma');
  assert.equal(normalizeName('priya iyer'), 'Priya Iyer');
  assert.equal(normalizeName('"Anil Kumar",'), 'Anil Kumar');
  assert.equal(normalizeName("o'brien d'souza"), "O'Brien D'Souza");
  assert.equal(normalizeName('McDonald Fernandes'), 'McDonald Fernandes', 'mixed case is left alone');
  assert.equal(normalizeName('राहुल शर्मा'), 'राहुल शर्मा');
  assert.equal(normalizeName(null), '');
  assert.equal(normalizeName(' - '), '');
});

test('normalisers can be overridden one at a time', () => {
  const phone = () => '+10000000000';
  const resolved = resolveNormalizers({ phone });
  assert.equal(resolved.phone, phone);
  assert.equal(resolved.email, referenceNormalizers.email);
  assert.equal(resolveNormalizers().name, referenceNormalizers.name);
});

test('hostile input is rejected quickly', () => {
  const started = Date.now();
  assert.equal(normalizePhone(`1${' '.repeat(100_000)}`), null);
  assert.equal(normalizeEmail(`${'a'.repeat(100_000)}@x.com`), null);
  assert.ok(Date.now() - started < 500);
});
