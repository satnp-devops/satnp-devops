import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeReminders, quietWindowAt, reminderJobId } from '../../src/core/scheduling/reminders.js';
import { SchedulingInputError } from '../../src/core/scheduling/errors.js';
import { localToUtc, localToUtcIso, toZonedParts } from '../../src/core/scheduling/tz.js';

const IST = 'Asia/Kolkata';
const quiet = { start: '21:00', end: '08:00' };
const at = (date, time, zone = IST) => localToUtcIso(date, time, zone);
const localAt = (iso, zone = IST) => {
  const p = toZonedParts(iso, zone);
  return `${p.date} ${p.time}`;
};

test('defaults: 24 hours and 1 hour before, sorted by send time', () => {
  const result = computeReminders({ start: '2026-11-12T10:00:00Z', now: '2026-11-09T10:00:00Z' });
  assert.deepEqual(result.reminders, [
    { offsetMin: 1440, at: '2026-11-11T10:00:00.000Z', shifted: null },
    { offsetMin: 60, at: '2026-11-12T09:00:00.000Z', shifted: null },
  ]);
  assert.deepEqual(result.skipped, []);
});

test('reminders already in the past are skipped', () => {
  const soon = computeReminders({ start: '2026-11-09T13:00:00Z', now: '2026-11-09T10:00:00Z' });
  assert.deepEqual(soon.reminders.map((r) => r.offsetMin), [60]);
  assert.deepEqual(soon.skipped, [{ offsetMin: 1440, reason: 'past' }]);
  const now = computeReminders({ start: '2026-11-09T10:30:00Z', now: '2026-11-09T10:00:00Z' });
  assert.deepEqual(now.reminders, []);
  assert.deepEqual(now.skipped.map((s) => s.reason), ['past', 'past']);
  const exactly = computeReminders({ start: '2026-11-09T11:00:00Z', now: '2026-11-09T10:00:00Z', offsetsMin: [60] });
  assert.deepEqual(exactly.skipped, [{ offsetMin: 60, reason: 'past' }], 'a reminder due exactly now counts as past');
});

test('custom offsets, duplicates removed, zero means at the start', () => {
  const result = computeReminders({
    start: '2026-11-12T10:00:00Z',
    now: '2026-11-01T00:00:00Z',
    offsetsMin: [10, 2880, 60, 60, 0],
    minGapMin: 0,
  });
  assert.deepEqual(result.reminders.map((r) => [r.offsetMin, r.at]), [
    [2880, '2026-11-10T10:00:00.000Z'],
    [60, '2026-11-12T09:00:00.000Z'],
    [10, '2026-11-12T09:50:00.000Z'],
    [0, '2026-11-12T10:00:00.000Z'],
  ]);
});

test('quiet hours: a reminder at 07:30 IST moves to 08:00 when that still leaves enough lead time', () => {
  const start = at('2026-11-10', '08:30');
  const result = computeReminders({ start, now: at('2026-11-01', '12:00'), timeZone: IST, quietHours: quiet });
  assert.deepEqual(
    result.reminders.map((r) => [r.offsetMin, localAt(r.at), r.shifted]),
    [[1440, '2026-11-09 08:30', null], [60, '2026-11-10 08:00', 'later']],
  );
});

test('quiet hours: when the morning is too close to the start, send the evening before', () => {
  const result = computeReminders({ start: at('2026-11-10', '08:10'), now: at('2026-11-01', '12:00'), timeZone: IST, quietHours: quiet });
  assert.deepEqual(
    result.reminders.map((r) => [r.offsetMin, localAt(r.at), r.shifted]),
    [[1440, '2026-11-09 08:10', null], [60, '2026-11-09 21:00', 'earlier']],
    '08:00 would be only 10 minutes before (minLeadMin 15)',
  );
});

test('quiet hours: boundaries are allowed and late-night meetings get the last pre-quiet minute', () => {
  const boundary = computeReminders({ start: at('2026-11-10', '22:00'), now: at('2026-11-01', '12:00'), timeZone: IST, quietHours: quiet, offsetsMin: [60] });
  assert.deepEqual(boundary.reminders.map((r) => [localAt(r.at), r.shifted]), [['2026-11-10 21:00', null]]);
  const late = computeReminders({ start: at('2026-11-10', '23:00'), now: at('2026-11-01', '12:00'), timeZone: IST, quietHours: quiet, offsetsMin: [60] });
  assert.deepEqual(late.reminders.map((r) => [localAt(r.at), r.shifted]), [['2026-11-10 21:00', 'earlier']]);
  const morning = computeReminders({ start: at('2026-11-10', '09:00'), now: at('2026-11-01', '12:00'), timeZone: IST, quietHours: quiet, offsetsMin: [60] });
  assert.deepEqual(morning.reminders.map((r) => [localAt(r.at), r.shifted]), [['2026-11-10 08:00', null]]);
});

