import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KIND_LIST, PROVIDER_LIST, adapterProblems, assertAdapterShape, getKind, getProvider, guardAdapter, providersFor, requiredMethods } from '../../src/integrations/index.js';
import { buildMockWebhook } from '../../src/integrations/framework/mocks/common.js';
import { presentCatalog } from '../../src/integrations/framework/catalog.js';
import { fakeContext } from './helpers.js';

// The adapter interfaces (framework/kinds/*.js): every provider in the catalogue must build an
// adapter that matches its kind, and every mock must answer the kind's sample call with output
// that matches the kind's schemas, deterministically and recorded in the sandbox.

const mockFor = (kindKey, options = {}) => {
  const { ctx, records, clock } = fakeContext({ kind: kindKey, ...options });
  const raw = getProvider(kindKey, 'mock').create(ctx);
  return { raw, adapter: guardAdapter(getKind(kindKey), raw, { checkOutputs: true }), ctx, records, clock };
};

test('the catalogue covers the ten kinds, each with a mock and the chosen providers', () => {
  assert.deepEqual(
    KIND_LIST.map((k) => k.key),
    ['messaging.whatsapp', 'messaging.email', 'messaging.sms', 'calling', 'meetings', 'calendar', 'payments', 'esign', 'ai', 'storage'],
  );
  const providers = (kind) => providersFor(kind).map((p) => p.key);
  for (const kind of KIND_LIST) assert.ok(providers(kind.key).includes('mock'), `${kind.key} has a mock`);
  assert.ok(providers('messaging.whatsapp').includes('whatsapp_cloud'));
  assert.ok(providers('messaging.email').includes('sendgrid'));
  assert.ok(providers('messaging.sms').includes('msg91'));
  assert.ok(providers('calling').includes('exotel'));
  assert.ok(providers('payments').includes('razorpay') && providers('payments').includes('stripe'));
  assert.ok(providers('esign').includes('digio'));
  assert.ok(providers('ai').includes('anthropic'));
  assert.ok(providers('storage').includes('azure_blob'));
  assert.equal(providers('meetings').length, 3, 'mock, Zoom and Google Meet');
  assert.equal(providers('calendar').length, 3, 'mock, Google Calendar and Microsoft 365');
});

test('every provider builds an adapter that matches its kind', () => {
  for (const provider of PROVIDER_LIST) {
    const kind = getKind(provider.kind);
    const { ctx } = fakeContext({ kind: kind.key });
    const adapter = provider.create(ctx);
    assert.deepEqual(adapterProblems(kind, adapter), [], `${provider.kind}:${provider.key}`);
    assert.equal(adapter.mock, provider.mock);
  }
});

test('the shape check names what is missing or wrong', () => {
  const kind = getKind('messaging.sms');
  const { raw } = mockFor('messaging.sms');
  const broken = { ...raw, kind: 'messaging.email', send: undefined, mock: 'yes' };
  const problems = adapterProblems(kind, broken);
  assert.ok(problems.some((p) => p.includes('kind must be "messaging.sms"')));
  assert.ok(problems.some((p) => p.includes('send() is missing')));
  assert.ok(problems.some((p) => p.includes('mock must be true or false')));
  assert.throws(() => assertAdapterShape(kind, broken), /does not match its interface/);
  // Kinds with webhooks also need the verify/parse/challenge trio.
  assert.ok('verifyWebhook' in requiredMethods(kind) && 'parseWebhook' in requiredMethods(kind));
  assert.ok(!('verifyWebhook' in requiredMethods(getKind('ai'))));
});

test('stubs for real providers throw a clear not-implemented error and fail their health check', async () => {
  const provider = getProvider('messaging.email', 'sendgrid');
  const kind = getKind('messaging.email');
  const adapter = guardAdapter(kind, provider.create(fakeContext({ kind: kind.key }).ctx));
  const health = await adapter.healthCheck();
  assert.equal(health.ok, false);
  assert.match(health.message, /not implemented yet/);
  await assert.rejects(adapter.send({ to: [{ email: 'parent@example.com' }], subject: 'Hello', text: 'Hi' }), (error) => {
    assert.equal(error.code, 'integration_not_implemented');
    assert.equal(error.status, 501);
    assert.equal(error.provider, 'sendgrid');
    return true;
  });
  const verdict = await adapter.verifyWebhook({ headers: {}, rawBody: '{}' });
  assert.deepEqual(verdict, { ok: false, reason: 'not_implemented' });
});

test('guarded adapters refuse bad input with field errors and wrap provider failures', async () => {
  const { adapter } = mockFor('messaging.sms');
  await assert.rejects(adapter.send({ to: '98765' }), (error) => {
    assert.equal(error.code, 'integration_invalid_input');
    assert.ok(Array.isArray(error.details) && error.details.every((d) => d.path.startsWith('input')));
    return true;
  });

  const kind = getKind('ai');
  const { raw } = mockFor('ai');
  const exploding = guardAdapter(kind, { ...raw, healthCheck: async () => { throw new Error('socket hang up: token=abc'); } });
  await assert.rejects(exploding.healthCheck(), (error) => {
    assert.equal(error.code, 'integration_provider_error');
    assert.ok(!error.message.includes('token=abc'), 'provider messages stay out of the error text');
    assert.equal(error.cause.message, 'socket hang up: token=abc');
    return true;
  });

  const drifting = guardAdapter(kind, { ...raw, healthCheck: async () => ({ fine: true }) }, { checkOutputs: true });
  await assert.rejects(drifting.healthCheck(), /breaks the ai interface/);
});

