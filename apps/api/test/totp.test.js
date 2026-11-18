import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  generateTotpSecret,
  hotp,
  normaliseRecoveryCode,
  totp,
  verifyTotp,
} from '../src/lib/totp.js';

// RFC 6238 appendix B test vectors (SHA-1, 8 digits, secret "12345678901234567890").
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');
const VECTORS = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

test('totp matches the RFC 6238 test vectors', () => {
  for (const [seconds, expected] of VECTORS) {
    assert.equal(totp(RFC_SECRET, { time: seconds * 1000, digits: 8 }), expected);
  }
});

test('hotp matches the RFC 4226 test vectors', () => {
  const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
  expected.forEach((code, counter) => assert.equal(hotp(RFC_SECRET, counter), code));
});

test('base32 round-trips arbitrary bytes', () => {
  for (let i = 0; i < 50; i += 1) {
    const bytes = Buffer.from(Array.from({ length: i }, (_, j) => (j * 37 + i) % 256));
    assert.deepEqual(base32Decode(base32Encode(bytes)), bytes);
  }
  assert.equal(base32Encode(RFC_SECRET), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
});

test('verifyTotp accepts the current code and one step of drift, and rejects others', () => {
  const secret = generateTotpSecret();
  const key = base32Decode(secret);
  const now = 1_800_000_000_000;
  const current = totp(key, { time: now });
  const previous = totp(key, { time: now - 30_000 });
  const old = totp(key, { time: now - 120_000 });
  assert.notEqual(verifyTotp(secret, current, { time: now }), null);
  assert.notEqual(verifyTotp(secret, previous, { time: now }), null);
  assert.equal(verifyTotp(secret, old, { time: now }), null);
  assert.equal(verifyTotp(secret, '12345', { time: now }), null);
  assert.equal(verifyTotp(secret, 'abcdef', { time: now }), null);
});

test('recovery codes are unique and normalise for comparison', () => {
  const codes = generateRecoveryCodes(8);
  assert.equal(new Set(codes).size, 8);
  for (const code of codes) {
    assert.match(code, /^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
    assert.equal(normaliseRecoveryCode(code.toLowerCase()), code.replace('-', ''));
  }
});
