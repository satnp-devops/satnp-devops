import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ExotelAuthError,
  ExotelConfigError,
  ExotelNetworkError,
  ExotelNotFoundError,
  ExotelProviderError,
  ExotelRateLimitError,
  ExotelValidationError,
  computeCallbackSignature,
  createExotelClient,
} from '../../../src/integrations/providers/exotel/index.js';
import { SECRET, baseConfig, callDetailsResponse, connectResponse, terminalCallback } from './fixtures.js';
import { fakeFetch, hang, jsonResponse, memoryLogger } from './fake-fetch.js';

const NOW = Date.UTC(2026, 10, 5, 5, 0, 0); // 2026-11-05T05:00:00Z
const BASIC = `Basic ${Buffer.from('test-api-key-123:test-api-token-456').toString('base64')}`;

/** @param {ReturnType<typeof fakeFetch>} fetch @param {object} [overrides] */
function makeClient(fetch, overrides = {}, extraDeps = {}) {
  const sleeps = [];
  const logger = memoryLogger();
  const client = createExotelClient(
    { ...baseConfig, ...overrides },
    {
      fetch,
      now: () => NOW,
      logger,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 0.5,
      generateRef: () => 'gen-ref-1',
      ...extraDeps,
    },
  );
  return { client, sleeps, logger };
}

test('config: validated with zod, errors name fields but never values', () => {
  assert.throws(
    () => createExotelClient({ accountSid: 'x y', apiKey: 'test-api-key-123', apiToken: 'short', sneaky: 1 }),
    (error) => {
      assert.ok(error instanceof ExotelConfigError);
      assert.equal(error.kind, 'permanent');
      assert.match(error.message, /accountSid/);
      assert.match(error.message, /apiToken/);
      assert.match(error.message, /sneaky/);
      assert.doesNotMatch(error.message, /test-api-key-123|short/);
      return true;
    },
  );
  assert.throws(() => createExotelClient({ ...baseConfig, statusCallbackUrl: 'http://insecure.test/x' }), ExotelConfigError);
  assert.throws(() => createExotelClient({ ...baseConfig, webhookSecret: 'too-short' }), ExotelConfigError);
  assert.throws(() => createExotelClient({ ...baseConfig, allowedWebhookIps: ['10.0.0.0/33'] }), ExotelConfigError);
});

test('regional hosts: Mumbai uses api.in.exotel.com, Singapore (default) api.exotel.com', () => {
  assert.equal(makeClient(fakeFetch([])).client.baseUrl, 'https://api.in.exotel.com');
  const { client } = makeClient(fakeFetch([]), { region: undefined });
  assert.equal(client.baseUrl, 'https://api.exotel.com');
  assert.equal(client.kind, 'calling');
  assert.ok(client.capabilities.includes('click_to_call'));
});

