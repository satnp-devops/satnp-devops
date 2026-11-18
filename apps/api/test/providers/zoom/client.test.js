import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEMO_MEETING_SETTINGS,
  ZoomAuthError,
  ZoomConfigError,
  ZoomError,
  ZoomNetworkError,
  ZoomNotFoundError,
  ZoomPermissionError,
  ZoomRateLimitError,
  ZoomServerError,
  ZoomValidationError,
  createZoomClient,
  encodeMeetingRef,
  parseRetryAfter,
  parseZoomConfig,
} from '../../../src/integrations/providers/zoom/index.js';
import { TEST_CONFIG, deps, fakeClock, fakeFetch, fixture, json, tokenResponse } from './helpers.js';

const MEETING_RESPONSE = {
  id: 85746065123,
  uuid: 'aDYlohsHRtCd4ii/1c9ObA==',
  host_id: '30R7kT7bTIKSNUFEuH_Qlg',
  host_email: 'priya.sharma@phoenix.example',
  topic: 'Phoenix CRM demo - Sunrise Public School',
  type: 2,
  status: 'waiting',
  start_time: '2026-11-10T10:30:00Z',
  duration: 45,
  timezone: 'Asia/Kolkata',
  created_at: '2026-11-05T09:00:00Z',
  join_url: 'https://us05web.zoom.us/j/85746065123?pwd=abc',
  start_url: 'https://us05web.zoom.us/s/85746065123?zak=host-only',
  password: 'x7Kp2q',
  settings: { waiting_room: true },
};

function client(handler, { config = {}, now, fetchOptions } = {}) {
  const fetch = fakeFetch(handler, fetchOptions);
  const d = deps(fetch, now ?? fakeClock());
  return { zoom: createZoomClient({ ...TEST_CONFIG, ...config }, d), fetch, d };
}

const allText = (d, error) => JSON.stringify({ logs: d.logs, error: error && { ...error, message: error.message, json: error.toJSON() } });

test('config: defaults applied; invalid config names fields but never echoes secrets', () => {
  const config = parseZoomConfig(TEST_CONFIG);
  assert.equal(config.apiBaseUrl, 'https://api.zoom.us/v2');
  assert.equal(config.oauthTokenUrl, 'https://zoom.us/oauth/token');
  assert.equal(config.defaultHostUserId, 'me');
  assert.equal(config.defaultTimezone, 'Asia/Kolkata');
  assert.equal(config.webhookToleranceSeconds, 300);
  assert.equal(parseZoomConfig({ ...TEST_CONFIG, apiBaseUrl: 'https://api-in.zoom.us/v2/' }).apiBaseUrl, 'https://api-in.zoom.us/v2');

  assert.throws(() => parseZoomConfig({ ...TEST_CONFIG, accountId: '' }), (error) => {
    assert.ok(error instanceof ZoomConfigError);
    assert.equal(error.retryable, false);
    assert.match(error.message, /accountId/);
    return true;
  });
  assert.throws(() => parseZoomConfig({ ...TEST_CONFIG, apiBaseUrl: 'http://api.zoom.us/v2' }), /apiBaseUrl/);
  assert.throws(
    () => parseZoomConfig({ ...TEST_CONFIG, clientSecret: 12345678, timeoutMs: 5 }),
    (error) => !error.message.includes('12345678') && /clientSecret/.test(error.message) && /timeoutMs/.test(error.message),
  );
  assert.throws(() => createZoomClient({}), ZoomConfigError);
});

test('token: S2S account_credentials request shape', async () => {
  const { zoom, fetch } = client(() => undefined);
  const info = await zoom.getAccessToken();
  const [call] = fetch.tokenCalls();
  assert.equal(call.method, 'POST');
  assert.equal(call.url.toString(), 'https://zoom.us/oauth/token');
  assert.equal(call.headers.authorization, `Basic ${Buffer.from('test-client-id:test-client-secret-DO-NOT-USE').toString('base64')}`);
  assert.equal(call.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(call.body)), { grant_type: 'account_credentials', account_id: 'test-account-id' });
  assert.ok(call.signal instanceof AbortSignal, 'every request carries a timeout signal');
  assert.deepEqual(info, {
    expiresAt: '2026-11-05T09:59:59.000Z',
    scopes: ['meeting:write:meeting:admin', 'meeting:read:list_past_participants:admin'],
    apiUrl: 'https://api-in.zoom.us',
  });
  assert.equal(JSON.stringify(info).includes('access-token-1'), false, 'token string is not exposed');
});

