import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FullSyncRequiredError, GoogleError, eventIdFromKey, verifyWebhook } from '../../../src/integrations/providers/google/index.js';
import { CHANNEL_SECRET, NOW, fixture, googleError, makeClient, tokenOk } from './_helpers.js';

const CAL = 'counsellor@phoenix-school.example.in';
const CAL_PATH = `/calendar/v3/calendars/${encodeURIComponent(CAL)}`;

function eventFixture(name, id, requestId = 'req') {
  return JSON.parse(JSON.stringify(fixture(name)).replaceAll('PLACEHOLDER_ID', id).replaceAll('PLACEHOLDER_REQUEST', requestId));
}

test('freeBusy posts the documented body and returns UTC busy intervals', async () => {
  const { client, fake } = makeClient([tokenOk(), { json: fixture('freebusy-response.json') }]);
  const result = await client.calendar.freeBusy({
    calendarIds: [CAL, 'unknown@example.com'],
    timeMin: '2026-11-10T05:30:00+05:30',
    timeMax: new Date('2026-11-11T00:00:00Z'),
  });
  const call = fake.calls[1];
  assert.equal(call.method, 'POST');
  assert.equal(call.url.href, 'https://www.googleapis.com/calendar/v3/freeBusy');
  assert.equal(call.headers.authorization, 'Bearer ya29.test-access-token-0001');
  assert.equal(call.headers['content-type'], 'application/json');
  assert.deepEqual(call.json, {
    timeMin: '2026-11-10T00:00:00.000Z',
    timeMax: '2026-11-11T00:00:00.000Z',
    timeZone: 'UTC',
    calendarExpansionMax: 2,
    items: [{ id: CAL }, { id: 'unknown@example.com' }],
  });
  assert.deepEqual(result.calendars[CAL].busy, [
    { start: '2026-11-10T04:30:00.000Z', end: '2026-11-10T05:00:00.000Z' },
    { start: '2026-11-10T09:00:00.000Z', end: '2026-11-10T10:15:00.000Z' },
  ]);
  assert.deepEqual(result.calendars['unknown@example.com'].errors, [{ domain: 'global', reason: 'notFound' }]);
});

test('freeBusy splits more than 50 calendars into several queries', async () => {
  const ids = Array.from({ length: 51 }, (_, i) => `host${i}@school.example.in`);
  const { client, fake } = makeClient([
    tokenOk(),
    { json: { calendars: Object.fromEntries(ids.slice(0, 50).map((id) => [id, { busy: [] }])) } },
    { json: { calendars: { [ids[50]]: { busy: [{ start: '2026-11-10T04:30:00Z', end: '2026-11-10T05:00:00Z' }] } } } },
  ]);
  const result = await client.calendar.freeBusy({ calendarIds: ids, timeMin: '2026-11-10T00:00:00Z', timeMax: '2026-11-11T00:00:00Z' });
  assert.equal(fake.calls.length, 3);
  assert.equal(fake.calls[1].json.items.length, 50);
  assert.equal(fake.calls[2].json.items.length, 1);
  assert.equal(Object.keys(result.calendars).length, 51);
});

test('freeBusy rejects naive local times and empty ranges before calling Google', async () => {
  const { client, fake } = makeClient([]);
  await assert.rejects(client.calendar.freeBusy({ calendarIds: [CAL], timeMin: '2026-11-10T10:00:00', timeMax: '2026-11-10T11:00:00Z' }), {
    code: 'bad_request',
    reason: 'invalid_time',
  });
  await assert.rejects(client.calendar.freeBusy({ calendarIds: [CAL], timeMin: '2026-11-10T10:00:00Z', timeMax: '2026-11-10T10:00:00Z' }), {
    reason: 'timeRangeEmpty',
  });
  assert.equal(fake.calls.length, 0);
});

