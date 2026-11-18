import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ZoomValidationError,
  computeAttendance,
  groupSessions,
  mergeIntervals,
  normalizeParticipantRow,
  parseWebhook,
  sessionsFromWebhookEvents,
} from '../../../src/integrations/providers/zoom/index.js';
import { fixture } from './helpers.js';

const reportSessions = () =>
  [...fixture('report_participants_page1.json').participants, ...fixture('report_participants_page2.json').participants].map(normalizeParticipantRow);

const WINDOW = { meetingStart: '2026-11-10T10:30:00Z', meetingEnd: '2026-11-10T11:15:00Z' };
const byName = (result, name) => result.attendees.find((a) => a.name === name);

test('mergeIntervals merges overlaps and touching intervals, drops empty ones', () => {
  assert.deepEqual(
    mergeIntervals([
      { start: 50, end: 60 },
      { start: 0, end: 10 },
      { start: 10, end: 20 },
      { start: 15, end: 30 },
      { start: 40, end: 40 },
      { start: 45, end: 44 },
    ]),
    [
      { start: 0, end: 30 },
      { start: 50, end: 60 },
    ],
  );
  assert.deepEqual(mergeIntervals([]), []);
});

test('report sample: rejoins merge, overlapping phone session is not double counted, window clips the host', () => {
  const result = computeAttendance(reportSessions(), { thresholdMinutes: 30, ...WINDOW });
  assert.equal(result.thresholdSeconds, 1800);
  assert.equal(result.windowSeconds, 2700);
  assert.equal(result.attendees.length, 3, 'host, Rahul (3 sessions), Anita; waiting-room row excluded');

  const rahul = byName(result, 'Rahul Verma');
  assert.equal(rahul.email, 'rahul.verma@example.in');
  assert.equal(rahul.registrantId, 'rKq8bQmFQ0eTxG3l2X5mEw');
  assert.equal(rahul.sessionCount, 3);
  // 10:31:00-10:48:30, 10:47:00-10:52:00 (phone, no email), 10:50:00-11:12:00 -> one interval.
  assert.deepEqual(rahul.intervals, [{ start: '2026-11-10T10:31:00.000Z', end: '2026-11-10T11:12:00.000Z' }]);
  assert.equal(rahul.attendedSeconds, 41 * 60);
  assert.equal(rahul.attendedMinutes, 41);
  assert.equal(rahul.meetsThreshold, true);
  assert.equal(Math.round(rahul.attendedRatio * 1000) / 1000, 0.911);

  const host = byName(result, 'Priya Sharma');
  assert.equal(host.attendedSeconds, 2700, 'clipped to 10:30-11:15');
  assert.equal(host.firstJoinAt, '2026-11-10T10:30:00.000Z');
  assert.equal(host.zoomUserId, '30R7kT7bTIKSNUFEuH_Qlg');

  const anita = byName(result, 'Anita K');
  assert.equal(anita.attendedSeconds, 360);
  assert.equal(anita.meetsThreshold, false);
  assert.equal(anita.email, null);

  assert.deepEqual(
    result.attendees.map((a) => a.name),
    ['Priya Sharma', 'Rahul Verma', 'Anita K'],
    'sorted by first join',
  );
});

test('thresholdRatio uses the meeting window; the stricter of minutes and ratio wins', () => {
  const sessions = reportSessions();
  const ratio = computeAttendance(sessions, { thresholdRatio: 0.95, ...WINDOW });
  assert.equal(ratio.thresholdSeconds, 2565);
  assert.equal(byName(ratio, 'Rahul Verma').meetsThreshold, false);
  assert.equal(byName(ratio, 'Priya Sharma').meetsThreshold, true);

  const both = computeAttendance(sessions, { thresholdMinutes: 5, thresholdRatio: 0.5, ...WINDOW });
  assert.equal(both.thresholdSeconds, 1350);
  assert.equal(byName(both, 'Anita K').meetsThreshold, false);

  const exact = computeAttendance(sessions, { thresholdMinutes: 6, ...WINDOW });
  assert.equal(byName(exact, 'Anita K').meetsThreshold, true, 'threshold is inclusive');
});

