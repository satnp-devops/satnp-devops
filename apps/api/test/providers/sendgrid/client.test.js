import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSendgridClient, SendgridError } from '../../../src/integrations/providers/sendgrid/index.js';

const API_KEY = 'SG.fakeKeyId_0123456789.fakeSecret_abcdefghijklmnopqrstuvwxyz';
const NOW = Date.parse('2026-11-05T10:00:00Z');

const baseConfig = {
  apiKey: API_KEY,
  defaultFrom: { email: 'admissions@phoenix.example', name: 'Phoenix Admissions' },
};

/**
 * Fake fetch: replies from a queue and records every call.
 * @param {Array<{ status?: number, headers?: Record<string, string>, body?: unknown } | Error>} replies
 */
function fakeFetch(replies) {
  /** @type {Array<{ url: string, method: string, headers: Record<string, string>, body: any }>} */
  const calls = [];
  const fn = async (/** @type {string} */ url, /** @type {any} */ init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const reply = replies.shift();
    if (!reply) throw new Error('unexpected fetch');
    if (reply instanceof Error) throw reply;
    const text = reply.body === undefined ? '' : typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
    const headers = { ...(reply.body !== undefined && typeof reply.body !== 'string' ? { 'content-type': 'application/json' } : {}), ...reply.headers };
    return new Response(text === '' ? null : text, { status: reply.status ?? 202, headers });
  };
  return { fn, calls };
}

/** @param {Parameters<typeof fakeFetch>[0]} replies @param {Record<string, unknown>} [config] */
function client(replies, config = {}) {
  const fetch = fakeFetch(replies);
  const sleeps = /** @type {number[]} */ ([]);
  const logs = /** @type {unknown[]} */ ([]);
  const logger = { debug: (/** @type {unknown} */ o) => logs.push(o), info: (/** @type {unknown} */ o) => logs.push(o), warn: (/** @type {unknown} */ o) => logs.push(o) };
  const c = createSendgridClient(
    { ...baseConfig, ...config },
    { fetch: /** @type {any} */ (fetch.fn), now: () => NOW, sleep: async (ms) => void sleeps.push(ms), random: () => 0.5, logger },
  );
  return { c, calls: fetch.calls, sleeps, logs };
}

const message = { messageId: 'msg_01HZX', to: { email: 'parent@example.in', name: 'Priya Sharma' }, subject: 'Your admission visit', text: 'See you at 10am.' };

test('send posts the v3 mail body with auth headers and returns X-Message-Id', async () => {
  const { c, calls } = client([{ status: 202, headers: { 'X-Message-Id': 'Ab12Cd34Ef56Gh78Ij90Kl', 'X-RateLimit-Remaining': '599' } }]);
  const result = await c.send(message);
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.method, 'POST');
  assert.equal(call.url, 'https://api.sendgrid.com/v3/mail/send');
  assert.equal(call.headers.Authorization, `Bearer ${API_KEY}`);
  assert.equal(call.headers['Content-Type'], 'application/json');
  assert.equal(call.headers['on-behalf-of'], undefined);
  assert.deepEqual(call.body, {
    personalizations: [{ to: [{ email: 'parent@example.in', name: 'Priya Sharma' }], custom_args: { phoenix_message_id: 'msg_01HZX' } }],
    from: { email: 'admissions@phoenix.example', name: 'Phoenix Admissions' },
    subject: 'Your admission visit',
    content: [{ type: 'text/plain', value: 'See you at 10am.' }],
  });
  assert.deepEqual(result, {
    status: 'accepted',
    messageId: 'msg_01HZX',
    providerMessageId: 'Ab12Cd34Ef56Gh78Ij90Kl',
    sandbox: false,
    recipients: 1,
    acceptedAt: '2026-11-05T10:00:00.000Z',
    statusCode: 202,
    attempts: 1,
    rateLimit: { limit: null, remaining: 599, resetAt: null },
  });
});

test('EU region and sandbox mode change host and mail_settings; sandbox 200 is "validated"', async () => {
  const { c, calls } = client([{ status: 200 }], { region: 'eu', sandboxMode: true });
  const result = await c.send(message);
  assert.equal(calls[0].url, 'https://api.eu.sendgrid.com/v3/mail/send');
  assert.deepEqual(calls[0].body.mail_settings, { sandbox_mode: { enable: true } });
  assert.equal(result.status, 'validated');
  assert.equal(result.sandbox, true);
  assert.equal(result.providerMessageId, null);
});

test('validate() forces sandbox for one call', async () => {
  const { c, calls } = client([{ status: 200 }]);
  const result = await c.validate(message);
  assert.equal(calls[0].body.mail_settings.sandbox_mode.enable, true);
  assert.equal(result.status, 'validated');
});

