import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseConnection } from '../../src/integrations/framework/resolve.js';

// getAdapter() resolution rules (framework/resolve.js chooseConnection, docs/platform/INTEGRATIONS.md).

const KIND = 'messaging.whatsapp';
const conn = (id, extra = {}) => ({ id, kind: KIND, provider: 'whatsapp_cloud', status: 'active', is_default: false, created_at: '2026-11-01T00:00:00Z', ...extra });

const choose = (candidates, options = {}) => chooseConnection({ candidates, kind: KIND, mocksAllowed: false, companyName: 'SatnPaper', ...options });

test("the company's default connection wins, then the oldest active one", () => {
  const older = conn('a', { created_at: '2026-10-01T00:00:00Z' });
  const preferred = conn('b', { is_default: true, created_at: '2026-11-02T00:00:00Z' });
  assert.equal(choose([older, preferred]).connection.id, 'b');
  assert.equal(choose([conn('c'), older]).connection.id, 'a');
});

test('disabled connections and other kinds are skipped', () => {
  const disabledDefault = conn('a', { is_default: true, status: 'disabled' });
  const email = conn('e', { kind: 'messaging.email' });
  assert.equal(choose([disabledDefault, email, conn('b')]).connection.id, 'b');
});

test('without a usable connection: the built-in mock when mocks are allowed, else integration_not_connected', () => {
  assert.deepEqual(choose([], { mocksAllowed: true }), { fallback: true });
  assert.throws(
    () => choose([conn('a', { status: 'disabled' })]),
    (error) => error.code === 'integration_not_connected' && error.status === 409 && /SatnPaper has no active WhatsApp connection/.test(error.message),
  );
});

test('mock connections are used only while mocks are allowed; production never falls back silently', () => {
  const mock = conn('m', { provider: 'mock', is_default: true });
  assert.equal(choose([mock], { mocksAllowed: true }).connection.id, 'm');
  assert.throws(() => choose([mock]), (error) => error.code === 'integration_not_connected');
  // A real connection is preferred over a mock default when mocks are off.
  assert.equal(choose([mock, conn('r')]).connection.id, 'r');
});

test('a named connection is that one or an error, never another', () => {
  const a = conn('a', { is_default: true });
  const b = conn('b');
  assert.equal(choose([a, b], { connectionId: 'b' }).connection.id, 'b');
  assert.throws(() => choose([a], { connectionId: 'zzz', mocksAllowed: true }), (error) => error.code === 'integration_unavailable');
  assert.throws(() => choose([conn('e', { kind: 'messaging.email' })], { connectionId: 'e' }), (error) => error.code === 'integration_unavailable');
  assert.throws(() => choose([conn('d', { status: 'disabled' })], { connectionId: 'd' }), (error) => error.code === 'integration_unavailable' && /disabled/.test(error.message));
  assert.throws(() => choose([conn('m', { provider: 'mock' })], { connectionId: 'm' }), (error) => error.code === 'integration_mocks_disabled');
});
