import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMsgraphConfig, redactConfig, MsgraphError } from '../../../src/integrations/providers/msgraph/index.js';
import { baseConfig, CLIENT_SECRET, WEBHOOK_SECRET } from './helpers.js';

test('valid config gets documented defaults', () => {
  const config = parseMsgraphConfig({ ...baseConfig, previousWebhookSecrets: undefined });
  assert.equal(config.authorityHost, 'https://login.microsoftonline.com');
  assert.equal(config.graphBaseUrl, 'https://graph.microsoft.com/v1.0');
  assert.equal(config.maxConcurrentPerMailbox, 4);
  assert.equal(config.subscriptionLifetimeMinutes, 10_000);
  assert.ok(config.subscriptionLifetimeMinutes <= 10_080);
  assert.equal(config.useImmutableIds, true);
  assert.deepEqual(config.previousWebhookSecrets, []);
});

test('tenant may be a domain but not a multi-tenant alias', () => {
  assert.equal(parseMsgraphConfig({ ...baseConfig, tenantId: 'phoenixgroup.onmicrosoft.com' }).tenantId, 'phoenixgroup.onmicrosoft.com');
  for (const tenantId of ['common', 'organizations', 'consumers', 'not a tenant']) {
    assert.throws(() => parseMsgraphConfig({ ...baseConfig, tenantId }), (err) => err instanceof MsgraphError && err.kind === 'config');
  }
});

test('rejects bad ids, short webhook secrets, http URLs and lifetimes over the Outlook maximum', () => {
  const bad = [
    { clientId: 'my-app' },
    { webhookSecret: 'short' },
    { notificationUrl: 'http://crm.phoenix.example.in/hook' },
    { notificationUrl: 'https://user:pass@crm.phoenix.example.in/hook' },
    { subscriptionLifetimeMinutes: 10_081 },
    { maxConcurrentPerMailbox: 5 },
  ];
  for (const override of bad) {
    assert.throws(() => parseMsgraphConfig({ ...baseConfig, ...override }), (err) => err.kind === 'config', JSON.stringify(override));
  }
});

test('config errors name fields but never echo secret values', () => {
  const secret = 'x'.repeat(10);
  try {
    parseMsgraphConfig({ ...baseConfig, clientId: 'nope', webhookSecret: secret });
    assert.fail('expected a config error');
  } catch (err) {
    assert.equal(err.code, 'invalid_config');
    assert.match(err.message, /webhookSecret/);
    assert.match(err.message, /clientId/);
    assert.ok(!err.message.includes(secret));
    assert.ok(!JSON.stringify(err.toJSON()).includes(secret));
  }
});

test('redactConfig hides every secret', () => {
  const redacted = redactConfig(parseMsgraphConfig(baseConfig));
  const text = JSON.stringify(redacted);
  assert.ok(!text.includes(CLIENT_SECRET));
  assert.ok(!text.includes(WEBHOOK_SECRET));
  assert.equal(redacted.clientSecret, '[REDACTED]');
  assert.deepEqual(redacted.previousWebhookSecrets, ['[REDACTED]']);
  assert.equal(redacted.clientId, baseConfig.clientId);
});