test('token: cached until expiry minus skew, single flight for concurrent callers', async () => {
  const now = fakeClock();
  let n = 0;
  const { zoom, fetch } = client(() => json(200, MEETING_RESPONSE), { now, fetchOptions: { token: () => tokenResponse({ access_token: `tok-${++n}` }) } });
  await Promise.all([zoom.getMeeting(85746065123), zoom.getMeeting(85746065123), zoom.getMeeting(85746065123)]);
  assert.equal(fetch.tokenCalls().length, 1);
  assert.ok(fetch.apiCalls.every((c) => c.headers.authorization === 'Bearer tok-1'));

  now.advance((3599 - 61) * 1000);
  await zoom.getMeeting(85746065123);
  assert.equal(fetch.tokenCalls().length, 1, 'still fresh 61 s before expiry');
  now.advance(2000);
  await zoom.getMeeting(85746065123);
  assert.equal(fetch.tokenCalls().length, 2, 'refreshed inside the 60 s skew');
  assert.equal(fetch.apiCalls.at(-1).headers.authorization, 'Bearer tok-2');
});

test('token: rejected credentials are a permanent ZoomAuthError without secrets in message or logs', async () => {
  const { zoom, fetch, d } = client(() => undefined, {
    fetchOptions: { token: () => json(400, { reason: 'Invalid client_id or client_secret', error: 'invalid_client' }) },
  });
  const error = await zoom.getMeeting(85746065123).catch((e) => e);
  assert.ok(error instanceof ZoomAuthError);
  assert.equal(error.retryable, false);
  assert.equal(error.status, 400);
  assert.equal(error.providerCode, 'invalid_client');
  assert.equal(fetch.tokenCalls().length, 1, 'not retried');
  assert.equal(fetch.apiCalls.length, 0);
  const text = allText(d, error);
  assert.equal(text.includes(TEST_CONFIG.clientSecret), false);
  assert.equal(text.includes(Buffer.from(`${TEST_CONFIG.clientId}:${TEST_CONFIG.clientSecret}`).toString('base64')), false);
});

test('token: 5xx from the token endpoint is retried (token requests are side-effect free)', async () => {
  let tokenAttempts = 0;
  const { zoom, d } = client(() => json(200, MEETING_RESPONSE), {
    fetchOptions: { token: () => (++tokenAttempts === 1 ? json(503, { code: 503, message: 'busy' }) : tokenResponse()) },
  });
  await zoom.getMeeting(85746065123);
  assert.equal(tokenAttempts, 2);
  assert.deepEqual(d.sleeps, [375], 'backoff 500ms * jitter(0.75)');
});

test('createMeeting: request shape, UTC start_time, demo defaults, normalised response', async () => {
  const { zoom, fetch } = client(() => json(201, MEETING_RESPONSE));
  const meeting = await zoom.createMeeting({
    topic: 'Phoenix CRM demo - Sunrise Public School',
    startTime: '2026-11-10T16:00:00+05:30',
    durationMinutes: 45,
    agenda: 'Admissions module walkthrough',
    alternativeHosts: ['ravi@phoenix.example'],
    invitees: ['principal@sunrise.example'],
    settings: { mute_upon_entry: true },
  });
  const [call] = fetch.apiCalls;
  assert.equal(call.method, 'POST');
  assert.equal(call.url.toString(), 'https://api.zoom.us/v2/users/me/meetings');
  assert.equal(call.headers.authorization, 'Bearer access-token-1');
  assert.equal(call.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(call.body), {
    topic: 'Phoenix CRM demo - Sunrise Public School',
    type: 2,
    duration: 45,
    timezone: 'Asia/Kolkata',
    start_time: '2026-11-10T10:30:00Z',
    agenda: 'Admissions module walkthrough',
    settings: {
      ...DEMO_MEETING_SETTINGS,
      alternative_hosts: 'ravi@phoenix.example',
      meeting_invitees: [{ email: 'principal@sunrise.example' }],
      mute_upon_entry: true,
    },
  });
  assert.equal(meeting.id, '85746065123');
  assert.equal(meeting.uuid, 'aDYlohsHRtCd4ii/1c9ObA==');
  assert.equal(meeting.startTime, '2026-11-10T10:30:00.000Z');
  assert.equal(meeting.joinUrl, 'https://us05web.zoom.us/j/85746065123?pwd=abc');
  assert.equal(meeting.startUrl, 'https://us05web.zoom.us/s/85746065123?zak=host-only');
  assert.equal(meeting.durationMinutes, 45);
  assert.equal(meeting.provider, 'zoom');
});

