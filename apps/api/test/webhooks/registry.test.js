import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry } from '../../src/core/registry.js';
import { buildRegistry } from '../../src/registry.js';
import { handlersFor, parseHandlerKey } from '../../src/core/webhooks/handlers.js';

// Modules declare webhookHandlers ("<kind|provider>:<event>") and jobs in module.js; the registry
// validates both at start-up (core/webhooks/handlers.js, core/jobs/definitions.js).

const noop = async () => {};

test('valid handler keys: a kind, a provider or *, with one of its events or *', () => {
  assert.deepEqual(parseHandlerKey('payments:payment.captured'), { source: 'payments', topic: 'payment.captured' });
  assert.deepEqual(parseHandlerKey('messaging.whatsapp:message.received'), { source: 'messaging.whatsapp', topic: 'message.received' });
  assert.deepEqual(parseHandlerKey('razorpay:refund.processed'), { source: 'razorpay', topic: 'refund.processed' });
  assert.deepEqual(parseHandlerKey('mock:esign.completed'), { source: 'mock', topic: 'esign.completed' });
  assert.deepEqual(parseHandlerKey('meetings:*'), { source: 'meetings', topic: '*' });
  assert.deepEqual(parseHandlerKey('*:payment.failed'), { source: '*', topic: 'payment.failed' });
});

test('handler keys that could never fire are rejected with a sentence', () => {
  const cases = [
    ['payment.captured', /must look like/],
    ['payments:', /must look like/],
    ['a:b:c', /must look like/],
    ['payment:payment.captured', /not a kind or provider/],
    ['ai:anything', /not a kind or provider that receives webhooks/], // the AI kind has no webhooks
    ['storage:*', /not a kind or provider that receives webhooks/],
    ['payments:payment.capture', /has no "payment.capture" event/],
    ['razorpay:message.received', /has no "message.received" event/], // a provider only has its kind's events
    ['*:no.such_event', /has no/],
  ];
  for (const [key, message] of cases) assert.throws(() => parseHandlerKey(key), message, key);
});

test('a module that declares webhook handlers gets them registered with stable ids', () => {
  const first = async () => {};
  const second = async () => {};
  const registry = createRegistry([
    { name: 'billing', webhookHandlers: { 'payments:payment.captured': [first, second], 'razorpay:*': noop } },
    { name: 'audit_trail', webhookHandlers: { '*:*': noop } },
  ]);
  const list = registry.webhookHandlers.get('payments:payment.captured');
  assert.deepEqual(
    list.map((h) => h.id),
    ['billing/payments:payment.captured/0', 'billing/payments:payment.captured/1'],
  );
  assert.equal(list[0].handle, first);
  assert.equal(list[0].module, 'billing');

  // Most specific first: kind + event, kind, provider + event, provider, then catch-alls.
  const matched = handlersFor(registry, { kind: 'payments', provider: 'razorpay', type: 'payment.captured' });
  assert.deepEqual(
    matched.map((h) => h.id),
    ['billing/payments:payment.captured/0', 'billing/payments:payment.captured/1', 'billing/razorpay:*/0', 'audit_trail/*:*/0'],
  );
  // Another provider of the same kind doesn't get the razorpay-only handler.
  assert.deepEqual(
    handlersFor(registry, { kind: 'payments', provider: 'stripe', type: 'payment.captured' }).map((h) => h.module),
    ['billing', 'billing', 'audit_trail'],
  );
  assert.deepEqual(handlersFor(registry, { kind: 'esign', provider: 'digio', type: 'esign.signed' }).map((h) => h.id), ['audit_trail/*:*/0']);
});

test("a module's own webhook source: its events go only to its handlers", () => {
  const source = { kind: 'messaging.whatsapp', events: ['message.in', 'message.status'], verifyWebhook: noop, parseWebhook: noop };
  const registry = createRegistry([
    { name: 'listener', webhookHandlers: { 'tool:message.in': noop, 'messaging.whatsapp:message.status': noop, '*:*': noop } },
    { name: 'tool_module', webhookSources: { tool: source } }, // declared by a later module: still known
  ]);
  assert.equal(registry.webhookSources.get('tool').module, 'tool_module');
  assert.deepEqual(handlersFor(registry, { kind: 'messaging.whatsapp', provider: 'tool', type: 'message.in' }).map((h) => h.id), ['listener/tool:message.in/0']);
  assert.deepEqual(handlersFor(registry, { kind: 'messaging.whatsapp', provider: 'tool', type: 'message.status' }), []);
  assert.deepEqual(
    handlersFor(registry, { kind: 'messaging.whatsapp', provider: 'mock', type: 'message.status' }).map((h) => h.id),
    ['listener/messaging.whatsapp:message.status/0', 'listener/*:*/0'],
  );

  assert.throws(() => createRegistry([{ name: 'm', webhookHandlers: { 'tool:message.out': noop } }, { name: 't', webhookSources: { tool: source } }]), /has no "message.out" event/);
  assert.throws(() => createRegistry([{ name: 't', webhookSources: { mock: source } }]), /Duplicate webhook source "mock"/);
  assert.throws(() => createRegistry([{ name: 't', webhookSources: { tool: { ...source, kind: 'storage' } } }]), /not a kind that receives webhooks/);
  assert.throws(() => createRegistry([{ name: 't', webhookSources: { tool: { ...source, parseWebhook: undefined } } }]), /needs verifyWebhook/);
  assert.throws(() => createRegistry([{ name: 't', webhookSources: { tool: { ...source, events: [] } } }]), /lists no events/);
});

