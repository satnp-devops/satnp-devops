import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeAttendance } from '../../src/integrations/providers/zoom/index.js';
import { decideOutcome, summariseAttendance } from '../../src/modules/scheduling/attendance.js';

const T0 = Date.parse('2026-11-10T10:00:00Z');
const at = (min) => new Date(T0 + min * 60_000).toISOString();
const session = (name, email, from, to) => ({ userId: `${name}-${from}`, name, email, joinTime: at(from), leaveTime: to === null ? null : at(to) });
const booking = { invitee_name: 'Priya Sharma', invitee_email: 'priya@example.com', guests: [{ name: 'Aarav', email: 'aarav@example.com' }] };

function summarise(sessions, { thresholdMin = 10, now = T0 + 60 * 60_000 } = {}) {
  const { attendees } = computeAttendance(sessions, { thresholdMinutes: thresholdMin, now });
  return summariseAttendance({ attendees, booking, hostEmail: 'kabir@phoenix.test', thresholdMin });
}

test('rejoins and second devices are merged before the threshold check', () => {
  const s = summarise([
    session('Host', 'kabir@phoenix.test', 0, 30),
    session('Priya Sharma', 'priya@example.com', 2, 6),
    session('Priya Sharma', 'priya@example.com', 5, 9), // a second device, overlapping
    session('Priya Sharma', 'priya@example.com', 12, 14), // a rejoin
  ]);
  assert.equal(s.inviteeSeconds, 9 * 60);
  assert.equal(s.meetsThreshold, false);
  assert.equal(s.hostSeconds, 30 * 60);
  assert.deepEqual(s.people.map((p) => p.role).sort(), ['host', 'invitee']);
});

test('the family side is the union of the invitee and their guests, the host excluded', () => {
  const s = summarise([
    session('Host', 'KABIR@phoenix.test', 0, 45),
    session('Priya Sharma', 'priya@example.com', 0, 6),
    session('Aarav', 'aarav@example.com', 4, 12),
  ]);
  assert.equal(s.inviteeSeconds, 12 * 60);
  assert.equal(s.meetsThreshold, true);
  assert.equal(s.people.find((p) => p.email?.toLowerCase() === 'kabir@phoenix.test').role, 'host');
});

test('a participant without an email is matched by name', () => {
  const s = summarise([session('priya  SHARMA', null, 0, 15)]);
  assert.equal(s.people[0].role, 'invitee');
  assert.equal(s.meetsThreshold, true);
});

test('host-only meetings never count as attended, even with a zero threshold', () => {
  const s = summarise([session('Host', 'kabir@phoenix.test', 0, 30)], { thresholdMin: 0 });
  assert.equal(s.inviteeSeconds, 0);
  assert.equal(s.meetsThreshold, false);
});

test('the threshold is inclusive', () => {
  assert.equal(summarise([session('Priya Sharma', 'priya@example.com', 0, 10)]).meetsThreshold, true);
  assert.equal(summarise([session('Priya Sharma', 'priya@example.com', 0, 9)]).meetsThreshold, false);
});

test('open sessions count up to now while the meeting runs', () => {
  const s = summarise([session('Priya Sharma', 'priya@example.com', 0, null)], { now: T0 + 4 * 60_000 });
  assert.equal(s.inviteeSeconds, 4 * 60);
  assert.equal(s.people[0].stillInMeeting, true);
});

test('no-show only once the meeting is over; attended as soon as the threshold is met', () => {
  assert.equal(decideOutcome({ meetsThreshold: true, over: false }), 'attended');
  assert.equal(decideOutcome({ meetsThreshold: false, over: false }), null);
  assert.equal(decideOutcome({ meetsThreshold: false, over: true }), 'no_show');
  assert.equal(decideOutcome({ meetsThreshold: true, over: true }), 'attended');
});
