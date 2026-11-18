import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conferenceRecordFilter, createGoogleClient, unionSeconds } from '../../../src/integrations/providers/google/index.js';
import { NOW, fakeFetch, fixture, makeClient, serviceAccountConfig, tokenOk } from './_helpers.js';

const RECORD = 'conferenceRecords/fe5ea4d0-0b0f-4c47-9e7c-5d0f2b0a1c11';

test('conferenceRecordFilter builds the documented EBNF filter', () => {
  assert.equal(
    conferenceRecordFilter({ meetingCode: 'ABC-mnop-xyz', startTimeFrom: '2026-11-10T00:00:00+05:30', startTimeTo: new Date('2026-11-11T00:00:00Z') }),
    'space.meeting_code = "abc-mnop-xyz" AND start_time>="2026-11-09T18:30:00.000Z" AND start_time<="2026-11-11T00:00:00.000Z"',
  );
  assert.equal(conferenceRecordFilter({ spaceName: 'spaces/jQCFfuBOdN5z', ongoing: true }), 'space.name = "spaces/jQCFfuBOdN5z" AND end_time IS NULL');
  assert.equal(conferenceRecordFilter({}), undefined);
  assert.throws(() => conferenceRecordFilter({ meetingCode: 'abc" OR 1=1' }), { code: 'bad_request' });
  assert.throws(() => conferenceRecordFilter({ spaceName: 'spaces/x"y' }), { code: 'bad_request' });
});

test('listConferenceRecords sends filter and capped page size', async () => {
  const { client, fake } = makeClient([tokenOk(), { json: fixture('meet-conference-records.json') }]);
  const page = await client.meet.listConferenceRecords({ meetingCode: 'abc-mnop-xyz', pageSize: 500 });
  const call = fake.calls[1];
  assert.equal(call.method, 'GET');
  assert.equal(call.url.origin + call.url.pathname, 'https://meet.googleapis.com/v2/conferenceRecords');
  assert.equal(call.url.searchParams.get('filter'), 'space.meeting_code = "abc-mnop-xyz"');
  assert.equal(call.url.searchParams.get('pageSize'), '100');
  assert.deepEqual(page.items[0], {
    name: RECORD,
    conferenceRecordId: 'fe5ea4d0-0b0f-4c47-9e7c-5d0f2b0a1c11',
    spaceName: 'spaces/jQCFfuBOdN5z',
    startTime: '2026-11-10T04:29:12.345Z',
    endTime: '2026-11-10T05:03:40.120Z',
    expireTime: '2026-12-10T05:03:40.120Z',
    active: false,
  });
  assert.equal(page.nextPageToken, null);
});

