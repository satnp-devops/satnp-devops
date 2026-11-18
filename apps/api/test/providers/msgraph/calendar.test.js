import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACCESS_TOKEN, MAILBOX, fixture, graphError, makeClient, respond } from './helpers.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const UTC_AND_IMMUTABLE = 'outlook.timezone="UTC", IdType="ImmutableId"';

test('getSchedule posts UTC times and normalises busy intervals', async () => {
  const { client, calls } = makeClient([respond(200, fixture('getschedule-response.json'))]);
  const result = await client.getSchedule({
    mailbox: MAILBOX,
    emails: ['counsellor.priya@phoenix.example.in', 'unknown.person@phoenix.example.in'],
    start: '2026-11-10T09:30:00+05:30',
    end: new Date('2026-11-10T13:00:00Z'),
    intervalMinutes: 60,
  });
  const call = calls[0];
  assert.equal(call.method, 'POST');
  assert.equal(call.url, `${GRAPH}/users/${MAILBOX}/calendar/getSchedule`);
  assert.equal(call.headers.authorization, `Bearer ${ACCESS_TOKEN}`);
  assert.equal(call.headers['content-type'], 'application/json');
  assert.equal(call.headers.prefer, 'outlook.timezone="UTC"');
  assert.match(call.headers['client-request-id'], /^[0-9a-f-]{36}$/);
  assert.deepEqual(JSON.parse(call.body), {
    schedules: ['counsellor.priya@phoenix.example.in', 'unknown.person@phoenix.example.in'],
    startTime: { dateTime: '2026-11-10T04:00:00', timeZone: 'UTC' },
    endTime: { dateTime: '2026-11-10T13:00:00', timeZone: 'UTC' },
    availabilityViewInterval: 60,
  });
  const [priya, unknown] = result.schedules;
  assert.equal(priya.email, 'counsellor.priya@phoenix.example.in');
  assert.deepEqual(priya.busy, [
    { startsAt: '2026-11-10T06:30:00.000Z', endsAt: '2026-11-10T08:00:00.000Z' },
    { startsAt: '2026-11-10T09:30:00.000Z', endsAt: '2026-11-10T10:30:00.000Z' },
  ]);
  assert.equal(priya.items.length, 5);
  assert.equal(priya.workingHours.timeZone, 'India Standard Time');
  assert.deepEqual(unknown.error, { message: "The requested user 'unknown.person@phoenix.example.in' is invalid.", responseCode: 'ErrorInvalidUser' });
});

test('getSchedule rejects ambiguous local times and reversed ranges before any request', async () => {
  const { client, calls } = makeClient();
  const base = { mailbox: MAILBOX, emails: ['a@example.com'] };
  await assert.rejects(client.getSchedule({ ...base, start: '2026-11-10T09:30:00', end: '2026-11-10T10:30:00Z' }), { kind: 'validation', code: 'invalid_time' });
  await assert.rejects(client.getSchedule({ ...base, start: '2026-11-10T10:30:00Z', end: '2026-11-10T09:30:00Z' }), { code: 'invalid_range' });
  await assert.rejects(client.getSchedule({ ...base, start: NOW_ISO(), end: NOW_ISO(1), intervalMinutes: 2 }), { code: 'invalid_input' });
  assert.equal(calls.length, 0);
});

function NOW_ISO(hours = 0) {
  return new Date(Date.UTC(2026, 10, 10, 4 + hours)).toISOString();
}

