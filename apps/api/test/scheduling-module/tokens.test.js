import { test } from 'node:test';
import assert from 'node:assert/strict';
import { macWithKey, manageTokenFor, newNonce, signToken, verifyToken } from '../../src/modules/scheduling/tokens.js';

const ID = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';

test('a signed token round-trips its id, expiry and nonce', () => {
  const nonce = newNonce();
  const expiresAt = new Date(Date.now() + 3600_000);
  const token = signToken({ kind: 'manage', id: ID, expiresAt, nonce });
  assert.equal(token.length, 59);
  assert.match(token, /^[A-Za-z0-9_-]+$/);
  const result = verifyToken(token, 'manage');
  assert.equal(result.ok, true);
  assert.equal(result.id, ID);
  assert.equal(result.nonce, nonce);
  assert.equal(result.expiresAt.getTime(), Math.floor(expiresAt.getTime() / 1000) * 1000);
});

test('tokens without expiry never expire', () => {
  const token = signToken({ kind: 'link', id: ID });
  const result = verifyToken(token, 'link', { now: Date.parse('2099-01-01T00:00:00Z') });
  assert.equal(result.ok, true);
  assert.equal(result.expiresAt, null);
});

test('changing any character of a token breaks it', () => {
  const token = signToken({ kind: 'link', id: ID });
  for (let i = 0; i < token.length; i += 1) {
    const replacement = token[i] === 'A' ? 'B' : 'A';
    const altered = token.slice(0, i) + replacement + token.slice(i + 1);
    assert.equal(verifyToken(altered, 'link').ok, false, `position ${i}`);
  }
});

test('a token is accepted only for its own kind', () => {
  const link = signToken({ kind: 'link', id: ID });
  const manage = signToken({ kind: 'manage', id: ID, nonce: newNonce() });
  assert.equal(verifyToken(link, 'manage').ok, false);
  assert.equal(verifyToken(manage, 'link').ok, false);
});

test('expired tokens say so; forged ones are just invalid', () => {
  const now = Date.parse('2026-11-10T10:00:00Z');
  const expired = signToken({ kind: 'link', id: ID, expiresAt: now - 1000 });
  assert.deepEqual(verifyToken(expired, 'link', { now }), { ok: false, reason: 'expired', id: ID });
  const body = Buffer.from(expired, 'base64url').subarray(0, 28);
  // The same body (and expiry) with a MAC made with another key.
  const forged = Buffer.concat([body, macWithKey(Buffer.alloc(32, 1), body)]).toString('base64url');
  assert.deepEqual(verifyToken(forged, 'link', { now: now - 60_000 }), { ok: false, reason: 'invalid' });
});

test('junk is refused without throwing', () => {
  for (const junk of [undefined, null, 42, '', 'x'.repeat(59), 'short', '!'.repeat(59), `${signToken({ kind: 'link', id: ID })}A`]) {
    assert.equal(verifyToken(junk, 'link').ok, false);
  }
  assert.throws(() => signToken({ kind: 'other', id: ID }));
  assert.throws(() => signToken({ kind: 'link', id: 'not-a-uuid' }));
});

test('manage links last until 30 days after the meeting and carry the booking nonce', () => {
  const end = Date.parse('2026-11-20T10:30:00Z');
  const token = manageTokenFor({ id: ID, end_at: new Date(end), token_nonce: 'a1b2c3d4e5f6' });
  const ok = verifyToken(token, 'manage', { now: end + 29 * 86_400_000 });
  assert.equal(ok.ok, true);
  assert.equal(ok.nonce, 'a1b2c3d4e5f6');
  assert.equal(verifyToken(token, 'manage', { now: end + 31 * 86_400_000 }).reason, 'expired');
});