test('insertEvent with Meet sends conferenceDataVersion=1, a deterministic id and a createRequest', async () => {
  const key = 'booking:bk_01HZX';
  const id = eventIdFromKey(key);
  const { client, fake } = makeClient([tokenOk(), { json: eventFixture('event-with-meet.json', id) }]);
  const event = await client.calendar.insertEvent({
    calendarId: CAL,
    idempotencyKey: key,
    summary: 'Admission counselling: Aarav Sharma (Class 6)',
    start: '2026-11-10T10:00:00+05:30',
    end: '2026-11-10T10:30:00+05:30',
    attendees: [{ email: 'parent.sharma@example.com', displayName: 'Priya Sharma' }],
    reminders: [{ method: 'popup', minutes: 15 }],
    extendedProperties: { private: { phoenixBookingId: 'bk_01HZX' } },
    withMeet: true,
    sendUpdates: 'all',
  });
  const call = fake.calls[1];
  assert.equal(call.method, 'POST');
  assert.equal(call.url.pathname, `${CAL_PATH}/events`);
  assert.equal(call.url.searchParams.get('conferenceDataVersion'), '1');
  assert.equal(call.url.searchParams.get('sendUpdates'), 'all');
  assert.match(id, /^[a-v0-9]{64}$/);
  assert.equal(call.json.id, id);
  assert.deepEqual(call.json.start, { dateTime: '2026-11-10T04:30:00.000Z', timeZone: 'Asia/Kolkata' });
  assert.deepEqual(call.json.end, { dateTime: '2026-11-10T05:00:00.000Z', timeZone: 'Asia/Kolkata' });
  assert.deepEqual(call.json.attendees, [{ email: 'parent.sharma@example.com', displayName: 'Priya Sharma' }]);
  assert.deepEqual(call.json.reminders, { useDefault: false, overrides: [{ method: 'popup', minutes: 15 }] });
  assert.equal(call.json.conferenceData.createRequest.conferenceSolutionKey.type, 'hangoutsMeet');
  assert.match(call.json.conferenceData.createRequest.requestId, /^[0-9a-f]{32}$/);

  assert.equal(event.id, id);
  assert.equal(event.deduplicated, false);
  assert.equal(event.start.at, '2026-11-10T04:30:00.000Z');
  assert.equal(event.start.timeZone, 'Asia/Kolkata');
  assert.deepEqual(event.meet, {
    url: 'https://meet.google.com/abc-mnop-xyz',
    meetingCode: 'abc-mnop-xyz',
    conferenceId: 'abc-mnop-xyz',
    status: 'success',
    phone: [{ uri: 'tel:+91-22-7127-0000', label: '+91 22 7127 0000', pin: '123456789', regionCode: 'IN' }],
    moreUri: 'https://tel.meet/abc-mnop-xyz?pin=123456789',
  });
  assert.equal(event.extendedProperties.private.phoenixBookingId, 'bk_01HZX');
});

test('insertEvent without Meet sends conferenceDataVersion=0 and defaults sendUpdates to none', async () => {
  const { client, fake } = makeClient([tokenOk(), { json: { id: 'abcde12345', start: {}, end: {} } }]);
  await client.calendar.insertEvent({ summary: 'Demo', start: new Date(NOW), end: NOW + 1800_000 });
  const call = fake.calls[1];
  assert.equal(call.url.pathname, '/calendar/v3/calendars/primary/events');
  assert.equal(call.url.searchParams.get('conferenceDataVersion'), '0');
  assert.equal(call.url.searchParams.get('sendUpdates'), 'none');
  assert.equal('conferenceData' in call.json, false);
  assert.equal('id' in call.json, false);
});

test('idempotent insert retries a 503 and resolves a 409 duplicate to the existing event', async () => {
  const key = 'booking:retry';
  const id = eventIdFromKey(key);
  const { client, fake, sleeps } = makeClient([
    tokenOk(),
    { status: 503, json: { error: { code: 503, message: 'Backend Error', errors: [{ reason: 'backendError' }] } } },
    googleError(409, 'duplicate', 'The requested identifier already exists.'),
    { json: eventFixture('event-insert-pending.json', id) },
  ]);
  const event = await client.calendar.insertEvent({ idempotencyKey: key, calendarId: CAL, start: '2026-11-10T04:30:00Z', end: '2026-11-10T05:00:00Z', withMeet: true });
  assert.equal(event.deduplicated, true);
  assert.equal(event.meet.status, 'pending');
  assert.equal(event.meet.url, null);
  assert.deepEqual(sleeps, [100]);
  assert.equal(fake.calls[1].json.id, fake.calls[2].json.id);
  assert.equal(fake.calls[3].method, 'GET');
  assert.equal(fake.calls[3].url.pathname, `${CAL_PATH}/events/${id}`);
});