test('createMeeting: host, schedule_for, config meetingSettings, instant meetings, Date input', async () => {
  const { zoom, fetch } = client(() => json(201, MEETING_RESPONSE), {
    config: { meetingSettings: { auto_recording: 'cloud', waiting_room: false }, defaultTimezone: 'Asia/Dubai' },
  });
  await zoom.createMeeting({ hostUserId: 'priya.sharma@phoenix.example', topic: 'Demo', startTime: new Date('2026-11-10T10:30:00.999Z'), scheduleFor: 'x@y.example' });
  const body = JSON.parse(fetch.apiCalls[0].body);
  assert.equal(fetch.apiCalls[0].url.pathname, '/v2/users/priya.sharma%40phoenix.example/meetings');
  assert.equal(body.start_time, '2026-11-10T10:30:00Z');
  assert.equal(body.duration, 30, 'default duration');
  assert.equal(body.timezone, 'Asia/Dubai');
  assert.equal(body.schedule_for, 'x@y.example');
  assert.equal(body.settings.auto_recording, 'cloud');
  assert.equal(body.settings.waiting_room, false);

  await zoom.createMeeting({ kind: 'instant', topic: 'Call now' });
  const instant = JSON.parse(fetch.apiCalls[1].body);
  assert.equal(instant.type, 1);
  assert.equal('start_time' in instant, false);
});

test('createMeeting: invalid input fails before any request', async () => {
  const { zoom, fetch } = client(() => json(201, MEETING_RESPONSE));
  const cases = [
    [{ startTime: '2026-11-10T10:30:00Z' }, /topic/],
    [{ topic: 'x' }, /startTime is required/],
    [{ topic: 'x', startTime: '2026-11-10 10:30' }, /startTime/],
    [{ topic: 'x', startTime: '2026-11-01T10:30:00Z' }, /in the past/],
    [{ topic: 'x', startTime: '2026-11-10T10:30:00Z', password: '12345678901' }, /password/],
    [{ topic: 'x', startTime: '2026-11-10T10:30:00Z', durationMinutes: 0 }, /durationMinutes/],
    [{ topic: 'x', startTime: '2026-11-10T10:30:00Z', invitees: ['not-an-email'] }, /invitees/],
    [{ topic: 'x'.repeat(201), startTime: '2026-11-10T10:30:00Z' }, /topic/],
  ];
  for (const [input, pattern] of cases) {
    await assert.rejects(zoom.createMeeting(input), (error) => error instanceof ZoomValidationError && pattern.test(error.message));
  }
  assert.equal(fetch.calls.length, 0);
});

test('createMeeting is never retried: 5xx and timeouts are ambiguous, 429 is retryable but not repeated', async () => {
  const input = { topic: 'Demo', startTime: '2026-11-10T10:30:00Z' };

  const server = client(() => json(500, { code: 500, message: 'Internal error' }));
  const e1 = await server.zoom.createMeeting(input).catch((e) => e);
  assert.ok(e1 instanceof ZoomServerError);
  assert.equal(e1.retryable, false);
  assert.equal(e1.ambiguous, true);
  assert.equal(server.fetch.apiCalls.length, 1);

  const timeoutFetch = fakeFetch(() => {
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  });
  const tz = createZoomClient(TEST_CONFIG, deps(timeoutFetch));
  const e2 = await tz.createMeeting(input).catch((e) => e);
  assert.ok(e2 instanceof ZoomNetworkError);
  assert.equal(e2.kind, 'timeout');
  assert.equal(e2.ambiguous, true);
  assert.equal(e2.retryable, false);
  assert.equal(timeoutFetch.apiCalls.length, 1);

  const limited = client(() => json(429, { code: 429, message: 'You have reached the maximum per-second rate limit for this API. Try again later.' }, { 'x-ratelimit-type': 'QPS', 'x-ratelimit-category': 'Light' }));
  const e3 = await limited.zoom.createMeeting(input).catch((e) => e);
  assert.ok(e3 instanceof ZoomRateLimitError);
  assert.equal(e3.retryable, true);
  assert.equal(e3.ambiguous, false);
  assert.equal(e3.limitType, 'QPS');
  assert.equal(e3.limitCategory, 'Light');
  assert.equal(e3.retryAfterMs, 1000);
  assert.equal(limited.fetch.apiCalls.length, 1);

  const refused = fakeFetch(() => {
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
  });
  const e4 = await createZoomClient(TEST_CONFIG, deps(refused)).createMeeting(input).catch((e) => e);
  assert.equal(e4.kind, 'network');
  assert.equal(e4.retryable, true, 'never reached Zoom, safe for the caller to retry');
  assert.equal(e4.ambiguous, false);
});

