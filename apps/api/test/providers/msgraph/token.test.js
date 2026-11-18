import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACCESS_TOKEN, CLIENT_ID, CLIENT_SECRET, NOW, TENANT_ID, makeClient, respond, tokenOk } from './helpers.js';

test('client-credentials request has the documented shape', async () => {
  const { client, tokenCalls } = makeClient();
  assert.equal(await client.getAccessToken(), ACCESS_TOKEN);
  assert.equal(tokenCalls.length, 1);
  const call = tokenCalls[0];
  assert.equal(call.url, `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`);
  assert.equal(call.method, 'POST');
  assert.equal(call.headers['content-type'], 'application/x-www-form-urlencoded');
  const form = new URLSearchParams(call.body);
  assert.deepEqual(Object.fromEntries(form), {
    client_id: CLIENT_ID,
    scope: 'https://graph.microsoft.com/.default',
    client_secret: CLIENT_SECRET,
    grant_type: 'client_credentials',
  });
  assert.ok(call.signal instanceof AbortSignal, 'every attempt has a timeout signal');
});

test('token is cached until the refresh skew, then refreshed', async () => {
  let now = NOW;
  let issued = 0;
  const { client, tokenCalls } = makeClient([], {
    now: () => now,
    token: () => tokenOk(3600, `token-${++issued}`),
  });
  assert.equal(await client.getAccessToken(), 'token-1');
  now += 3600_000 - 300_001; // just inside the 5-minute skew
  assert.equal(await client.getAccessToken(), 'token-1');
  now += 2;
  assert.equal(await client.getAccessToken(), 'token-2');
  assert.equal(tokenCalls.length, 2);
});

test('concurrent callers share one token request', async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const { client, tokenCalls } = makeClient([], { token: async () => (await gate, tokenOk()) });
  const pending = Promise.all([client.getAccessToken(), client.getAccessToken(), client.getAccessToken()]);
  release();
  assert.deepEqual(await pending, [ACCESS_TOKEN, ACCESS_TOKEN, ACCESS_TOKEN]);
  assert.equal(tokenCalls.length, 1);
});

test('invalid_client is a permanent auth error and the secret is redacted', async () => {
  const { client, tokenCalls } = makeClient([], {
    token: () =>
      respond(401, {
        error: 'invalid_client',
        error_description: `AADSTS7000215: Invalid client secret provided (${CLIENT_SECRET}).\r\nTrace ID: abc\r\nCorrelation ID: def`,
        error_codes: [7000215],
        trace_id: 'trace-1',
        correlation_id: 'corr-1',
      }),
  });
  await assert.rejects(client.getAccessToken(), (err) => {
    assert.equal(err.name, 'MsgraphError');
    assert.equal(err.kind, 'auth');
    assert.equal(err.code, 'invalid_client');
    assert.equal(err.retryable, false);
    assert.deepEqual(err.details.errorCodes, [7000215]);
    assert.equal(err.requestId, 'trace-1');
    assert.ok(!err.message.includes(CLIENT_SECRET));
    assert.ok(!err.message.includes('Trace ID'), 'only the first line of error_description is kept');
    return true;
  });
  assert.equal(tokenCalls.length, 1, 'permanent errors are not retried');
});

test('transient token failures are retried with backoff', async () => {
  let n = 0;
  const { client, tokenCalls, sleeps } = makeClient([], {
    token: () => {
      n += 1;
      if (n === 1) throw new TypeError('fetch failed');
      if (n === 2) return respond(503, { error: 'temporarily_unavailable', error_description: 'try later' }, { 'retry-after': '2' });
      return tokenOk();
    },
  });
  assert.equal(await client.getAccessToken(), ACCESS_TOKEN);
  assert.equal(tokenCalls.length, 3);
  assert.deepEqual(sleeps, [250, 2000], 'jittered backoff, then Retry-After');
});

test('a malformed token response is rejected', async () => {
  const { client } = makeClient([], { token: () => respond(200, { token_type: 'Bearer' }) });
  await assert.rejects(client.getAccessToken(), { kind: 'unexpected', code: 'invalid_token_response' });
});