const READ_SAMPLES = new Set(['listBusy']);

test('every mock answers its kind sample call within the interface, the same way twice, and records it', async () => {
  for (const kind of KIND_LIST) {
    const { adapter, records } = mockFor(kind.key);
    const input = kind.sample.input({ now: () => Date.parse('2026-11-06T10:00:00Z'), provider: 'mock' });
    const first = await adapter[kind.sample.method](input);
    const second = await adapter[kind.sample.method](input);
    // Storage etags change on every write, as with Azure; everything else repeats exactly.
    const comparable = (value) => (kind.key === 'storage' ? { ...value, etag: 'any' } : value);
    assert.deepEqual(comparable(second), comparable(first), `${kind.key} ${kind.sample.method} is deterministic`);
    // Reads (calendar listBusy) record nothing; every call that would reach a provider does.
    if (!READ_SAMPLES.has(kind.sample.method)) assert.ok(records.length > 0, `${kind.key} recorded its call in the sandbox`);
    assert.deepEqual(await adapter.healthCheck(), { ok: true, message: (await adapter.healthCheck()).message, details: { mock: true } });
  }
});

test('mocks fail on purpose when told to', async () => {
  const { adapter } = mockFor('messaging.whatsapp', { config: { simulate: 'failing_sends' } });
  const kind = getKind('messaging.whatsapp');
  await assert.rejects(adapter[kind.sample.method](kind.sample.input({ now: Date.now, provider: 'mock' })), (error) => {
    assert.equal(error.code, 'integration_provider_error');
    assert.equal(error.retryable, true);
    return true;
  });
  const unhealthy = mockFor('messaging.whatsapp', { config: { simulate: 'failing_health' } }).adapter;
  assert.equal((await unhealthy.healthCheck()).ok, false);
});

test('mock webhooks are verified by signature over the raw body and parsed into events', async () => {
  for (const kind of KIND_LIST.filter((k) => k.webhooks)) {
    const { adapter, ctx } = mockFor(kind.key);
    const type = Object.keys(kind.webhooks.events)[0];
    const events = [{ id: `evt-${kind.key}`, type, occurredAt: '2026-11-06T10:00:00Z', data: { hello: 'world' } }];
    const request = buildMockWebhook(ctx.derivedSecret('mock-webhook'), events);
    assert.deepEqual(await adapter.verifyWebhook(request), { ok: true }, kind.key);
    const parsed = await adapter.parseWebhook(request);
    assert.equal(parsed.events[0].eventId, `evt-${kind.key}`);
    assert.equal(parsed.events[0].occurredAt, '2026-11-06T10:00:00.000Z');

    const tampered = { ...request, rawBody: Buffer.from(request.rawBody.toString().replace('world', 'w0rld')) };
    assert.deepEqual(await adapter.verifyWebhook(tampered), { ok: false, reason: 'bad_signature' });
    assert.deepEqual(await adapter.verifyWebhook({ ...request, headers: {} }), { ok: false, reason: 'missing_signature' });
    const challenge = await adapter.webhookChallenge({ method: 'GET', query: { challenge: 'abc' } });
    assert.deepEqual(challenge, { status: 200, contentType: 'text/plain', body: 'abc' });
  }
});

test('the payments mock: a paid link becomes a payment, refunds are idempotent by reference and capped', async () => {
  const { adapter } = mockFor('payments');
  const link = await adapter.createPaymentLink({
    amountMinor: 150_000,
    currency: 'INR',
    description: 'SAT group batch, first instalment',
    customer: { name: 'Priya Sharma', email: 'priya@example.com' },
    reference: 'inv-1001',
  });
  assert.match(link.providerLinkId, /^plink_mock_/);
  const providerPaymentId = link.providerLinkId.replace(/^plink_/, 'pay_');
  assert.equal((await adapter.getPayment({ providerPaymentId })).status, 'captured');

  const partial = await adapter.refund({ providerPaymentId, amountMinor: 50_000, reference: 'rf-1' });
  const again = await adapter.refund({ providerPaymentId, amountMinor: 50_000, reference: 'rf-1' });
  assert.deepEqual(again, partial, 'the same refund reference is answered, not repeated');
  assert.equal((await adapter.getPayment({ providerPaymentId })).status, 'partially_refunded');
  await assert.rejects(adapter.refund({ providerPaymentId, amountMinor: 200_000, reference: 'rf-2' }), (error) => error.code === 'integration_provider_error');
  await adapter.refund({ providerPaymentId, reference: 'rf-3' });
  assert.equal((await adapter.getPayment({ providerPaymentId })).status, 'refunded');
});

test('the catalogue sent to the web lists field definitions without secrets or regexes', () => {
  const withMocks = presentCatalog({ mocksAllowed: true });
  const without = presentCatalog({ mocksAllowed: false });
  const email = withMocks.find((k) => k.key === 'messaging.email');
  assert.ok(email.providers.some((p) => p.key === 'mock'));
  assert.ok(!without.find((k) => k.key === 'messaging.email').providers.some((p) => p.key === 'mock'));
  const sendgrid = email.providers.find((p) => p.key === 'sendgrid');
  assert.ok(sendgrid.fields.some((f) => f.secret));
  assert.ok(JSON.stringify(withMocks).length > 1000);
  for (const field of sendgrid.fields) assert.ok(!('pattern' in field));
});
