import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildRegistry } from '../../src/registry.js';
import {
  apiKeyAccess,
  bearerToken,
  generateApiKey,
  hashApiKey,
  keyStatus,
  looksLikeApiKey,
  scopeProblems,
  serviceUserFor,
} from '../../src/modules/integrations/apiKeys/keys.js';

const registry = buildRegistry();

test('keys are phx_ plus 43 random characters; only their sha256 and a short prefix are kept', () => {
  const one = generateApiKey();
  const two = generateApiKey();
  assert.match(one.secret, /^phx_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(one.secret, two.secret);
  assert.equal(one.hash, createHash('sha256').update(one.secret).digest('hex'));
  assert.equal(hashApiKey(one.secret), one.hash);
  assert.equal(one.prefix, one.secret.slice(0, 12));
  assert.ok(!one.hash.includes(one.secret.slice(4)), 'the hash does not contain the key');
  assert.ok(looksLikeApiKey(one.secret));
  assert.ok(!looksLikeApiKey('phx_short'));
  assert.ok(!looksLikeApiKey(`sk_${one.secret.slice(4)}`));
});

test('the Authorization header must be Bearer <token>', () => {
  assert.equal(bearerToken('Bearer phx_abc'), 'phx_abc');
  assert.equal(bearerToken('bearer   phx_abc  '), 'phx_abc');
  assert.equal(bearerToken('Basic dXNlcjpwYXNz'), null);
  assert.equal(bearerToken('Bearer'), null);
  assert.equal(bearerToken(undefined), null);
});

test('scopes are known permission keys the creator holds, never api_keys.*, wildcards or :own', () => {
  const holds = (scope) => scope !== 'users.manage';
  const problems = scopeProblems(registry, ['contacts.view', 'users.manage', 'api_keys.manage', 'contacts.*', 'deals.view:own', 'nope.view'], holds);
  assert.deepEqual(
    problems.map((p) => p.index),
    [1, 2, 3, 4, 5],
  );
  assert.match(problems[0].message, /permissions you hold/);
  assert.match(problems[1].message, /cannot manage API keys/);
  assert.deepEqual(scopeProblems(registry, ['contacts.view', 'integrations.view'], holds), []);
});

test("a key's access context has exactly its scopes at its unit and below", () => {
  const company = { id: 'c1', path: 'g1.c1', name: 'SatnPaper', type: 'company', root_id: 'g1' };
  const access = apiKeyAccess({ id: 'k1', name: 'Website', scopes: ['contacts.view', 'integrations.view'], service_user_id: 'u1' }, company);
  assert.equal(access.userId, 'u1');
  assert.equal(access.mfaRequired, false);
  assert.ok(access.can('contacts.view', 'g1.c1'));
  assert.ok(access.can('contacts.view', 'g1.c1.b1'), 'inherited down the tree');
  assert.ok(!access.can('contacts.manage', 'g1.c1'), 'writes need their own scope');
  assert.ok(!access.can('contacts.view', 'g1.c2'), 'other companies are out of reach');
  assert.ok(!access.can('contacts.view', 'g1'), 'not at the group either');
  assert.ok(access.canSee('g1'), 'ancestors are visible for context, like for people');
  assert.ok(!access.canSee('g1.c2'));
  assert.equal(access.level('contacts.view', 'g1.c1'), 'all');
  assert.deepEqual(access.rootsFor('contacts.view'), ['g1.c1']);
  assert.deepEqual(access.groupIds(), ['g1']);
});

test('revoked and expired keys are not active', () => {
  const now = Date.parse('2026-11-06T10:00:00Z');
  assert.equal(keyStatus({ revoked_at: null, expires_at: null }, now), 'active');
  assert.equal(keyStatus({ revoked_at: null, expires_at: '2026-11-07T00:00:00Z' }, now), 'active');
  assert.equal(keyStatus({ revoked_at: null, expires_at: '2026-11-06T10:00:00Z' }, now), 'expired');
  assert.equal(keyStatus({ revoked_at: '2026-11-01T00:00:00Z', expires_at: null }, now), 'revoked');
});

test('the service user of a key can never sign in', () => {
  const user = serviceUserFor('k1', 'Website forms');
  assert.equal(user.status, 'disabled');
  assert.equal(user.password_hash, null);
  assert.match(user.email, /@keys\.phoenix\.invalid$/);
  assert.equal(user.name, 'API key: Website forms');
});
