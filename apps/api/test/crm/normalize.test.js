import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  displayName,
  emailDomain,
  isFreeEmailDomain,
  nameSimilarity,
  namesLikelySame,
  normalizeDomain,
  normalizeEmail,
  normalizeName,
  normalizePhone,
  phoneSearchTokens,
  splitE164,
  splitFullName,
  toE164,
} from '../../src/core/crm/normalize.js';

test('Indian numbers in every common shape normalise to the same E.164', () => {
  const shapes = [
    '9812345678',
    '98123 45678',
    '98123-45678',
    '098123 45678',
    '+91 98123 45678',
    '+91-98123-45678',
    '(+91) 98123 45678',
    '+91 098123 45678',
    '919812345678',
    '00919812345678',
    'tel:+919812345678',
    ' 98.123.456.78 ',
  ];
  for (const shape of shapes) assert.equal(toE164(shape), '+919812345678', shape);
  assert.deepEqual(normalizePhone('98123 45678'), { e164: '+919812345678', country: 'IN', national: '9812345678' });
});

test('landlines with an STD code work, with or without the trunk 0', () => {
  assert.equal(toE164('020 2612 3456'), '+912026123456');
  assert.equal(toE164('080-6543-2100'), '+918065432100');
  assert.equal(toE164('+91 80 6543 2100'), '+918065432100');
});

test('international numbers keep their own country code', () => {
  assert.deepEqual(normalizePhone('+971 50 123 4567'), { e164: '+971501234567', country: 'AE', national: '501234567' });
  assert.equal(toE164('+1 (415) 555-0100'), '+14155550100');
  assert.equal(toE164('+44 (0)7911 123456'), '+447911123456');
  assert.equal(toE164('0044 7911 123456'), '+447911123456');
  assert.equal(toE164('+65 9123 4567'), '+6591234567');
  // A country we have no table for is still accepted if it looks like E.164.
  assert.deepEqual(normalizePhone('+86 138 0013 8000'), { e164: '+8613800138000', country: null, national: '8613800138000' });
});

test('the default country decides how national numbers are read', () => {
  assert.equal(toE164('050 123 4567', 'AE'), '+971501234567');
  assert.equal(toE164('9123 4567', 'SG'), '+6591234567');
  assert.equal(toE164('(415) 555-0100', 'US'), '+14155550100');
  assert.equal(toE164('1 415 555 0100', 'US'), '+14155550100');
  assert.equal(toE164('9812345678', 'XX'), '+919812345678', 'unknown countries fall back to India');
});

test('things that are not phone numbers are rejected', () => {
  for (const bad of ['', '   ', '12345', '98123456', '981234567890', '+91 12345', '1800 123 4567', 'call me', '98123 45678 ext 2', '+', null, undefined, {}]) {
    assert.equal(normalizePhone(bad), null, String(bad));
  }
  assert.equal(toE164('0123456789'), null, 'Indian numbers do not start with 0 or 1 after the trunk prefix');
});

test('E.164 numbers split into calling code and national number, and expand into search tokens', () => {
  assert.deepEqual(splitE164('+919812345678'), { callingCode: '91', national: '9812345678', country: 'IN' });
  assert.deepEqual(splitE164('+971501234567'), { callingCode: '971', national: '501234567', country: 'AE' });
  assert.equal(splitE164('9812345678'), null);
  assert.deepEqual(phoneSearchTokens('+919812345678'), ['+919812345678', '919812345678', '9812345678']);
});

test('emails are trimmed and lower-cased; invalid ones are rejected', () => {
  assert.equal(normalizeEmail('  Priya.Sharma@Example.COM '), 'priya.sharma@example.com');
  assert.equal(normalizeEmail('mailto:Ravi@school.example'), 'ravi@school.example');
  for (const bad of ['', 'priya', 'priya@', '@example.com', 'priya@example', 'pri ya@example.com', 'a@b.c', 42]) {
    assert.equal(normalizeEmail(bad), null, String(bad));
  }
  assert.equal(emailDomain('Director@ApexCoaching.example'), 'apexcoaching.example');
  assert.ok(isFreeEmailDomain('gmail.com'));
  assert.ok(isFreeEmailDomain('Rediffmail.com'));
  assert.ok(!isFreeEmailDomain('apexcoaching.example'));
});

test('domains are reduced to the bare host', () => {
  assert.equal(normalizeDomain('https://www.Greenwood.example/about?x=1'), 'greenwood.example');
  assert.equal(normalizeDomain('www2.school.example:8080'), 'school.example');
  assert.equal(normalizeDomain('office@apex.example'), 'apex.example');
  assert.equal(normalizeDomain('apex.example.'), 'apex.example');
  assert.equal(normalizeDomain('not a domain'), null);
  assert.equal(normalizeDomain('localhost'), null);
});

test('names are normalised for sorting and matching', () => {
  assert.equal(normalizeName("Mrs. Priya  D'Souza"), 'priya dsouza');
  assert.equal(normalizeName('Dr. RAJESH   Kumar-Iyer'), 'rajesh kumar iyer');
  assert.equal(normalizeName('Zoë Fernandes'), 'zoe fernandes');
  assert.equal(normalizeName('Master Aarav'), 'aarav');
  assert.equal(normalizeName('Mr'), 'mr', 'a lone title is kept rather than emptied');
  assert.equal(normalizeName('प्रिया शर्मा'), 'प्रिया शर्मा', 'Devanagari is kept');
  assert.equal(displayName('  Priya ', ' Sharma  '), 'Priya Sharma');
  assert.equal(displayName('Priya', null), 'Priya');
  assert.deepEqual(splitFullName('  Priya   Rani Sharma '), { firstName: 'Priya', lastName: 'Rani Sharma' });
  assert.deepEqual(splitFullName('Priya'), { firstName: 'Priya', lastName: null });
});

test('name similarity behaves like pg_trgm', () => {
  assert.equal(nameSimilarity('Priya Sharma', 'priya sharma'), 1);
  assert.ok(nameSimilarity('Aarav Sharma', 'Arav Sharma') > 0.7);
  assert.ok(nameSimilarity('Priya Sharma', 'Aarav Sharma') < 0.4);
  assert.equal(nameSimilarity('', 'Priya'), 0);
});

test('namesLikelySame tells a person from their family members', () => {
  assert.equal(namesLikelySame('Priya Sharma', 'Mrs Priya Sharma'), true);
  assert.equal(namesLikelySame('Priya', 'Priya Sharma'), true, 'a shorter form of the same name');
  assert.equal(namesLikelySame('P Sharma', 'Priya Sharma'), true, 'an initial');
  assert.equal(namesLikelySame('Aarav Sharma', 'Arav Sharma'), true, 'a spelling variant');
  assert.equal(namesLikelySame('Priya Sharma', 'Aarav Sharma'), false, 'parent and child sharing a number');
  assert.equal(namesLikelySame('Rohan Mehta', 'Rohit Mehta'), false, 'siblings');
  assert.equal(namesLikelySame('', 'Priya Sharma'), null, "can't tell without both names");
});