test('a response body that breaks mid-stream after a 201 is ambiguous for create', async () => {
  const broken = () => new Response(new ReadableStream({ start: (controller) => controller.error(new Error('socket reset')) }), { status: 201 });
  const { zoom, fetch } = client(broken);
  const error = await zoom.createMeeting({ topic: 'Demo', startTime: '2026-11-10T10:30:00Z' }).catch((e) => e);
  assert.ok(error instanceof ZoomNetworkError);
  assert.equal(error.ambiguous, true);
  assert.equal(error.retryable, false);
  assert.equal(fetch.apiCalls.length, 1);
});

test('401 from the API refreshes the token once and retries (any method)', async () => {
  let n = 0;
  let apiAttempts = 0;
  const { zoom, fetch } = client(
    () => (++apiAttempts === 1 ? json(401, { code: 124, message: 'Access token has expired.' }) : json(201, MEETING_RESPONSE)),
    { fetchOptions: { token: () => tokenResponse({ access_token: `tok-${++n}` }) } },
  );
  const meeting = await zoom.createMeeting({ topic: 'Demo', startTime: '2026-11-10T10:30:00Z' });
  assert.equal(meeting.id, '85746065123');
  assert.equal(fetch.tokenCalls().length, 2);
  assert.deepEqual(fetch.apiCalls.map((c) => c.headers.authorization), ['Bearer tok-1', 'Bearer tok-2']);

  const always = client(() => json(401, { code: 124, message: 'Invalid access token.' }));
  const error = await always.zoom.getMeeting(85746065123).catch((e) => e);
  assert.ok(error instanceof ZoomAuthError);
  assert.equal(error.providerCode, 124);
  assert.equal(always.fetch.apiCalls.length, 2, 'one refresh, then give up');
});

test('idempotent calls retry 5xx/429 with backoff and Retry-After, bounded by maxRetries', async () => {
  let attempts = 0;
  const { zoom, d, fetch } = client(() => {
    attempts += 1;
    if (attempts === 1) return json(503, { code: 503, message: 'Service Unavailable' });
    if (attempts === 2) return json(429, { code: 429, message: 'per-second' }, { 'retry-after': '2' });
    return json(200, MEETING_RESPONSE);
  });
  const meeting = await zoom.getMeeting('85746065123', { occurrenceId: '1648194360000' });
  assert.equal(meeting.topic, 'Phoenix CRM demo - Sunrise Public School');
  assert.deepEqual(d.sleeps, [375, 2000]);
  assert.equal(fetch.apiCalls[0].url.toString(), 'https://api.zoom.us/v2/meetings/85746065123?occurrence_id=1648194360000');
  assert.equal(fetch.apiCalls[0].method, 'GET');

  const down = client(() => json(502, { message: 'Bad Gateway' }));
  const error = await down.zoom.getMeeting(85746065123).catch((e) => e);
  assert.ok(error instanceof ZoomServerError);
  assert.equal(error.retryable, true);
  assert.equal(error.ambiguous, false);
  assert.equal(down.fetch.apiCalls.length, 3, '1 + maxRetries(2)');
  assert.deepEqual(down.d.sleeps, [375, 750]);
});