test('waiting room rows are excluded unless includeWaitingRoom', () => {
  const sessions = reportSessions();
  assert.equal(computeAttendance(sessions, { thresholdMinutes: 0 }).attendees.some((a) => a.name === 'Sunil'), false);
  const sunil = byName(computeAttendance(sessions, { thresholdMinutes: 0, includeWaitingRoom: true }), 'Sunil');
  assert.equal(sunil.attendedSeconds, 60);
});

test('without a window nothing is clipped; open sessions close at meetingEnd or now, else are ignored', () => {
  const sessions = [
    normalizeParticipantRow({ user_id: '1', name: 'Asha', user_email: 'asha@example.in', join_time: '2026-11-10T10:00:00Z', leave_time: '2026-11-10T10:10:00Z' }),
    normalizeParticipantRow({ user_id: '2', name: 'Asha', user_email: 'ASHA@example.in', join_time: '2026-11-10T10:20:00Z' }),
  ];
  const noEnd = computeAttendance(sessions, { thresholdMinutes: 5 });
  assert.equal(noEnd.attendees[0].attendedSeconds, 600);
  assert.equal(noEnd.attendees[0].stillInMeeting, false);
  assert.equal(noEnd.windowSeconds, null);
  assert.equal(noEnd.attendees[0].attendedRatio, null);

  const withNow = computeAttendance(sessions, { thresholdMinutes: 5, now: '2026-11-10T10:25:00Z' });
  assert.equal(withNow.attendees[0].attendedSeconds, 900);
  assert.equal(withNow.attendees[0].stillInMeeting, true);
  assert.equal(withNow.attendees[0].lastLeaveAt, '2026-11-10T10:25:00.000Z');
});

test('grouping: identifiers chain together; same-name guests without ids merge only into a unique match', () => {
  const rows = [
    { user_id: '1', name: 'A', user_email: 'a@x.in' },
    { user_id: '2', name: 'A (phone)', registrant_id: 'r1', user_email: 'a@x.in' },
    { user_id: '3', name: 'Someone', registrant_id: 'r1' },
    { user_id: '4', name: 'Guest' },
    { user_id: '5', name: ' guest ' },
    { user_id: '6', name: 'Dup', user_email: 'd1@x.in' },
    { user_id: '7', name: 'Dup', user_email: 'd2@x.in' },
    { user_id: '8', name: 'Dup' },
    { user_id: '9' },
  ].map(normalizeParticipantRow);
  const keys = groupSessions(rows);
  assert.equal(keys[0], keys[1]);
  assert.equal(keys[1], keys[2], 'registrant-only row joins the email group through the shared registrant');
  assert.equal(keys[3], keys[4], 'name-only rows group by normalised name');
  assert.equal(keys[3], 'name:guest');
  assert.notEqual(keys[5], keys[6]);
  assert.equal(keys[7], 'name:dup', 'ambiguous name match is not merged into either email group');
  assert.equal(keys[8], 'session:9');
});

test('custom keyOf overrides grouping; null skips a session', () => {
  const sessions = reportSessions();
  const result = computeAttendance(sessions, {
    thresholdMinutes: 1,
    keyOf: (s) => (s.email === 'priya.sharma@phoenix.example' ? null : s.userId),
    ...WINDOW,
  });
  assert.equal(result.attendees.length, 4, 'host skipped, each remaining in-meeting session separate');
  assert.ok(result.attendees.every((a) => a.sessionCount === 1));
});

test('computeAttendance validates its options', () => {
  assert.throws(() => computeAttendance([], {}), ZoomValidationError);
  assert.throws(() => computeAttendance([], { thresholdRatio: 0.5 }), /needs meetingStart and meetingEnd/);
  assert.throws(() => computeAttendance([], { thresholdRatio: 1.5, ...WINDOW }), /between 0 and 1/);
  assert.throws(() => computeAttendance([], { thresholdMinutes: -1 }), /thresholdMinutes/);
  assert.throws(() => computeAttendance([], { thresholdMinutes: 1, meetingStart: WINDOW.meetingEnd, meetingEnd: WINDOW.meetingStart }), /before/);
  assert.deepEqual(computeAttendance([], { thresholdMinutes: 1 }).attendees, []);
});