test('400 maps to a permanent validation error with provider field errors', async () => {
  const { c, calls } = client([
    { status: 400, body: { errors: [{ message: 'The from email does not contain a valid address.', field: 'from.email', help: 'http://sendgrid.com/docs' }] } },
  ]);
  const error = await c.send(message).catch((e) => e);
  assert.ok(error instanceof SendgridError);
  assert.equal(error.code, 'validation');
  assert.equal(error.status, 400);
  assert.equal(error.retryable, false);
  assert.equal(error.permanent, true);
  assert.deepEqual(error.providerErrors, [{ message: 'The from email does not contain a valid address.', field: 'from.email', help: 'http://sendgrid.com/docs' }]);
  assert.match(error.message, /from\.email: The from email/);
  assert.equal(calls.length, 1);
});

test('401/403/413 are permanent and never retried', async () => {
  for (const [status, code] of [[401, 'auth'], [403, 'forbidden'], [413, 'payload_too_large']]) {
    const { c, calls } = client([{ status: Number(status), body: { errors: [{ message: 'nope', field: null }] } }]);
    const error = await c.send(message).catch((e) => e);
    assert.equal(error.code, code);
    assert.equal(error.retryable, false);
    assert.equal(calls.length, 1);
  }
});

test('mail send is not retried on 500: retryable but outcome unknown', async () => {
  const { c, calls } = client([{ status: 500, body: { errors: [{ message: 'internal error', field: null }] } }, { status: 202 }]);
  const error = await c.send(message).catch((e) => e);
  assert.equal(error.code, 'provider_error');
  assert.equal(error.retryable, true);
  assert.equal(error.outcomeUnknown, true);
  assert.equal(calls.length, 1);
});

test('mail send is retried after 429 using X-RateLimit-Reset, then succeeds', async () => {
  const reset = String(NOW / 1000 + 2);
  const { c, calls, sleeps } = client([
    { status: 429, headers: { 'X-RateLimit-Limit': '600', 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': reset }, body: { errors: [{ field: null, message: 'too many requests' }] } },
    { status: 202, headers: { 'X-Message-Id': 'retry-ok' } },
  ]);
  const result = await c.send(message);
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [2000]);
  assert.equal(result.attempts, 2);
  assert.equal(result.providerMessageId, 'retry-ok');
});

test('429 with a long reset is returned to the caller with retryAfterMs', async () => {
  const { c, calls } = client([{ status: 429, headers: { 'Retry-After': '120' }, body: { errors: [{ message: 'too many requests' }] } }]);
  const error = await c.send(message).catch((e) => e);
  assert.equal(error.code, 'rate_limited');
  assert.equal(error.retryable, true);
  assert.equal(error.outcomeUnknown, false);
  assert.equal(error.retryAfterMs, 120_000);
  assert.equal(calls.length, 1);
});

test('mail send retries a connection refused (nothing sent) but not a reset connection', async () => {
  const refused = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
  const reset = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) });
  const ok = client([refused, { status: 202, headers: { 'X-Message-Id': 'x' } }]);
  assert.equal((await ok.c.send(message)).attempts, 2);
  assert.deepEqual(ok.sleeps, [375]);

  const bad = client([reset, { status: 202 }]);
  const error = await bad.c.send(message).catch((e) => e);
  assert.equal(error.code, 'network');
  assert.equal(error.outcomeUnknown, true);
  assert.equal(bad.calls.length, 1);
});

test('timeouts on mail send are typed and not retried', async () => {
  const { c, calls } = client([new DOMException('The operation was aborted due to timeout', 'TimeoutError')]);
  const error = await c.send(message).catch((e) => e);
  assert.equal(error.code, 'timeout');
  assert.equal(error.retryable, true);
  assert.equal(error.outcomeUnknown, true);
  assert.equal(calls.length, 1);
});

test('a real AbortSignal timeout reaches fetch', async () => {
  const fetch = async (/** @type {string} */ _url, /** @type {any} */ init) =>
    new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  const c = createSendgridClient({ ...baseConfig, timeoutMs: 500 }, { fetch: /** @type {any} */ (fetch) });
  const error = await c.send(message).catch((e) => e);
  assert.equal(error.code, 'timeout');
});

test('caller abort is not retried and is not reported as a timeout', async () => {
  const controller = new AbortController();
  controller.abort();
  const fetch = async (/** @type {string} */ _url, /** @type {any} */ init) => {
    throw init.signal.reason;
  };
  const c = createSendgridClient(baseConfig, { fetch: /** @type {any} */ (fetch) });
  const error = await c.send(message, { signal: controller.signal }).catch((e) => e);
  assert.equal(error.code, 'network');
  assert.equal(error.retryable, false);
});