test('daily rate limits are not waited for: retryAfterMs points at the reset', async () => {
  const header = client(() => json(429, { code: 429, message: 'You have reached the maximum daily rate limit for this API.' }, { 'retry-after': '2026-11-06T00:00:00Z', 'x-ratelimit-type': 'Daily-limit' }));
  const e1 = await header.zoom.getMeeting(85746065123).catch((e) => e);
  assert.ok(e1 instanceof ZoomRateLimitError);
  assert.equal(e1.retryAfterMs, 15 * 3600 * 1000);
  assert.equal(header.fetch.apiCalls.length, 1);

  const noHeader = client(() => json(429, { code: 429, message: 'You have reached the maximum daily rate limit for this API.' }));
  const e2 = await noHeader.zoom.getMeeting(85746065123).catch((e) => e);
  assert.equal(e2.retryAfterMs, 15 * 3600 * 1000, 'until 00:00 UTC');
  assert.equal(noHeader.fetch.apiCalls.length, 1);

  assert.equal(parseRetryAfter('3', 0), 3000);
  assert.equal(parseRetryAfter('Thu, 05 Nov 2026 09:00:10 GMT', Date.parse('2026-11-05T09:00:00Z')), 10_000);
  assert.equal(parseRetryAfter('soon', 0), null);
  assert.equal(parseRetryAfter(null, 0), null);
});

test('error mapping: Zoom status and code to typed errors', async () => {
  const cases = [
    [json(400, { code: 300, message: 'Invalid field.', errors: [{ field: 'settings.jbh_time', message: 'bad' }] }), ZoomValidationError, 'validation'],
    [json(400, { code: 3161, message: 'Your user account is not allowed meeting hosting and scheduling capabilities.' }), ZoomPermissionError, 'permission'],
    [json(400, { code: 200, message: 'No permission.' }), ZoomPermissionError, 'permission'],
    [json(403, { code: 4711, message: 'Invalid access token, does not contain scopes.' }), ZoomPermissionError, 'permission'],
    [json(404, { code: 3001, message: 'Meeting does not exist: 85746065123.' }), ZoomNotFoundError, 'not_found'],
    [json(409, { code: 1005, message: 'Conflict' }), ZoomValidationError, 'conflict'],
    [new Response('<html>teapot</html>', { status: 418 }), ZoomError, 'unknown'],
  ];
  for (const [response, ErrorClass, kind] of cases) {
    const { zoom } = client(() => response.clone());
    const error = await zoom.getMeeting(85746065123).catch((e) => e);
    assert.ok(error instanceof ErrorClass, `${response.status} -> ${ErrorClass.name}`);
    assert.equal(error.kind, kind);
    assert.equal(error.retryable, false);
    assert.equal(error.status, response.status);
    assert.equal(error.path, '/meetings/85746065123');
    assert.equal(error.method, 'GET');
  }
  const { zoom } = client(() => json(400, { code: 300, message: 'Invalid field.', errors: [{ field: 'settings.jbh_time', message: 'bad' }] }));
  const error = await zoom.getMeeting(85746065123).catch((e) => e);
  assert.equal(error.providerCode, 300);
  assert.deepEqual(error.details, [{ field: 'settings.jbh_time', message: 'bad' }]);
  assert.match(error.message, /^Zoom GET \/meetings\/85746065123 failed \(400 code 300\): Invalid field\.$/);
});

test('secrets and tokens are redacted from error messages and never logged', async () => {
  const { zoom, d } = client(() =>
    json(400, { code: 300, message: `echo ${TEST_CONFIG.clientSecret} access-token-1 ${TEST_CONFIG.webhookSecretToken}` }),
  );
  const error = await zoom.getMeeting(85746065123).catch((e) => e);
  assert.match(error.message, /\[REDACTED\]/);
  const text = allText(d, error);
  for (const secret of [TEST_CONFIG.clientSecret, TEST_CONFIG.webhookSecretToken, 'access-token-1']) {
    assert.equal(text.includes(secret), false, `${secret} leaked`);
  }
  assert.ok(d.logs.some((l) => l.level === 'warn' && l.obj.zoom.status === 400));
});

test('meeting IDs above 2^53 survive JSON parsing as strings', async () => {
  const big = '{"id":12345678901234567890,"uuid":"u","topic":"t","start_time":"2026-11-10T10:30:00Z"}';
  const { zoom } = client(() => new Response(big, { status: 200, headers: { 'content-type': 'application/json' } }));
  const meeting = await zoom.getMeeting('85746065123');
  assert.equal(meeting.id, '12345678901234567890');
});