test('getMeetingAttendance pages participants and sessions and counts overlapping sessions once', async () => {
  const { client, fake, advance } = makeClient([
    tokenOk(),
    { json: fixture('meet-conference-records.json') },
    { json: fixture('meet-participants-page1.json') },
    { json: fixture('meet-participants-page2.json') },
    // counsellor: one session
    { json: { participantSessions: [{ name: `${RECORD}/participants/p-counsellor/participantSessions/s1`, startTime: '2026-11-10T04:29:12Z', endTime: '2026-11-10T05:03:40Z' }] } },
    // parent: dropped and rejoined; also briefly on a second device (overlap)
    {
      json: {
        participantSessions: [
          { name: `${RECORD}/participants/p-parent/participantSessions/s3`, startTime: '2026-11-10T04:45:00Z', endTime: '2026-11-10T05:02:00Z' },
          { name: `${RECORD}/participants/p-parent/participantSessions/s2`, startTime: '2026-11-10T04:31:00Z', endTime: '2026-11-10T04:41:00Z' },
        ],
        nextPageToken: 'sess-2',
      },
    },
    { json: { participantSessions: [{ name: `${RECORD}/participants/p-parent/participantSessions/s4`, startTime: '2026-11-10T04:50:00Z', endTime: '2026-11-10T04:55:00Z' }] } },
    // phone dial-in still connected
    { json: { participantSessions: [{ name: `${RECORD}/participants/p-phone/participantSessions/s5`, startTime: '2026-11-10T04:40:00Z' }] } },
  ]);
  advance(Date.parse('2026-11-10T05:10:00Z') - NOW); // clock: 10 minutes after the call ended
  const result = await client.meet.getMeetingAttendance({ meetingCode: 'abc-mnop-xyz' });
  assert.equal(fake.pending(), 0);
  assert.equal(fake.calls[3].url.searchParams.get('pageToken'), 'page-2');
  assert.equal(fake.calls[2].url.pathname, `/v2/${RECORD}/participants`);
  assert.equal(fake.calls[2].url.searchParams.get('pageSize'), '250');
  assert.equal(fake.calls[4].url.pathname, `/v2/${RECORD}/participants/p-counsellor/participantSessions`);
  assert.equal(fake.calls[6].url.searchParams.get('pageToken'), 'sess-2');

  const [conference] = result.conferences;
  const byId = Object.fromEntries(conference.participants.map((p) => [p.participantId, p]));
  assert.equal(byId['p-counsellor'].kind, 'signed_in');
  assert.equal(byId['p-counsellor'].userId, 'users/112233445566778899000');
  assert.equal(byId['p-counsellor'].attendedSeconds, 34 * 60 + 28);
  assert.equal(byId['p-parent'].kind, 'anonymous');
  assert.equal(byId['p-parent'].displayName, 'Priya Sharma');
  assert.equal(byId['p-parent'].attendedSeconds, 10 * 60 + 17 * 60, 'the overlapping 04:50-04:55 session is not double counted');
  assert.deepEqual(byId['p-parent'].sessions.map((s) => s.start), ['2026-11-10T04:31:00.000Z', '2026-11-10T04:45:00.000Z', '2026-11-10T04:50:00.000Z']);
  assert.equal(byId['p-phone'].kind, 'phone');
  assert.equal(byId['p-phone'].active, true);
  assert.equal(byId['p-phone'].lastLeftAt, null);
  // open session counts until "now" (the fixed test clock)
  assert.equal(byId['p-phone'].attendedSeconds, 30 * 60);
});

test('unionSeconds merges overlaps and ignores bad intervals', () => {
  const now = Date.parse('2026-11-10T05:00:00Z');
  assert.equal(
    unionSeconds(
      [
        { start: '2026-11-10T04:00:00Z', end: '2026-11-10T04:10:00Z' },
        { start: '2026-11-10T04:05:00Z', end: '2026-11-10T04:20:00Z' },
        { start: '2026-11-10T04:30:00Z', end: null },
        { start: null, end: '2026-11-10T04:40:00Z' },
        { start: '2026-11-10T04:45:00Z', end: '2026-11-10T04:44:00Z' },
      ],
      now,
    ),
    20 * 60 + 30 * 60,
  );
});

test('getSpace accepts a meeting code alias', async () => {
  const { client, fake } = makeClient([
    tokenOk(),
    { json: { name: 'spaces/jQCFfuBOdN5z', meetingUri: 'https://meet.google.com/abc-mnop-xyz', meetingCode: 'abc-mnop-xyz', activeConference: { conferenceRecord: RECORD } } },
  ]);
  const space = await client.meet.getSpace({ space: 'abc-mnop-xyz' });
  assert.equal(fake.calls[1].url.href, 'https://meet.googleapis.com/v2/spaces/abc-mnop-xyz');
  assert.equal(space.name, 'spaces/jQCFfuBOdN5z');
  assert.equal(space.activeConferenceRecord, RECORD);
});

test('participant names are validated before building URLs', async () => {
  const { client, fake } = makeClient([]);
  await assert.rejects(client.meet.listParticipantSessions({ participant: '../../spaces/x' }), { code: 'bad_request' });
  await assert.rejects(client.meet.listParticipants({ conferenceRecord: 'conferenceRecords/a/../b' }), { code: 'bad_request' });
  assert.equal(fake.calls.length, 0);
});

test('Meet calls need user credentials (delegation subject or per-user OAuth)', async () => {
  const fake = fakeFetch([]);
  const config = serviceAccountConfig();
  delete config.auth.subject;
  const client = createGoogleClient(config, { fetch: fake.fetch, now: () => NOW });
  await assert.rejects(client.meet.listConferenceRecords({}), { code: 'config_invalid' });
  assert.equal(fake.calls.length, 0);
});