function webhook(event, participant, eventTs) {
  return parseWebhook({
    event,
    event_ts: eventTs,
    payload: {
      account_id: 'acc',
      object: { id: '85746065123', uuid: 'aDYlohsHRtCd4ii/1c9ObA==', start_time: '2026-11-10T10:30:00Z', duration: 45, ...(participant ? { participant } : { end_time: '2026-11-10T11:15:00Z' }) },
    },
  })[0];
}

test('sessionsFromWebhookEvents pairs joined/left by user_id, de-duplicates retries, closes on meeting.ended', () => {
  const t = (hhmm) => `2026-11-10T${hhmm}:00Z`;
  const ms = (hhmm) => Date.parse(t(hhmm));
  const joined1 = webhook('meeting.participant_joined', { user_id: '100', user_name: 'Rahul Verma', email: 'rahul.verma@example.in', join_time: t('10:31') }, ms('10:31'));
  const left1 = webhook('meeting.participant_left', { user_id: '100', user_name: 'Rahul Verma', email: 'rahul.verma@example.in', leave_time: t('10:48'), leave_reason: 'Rahul Verma got disconnected from the meeting.' }, ms('10:48'));
  const joined2 = webhook('meeting.participant_joined', { user_id: '200', user_name: 'Rahul Verma', email: 'rahul.verma@example.in', join_time: t('10:50') }, ms('10:50'));
  const leftWithoutJoin = webhook('meeting.participant_left', { user_id: '300', user_name: 'Anita K', leave_time: t('10:40') }, ms('10:40'));
  const ended = webhook('meeting.ended', null, ms('11:15'));

  // Out of order, with a duplicate delivery of joined1.
  const sessions = sessionsFromWebhookEvents([ended, joined2, left1, joined1, leftWithoutJoin, joined1]);
  assert.equal(sessions.length, 3);
  const rahul = sessions.filter((s) => s.name === 'Rahul Verma');
  assert.deepEqual(
    rahul.map((s) => [s.joinTime, s.leaveTime]),
    [
      ['2026-11-10T10:31:00.000Z', '2026-11-10T10:48:00.000Z'],
      ['2026-11-10T10:50:00.000Z', '2026-11-10T11:15:00.000Z'],
    ],
  );
  assert.equal(rahul[0].leaveReason, 'Rahul Verma got disconnected from the meeting.');
  const anita = sessions.find((s) => s.name === 'Anita K');
  assert.deepEqual([anita.joinTime, anita.leaveTime], ['2026-11-10T10:30:00.000Z', '2026-11-10T10:40:00.000Z'], 'missed join starts at meeting start');

  const result = computeAttendance(sessions, { thresholdMinutes: 30, ...WINDOW });
  assert.equal(byName(result, 'Rahul Verma').attendedSeconds, (17 + 25) * 60);
  assert.equal(byName(result, 'Rahul Verma').sessionCount, 2);
  assert.equal(byName(result, 'Rahul Verma').meetsThreshold, true);
});

test('sessionsFromWebhookEvents leaves sessions open while the meeting runs, unless endAt is given', () => {
  const joined = webhook('meeting.participant_joined', { user_id: '1', user_name: 'Live', join_time: '2026-11-10T10:31:00Z' }, Date.parse('2026-11-10T10:31:00Z'));
  assert.equal(sessionsFromWebhookEvents([joined])[0].leaveTime, null);
  assert.equal(sessionsFromWebhookEvents([joined], { endAt: '2026-11-10T10:41:00Z' })[0].leaveTime, '2026-11-10T10:41:00.000Z');
  const live = computeAttendance(sessionsFromWebhookEvents([joined]), { thresholdMinutes: 5, now: '2026-11-10T10:37:00Z' });
  assert.equal(live.attendees[0].attendedSeconds, 360);
  assert.equal(live.attendees[0].stillInMeeting, true);
});