test('updateMeeting sends only the changed fields (PATCH, 204); validation and occurrences', async () => {
  const { zoom, fetch } = client(() => new Response(null, { status: 204 }));
  const result = await zoom.updateMeeting(85746065123, { startTime: '2026-11-11T17:00:00+05:30', durationMinutes: 60, invitees: ['a@b.example'] }, { occurrenceId: '1648194360000' });
  assert.deepEqual(result, { updated: true });
  const [call] = fetch.apiCalls;
  assert.equal(call.method, 'PATCH');
  assert.equal(call.url.toString(), 'https://api.zoom.us/v2/meetings/85746065123?occurrence_id=1648194360000');
  assert.deepEqual(JSON.parse(call.body), { start_time: '2026-11-11T11:30:00Z', duration: 60, settings: { meeting_invitees: [{ email: 'a@b.example' }] } });

  await assert.rejects(zoom.updateMeeting(85746065123, {}), ZoomValidationError);
  await assert.rejects(zoom.updateMeeting(85746065123, { startTime: '2026-11-01T00:00:00Z' }), /in the past/);
  await assert.rejects(zoom.updateMeeting('85746065123; DROP', { topic: 'x' }), /meeting ID/);
  assert.equal(fetch.apiCalls.length, 1);
});

test('deleteMeeting: query flags, and an already deleted meeting counts as deleted', async () => {
  let status = 204;
  const { zoom, fetch } = client(() => (status === 204 ? new Response(null, { status }) : json(404, { code: 3001, message: 'Meeting does not exist: 85746065123.' })));
  assert.deepEqual(await zoom.deleteMeeting('85746065123', { notifyRegistrants: true }), { deleted: true, alreadyDeleted: false });
  const [call] = fetch.apiCalls;
  assert.equal(call.method, 'DELETE');
  assert.equal(call.url.pathname, '/v2/meetings/85746065123');
  assert.deepEqual(Object.fromEntries(call.url.searchParams), { schedule_for_reminder: 'false', cancel_meeting_reminder: 'true' });
  assert.equal(call.body, undefined);
  status = 404;
  assert.deepEqual(await zoom.deleteMeeting(85746065123), { deleted: true, alreadyDeleted: true });
});

test('encodeMeetingRef: numeric IDs as is, UUIDs encoded once, UUIDs with "/" double-encoded', () => {
  assert.equal(encodeMeetingRef(85746065123), '85746065123');
  assert.equal(encodeMeetingRef('4444AAAiAAAAAiAiAiiAii=='), '4444AAAiAAAAAiAiAiiAii%3D%3D');
  assert.equal(encodeMeetingRef('ab+cd=='), 'ab%2Bcd%3D%3D');
  assert.equal(encodeMeetingRef('/ajXp112QmuoKj4854875=='), '%252FajXp112QmuoKj4854875%253D%253D');
  assert.equal(encodeMeetingRef('ab//cd=='), 'ab%252F%252Fcd%253D%253D');
  assert.equal(encodeMeetingRef('aDYlohsHRtCd4ii/1c9ObA=='), 'aDYlohsHRtCd4ii%252F1c9ObA%253D%253D');
  assert.throws(() => encodeMeetingRef(''), ZoomValidationError);
});

test('listParticipants pages through the report endpoint with a double-encoded UUID', async () => {
  const pages = [fixture('report_participants_page1.json'), fixture('report_participants_page2.json')];
  const { zoom, fetch } = client((call, index) => json(200, pages[index]));
  const { participants } = await zoom.listParticipants('aDYlohsHRtCd4ii/1c9ObA==');
  assert.equal(participants.length, 6);
  const [first, second] = fetch.apiCalls;
  assert.equal(first.url.pathname, '/v2/report/meetings/aDYlohsHRtCd4ii%252F1c9ObA%253D%253D/participants');
  assert.deepEqual(Object.fromEntries(first.url.searchParams), { page_size: '300', include_fields: 'registrant_id' });
  assert.deepEqual(Object.fromEntries(second.url.searchParams), { page_size: '300', next_page_token: 'Tva2CuIdTgsv8wAnhyAdU3m06Y2HuLQtlh3', include_fields: 'registrant_id' });
  assert.deepEqual(participants[1], {
    userId: '16779264',
    zoomUserId: null,
    participantUuid: null,
    registrantId: 'rKq8bQmFQ0eTxG3l2X5mEw',
    name: 'Rahul Verma',
    email: 'rahul.verma@example.in',
    customerKey: null,
    phoneNumber: null,
    joinTime: '2026-11-10T10:31:00.000Z',
    leaveTime: '2026-11-10T10:48:30.000Z',
    durationSeconds: 1050,
    status: 'in_meeting',
    internalUser: null,
    leaveReason: null,
  });
  assert.equal(participants[0].zoomUserId, '30R7kT7bTIKSNUFEuH_Qlg');
});