test('insert without an idempotency key is not retried', async () => {
  const { client, fake } = makeClient([tokenOk(), { status: 503, json: { error: { code: 503, message: 'Backend Error' } } }]);
  await assert.rejects(client.calendar.insertEvent({ start: '2026-11-10T04:30:00Z', end: '2026-11-10T05:00:00Z' }), {
    code: 'server_error',
    retryable: true,
  });
  assert.equal(fake.calls.length, 2);
});

test('waitForConference polls until the Meet link is ready', async () => {
  const id = 'abcdef0123';
  const { client, fake, sleeps } = makeClient([
    tokenOk(),
    { json: eventFixture('event-insert-pending.json', id) },
    { json: eventFixture('event-with-meet.json', id) },
  ]);
  const event = await client.calendar.waitForConference({ calendarId: CAL, eventId: id, intervalMs: 500 });
  assert.equal(event.meet.url, 'https://meet.google.com/abc-mnop-xyz');
  assert.deepEqual(sleeps, [500]);
  assert.equal(fake.calls.length, 3);
});

test('patchEvent is a PATCH with only the changed fields and is never retried', async () => {
  const { client, fake } = makeClient([tokenOk(), { status: 500, json: { error: { code: 500, message: 'Backend Error' } } }]);
  await assert.rejects(
    client.calendar.patchEvent({ calendarId: CAL, eventId: 'abcdef0123', changes: { start: '2026-11-11T04:30:00Z', end: '2026-11-11T05:00:00Z' }, sendUpdates: 'all' }),
    { code: 'server_error' },
  );
  const call = fake.calls[1];
  assert.equal(fake.calls.length, 2);
  assert.equal(call.method, 'PATCH');
  assert.equal(call.url.pathname, `${CAL_PATH}/events/abcdef0123`);
  assert.equal(call.url.searchParams.get('conferenceDataVersion'), '0');
  assert.deepEqual(Object.keys(call.json).sort(), ['end', 'start']);
});

test('deleteEvent treats 410 as already deleted', async () => {
  const { client, fake } = makeClient([tokenOk(), { status: 204 }, googleError(410, 'deleted', 'Resource has been deleted')]);
  assert.deepEqual(await client.calendar.deleteEvent({ calendarId: CAL, eventId: 'abcdef0123', sendUpdates: 'all' }), { deleted: true, alreadyDeleted: false });
  assert.equal(fake.calls[1].method, 'DELETE');
  assert.equal(fake.calls[1].url.searchParams.get('sendUpdates'), 'all');
  assert.deepEqual(await client.calendar.deleteEvent({ calendarId: CAL, eventId: 'abcdef0123' }), { deleted: true, alreadyDeleted: true });
});

test('syncEvents follows pages and returns the next sync token', async () => {
  const { client, fake } = makeClient([
    tokenOk(),
    { json: { items: [{ id: 'aaaaa11111', status: 'confirmed', start: { dateTime: '2026-11-10T10:00:00+05:30' }, end: {} }], nextPageToken: 'p2' } },
    { json: { items: [{ id: 'bbbbb22222', status: 'cancelled' }], nextSyncToken: 'sync-2' } },
  ]);
  const result = await client.calendar.syncEvents({ calendarId: CAL, syncToken: 'sync-1' });
  assert.equal(result.nextSyncToken, 'sync-2');
  assert.equal(result.fullSync, false);
  assert.deepEqual(result.events.map((e) => [e.id, e.status]), [['aaaaa11111', 'confirmed'], ['bbbbb22222', 'cancelled']]);
  assert.equal(fake.calls[1].url.searchParams.get('syncToken'), 'sync-1');
  assert.equal(fake.calls[2].url.searchParams.get('syncToken'), 'sync-1');
  assert.equal(fake.calls[2].url.searchParams.get('pageToken'), 'p2');
  assert.equal(fake.calls[1].url.searchParams.get('maxResults'), '2500');
});