test('createEvent sends a Teams meeting with transactionId and normalises the response', async () => {
  const { client, calls } = makeClient([respond(201, fixture('event-created.json'))]);
  const event = await client.createEvent(MAILBOX, {
    subject: 'Admissions counselling: Grade 11 science',
    start: '2026-11-10T11:00:00+05:30',
    end: '2026-11-10T11:30:00+05:30',
    attendees: [{ email: 'anita.sharma@example.com', name: 'Anita Sharma' }, { email: 'rohan.sharma@example.com', type: 'optional' }],
    body: { html: '<p>Please join 5 minutes early.</p>' },
    allowNewTimeProposals: false,
    idempotencyKey: 'booking-8f3c2a',
  });
  const call = calls[0];
  assert.equal(call.method, 'POST');
  assert.equal(call.url, `${GRAPH}/users/${MAILBOX}/events`);
  assert.equal(call.headers.prefer, UTC_AND_IMMUTABLE);
  assert.deepEqual(JSON.parse(call.body), {
    subject: 'Admissions counselling: Grade 11 science',
    body: { contentType: 'HTML', content: '<p>Please join 5 minutes early.</p>' },
    start: { dateTime: '2026-11-10T05:30:00', timeZone: 'UTC' },
    end: { dateTime: '2026-11-10T06:00:00', timeZone: 'UTC' },
    attendees: [
      { emailAddress: { address: 'anita.sharma@example.com', name: 'Anita Sharma' }, type: 'required' },
      { emailAddress: { address: 'rohan.sharma@example.com' }, type: 'optional' },
    ],
    allowNewTimeProposals: false,
    isOnlineMeeting: true,
    onlineMeetingProvider: 'teamsForBusiness',
    transactionId: 'booking-8f3c2a',
  });
  assert.equal(event.id, 'AAMkAGI1AAAt8AHjAAA=');
  assert.equal(event.startsAt, '2026-11-10T05:30:00.000Z');
  assert.equal(event.endsAt, '2026-11-10T06:00:00.000Z');
  assert.equal(event.createdAt, '2026-11-05T03:00:50.757Z');
  assert.match(event.joinUrl, /^https:\/\/teams\.microsoft\.com\/l\/meetup-join\//);
  assert.deepEqual(event.onlineMeeting.provider, 'teamsForBusiness');
  assert.equal(event.onlineMeeting.tollNumber, '+91 22 6241 6885');
  assert.deepEqual(event.organizer, { email: 'counsellor.priya@phoenix.example.in', name: 'Priya Counsellor' });
  assert.equal(event.attendees[0].respondedAt, null);
  assert.equal(event.attendees[1].respondedAt, '2026-11-05T04:10:00.000Z');
  assert.equal(event.transactionId, 'booking-8f3c2a');
});

test('createEvent retries a 503 with the same transactionId and client-request-id', async () => {
  const { client, calls, sleeps } = makeClient([
    respond(503, graphError('ServiceUnavailable', 'Service unavailable'), { 'retry-after': '3' }),
    respond(201, fixture('event-created.json')),
  ]);
  await client.createEvent(MAILBOX, { subject: 'Demo', start: NOW_ISO(), end: NOW_ISO(1) });
  assert.equal(calls.length, 2);
  const [first, second] = calls.map((c) => JSON.parse(c.body));
  assert.equal(first.transactionId, second.transactionId, 'generated key is reused across retries');
  assert.equal(calls[0].headers['client-request-id'], calls[1].headers['client-request-id']);
  assert.deepEqual(sleeps, [3000]);
});

test('updateEvent PATCHes only the given fields', async () => {
  const { client, calls } = makeClient([respond(200, fixture('event-created.json'))]);
  await client.updateEvent(MAILBOX, 'AAMkAGI1AAAt8AHjAAA=', { start: '2026-11-11T05:30:00Z', end: '2026-11-11T06:00:00Z', location: 'Pune campus' });
  assert.equal(calls[0].method, 'PATCH');
  assert.equal(calls[0].url, `${GRAPH}/users/${MAILBOX}/events/AAMkAGI1AAAt8AHjAAA%3D`);
  assert.deepEqual(JSON.parse(calls[0].body), {
    start: { dateTime: '2026-11-11T05:30:00', timeZone: 'UTC' },
    end: { dateTime: '2026-11-11T06:00:00', timeZone: 'UTC' },
    location: { displayName: 'Pune campus' },
  });
  await assert.rejects(client.updateEvent(MAILBOX, 'x', {}), { code: 'invalid_input' });
  await assert.rejects(client.updateEvent(MAILBOX, 'x', { isOnlineMeeting: false }), { code: 'invalid_input' }, 'unknown fields are refused');
});

test('cancelEvent posts the comment and is never retried', async () => {
  const ok = makeClient([respond(202)]);
  assert.deepEqual(await ok.client.cancelEvent(MAILBOX, 'evt-1', { comment: 'Counsellor unavailable; we will reschedule.' }), { cancelled: true });
  assert.equal(ok.calls[0].url, `${GRAPH}/users/${MAILBOX}/events/evt-1/cancel`);
  assert.deepEqual(JSON.parse(ok.calls[0].body), { comment: 'Counsellor unavailable; we will reschedule.' });

  const failing = makeClient([respond(503, graphError('ServiceUnavailable', 'busy'), { 'retry-after': '1' })]);
  await assert.rejects(failing.client.cancelEvent(MAILBOX, 'evt-1'), { kind: 'unavailable', retryable: true, retryAfterMs: 1000 });
  assert.equal(failing.calls.length, 1);

  const attendee = makeClient([respond(400, graphError('ErrorInvalidRequest', "Your request can't be completed. You need to be an organizer to cancel a meeting."))]);
  await assert.rejects(attendee.client.cancelEvent(MAILBOX, 'evt-1'), { kind: 'validation', retryable: false, status: 400 });
});

test('deleteEvent treats 404 as already deleted', async () => {
  const { client, calls } = makeClient([respond(204), respond(404, graphError('ErrorItemNotFound', 'The specified object was not found in the store.'))]);
  assert.deepEqual(await client.deleteEvent(MAILBOX, 'evt-1'), { deleted: true, alreadyDeleted: false });
  assert.deepEqual(await client.deleteEvent(MAILBOX, 'evt-1'), { deleted: true, alreadyDeleted: true });
  assert.equal(calls[0].method, 'DELETE');
});

test('getEvent maps Graph errors to typed errors', async () => {
  const cases = [
    [403, 'ErrorAccessDenied', 'permission', false],
    [404, 'ErrorItemNotFound', 'not_found', false],
    [409, 'ErrorIrresolvableConflict', 'conflict', false],
    [412, 'PreconditionFailed', 'precondition', false],
    [400, 'ErrorInvalidIdMalformed', 'validation', false],
    [500, 'InternalServerError', 'unavailable', true],
  ];
  for (const [status, code, kind, retryable] of cases) {
    const responses = Array.from({ length: 4 }, () => respond(status, graphError(code, 'nope'), { 'request-id': 'req-9' }));
    const { client } = makeClient(responses);
    await assert.rejects(client.getEvent(MAILBOX, 'evt-1'), (err) => {
      assert.equal(err.kind, kind, code);
      assert.equal(err.code, code);
      assert.equal(err.status, status);
      assert.equal(err.retryable, retryable);
      assert.equal(err.requestId, 'req-9');
      assert.equal(err.details.innerCode, undefined);
      return true;
    });
  }
});
