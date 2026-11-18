import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SCOPES, createGoogleClient, parseConfig, redact, serviceAccountFromJson } from '../../../src/integrations/providers/google/index.js';
import { CHANNEL_SECRET, makeClient, serviceAccountConfig, testPrivateKeyPem } from './_helpers.js';

test('defaults are applied', () => {
  const config = parseConfig(serviceAccountConfig());
  assert.deepEqual(config.scopes, [...DEFAULT_SCOPES]);
  assert.equal(config.calendarId, 'primary');
  assert.equal(config.defaultTimeZone, 'Asia/Kolkata');
  assert.equal(config.webhook.ttlSeconds, 604800);
  assert.equal(config.timeoutMs, 15000);
  assert.equal(config.endpoints.calendarBaseUrl, 'https://www.googleapis.com/calendar/v3');
});

test('invalid config reports field paths, never values', () => {
  assert.throws(
    () =>
      parseConfig({
        auth: { type: 'oauth_user', clientId: 'cid', clientSecret: '', refreshToken: '1//super-secret-refresh' },
        webhook: { address: 'http://insecure.example', channelSecret: 'short-secret-value' },
      }),
    (error) => {
      assert.equal(error.code, 'config_invalid');
      const text = JSON.stringify({ message: error.message, details: error.details });
      assert.match(text, /auth\.clientSecret/);
      assert.match(text, /webhook\.address/);
      assert.match(text, /webhook\.channelSecret/);
      assert.ok(!text.includes('super-secret-refresh'));
      assert.ok(!text.includes('short-secret-value'));
      return true;
    },
  );
});

test('an unparseable private key fails fast without echoing it', () => {
  const config = serviceAccountConfig();
  config.auth.privateKey = '-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----\n';
  assert.throws(() => createGoogleClient(config, { fetch: async () => new Response('{}') }), (error) => {
    assert.equal(error.code, 'config_invalid');
    assert.ok(!error.message.includes('not-a-key'));
    return true;
  });
});

test('serviceAccountFromJson maps a key file and normalises escaped newlines', () => {
  const json = JSON.stringify({
    type: 'service_account',
    project_id: 'phoenix-crm-test',
    private_key_id: 'abc123',
    private_key: testPrivateKeyPem.replace(/\n/g, '\\n'),
    client_email: 'svc@phoenix-crm-test.iam.gserviceaccount.com',
  });
  const auth = serviceAccountFromJson(json, { subject: 'admin@school.example.in' });
  assert.equal(auth.privateKeyId, 'abc123');
  const config = parseConfig({ auth: { ...auth, privateKey: testPrivateKeyPem.replace(/\n/g, '\\n') } });
  assert.equal(config.auth.privateKey, testPrivateKeyPem);
  assert.throws(() => serviceAccountFromJson({ type: 'authorized_user' }), { code: 'config_invalid' });
});

test('describe() never includes secrets', () => {
  const { client } = makeClient([]);
  const text = JSON.stringify(client.describe());
  assert.ok(!text.includes('PRIVATE KEY'));
  assert.ok(!text.includes(CHANNEL_SECRET));
  assert.match(text, /phoenix-calendar@phoenix-crm-test/);
});

test('redact removes configured secrets, bearer tokens and PEM blocks', () => {
  const out = redact(`token=ya29.abcdef ${CHANNEL_SECRET} Authorization: Bearer abc.def ${testPrivateKeyPem}`, [CHANNEL_SECRET]);
  assert.ok(!out.includes(CHANNEL_SECRET));
  assert.ok(!out.includes('ya29.abcdef'));
  assert.ok(!out.includes('abc.def'));
  assert.ok(!out.includes('BEGIN PRIVATE KEY'));
});
