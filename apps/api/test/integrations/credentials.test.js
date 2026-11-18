import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { decryptCredentials, deriveConnectionSecret, encryptCredentials } from '../../src/integrations/framework/credentials.js';
import { credentialHints, secretHint } from '../../src/integrations/framework/fields.js';
import { TEST_KEY } from './helpers.js';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';

test('credentials round-trip through AES-256-GCM and the ciphertext reveals nothing', () => {
  const secrets = { apiKey: 'SG.abcdefghijklmnop.qrstuvwxyz', webhookSecret: 'whsec_123' };
  const sealed = encryptCredentials(A, secrets, TEST_KEY);
  assert.equal(typeof sealed, 'string');
  assert.ok(!sealed.includes('SG.abc'), 'the secret is not in the stored value');
  assert.deepEqual(decryptCredentials(A, sealed, TEST_KEY), secrets);
  // A fresh IV each time: the same secrets never encrypt to the same value.
  assert.notEqual(encryptCredentials(A, secrets, TEST_KEY), sealed);
});

test('credentials copied onto another connection are refused', () => {
  const sealed = encryptCredentials(A, { token: 't' }, TEST_KEY);
  assert.throws(() => decryptCredentials(B, sealed, TEST_KEY), /different connection/);
});

test('a wrong key or a tampered value fails without leaking the plaintext', () => {
  const sealed = encryptCredentials(A, { token: 'very-secret' }, TEST_KEY);
  const otherKey = randomBytes(32);
  assert.throws(() => decryptCredentials(A, sealed, otherKey), (error) => !String(error.message).includes('very-secret'));
  const flipped = sealed.slice(0, -4) + (sealed.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
  assert.throws(() => decryptCredentials(A, flipped, TEST_KEY), /could not be decrypted/);
});

test('empty credentials decrypt to an empty object; encrypting needs the connection id', () => {
  assert.deepEqual(decryptCredentials(A, null, TEST_KEY), {});
  assert.deepEqual(decryptCredentials(A, encryptCredentials(A, {}, TEST_KEY), TEST_KEY), {});
  assert.throws(() => encryptCredentials(null, {}, TEST_KEY), /connection id/);
});

test('derived connection secrets are stable per connection and purpose, and differ otherwise', () => {
  const one = deriveConnectionSecret(A, 'mock-webhook', TEST_KEY);
  assert.equal(deriveConnectionSecret(A, 'mock-webhook', TEST_KEY), one);
  assert.notEqual(deriveConnectionSecret(B, 'mock-webhook', TEST_KEY), one);
  assert.notEqual(deriveConnectionSecret(A, 'other', TEST_KEY), one);
});

test('hints show only the last characters of secret fields', () => {
  assert.match(secretHint('SG.abcdefghijklmnop'), /^•+mnop$/);
  const fields = [
    { key: 'apiKey', label: 'API key', input: 'text', secret: true },
    { key: 'region', label: 'Region', input: 'text' },
  ];
  const hints = credentialHints(fields, { apiKey: 'SG.abcdefghijklmnop', region: 'in' });
  assert.deepEqual(Object.keys(hints), ['apiKey']);
  assert.ok(!hints.apiKey.includes('abcdefghijkl'));
});