test('bad webhook handler declarations fail at start-up', () => {
  assert.throws(() => createRegistry([{ name: 'm', webhookHandlers: { 'payments:payment.captured': 'not a function' } }]), /must be a function/);
  assert.throws(() => createRegistry([{ name: 'm', webhookHandlers: { 'payments:payment.captured': [] } }]), /has no handlers/);
  assert.throws(() => createRegistry([{ name: 'm', webhookHandlers: { 'payments:paid': noop } }]), /has no "paid" event/);
});

test('jobs: a function or { handler, attempts, backoffMs, repeat, label, data }', () => {
  const registry = createRegistry([
    {
      name: 'deals',
      jobs: {
        'deals.bulk': noop,
        'deals.import': { handler: noop, attempts: 3, backoffMs: 500, label: 'Import deals' },
        'deals.nightly': { handler: noop, repeat: { pattern: '0 2 * * *', tz: 'Asia/Kolkata' }, data: { full: true } },
        'deals.every_minute': { handler: noop, repeat: { every: 60_000 } },
      },
    },
  ]);
  assert.equal(registry.jobs.get('deals.bulk').label, 'deals.bulk');
  assert.equal(registry.jobs.get('deals.bulk').attempts, null);
  assert.equal(registry.jobs.get('deals.import').attempts, 3);
  assert.equal(registry.jobs.get('deals.import').module, 'deals');
  assert.deepEqual(registry.jobs.get('deals.nightly').repeat, { pattern: '0 2 * * *', tz: 'Asia/Kolkata' });
  assert.deepEqual(registry.jobs.get('deals.nightly').data, { full: true });
  assert.equal(registry.jobs.get('deals.every_minute').repeat.every, 60_000);
});

test('bad job declarations fail at start-up with the job named', () => {
  const cases = [
    [{ Deals: noop }, /module\.action/],
    [{ bulk: noop }, /module\.action/],
    [{ 'deals.bulk': { attempts: 3 } }, /handler must be a function/],
    [{ 'deals.bulk': { handler: noop, retries: 3 } }, /unknown option\(s\) retries/],
    [{ 'deals.bulk': { handler: noop, attempts: 0 } }, /attempts must be a whole number/],
    [{ 'deals.bulk': { handler: noop, attempts: 2.5 } }, /attempts must be a whole number/],
    [{ 'deals.bulk': { handler: noop, backoffMs: 1 } }, /backoffMs/],
    [{ 'deals.bulk': { handler: noop, repeat: { pattern: 'every day' } } }, /not a cron pattern/],
    [{ 'deals.bulk': { handler: noop, repeat: { pattern: '* * *' } } }, /not a cron pattern/],
    [{ 'deals.bulk': { handler: noop, repeat: { every: 10 } } }, /at least 1000 ms/],
    [{ 'deals.bulk': { handler: noop, repeat: { every: 60_000, pattern: '* * * * *' } } }, /exactly one of/],
    [{ 'deals.bulk': { handler: noop, repeat: { pattern: '* * * * *', tz: 'Mars/Olympus' } } }, /unknown time zone/],
    [{ 'deals.bulk': { handler: noop, repeat: { every: 60_000, tz: 'UTC' } } }, /tz only applies/],
    [{ 'deals.bulk': { handler: noop, data: { a: 1 } } }, /data is the payload of a repeating job/],
  ];
  for (const [jobs, message] of cases) {
    assert.throws(() => createRegistry([{ name: 'deals', jobs }]), message, JSON.stringify(Object.keys(jobs)));
  }
  assert.throws(
    () => createRegistry([{ name: 'a', jobs: { 'deals.bulk': noop } }, { name: 'b', jobs: { 'deals.bulk': noop } }]),
    /Duplicate job "deals.bulk"/,
  );
});

test('the installed modules register the webhook and job permissions and the housekeeping schedules', () => {
  const registry = buildRegistry();
  for (const key of ['webhooks.view', 'webhooks.manage', 'jobs.view', 'jobs.manage']) assert.ok(registry.permissions.has(key), key);
  assert.ok(registry.roleGrants.get('company_admin').has('webhooks.view'));
  assert.ok(registry.roleGrants.get('group_admin').has('jobs.manage'));
  assert.ok(!registry.roleGrants.get('counsellor')?.has('jobs.view'));
  assert.deepEqual(registry.jobs.get('webhooks.sweep').repeat, { every: 60_000 });
  assert.equal(registry.jobs.get('webhooks.prune').repeat.pattern, '30 2 * * *');
});