test('quiet hours: one-way shift policies and skips', () => {
  const base = { start: at('2026-11-10', '08:10'), now: at('2026-11-01', '12:00'), timeZone: IST, offsetsMin: [60] };
  const laterOnly = computeReminders({ ...base, quietHours: { ...quiet, shift: 'later' } });
  assert.deepEqual(laterOnly.reminders, []);
  assert.deepEqual(laterOnly.skipped, [{ offsetMin: 60, reason: 'quiet_hours' }]);
  const laterLowLead = computeReminders({ ...base, quietHours: { ...quiet, shift: 'later' }, minLeadMin: 5 });
  assert.deepEqual(laterLowLead.reminders.map((r) => localAt(r.at)), ['2026-11-10 08:00']);
  const earlierOnly = computeReminders({ ...base, start: at('2026-11-10', '08:30'), quietHours: { ...quiet, shift: 'earlier' } });
  assert.deepEqual(earlierOnly.reminders.map((r) => [localAt(r.at), r.shifted]), [['2026-11-09 21:00', 'earlier']]);
  // Late meeting booked during quiet hours: the evening slot has passed and the morning is after the start.
  const stuck = computeReminders({ start: at('2026-11-10', '23:30'), now: at('2026-11-10', '21:05'), timeZone: IST, quietHours: quiet, offsetsMin: [60] });
  assert.deepEqual(stuck.skipped, [{ offsetMin: 60, reason: 'quiet_hours' }]);
});

test('daytime quiet windows (for example a lunch break) work too', () => {
  const lunch = { start: '13:00', end: '14:00' };
  const result = computeReminders({ start: at('2026-11-10', '14:30'), now: at('2026-11-01', '12:00'), timeZone: IST, quietHours: lunch, offsetsMin: [60] });
  assert.deepEqual(result.reminders.map((r) => [localAt(r.at), r.shifted]), [['2026-11-10 14:00', 'later']]);
  assert.equal(quietWindowAt(localToUtc('2026-11-10', '12:30', IST), lunch, IST), null);
});

test('reminders that land together collapse into the one that best fits its lead time', () => {
  const result = computeReminders({
    start: at('2026-11-10', '09:00'),
    now: at('2026-11-01', '12:00'),
    timeZone: IST,
    quietHours: quiet,
    offsetsMin: [120, 60],
  });
  // 120 → 07:00 (quiet) → 08:00; 60 → 08:00. Both say "08:00", which is exactly one hour before.
  assert.deepEqual(result.reminders.map((r) => [r.offsetMin, localAt(r.at)]), [[60, '2026-11-10 08:00']]);
  assert.deepEqual(result.skipped, [{ offsetMin: 120, reason: 'duplicate' }]);
  const close = computeReminders({ start: '2026-11-12T10:00:00Z', now: '2026-11-01T00:00:00Z', offsetsMin: [60, 50] });
  assert.deepEqual(close.reminders.map((r) => r.offsetMin), [60], 'within minGapMin (15) of each other');
  assert.deepEqual(close.skipped, [{ offsetMin: 50, reason: 'duplicate' }]);
});

test('quiet hours follow the attendee zone across a DST change (New York fall back)', () => {
  const ny = 'America/New_York';
  const start = localToUtcIso('2026-11-01', '07:30', ny);
  assert.equal(start, '2026-11-01T12:30:00.000Z');
  const result = computeReminders({ start, now: '2026-10-25T00:00:00Z', timeZone: ny, quietHours: { start: '22:00', end: '07:00' }, offsetsMin: [60] });
  assert.deepEqual(result.reminders, [{ offsetMin: 60, at: '2026-11-01T12:00:00.000Z', shifted: 'later' }], '07:00 EST');
  const window = quietWindowAt(Date.parse('2026-11-01T11:30:00Z'), { start: '22:00', end: '07:00' }, ny);
  assert.deepEqual(window.map((ms) => new Date(ms).toISOString()), ['2026-11-01T02:00:00.000Z', '2026-11-01T12:00:00.000Z'], 'a 10-hour night');
});

test('Kathmandu attendee: quiet hours use +05:45', () => {
  const ktm = 'Asia/Kathmandu';
  const result = computeReminders({
    start: localToUtcIso('2026-11-10', '08:45', ktm),
    now: '2026-11-01T00:00:00Z',
    timeZone: ktm,
    quietHours: quiet,
    offsetsMin: [60],
  });
  assert.deepEqual(result.reminders, [{ offsetMin: 60, at: localToUtcIso('2026-11-10', '08:00', ktm), shifted: 'later' }]);
  assert.equal(result.reminders[0].at, '2026-11-10T02:15:00.000Z');
});

test('invalid input is refused', () => {
  const ok = { start: '2026-11-12T10:00:00Z', now: '2026-11-01T00:00:00Z' };
  assert.throws(() => computeReminders({ ...ok, quietHours: quiet }), SchedulingInputError, 'quiet hours need a zone');
  assert.throws(() => computeReminders({ ...ok, timeZone: 'IST', quietHours: quiet }), SchedulingInputError);
  assert.throws(() => computeReminders({ ...ok, timeZone: IST, quietHours: { start: '21:00', end: '21:00' } }), SchedulingInputError);
  assert.throws(() => computeReminders({ ...ok, timeZone: IST, quietHours: { start: '9pm', end: '08:00' } }), SchedulingInputError);
  assert.throws(() => computeReminders({ ...ok, offsetsMin: [-5] }), SchedulingInputError);
  assert.throws(() => computeReminders({ ...ok, start: '2026-11-12 10:00' }), SchedulingInputError);
});

test('reminder job ids are stable, unique per booking version, and safe for BullMQ', () => {
  assert.equal(reminderJobId('bk_123', 60, 2), 'reminder-bk_123-s2-m60');
  assert.notEqual(reminderJobId('bk_123', 60, 1), reminderJobId('bk_123', 60, 2));
  assert.equal(reminderJobId('bk_123', 1440), 'reminder-bk_123-s0-m1440');
  assert.ok(!reminderJobId('a', 60, 0).includes(':'));
});
