import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { getKind, getProvider, guardAdapter, buildMockWebhook, MOCK_SIGNATURE_HEADER } from '../../src/integrations/index.js';
import { adapterRequest, reasonText } from '../../src/core/webhooks/ingress.js';
import { fakeContext } from '../integrations/helpers.js';

// Signature verification as the webhook endpoint does it (core/webhooks/ingress.js): the Express
// request becomes { method, headers, query, rawBody, url }, and the connection's (guarded) adapter
// checks the HMAC-SHA256 of the exact raw bytes in x-phoenix-mock-signature.

const KIND = 'payments';
const events = [{ id: 'evt_1', type: 'payment.captured', occurredAt: '2026-11-06T10:00:00.000Z', reference: 'deal-1', data: { amountMinor: 150000 } }];

function adapterWith(credentials = {}) {
  const kind = getKind(KIND);
  const { ctx } = fakeContext({ kind: KIND, credentials });
  const adapter = guardAdapter(kind, getProvider(KIND, 'mock').create(ctx), { checkOutputs: true });
  return { adapter, secret: credentials.webhookSecret || ctx.derivedSecret('mock-webhook') };
}

/** An Express-like request after express.raw(): body is the Buffer received. */
function expressRequest({ body, headers = {}, method = 'POST', query = {} }) {
  return { method, headers: { 'content-type': 'application/json', ...headers }, query, body, originalUrl: '/api/v1/webhooks/mock/x' };
}

test('a correctly signed delivery verifies, from the raw bytes the route received', async () => {
  const { adapter, secret } = adapterWith();
  const signed = buildMockWebhook(secret, events);
  const request = adapterRequest(expressRequest({ body: signed.rawBody, headers: signed.headers }));
  assert.ok(Buffer.isBuffer(request.rawBody));
  assert.deepEqual(await adapter.verifyWebhook(request), { ok: true });
  const parsed = await adapter.parseWebhook(request);
  assert.equal(parsed.events[0].eventId, 'evt_1');
  assert.equal(parsed.events[0].type, 'payment.captured');
});

test('the stored webhookSecret credential is the key when set', async () => {
  const { adapter } = adapterWith({ webhookSecret: 'whsec_test_0123456789abcdef' });
  const good = buildMockWebhook('whsec_test_0123456789abcdef', events);
  const derived = buildMockWebhook(adapterWith().secret, events);
  assert.equal((await adapter.verifyWebhook(adapterRequest(expressRequest({ body: good.rawBody, headers: good.headers })))).ok, true);
  const wrong = await adapter.verifyWebhook(adapterRequest(expressRequest({ body: derived.rawBody, headers: derived.headers })));
  assert.deepEqual(wrong, { ok: false, reason: 'bad_signature' });
});

test('re-serialised JSON fails: signatures are over the exact bytes, never parsed and re-encoded', async () => {
  const { adapter, secret } = adapterWith();
  const signed = buildMockWebhook(secret, events);
  const reformatted = Buffer.from(JSON.stringify(JSON.parse(signed.rawBody.toString('utf8')), null, 2));
  const verdict = await adapter.verifyWebhook(adapterRequest(expressRequest({ body: reformatted, headers: signed.headers })));
  assert.deepEqual(verdict, { ok: false, reason: 'bad_signature' });
});

test('a tampered body, a wrong secret or a malformed header is refused without throwing', async () => {
  const { adapter, secret } = adapterWith();
  const signed = buildMockWebhook(secret, events);
  const tampered = Buffer.from(signed.rawBody.toString('utf8').replace('150000', '1'));
  const cases = [
    { body: tampered, headers: signed.headers },
    { body: signed.rawBody, headers: { [MOCK_SIGNATURE_HEADER]: `sha256=${createHmac('sha256', 'not-the-secret').update(signed.rawBody).digest('hex')}` } },
    { body: signed.rawBody, headers: { [MOCK_SIGNATURE_HEADER]: 'sha256=abc' } },
    { body: signed.rawBody, headers: { [MOCK_SIGNATURE_HEADER]: createHmac('sha256', secret).update(signed.rawBody).digest('hex') } }, // no sha256= prefix
  ];
  for (const c of cases) {
    const verdict = await adapter.verifyWebhook(adapterRequest(expressRequest(c)));
    assert.deepEqual(verdict, { ok: false, reason: 'bad_signature' });
  }
});

test('a missing signature header or an empty body is refused', async () => {
  const { adapter } = adapterWith();
  const missing = await adapter.verifyWebhook(adapterRequest(expressRequest({ body: Buffer.from('{"events":[]}') })));
  assert.deepEqual(missing, { ok: false, reason: 'missing_signature' });
  // No body at all (express.raw leaves req.body unset): an empty buffer, never undefined.
  const request = adapterRequest(expressRequest({ body: undefined, headers: { [MOCK_SIGNATURE_HEADER]: 'sha256=00' } }));
  assert.equal(request.rawBody.length, 0);
  assert.equal((await adapter.verifyWebhook(request)).ok, false);
});

test('the handshake is answered only for GET with a challenge', async () => {
  const { adapter } = adapterWith();
  const get = adapterRequest(expressRequest({ method: 'GET', body: undefined, query: { challenge: 'abc123' } }));
  assert.deepEqual(await adapter.webhookChallenge(get), { status: 200, contentType: 'text/plain', body: 'abc123' });
  const post = adapterRequest(expressRequest({ body: Buffer.from('{}'), query: { challenge: 'abc123' } }));
  assert.equal(await adapter.webhookChallenge(post), null);
});

test('rejection reasons read as sentences in the delivery log', () => {
  assert.match(reasonText('bad_signature'), /does not match/);
  assert.match(reasonText('missing_signature'), /missing/);
  assert.match(reasonText('something_new'), /something_new/);
});