test('connectCall sends the documented form request: agent first, then customer', async () => {
  const fetch = fakeFetch([jsonResponse(connectResponse)]);
  const { client } = makeClient(fetch, { record: true, timeLimitSeconds: 1800 });
  const call = await client.connectCall({ agentNumber: '091234 56789', customerNumber: '+91 98765-43210', ref: 'lead-42' });

  assert.equal(fetch.calls.length, 1);
  const req = fetch.calls[0];
  assert.equal(req.method, 'POST');
  assert.equal(req.url, 'https://api.in.exotel.com/v1/Accounts/phoenixedu1/Calls/connect.json');
  assert.equal(req.headers.Authorization, BASIC);
  assert.equal(req.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(req.headers.Accept, 'application/json');
  assert.ok(req.signal instanceof AbortSignal);

  const form = new URLSearchParams(req.body);
  const exp = NOW / 1000 + 7 * 86400;
  const signed = new URL(form.get('StatusCallback'));
  assert.deepEqual(Object.fromEntries(form), {
    From: '+919123456789',
    To: '+919876543210',
    CallerId: '08044556678',
    TimeLimit: '1800',
    Record: 'true',
    RecordingChannels: 'single',
    RecordingFormat: 'mp3',
    CustomField: 'lead-42',
    StatusCallback: form.get('StatusCallback'),
    'StatusCallbackEvents[0]': 'terminal',
    'StatusCallbackEvents[1]': 'answered',
    StatusCallbackContentType: 'application/json',
  });
  assert.equal(signed.origin + signed.pathname, 'https://crm.phoenix.test/api/webhooks/exotel/status');
  assert.equal(signed.searchParams.get('phx_ref'), 'lead-42');
  assert.equal(signed.searchParams.get('phx_exp'), String(exp));
  assert.equal(signed.searchParams.get('phx_sig'), computeCallbackSignature(SECRET, 'lead-42', exp));

  assert.equal(call.callId, '09c14403fb2a31097ba5ed64f9251646');
  assert.equal(call.status, 'in_progress');
  assert.equal(call.direction, 'outbound');
  assert.equal(call.ref, 'lead-42');
  assert.ok(call.complianceWarnings.includes('service_calls_need_an_existing_relationship_or_consent_record'));
  assert.equal(call.createdAt, '2026-11-05T05:14:40.000Z');
});

test('connectCall: SIP agent, generated ref, no callback when disabled', async () => {
  const fetch = fakeFetch([jsonResponse(connectResponse)]);
  const { client } = makeClient(fetch);
  const call = await client.connectCall({
    agentNumber: 'sip:counsellor7@phoenixedu.exotel.com',
    customerNumber: '9876543210',
    statusCallbackUrl: null,
    callType: 'trans',
    ringTimeoutSeconds: 30,
  });
  const form = new URLSearchParams(fetch.calls[0].body);
  assert.equal(form.get('From'), 'sip:counsellor7@phoenixedu.exotel.com');
  assert.equal(form.get('CustomField'), 'gen-ref-1');
  assert.equal(form.get('CallType'), 'trans');
  assert.equal(form.get('TimeOut'), '30');
  assert.equal(form.get('StatusCallback'), null);
  assert.equal(form.get('Record'), null);
  assert.equal(call.ref, 'gen-ref-1');
});

test('connectCall validates locally before any request', async () => {
  const fetch = fakeFetch([]);
  const { client } = makeClient(fetch);
  await assert.rejects(client.connectCall({ agentNumber: '9123456789', customerNumber: '12345' }), (e) => {
    assert.ok(e instanceof ExotelValidationError);
    assert.equal(e.code, 'invalid_phone');
    assert.doesNotMatch(e.message, /12345/, 'phone numbers are not echoed into messages');
    return true;
  });
  await assert.rejects(client.connectCall({ agentNumber: '9123456789', customerNumber: '9876543210', ref: 'has space' }), ExotelValidationError);
  await assert.rejects(client.connectCall({ agentNumber: '9123456789', customerNumber: '9876543210', bogus: true }), ExotelValidationError);
  await assert.rejects(
    client.connectCall({ agentNumber: '9123456789', customerNumber: '9876543210', purpose: 'promotional' }),
    (e) => e.code === 'compliance_blocked' && e.details.reasons.includes('promotional_calls_require_140_series_caller_id'),
  );
  const noCaller = makeClient(fetch, { callerId: undefined }).client;
  await assert.rejects(noCaller.connectCall({ agentNumber: '9123456789', customerNumber: '9876543210' }), (e) => e.code === 'caller_id_missing');
  assert.equal(fetch.calls.length, 0);
});

test('connectCall refuses unverifiable callbacks (no secret, no IP list)', async () => {
  const { client } = makeClient(fakeFetch([]), { webhookSecret: undefined });
  await assert.rejects(client.connectCall({ agentNumber: '9123456789', customerNumber: '9876543210' }), ExotelConfigError);
  const ipOnly = makeClient(fakeFetch([jsonResponse(connectResponse)]), { webhookSecret: undefined, allowedWebhookIps: ['203.0.113.0/24'] });
  await ipOnly.client.connectCall({ agentNumber: '9123456789', customerNumber: '9876543210' });
});

test('connectCall is not retried on 5xx or timeout: outcomeUnknown with ref', async () => {
  const fetch = fakeFetch([jsonResponse({ RestException: { Status: 502, Message: 'Bad gateway' } }, 502)]);
  const { client, sleeps } = makeClient(fetch);
  await assert.rejects(client.connectCall({ agentNumber: '9123456789', customerNumber: '9876543210', ref: 'lead-9' }), (e) => {
    assert.ok(e instanceof ExotelProviderError);
    assert.equal(e.code, 'provider_unavailable');
    assert.equal(e.retryable, true);
    assert.equal(e.outcomeUnknown, true);
    assert.equal(e.details.ref, 'lead-9');
    return true;
  });
  assert.equal(fetch.calls.length, 1);
  assert.equal(sleeps.length, 0);

  const slow = fakeFetch([hang()]);
  const timed = makeClient(slow, { timeoutMs: 50 }).client;
  await assert.rejects(timed.connectCall({ agentNumber: '9123456789', customerNumber: '9876543210' }), (e) => {
    assert.ok(e instanceof ExotelNetworkError);
    assert.equal(e.code, 'timeout');
    assert.equal(e.outcomeUnknown, true);
    return true;
  });
  assert.equal(slow.calls.length, 1);
});

test('connectCall retries 429 (request was rejected) honouring Retry-After', async () => {
  const fetch = fakeFetch([
    jsonResponse({ RestException: { Status: 429, Message: 'Rate limit exceeded (200 requests per minute)' } }, 429, { 'Retry-After': '2' }),
    jsonResponse(connectResponse),
  ]);
  const { client, sleeps, logger } = makeClient(fetch);
  const call = await client.connectCall({ agentNumber: '9123456789', customerNumber: '9876543210' });
  assert.equal(call.callId, '09c14403fb2a31097ba5ed64f9251646');
  assert.equal(fetch.calls.length, 2);
  assert.deepEqual(sleeps, [2000]);
  const logged = JSON.stringify(logger.entries);
  assert.match(logged, /rate_limited/);
  assert.doesNotMatch(logged, /test-api-token-456|test-api-key-123|Basic |9876543210/);
});

test('429 with a long Retry-After is surfaced instead of sleeping', async () => {
  const fetch = fakeFetch([jsonResponse({ RestException: { Status: 429, Message: 'slow down' } }, 429, { 'Retry-After': '120' })]);
  const { client } = makeClient(fetch);
  await assert.rejects(client.connectCall({ agentNumber: '9123456789', customerNumber: '9876543210' }), (e) => {
    assert.ok(e instanceof ExotelRateLimitError);
    assert.equal(e.kind, 'retryable');
    assert.equal(e.retryAfterMs, 120000);
    return true;
  });
  assert.equal(fetch.calls.length, 1);
});

test('error mapping: 401 auth (redacted), 400 validation, 402 balance, 404 not found', async () => {
  const cases = [
    [401, 'Authentication failed for test-api-key-123:test-api-token-456', ExotelAuthError, 'unauthorized'],
    [403, 'Forbidden', ExotelAuthError, 'forbidden'],
    [400, 'Missing parameter From', ExotelValidationError, 'invalid_request'],
    [402, 'Insufficient balance', ExotelProviderError, 'payment_required'],
    [404, 'Not found', ExotelNotFoundError, 'not_found'],
    [418, 'Teapot', ExotelProviderError, 'provider_error'],
  ];
  for (const [status, message, Type, code] of cases) {
    const fetch = fakeFetch([jsonResponse({ RestException: { Status: status, Message: message } }, status)]);
    const { client } = makeClient(fetch);
    await assert.rejects(client.getCall('b6cfaf5f5cef3ca0fc937749ef96d245'), (e) => {
      assert.ok(e instanceof Type, `${status} -> ${Type.name}`);
      assert.equal(e.code, code);
      assert.equal(e.status, status);
      assert.equal(e.retryable, false);
      assert.doesNotMatch(JSON.stringify(e), /test-api-token-456|test-api-key-123/);
      return true;
    });
    assert.equal(fetch.calls.length, 1, `${status} is not retried`);
  }
  const fetch = fakeFetch([new Response('<RestException><Message>Old XML error</Message></RestException>', { status: 400 })]);
  await assert.rejects(makeClient(fetch).client.getCall('b6cfaf5f5cef3ca0fc937749ef96d245'), (e) => e.providerMessage === 'Old XML error');
});

test('getCall: GET with details=true, retried on 503 and network errors with backoff', async () => {
  const fetch = fakeFetch([
    new Response('upstream down', { status: 503 }),
    new TypeError('fetch failed'),
    jsonResponse(callDetailsResponse),
  ]);
  const { client, sleeps } = makeClient(fetch);
  const call = await client.getCall('b6cfaf5f5cef3ca0fc937749ef96d245');
  assert.equal(fetch.calls.length, 3);
  for (const req of fetch.calls) {
    assert.equal(req.method, 'GET');
    assert.equal(req.url, 'https://api.in.exotel.com/v1/Accounts/phoenixedu1/Calls/b6cfaf5f5cef3ca0fc937749ef96d245.json?details=true');
    assert.equal(req.headers.Authorization, BASIC);
    assert.equal(req.body, undefined);
  }
  assert.deepEqual(sleeps, [225, 450], 'exponential backoff with jitter (random=0.5)');
  assert.equal(call.talkDurationSeconds, 320);
  assert.deepEqual(call.price, { amountMinor: 188, currency: 'INR' });
});

test('getCall gives up after maxRetries with a retryable error; bad ids and bodies are permanent', async () => {
  const fetch = fakeFetch([new TypeError('fetch failed'), new TypeError('fetch failed')]);
  const { client } = makeClient(fetch, { maxRetries: 1 });
  await assert.rejects(client.getCall('b6cfaf5f5cef3ca0fc937749ef96d245'), (e) => {
    assert.ok(e instanceof ExotelNetworkError);
    assert.equal(e.kind, 'retryable');
    assert.equal(e.outcomeUnknown, false);
    return true;
  });
  await assert.rejects(client.getCall('../../etc'), ExotelValidationError);
  const bad = makeClient(fakeFetch([new Response('not json', { status: 200 })])).client;
  await assert.rejects(bad.getCall('b6cfaf5f5cef3ca0fc937749ef96d245'), (e) => e.code === 'response_invalid');
});

test('caller abort is not retried', async () => {
  const controller = new AbortController();
  const fetch = fakeFetch([hang()]);
  const { client } = makeClient(fetch);
  const pending = client.getCall('b6cfaf5f5cef3ca0fc937749ef96d245', { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (e) => e.code === 'aborted' && e.retryable === false);
  assert.equal(fetch.calls.length, 1);
});

test('fetchRecording: Basic auth only to Exotel hosts, dropped on redirect to S3', async () => {
  const audio = Buffer.from('ID3fake-mp3-bytes');
  const fetch = fakeFetch([
    new Response(null, { status: 302, headers: { location: 'https://exotel-recordings.s3.ap-south-1.amazonaws.com/r.mp3?X-Amz-Signature=abc' } }),
    new Response(audio, { status: 200, headers: { 'content-type': 'audio/mpeg', 'content-length': String(audio.length) } }),
  ]);
  const { client } = makeClient(fetch);
  const result = await client.fetchRecording(callDetailsResponse.Call.RecordingUrl);
  assert.equal(result.contentType, 'audio/mpeg');
  assert.equal(result.sizeBytes, audio.length);
  assert.deepEqual(result.body, audio);
  assert.equal(fetch.calls[0].headers.Authorization, BASIC);
  assert.equal(fetch.calls[0].redirect, 'manual');
  assert.match(fetch.calls[1].url, /amazonaws\.com/);
  assert.equal(fetch.calls[1].headers.Authorization, undefined);
});

test('fetchRecording: size limit, not-yet-available, and unsafe URLs', async () => {
  const big = fakeFetch([new Response('x'.repeat(5000), { status: 200, headers: { 'content-length': '5000' } })]);
  await assert.rejects(makeClient(big).client.fetchRecording('https://recordings.exotel.com/a.mp3', { maxBytes: 1024 }), (e) => e.code === 'recording_too_large');

  const stream = new ReadableStream({
    start(controller) {
      for (let i = 0; i < 4; i += 1) controller.enqueue(new Uint8Array(600));
      controller.close();
    },
  });
  const chunked = fakeFetch([new Response(stream, { status: 200 })]);
  await assert.rejects(makeClient(chunked).client.fetchRecording('https://recordings.exotel.com/a.mp3', { maxBytes: 1024 }), (e) => e.code === 'recording_too_large');

  const missing = fakeFetch([new Response('', { status: 404 })]);
  await assert.rejects(makeClient(missing).client.fetchRecording('https://recordings.exotel.com/a.mp3'), (e) => {
    assert.ok(e instanceof ExotelNotFoundError);
    assert.equal(e.code, 'recording_not_available');
    assert.equal(e.retryable, true);
    return true;
  });

  const none = fakeFetch([]);
  const { client } = makeClient(none);
  await assert.rejects(client.fetchRecording('http://recordings.exotel.com/a.mp3'), ExotelValidationError);
  await assert.rejects(client.fetchRecording('https://u:p@recordings.exotel.com/a.mp3'), ExotelValidationError);
  await assert.rejects(client.fetchRecording('not a url'), ExotelValidationError);
  assert.equal(none.calls.length, 0);

  const evil = fakeFetch([new Response('x', { status: 200 })]);
  await makeClient(evil).client.fetchRecording('https://recordings.exotel.com.evil.test/a.mp3');
  assert.equal(evil.calls[0].headers.Authorization, undefined, 'look-alike hosts get no credentials');
});

test('client.verifyWebhook / parseWebhook use the configured secret, IP list and clock', () => {
  const { client } = makeClient(fakeFetch([]), { allowedWebhookIps: ['203.0.113.0/24'] });
  const url = new URL(client.buildStatusCallbackUrl('lead-42'));
  const body = JSON.stringify(terminalCallback);
  const headers = { 'content-type': 'application/json' };
  assert.equal(client.verifyWebhook(body, headers, { url: url.pathname + url.search, remoteIp: '203.0.113.9' }).valid, true);
  assert.equal(client.verifyWebhook(body, headers, { url: url.pathname + url.search, remoteIp: '192.0.2.9' }).valid, false);
  const flow = new URL(client.buildFlowUrl('https://crm.phoenix.test/hooks/exotel/passthru'));
  assert.equal(client.verifyWebhook('', {}, { url: `${flow.pathname}${flow.search}&CallSid=1`, remoteIp: '203.0.113.9' }).scheme, 'static_token');

  const [event] = client.parseWebhook({ CallSid: 'abcdef123456', Status: 'completed' });
  assert.equal(event.occurredAt, new Date(NOW).toISOString(), 'falls back to the injected clock');
});

test('redact masks secrets in arbitrary text', () => {
  const { client } = makeClient(fakeFetch([]));
  const text = client.redact(`token=test-api-token-456 secret=${SECRET} url=https://k:t@api.exotel.com/x`);
  assert.doesNotMatch(text, /test-api-token-456|test-secret|k:t@/);
});
