import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  DUMMY_PASSWORD_HASH,
  decrypt,
  encrypt,
  hashPassword,
  randomToken,
  sha256,
  verifyPassword,
} from '../src/lib/crypto.js';

test('passwords hash with a random salt and verify', async () => {
  const first = await hashPassword('correct horse battery');
  const second = await hashPassword('correct horse battery');
  assert.notEqual(first, second);
  assert.ok(await verifyPassword('correct horse battery', first));
  assert.ok(!(await verifyPassword('wrong password!!', first)));
  assert.ok(!(await verifyPassword('anything', null)));
  assert.ok(!(await verifyPassword('anything', DUMMY_PASSWORD_HASH)));
});

test('secrets encrypt and decrypt with AES-256-GCM, and tampering is detected', () => {
  const key = randomBytes(32);
  const sealed = encrypt('JBSWY3DPEHPK3PXP', key);
  assert.equal(decrypt(sealed, key), 'JBSWY3DPEHPK3PXP');
  const parts = sealed.split(':');
  parts[3] = Buffer.from('tampered').toString('base64');
  assert.throws(() => decrypt(parts.join(':'), key));
  assert.throws(() => decrypt(sealed, randomBytes(32)));
});

test('tokens are random and hashes are stable', () => {
  assert.notEqual(randomToken(), randomToken());
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