test('idempotent GETs retry 5xx with exponential backoff, up to maxRetries', async () => {
  const { c, calls, sleeps } = client([{ status: 503 }, { status: 502 }, { status: 200, body: { id: 'wh1', public_key: 'MFkw...' } }], { onBehalfOf: 'phoenix-schools' });
  const result = await c.getEventWebhookPublicKey('77d4a5da-7015-11ed-a1eb-0242ac120002');
  assert.deepEqual(result, { webhookId: '77d4a5da-7015-11ed-a1eb-0242ac120002', publicKey: 'MFkw...' });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url, 'https://api.sendgrid.com/v3/user/webhooks/event/settings/signed/77d4a5da-7015-11ed-a1eb-0242ac120002');
  assert.equal(calls[0].headers['on-behalf-of'], 'phoenix-schools');
  assert.equal(calls[0].body, undefined);
  assert.deepEqual(sleeps, [375, 750]);

  const exhausted = client([{ status: 503 }, { status: 503 }, { status: 503 }]);
  const error = await exhausted.c.getEventWebhookPublicKey('wh1').catch((e) => e);
  assert.equal(error.code, 'provider_error');
  assert.equal(error.outcomeUnknown, false);
  assert.equal(exhausted.calls.length, 3);
});

test('testConnection reads scopes', async () => {
  const { c, calls } = client([{ status: 200, body: { scopes: ['mail.send', 'user.webhooks.event.settings.read'] } }]);
  assert.deepEqual(await c.testConnection(), { ok: true, canSend: true, scopes: ['mail.send', 'user.webhooks.event.settings.read'] });
  assert.equal(calls[0].url, 'https://api.sendgrid.com/v3/scopes');
});

test('createBatchId posts to /v3/mail/batch', async () => {
  const { c, calls } = client([{ status: 201, body: { batch_id: 'HkJ5yLYULb7Rj8GKSx7u025ouWVlMgAi' } }]);
  assert.deepEqual(await c.createBatchId(), { batchId: 'HkJ5yLYULb7Rj8GKSx7u025ouWVlMgAi' });
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, 'https://api.sendgrid.com/v3/mail/batch');
});

test('local validation errors are thrown before any request', async () => {
  const { c, calls } = client([]);
  const error = await c.send({ messageId: 'm1', to: 'parent@example.in' }).catch((e) => e);
  assert.equal(error.code, 'validation');
  assert.equal(error.retryable, false);
  assert.ok(error.issues.length > 0);
  assert.equal(calls.length, 0);
});

test('the API key never appears in errors, logs or describe()', async () => {
  const echo = { status: 401, body: { errors: [{ message: `authorization required for ${API_KEY}`, field: null }] } };
  const { c, logs } = client([echo]);
  const error = await c.send(message).catch((e) => e);
  const surfaces = [error.message, JSON.stringify(error), JSON.stringify(logs), JSON.stringify(c.describe()), JSON.stringify(c)];
  for (const text of surfaces) assert.equal(text.includes('fakeSecret_abcdefghijklmnopqrstuvwxyz'), false, text);
  assert.match(error.message, /\[REDACTED\]/);

  const netError = Object.assign(new TypeError('fetch failed'), { cause: new Error(`bad header ${API_KEY}`) });
  const net = client([netError]);
  const e2 = await net.c.send(message).catch((e) => e);
  assert.equal(e2.message.includes(API_KEY), false);
});

test('config is validated with field paths and no secret values', () => {
  assert.throws(
    () => createSendgridClient({ apiKey: 'short', defaultFrom: { email: 'not-an-email' }, region: 'in' }),
    (error) => {
      assert.ok(error instanceof SendgridError);
      assert.equal(error.code, 'config');
      assert.match(error.message, /apiKey/);
      assert.match(error.message, /defaultFrom\.email/);
      assert.match(error.message, /region/);
      assert.equal(error.message.includes('short'), false);
      return true;
    },
  );
  assert.throws(() => createSendgridClient({ ...baseConfig, unknownField: 1 }), /unknownField|Unrecognized/);
});

test('client verifyWebhook/verifyInbound need configured keys', () => {
  const { c } = client([]);
  assert.throws(() => c.verifyWebhook('[]', {}), (e) => e instanceof SendgridError && e.code === 'config');
  assert.throws(() => c.verifyInbound(Buffer.from(''), {}), (e) => e instanceof SendgridError && e.code === 'config');
});