test('listParticipants source "past" uses /past_meetings; maxPages bounds runaway pagination', async () => {
  const { zoom, fetch, d } = client(() => json(200, { next_page_token: 'again', participants: [{ user_id: '1', name: 'A', join_time: '2026-11-10T10:31:00Z' }] }));
  const { participants } = await zoom.listParticipants(85746065123, { source: 'past', pageSize: 50, maxPages: 3 });
  assert.equal(participants.length, 3);
  assert.equal(fetch.apiCalls[0].url.pathname, '/v2/past_meetings/85746065123/participants');
  assert.deepEqual(Object.fromEntries(fetch.apiCalls[0].url.searchParams), { page_size: '50' });
  assert.ok(d.logs.some((l) => l.msg.includes('maxPages')));
});

test('getPastMeeting and listPastInstances', async () => {
  const { zoom, fetch } = client((call) =>
    call.url.pathname.endsWith('/instances')
      ? json(200, { meetings: [{ uuid: 'aDYlohsHRtCd4ii/1c9ObA==', start_time: '2026-11-10T10:29:10Z' }] })
      : json(200, { id: 85746065123, uuid: 'aDYlohsHRtCd4ii/1c9ObA==', start_time: '2026-11-10T10:29:10Z', end_time: '2026-11-10T11:15:00Z', duration: 46, participants_count: 6, total_minutes: 140, topic: 'Demo' }),
  );
  const past = await zoom.getPastMeeting('aDYlohsHRtCd4ii/1c9ObA==');
  assert.equal(fetch.apiCalls[0].url.pathname, '/v2/past_meetings/aDYlohsHRtCd4ii%252F1c9ObA%253D%253D');
  assert.equal(past.endTime, '2026-11-10T11:15:00.000Z');
  assert.equal(past.participantsCount, 6);
  assert.deepEqual(await zoom.listPastInstances(85746065123), [{ uuid: 'aDYlohsHRtCd4ii/1c9ObA==', startTime: '2026-11-10T10:29:10.000Z' }]);
});

test('useTokenApiUrl sends requests to the regional cluster, but only to zoom.us hosts', async () => {
  const { zoom, fetch } = client(() => json(200, MEETING_RESPONSE), { config: { useTokenApiUrl: true } });
  await zoom.getMeeting(85746065123);
  assert.equal(fetch.apiCalls[0].url.origin, 'https://api-in.zoom.us');
  assert.equal(fetch.apiCalls[0].url.pathname, '/v2/meetings/85746065123');

  const evil = client(() => json(200, MEETING_RESPONSE), { config: { useTokenApiUrl: true }, fetchOptions: { token: () => tokenResponse({ api_url: 'https://attacker.example' }) } });
  await evil.zoom.getMeeting(85746065123);
  assert.equal(evil.fetch.apiCalls[0].url.origin, 'https://api.zoom.us');
});

test('a caller AbortSignal cancels the request without retries', async () => {
  const controller = new AbortController();
  const fetch = fakeFetch(() => {
    controller.abort();
    throw new DOMException('aborted', 'AbortError');
  });
  const zoom = createZoomClient(TEST_CONFIG, deps(fetch));
  const error = await zoom.getMeeting(85746065123, { signal: controller.signal }).catch((e) => e);
  assert.ok(error instanceof ZoomError);
  assert.match(error.message, /aborted by caller/);
  assert.equal(fetch.apiCalls.length, 1);
});

test('client exposes provider metadata and is frozen', () => {
  const { zoom } = client(() => undefined);
  assert.equal(zoom.provider, 'zoom');
  assert.ok(zoom.capabilities.includes('meetings.create'));
  assert.ok(Object.isFrozen(zoom));
  assert.equal(JSON.stringify(zoom).includes(TEST_CONFIG.clientSecret), false);
});