test('an expired sync token raises FullSyncRequiredError', async () => {
  const { client } = makeClient([tokenOk(), googleError(410, 'fullSyncRequired', 'Sync token is no longer valid, a full sync is required.', 'calendar')]);
  await assert.rejects(client.calendar.syncEvents({ calendarId: CAL, syncToken: 'old' }), (error) => {
    assert.ok(error instanceof FullSyncRequiredError);
    assert.equal(error.code, 'full_sync_required');
    assert.equal(error.retryable, false);
    return true;
  });
});

test('listEvents refuses filters that Google rejects with a sync token', async () => {
  const { client, fake } = makeClient([]);
  await assert.rejects(client.calendar.listEvents({ syncToken: 's', timeMin: '2026-11-10T00:00:00Z', q: 'x' }), /q, timeMin/);
  assert.equal(fake.calls.length, 0);
});

test('watchEvents creates a web_hook channel whose token verifies', async () => {
  const { client, fake } = makeClient([
    tokenOk(),
    (call) => ({ json: { ...fixture('watch-response.json'), id: call.json.id, token: call.json.token, expiration: String(NOW + 604800_000) } }),
  ]);
  const channel = await client.calendar.watchEvents({ calendarId: CAL, channelId: 'phx-cal-0001' });
  const call = fake.calls[1];
  assert.equal(call.method, 'POST');
  assert.equal(call.url.pathname, `${CAL_PATH}/events/watch`);
  assert.equal(call.json.id, 'phx-cal-0001');
  assert.equal(call.json.type, 'web_hook');
  assert.equal(call.json.address, 'https://crm.phoenix.example.in/webhooks/google/calendar');
  assert.deepEqual(call.json.params, { ttl: '604800' });
  assert.deepEqual(channel, {
    channelId: 'phx-cal-0001',
    resourceId: 'ret08u3rv24htgh289g',
    resourceUri: 'https://www.googleapis.com/calendar/v3/calendars/counsellor%40phoenix-school.example.in/events?alt=json',
    calendarId: CAL,
    expiresAt: new Date(NOW + 604800_000).toISOString(),
  });
  const headers = {
    'x-goog-channel-id': 'phx-cal-0001',
    'x-goog-channel-token': call.json.token,
    'x-goog-resource-id': 'ret08u3rv24htgh289g',
    'x-goog-resource-state': 'sync',
    'x-goog-message-number': '1',
  };
  assert.equal(verifyWebhook('', headers, CHANNEL_SECRET, { now: NOW + 1000 }).ok, true);
  assert.equal(verifyWebhook('', headers, CHANNEL_SECRET, { now: NOW + 604800_000 + 301_000 }).reason, 'expired');
});

test('watchEvents is not retried (a repeated channel id would be rejected)', async () => {
  const { client, fake } = makeClient([tokenOk(), { status: 503, json: { error: { code: 503, message: 'x' } } }]);
  await assert.rejects(client.calendar.watchEvents({ calendarId: CAL }), { code: 'server_error' });
  assert.equal(fake.calls.length, 2);
});

test('stopChannel posts id and resourceId; 404 counts as already stopped', async () => {
  const { client, fake } = makeClient([tokenOk(), { status: 204 }, googleError(404, 'notFound', 'Channel not found')]);
  assert.deepEqual(await client.calendar.stopChannel({ channelId: 'phx-cal-0001', resourceId: 'ret08u3rv24htgh289g' }), { stopped: true, alreadyStopped: false });
  assert.equal(fake.calls[1].url.href, 'https://www.googleapis.com/calendar/v3/channels/stop');
  assert.deepEqual(fake.calls[1].json, { id: 'phx-cal-0001', resourceId: 'ret08u3rv24htgh289g' });
  assert.deepEqual(await client.calendar.stopChannel({ channelId: 'phx-cal-0001', resourceId: 'ret08u3rv24htgh289g' }), { stopped: true, alreadyStopped: true });
});

