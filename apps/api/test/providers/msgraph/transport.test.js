import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMsgraphClient } from '../../../src/integrations/providers/msgraph/index.js';
import {
  ACCESS_TOKEN,
  CLIENT_SECRET,
  MAILBOX,
  WEBHOOK_SECRET,
  baseConfig,
  fakeFetch,
  fixture,
  graphError,
  makeClient,
  respond,
  tokenOk,
} from './helpers.js';

const throttled = (retryAfter) =>
  respond(429, graphError('TooManyRequests', 'Application is over its MailboxConcurrency limit.'), retryAfter ? { 'retry-after': retryAfter } : {});

test('429 waits Retry-After seconds then succeeds', async () => {
  const { client, calls, sleeps } = makeClient([throttled('7'), throttled('1'), respond(200, fixture('event-created.json'))]);
  await client.getEvent(MAILBOX, 'evt-1');
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [7000, 1000]);
});

test('429 without Retry-After falls back to exponential backoff with jitter', async () => {
  const { client, sleeps } = makeClient([throttled(), throttled(), respond(200, fixture('event-created.json'))]);
  await client.getEvent(MAILBOX, 'evt-1');
  assert.deepEqual(sleeps, [250, 500]);
});

test('Retry-After longer than maxRetryDelayMs is returned to the caller instead of waited out', async () => {
  const { client, calls, sleeps } = makeClient([throttled('120')]);
  await assert.rejects(client.getEvent(MAILBOX, 'evt-1'), { kind: 'throttled', retryable: true, retryAfterMs: 120_000, status: 429 });
  assert.equal(calls.length, 1);
  assert.deepEqual(sleeps, []);
});

test('retries stop after maxRetries', async () => {
  const { client, calls } = makeClient(Array.from({ length: 5 }, () => throttled('1')), { config: { maxRetries: 2 } });
  await assert.rejects(client.getEvent(MAILBOX, 'evt-1'), { kind: 'throttled' });
  assert.equal(calls.length, 3);
});

test('non-idempotent calls are not retried on 429', async () => {
  const { client, calls } = makeClient([throttled('1')]);
  await assert.rejects(client.createSubscription({ mailbox: MAILBOX }), { kind: 'throttled', retryable: true });
  assert.equal(calls.length, 1);
});

test('a 401 refreshes the token once and replays the request', async () => {
  let issued = 0;
  const { client, calls, tokenCalls } = makeClient(
    [respond(401, graphError('InvalidAuthenticationToken', 'Access token has expired or is not yet valid.')), respond(202)],
    { token: () => tokenOk(3599, `token-${++issued}`) },
  );
  await client.cancelEvent(MAILBOX, 'evt-1');
  assert.equal(tokenCalls.length, 2);
  assert.equal(calls[0].headers.authorization, 'Bearer token-1');
  assert.equal(calls[1].headers.authorization, 'Bearer token-2');
});

test('a second 401 is a permanent auth error', async () => {
  const unauthorized = () => respond(401, graphError('InvalidAuthenticationToken', 'nope'));
  const { client, calls } = makeClient([unauthorized(), unauthorized()]);
  await assert.rejects(client.getEvent(MAILBOX, 'evt-1'), { kind: 'auth', retryable: false });
  assert.equal(calls.length, 2);
});

test('network failures retry idempotent calls and flag unknown outcome on others', async () => {
  const boom = () => {
    throw new TypeError('fetch failed');
  };
  const idempotent = makeClient([boom, respond(200, fixture('event-created.json'))]);
  await idempotent.client.getEvent(MAILBOX, 'evt-1');
  assert.equal(idempotent.calls.length, 2);

  const once = makeClient([boom]);
  await assert.rejects(once.client.cancelEvent(MAILBOX, 'evt-1'), (err) => {
    assert.equal(err.kind, 'network');
    assert.equal(err.retryable, true);
    assert.equal(err.details.outcomeUnknown, true);
    return true;
  });
  assert.equal(once.calls.length, 1);
});

test('each attempt times out via AbortSignal', async () => {
  const hang = (call) =>
    new Promise((_, reject) => call.signal.addEventListener('abort', () => reject(call.signal.reason), { once: true }));
  const { client } = makeClient([hang], { config: { requestTimeoutMs: 1000, maxRetries: 0 } });
  await assert.rejects(client.getEvent(MAILBOX, 'evt-1'), { kind: 'timeout', retryable: true });
});

test('a caller abort is reported as aborted, not retried', async () => {
  const controller = new AbortController();
  const hang = (call) => {
    controller.abort();
    return Promise.reject(call.signal.reason);
  };
  const { client, calls } = makeClient([hang, respond(200, {})]);
  await assert.rejects(client.getEvent(MAILBOX, 'evt-1', { signal: controller.signal }), { kind: 'aborted', retryable: false });
  assert.equal(calls.length, 1);
});

test('paging follows @odata.nextLink but never to another host', async () => {
  const page1 = { value: [{ id: 'sub-1', resource: 'users/a/events', changeType: 'created', expirationDateTime: '2026-11-12T04:30:00Z' }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/subscriptions?$skiptoken=abc' };
  const page2 = { value: [{ id: 'sub-2', resource: 'users/b/events', changeType: 'created,updated', expirationDateTime: '2026-11-12T04:30:00Z' }] };
  const { client, calls } = makeClient([respond(200, page1), respond(200, page2)]);
  const subs = await client.listSubscriptions();
  assert.deepEqual(subs.map((s) => s.id), ['sub-1', 'sub-2']);
  assert.deepEqual(subs[1].changeTypes, ['created', 'updated']);
  assert.equal(calls[1].url, 'https://graph.microsoft.com/v1.0/subscriptions?$skiptoken=abc');

  const evil = makeClient([respond(200, { value: [], '@odata.nextLink': 'https://attacker.example/steal' })]);
  await assert.rejects(evil.client.listSubscriptions(), { code: 'foreign_link' });
  assert.equal(evil.calls.length, 1, 'the token is never sent to the foreign host');
});

test('at most four requests run at once per mailbox', async () => {
  let active = 0;
  let peak = 0;
  const slow = async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return respond(200, fixture('event-created.json'));
  };
  const { client } = makeClient(Array.from({ length: 8 }, () => slow));
  await Promise.all(Array.from({ length: 8 }, (_, i) => client.getEvent(i % 2 ? MAILBOX : MAILBOX.toUpperCase(), `evt-${i}`)));
  assert.equal(peak, 4);
});

test('logs never contain secrets, tokens or request bodies', async () => {
  const { client, logs } = makeClient([throttled('1'), respond(201, fixture('event-created.json'))]);
  await client.createEvent(MAILBOX, { subject: 'Private: fee discussion', start: '2026-11-10T05:30:00Z', end: '2026-11-10T06:00:00Z' });
  const text = JSON.stringify(logs);
  assert.ok(logs.length > 0);
  for (const secret of [CLIENT_SECRET, WEBHOOK_SECRET, ACCESS_TOKEN, 'fee discussion']) assert.ok(!text.includes(secret), secret);
});

test('uses the global fetch when none is injected', () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = fakeFetch().fetch;
    assert.equal(createMsgraphClient(baseConfig).provider, 'msgraph');
  } finally {
    globalThis.fetch = original;
  }
});