const errorCases = [
  [googleError(403, 'rateLimitExceeded', 'Rate Limit Exceeded', 'usageLimits'), 'rate_limited', true],
  [googleError(403, 'userRateLimitExceeded', 'User Rate Limit Exceeded', 'usageLimits'), 'rate_limited', true],
  [googleError(429, 'rateLimitExceeded', 'Rate Limit Exceeded', 'usageLimits'), 'rate_limited', true],
  [googleError(403, 'quotaExceeded', 'Calendar usage limits exceeded.', 'usageLimits'), 'quota_exceeded', false],
  [googleError(403, 'forbiddenForNonOrganizer', 'Shared properties can only be changed by the organizer of the event.', 'calendar'), 'permission_denied', false],
  [googleError(404, 'notFound', 'Not Found'), 'not_found', false],
  [googleError(409, 'conflict', 'Conflict'), 'conflict', false],
  [googleError(412, 'conditionNotMet', 'Precondition Failed'), 'precondition_failed', false],
  [googleError(400, 'timeRangeEmpty', 'The specified time range is empty.', 'calendar'), 'bad_request', false],
  [googleError(500, 'backendError', 'Backend Error'), 'server_error', true],
];

for (const [response, code, retryable] of errorCases) {
  test(`HTTP ${response.status} ${response.json.error.errors[0].reason} maps to ${code}`, async () => {
    const { client } = makeClient([tokenOk(), response], { maxRetries: 0 });
    await assert.rejects(client.calendar.getEvent({ calendarId: CAL, eventId: 'abcdef0123' }), (error) => {
      assert.ok(error instanceof GoogleError);
      assert.equal(error.code, code);
      assert.equal(error.retryable, retryable);
      assert.equal(error.status, response.status);
      assert.equal(error.operation, 'events.get');
      return true;
    });
  });
}

test('rate-limited reads honour Retry-After and back off exponentially', async () => {
  const { client, sleeps } = makeClient([
    tokenOk(),
    { ...googleError(429, 'rateLimitExceeded', 'x', 'usageLimits'), headers: { 'retry-after': '2' } },
    googleError(403, 'rateLimitExceeded', 'x', 'usageLimits'),
    googleError(503, 'backendError'),
    { json: { id: 'abcdef0123', start: {}, end: {} } },
  ]);
  await client.calendar.getEvent({ calendarId: CAL, eventId: 'abcdef0123' });
  assert.deepEqual(sleeps, [2000, 200, 400]);
});

test('retries stop after maxRetries', async () => {
  const { client, fake } = makeClient([tokenOk(), googleError(500, 'backendError'), googleError(500, 'backendError'), googleError(500, 'backendError')], { maxRetries: 2 });
  await assert.rejects(client.calendar.getEvent({ eventId: 'abcdef0123' }), { code: 'server_error' });
  assert.equal(fake.calls.length, 4);
});

test('timeouts abort the request and are reported as retryable timeout errors', async () => {
  const hang = (call) =>
    new Promise((_, reject) => call.signal.addEventListener('abort', () => reject(call.signal.reason), { once: true }));
  const { client, fake } = makeClient([tokenOk(), hang, hang], { timeoutMs: 20, maxRetries: 1 });
  await assert.rejects(client.calendar.getEvent({ eventId: 'abcdef0123' }), { code: 'timeout', retryable: true });
  assert.equal(fake.calls.length, 3);
});

test('network errors are retryable and redact secrets', async () => {
  const { client } = makeClient([tokenOk(), new TypeError('fetch failed: Bearer ya29.test-access-token-0001')], { maxRetries: 0 });
  await assert.rejects(client.calendar.getEvent({ eventId: 'abcdef0123' }), (error) => {
    assert.equal(error.code, 'network');
    assert.equal(error.retryable, true);
    assert.ok(!error.message.includes('ya29.test-access-token-0001'));
    return true;
  });
});

test('quotaUser is sent as x-goog-quota-user and logs carry no URLs or tokens', async () => {
  const { client, fake, logs } = makeClient([tokenOk(), { json: { id: 'abcdef0123', start: {}, end: {} } }], { quotaUser: 'company-42' });
  await client.calendar.getEvent({ calendarId: CAL, eventId: 'abcdef0123' });
  assert.equal(fake.calls[1].headers['x-goog-quota-user'], 'company-42');
  assert.equal(fake.calls[0].headers['x-goog-quota-user'], undefined);
  const text = JSON.stringify(logs);
  assert.ok(!text.includes('ya29'));
  assert.ok(!text.includes(CAL));
  assert.ok(logs.some((l) => l.obj.operation === 'events.get' && l.obj.status === 200));
});
