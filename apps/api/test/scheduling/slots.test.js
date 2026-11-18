import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_RANGE_DAYS,
  checkSlot,
  generateSlots,
  groupSlotsByLocalDate,
  mergeIntervals,
} from '../../src/core/scheduling/slots.js';
import { SchedulingInputError } from '../../src/core/scheduling/errors.js';
import { localToUtcIso, toZonedParts } from '../../src/core/scheduling/tz.js';

// 2026-11-09 is a Monday. India has no DST, so local 09:00 is always 03:30Z.
const MON = '2026-11-09';
const IST = 'Asia/Kolkata';
const longAgo = '2026-01-01T00:00:00Z';

/** Slots as 'YYYY-MM-DD HH:MM' in a zone, for readable assertions. */
const local = (slots, zone) =>
  slots.map((s) => {
    const p = toZonedParts(s.start, zone);
    return `${p.date} ${p.time}`;
  });
const times = (slots, zone) => local(slots, zone).map((v) => v.slice(11));

/** One local day of an IST host, as a UTC range. */
const dayRange = (date, zone = IST) => ({ from: localToUtcIso(date, '00:00', zone), to: localToUtcIso(date, '24:00', zone) });

const istHost = (extra = {}) => ({ id: 'asha', timeZone: IST, weekly: { mon: ['09:00-12:00'] }, ...extra });

test('slots step through a weekly range in the host zone and fit entirely inside it', () => {
  const slots = generateSlots({ eventType: { durationMin: 60 }, hosts: [istHost()], range: dayRange(MON), now: longAgo });
  assert.deepEqual(slots, [
    { start: '2026-11-09T03:30:00.000Z', end: '2026-11-09T04:30:00.000Z', hostIds: ['asha'] },
    { start: '2026-11-09T04:30:00.000Z', end: '2026-11-09T05:30:00.000Z', hostIds: ['asha'] },
    { start: '2026-11-09T05:30:00.000Z', end: '2026-11-09T06:30:00.000Z', hostIds: ['asha'] },
  ]);
});

test('slotIntervalMin sets the step independently of the duration', () => {
  const slots = generateSlots({
    eventType: { durationMin: 60, slotIntervalMin: 30 },
    hosts: [istHost()],
    range: dayRange(MON),
    now: longAgo,
  });
  assert.deepEqual(times(slots, IST), ['09:00', '09:30', '10:00', '10:30', '11:00']);
});

test('a slot that does not fit before the range ends is dropped', () => {
  const slots = generateSlots({
    eventType: { durationMin: 60, slotIntervalMin: 30 },
    hosts: [istHost({ weekly: { mon: [{ start: '09:00', end: '10:15' }] } })],
    range: dayRange(MON),
    now: longAgo,
  });
  assert.deepEqual(times(slots, IST), ['09:00']);
});

test('several ranges per day, other weekdays, and range.from/to filtering by start', () => {
  const host = istHost({ weekly: { mon: ['09:00-10:00', { start: '14:00', end: '15:00' }], tue: ['09:00-10:00'] } });
  const twoDays = { from: localToUtcIso(MON, '00:00', IST), to: localToUtcIso('2026-11-10', '24:00', IST) };
  const all = generateSlots({ eventType: { durationMin: 30 }, hosts: [host], range: twoDays, now: longAgo });
  assert.deepEqual(local(all, IST), [
    '2026-11-09 09:00',
    '2026-11-09 09:30',
    '2026-11-09 14:00',
    '2026-11-09 14:30',
    '2026-11-10 09:00',
    '2026-11-10 09:30',
  ]);
  const window = { from: localToUtcIso(MON, '09:30', IST), to: localToUtcIso(MON, '14:30', IST) };
  const some = generateSlots({ eventType: { durationMin: 30 }, hosts: [host], range: window, now: longAgo });
  assert.deepEqual(times(some, IST), ['09:30', '14:00'], 'from is inclusive, to is exclusive');
});

test('date overrides replace weekly hours, block days, or open closed days', () => {
  const week = { from: localToUtcIso(MON, '00:00', IST), to: localToUtcIso('2026-11-15', '24:00', IST) };
  const host = istHost({
    weekly: { mon: ['09:00-10:00'], tue: ['09:00-10:00'], wed: ['09:00-10:00'], thu: ['09:00-10:00'] },
    overrides: {
      '2026-11-09': ['16:00-17:00'],
      '2026-11-10': 'unavailable',
      '2026-11-11': [],
      '2026-11-12': null,
      '2026-11-14': [{ start: '11:00', end: '12:00' }],
    },
  });
  const slots = generateSlots({ eventType: { durationMin: 60 }, hosts: [host], range: week, now: longAgo });
  assert.deepEqual(local(slots, IST), ['2026-11-09 16:00', '2026-11-14 11:00']);
});

test('busy time removes overlapping slots but back-to-back meetings are allowed', () => {
  const host = istHost({
    busy: [
      { start: localToUtcIso(MON, '10:00', IST), end: localToUtcIso(MON, '10:45', IST) },
      { start: localToUtcIso(MON, '11:30', IST), end: localToUtcIso(MON, '12:00', IST) },
    ],
  });
  const slots = generateSlots({ eventType: { durationMin: 30 }, hosts: [host], range: dayRange(MON), now: longAgo });
  assert.deepEqual(times(slots, IST), ['09:00', '09:30', '11:00']);
});

test('event buffers keep a gap around existing bookings and may extend outside working hours', () => {
  const host = istHost({
    busy: [{ start: localToUtcIso(MON, '10:00', IST), end: localToUtcIso(MON, '11:00', IST) }],
  });
  const slots = generateSlots({
    eventType: { durationMin: 30, bufferBeforeMin: 15, bufferAfterMin: 15 },
    hosts: [host],
    range: dayRange(MON),
    now: longAgo,
  });
  // 09:30 ends at 10:00 but needs 15 min after; 11:00 needs 15 min before (10:45 is busy).
  assert.deepEqual(times(slots, IST), ['09:00', '11:30'], '09:00 is offered although its buffer starts at 08:45');
});

test('busy entries can carry their own buffers', () => {
  const host = istHost({
    busy: [{ start: localToUtcIso(MON, '10:00', IST), end: localToUtcIso(MON, '10:30', IST), bufferBeforeMin: 30, bufferAfterMin: 30 }],
  });
  const slots = generateSlots({ eventType: { durationMin: 30 }, hosts: [host], range: dayRange(MON), now: longAgo });
  assert.deepEqual(times(slots, IST), ['09:00', '11:00', '11:30']);
});

test('unsorted and overlapping busy intervals are handled', () => {
  const host = istHost({
    busy: [
      { start: localToUtcIso(MON, '11:00', IST), end: localToUtcIso(MON, '11:20', IST) },
      { start: localToUtcIso(MON, '09:10', IST), end: localToUtcIso(MON, '09:40', IST) },
      { start: localToUtcIso(MON, '09:30', IST), end: localToUtcIso(MON, '10:05', IST) },
    ],
  });
  const slots = generateSlots({ eventType: { durationMin: 30 }, hosts: [host], range: dayRange(MON), now: longAgo });
  assert.deepEqual(times(slots, IST), ['10:30', '11:30']);
  assert.deepEqual(mergeIntervals([[5, 8], [1, 3], [3, 4], [7, 9], [10, 10]]), [[1, 4], [5, 9]]);
});

test('minimum notice hides slots that start too soon (the boundary itself is bookable)', () => {
  const now = localToUtcIso(MON, '08:50', IST);
  const slots = generateSlots({
    eventType: { durationMin: 30, minNoticeMin: 130 },
    hosts: [istHost()],
    range: dayRange(MON),
    now,
  });
  assert.deepEqual(times(slots, IST), ['11:00', '11:30'], 'now + 130 min = 11:00 exactly');
  const none = generateSlots({ eventType: { durationMin: 30 }, hosts: [istHost()], range: dayRange(MON), now: localToUtcIso(MON, '13:00', IST) });
  assert.deepEqual(none, [], 'past slots are never offered');
  const partly = generateSlots({ eventType: { durationMin: 30 }, hosts: [istHost()], range: dayRange(MON), now: localToUtcIso(MON, '10:10', IST) });
  assert.deepEqual(times(partly, IST), ['10:30', '11:00', '11:30'], 'steps stay on the grid after now');
});

test('horizonDays limits how far ahead people can book', () => {
  const host = istHost({ weekly: Object.fromEntries(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((d) => [d, ['09:00-10:00']])) });
  const now = localToUtcIso(MON, '09:00', IST);
  const slots = generateSlots({
    eventType: { durationMin: 60, horizonDays: 2 },
    hosts: [host],
    range: { from: now, to: localToUtcIso('2026-11-20', '00:00', IST) },
    now,
  });
  assert.deepEqual(local(slots, IST), ['2026-11-09 09:00', '2026-11-10 09:00', '2026-11-11 09:00'], 'exactly now + 2 days is still in');
});

test('maxPerDay counts bookings per local date in the host zone', () => {
  const range = { from: localToUtcIso(MON, '00:00', IST), to: localToUtcIso('2026-11-11', '00:00', IST) };
  const host = istHost({
    weekly: { mon: ['09:00-11:00'], tue: ['00:00-02:00', '09:00-10:00'] },
    bookedCountByDate: { '2026-11-09': 2, '2026-11-10': 1 },
  });
  const capped = generateSlots({ eventType: { durationMin: 60, maxPerDay: 2 }, hosts: [host], range, now: longAgo });
  assert.deepEqual(local(capped, IST), ['2026-11-10 00:00', '2026-11-10 01:00', '2026-11-10 09:00']);
  const tight = generateSlots({ eventType: { durationMin: 60, maxPerDay: 1 }, hosts: [host], range, now: longAgo });
  assert.deepEqual(tight, [], 'Tuesday 00:30 IST is Monday in UTC but counts against Tuesday');
  const open = generateSlots({ eventType: { durationMin: 60 }, hosts: [host], range, now: longAgo });
  assert.equal(open.length, 5);
});

test('an overnight range runs past midnight and slots can cross it', () => {
  const fri = '2026-11-13';
  const host = istHost({ weekly: { fri: ['22:00-01:00'] }, overrides: { '2026-11-14': 'unavailable' } });
  const range = { from: localToUtcIso(fri, '00:00', IST), to: localToUtcIso('2026-11-15', '00:00', IST) };
  const slots = generateSlots({ eventType: { durationMin: 60, slotIntervalMin: 30 }, hosts: [host], range, now: longAgo });
  assert.deepEqual(local(slots, IST), ['2026-11-13 22:00', '2026-11-13 22:30', '2026-11-13 23:00', '2026-11-13 23:30', '2026-11-14 00:00']);
  assert.equal(slots[3].end, localToUtcIso('2026-11-14', '00:30', IST), 'the 23:30 slot ends after midnight');
});

test('touching ranges on consecutive days merge, so a slot can span midnight', () => {
  const host = istHost({ weekly: { fri: ['20:00-24:00'], sat: ['00:00-02:00'] } });
  const range = { from: localToUtcIso('2026-11-13', '00:00', IST), to: localToUtcIso('2026-11-15', '00:00', IST) };
  const slots = generateSlots({ eventType: { durationMin: 60, slotIntervalMin: 30 }, hosts: [host], range, now: longAgo });
  assert.ok(local(slots, IST).includes('2026-11-13 23:30'));
  assert.equal(slots.length, 11, '20:00 … 01:00 every 30 min');
});

test('"24:00" ends a range at midnight', () => {
  const host = istHost({ weekly: { mon: ['21:00-24:00'] } });
  const slots = generateSlots({ eventType: { durationMin: 60 }, hosts: [host], range: dayRange(MON), now: longAgo });
  assert.deepEqual(times(slots, IST), ['21:00', '22:00', '23:00']);
});

test('a host whose working day crosses UTC midnight (Sydney)', () => {
  const host = { id: 'sam', timeZone: 'Australia/Sydney', weekly: { mon: ['09:00-11:00'] } };
  const range = dayRange(MON, 'Australia/Sydney');
  const slots = generateSlots({ eventType: { durationMin: 60 }, hosts: [host], range, now: longAgo });
  assert.deepEqual(slots.map((s) => s.start), ['2026-11-08T22:00:00.000Z', '2026-11-08T23:00:00.000Z'], 'Monday 09:00 AEDT is Sunday 22:00Z');
});

test('New York fall-back day: a 00:00–04:00 range is five real hours', () => {
  const host = { id: 'nia', timeZone: 'America/New_York', weekly: { sun: ['00:00-04:00', '09:00-10:00'] } };
  const slots = generateSlots({ eventType: { durationMin: 60 }, hosts: [host], range: dayRange('2026-11-01', 'America/New_York'), now: longAgo });
  assert.deepEqual(slots.map((s) => s.start.slice(11, 16)), ['04:00', '05:00', '06:00', '07:00', '08:00', '14:00']);
  assert.deepEqual(times(slots, 'America/New_York'), ['00:00', '01:00', '01:00', '02:00', '03:00', '09:00'], '01:00 occurs twice');
  const before = generateSlots({ eventType: { durationMin: 60 }, hosts: [host], range: dayRange('2026-10-25', 'America/New_York'), now: longAgo });
  assert.equal(before.at(-1).start, '2026-10-25T13:00:00.000Z', '09:00 EDT the week before');
});

test('New York spring-forward day: ranges shrink and an edge in the gap moves forward', () => {
  const host = { id: 'nia', timeZone: 'America/New_York', weekly: { sun: ['00:00-04:00'] } };
  const slots = generateSlots({ eventType: { durationMin: 60 }, hosts: [host], range: dayRange('2026-03-08', 'America/New_York'), now: longAgo });
  assert.deepEqual(times(slots, 'America/New_York'), ['00:00', '01:00', '03:00'], 'no 02:00 slot');
  const gapStart = { id: 'nia', timeZone: 'America/New_York', weekly: { sun: ['02:30-05:00'] } };
  const shifted = generateSlots({ eventType: { durationMin: 30 }, hosts: [gapStart], range: dayRange('2026-03-08', 'America/New_York'), now: longAgo });
  assert.deepEqual(times(shifted, 'America/New_York'), ['03:30', '04:00', '04:30'], '02:30 does not exist and reads as 03:30 EDT');
});

test('Europe/London and Australia/Sydney keep local hours across their transitions', () => {
  const london = { id: 'lee', timeZone: 'Europe/London', weekly: { sat: ['09:00-10:00'], sun: ['09:00-10:00'] } };
  const lr = { from: '2026-10-24T00:00:00Z', to: '2026-10-26T00:00:00Z' };
  const ls = generateSlots({ eventType: { durationMin: 60 }, hosts: [london], range: lr, now: longAgo });
  assert.deepEqual(ls.map((s) => s.start), ['2026-10-24T08:00:00.000Z', '2026-10-25T09:00:00.000Z']);

  const sydney = { id: 'sam', timeZone: 'Australia/Sydney', weekly: { sat: ['09:00-10:00'], sun: ['09:00-10:00'] } };
  const sr = { from: '2026-10-02T00:00:00Z', to: '2026-10-04T00:00:00Z' };
  const ss = generateSlots({ eventType: { durationMin: 60 }, hosts: [sydney], range: sr, now: longAgo });
  assert.deepEqual(ss.map((s) => s.start), ['2026-10-02T23:00:00.000Z', '2026-10-03T22:00:00.000Z'], 'AEST then AEDT');
});

test('hosts in different zones (Kathmandu +05:45, Kolkata +05:30) merge into one sorted list', () => {
  const hosts = [
    { id: 'kol', timeZone: 'Asia/Kolkata', weekly: { mon: ['09:00-10:00'] } },
    { id: 'ktm', timeZone: 'Asia/Kathmandu', weekly: { mon: ['09:00-10:00'] } },
  ];
  const range = { from: '2026-11-09T00:00:00Z', to: '2026-11-10T00:00:00Z' };
  const slots = generateSlots({ eventType: { durationMin: 30 }, hosts, range, now: longAgo });
  assert.deepEqual(
    slots.map((s) => [s.start.slice(11, 16), s.hostIds.join(',')]),
    [['03:15', 'ktm'], ['03:30', 'kol'], ['03:45', 'ktm'], ['04:00', 'kol']],
  );
});

test('alignTimeZone puts hosts on one wall-clock grid measured from local midnight', () => {
  const hosts = [
    { id: 'kol', timeZone: 'Asia/Kolkata', weekly: { mon: ['09:00-10:00'] } },
    { id: 'ktm', timeZone: 'Asia/Kathmandu', weekly: { mon: ['09:00-10:00'] } },
  ];
  const range = { from: '2026-11-09T00:00:00Z', to: '2026-11-10T00:00:00Z' };
  const slots = generateSlots({ eventType: { durationMin: 30, alignTimeZone: 'Asia/Kolkata' }, hosts, range, now: longAgo });
  assert.deepEqual(
    slots.map((s) => [times([s], IST)[0], s.hostIds.join(',')]),
    [['09:00', 'kol,ktm'], ['09:30', 'kol']],
    'Kathmandu 09:00 is 08:45 IST, so its first aligned slot is 09:00 IST and 09:30 IST would end after 09:45 IST',
  );
  const odd = generateSlots({
    eventType: { durationMin: 50, alignTimeZone: 'asia/calcutta' },
    hosts: [istHost()],
    range: dayRange(MON),
    now: longAgo,
  });
  assert.deepEqual(times(odd, IST), ['09:10', '10:00', '10:50'], 'a 50-minute grid from midnight: …, 08:20, 09:10, 10:00');
  assert.throws(() => generateSlots({ eventType: { durationMin: 30, alignTimeZone: 'IST' }, hosts, range, now: longAgo }), SchedulingInputError);
});

test('shared slots list every free host, in the order hosts were given; busy only blocks its own host', () => {
  const hosts = [
    istHost({ id: 'b', weekly: { mon: ['09:00-11:00'] }, busy: [{ start: localToUtcIso(MON, '09:00', IST), end: localToUtcIso(MON, '09:30', IST) }] }),
    istHost({ id: 'a', weekly: { mon: ['09:00-10:00'] } }),
  ];
  const slots = generateSlots({ eventType: { durationMin: 30 }, hosts, range: dayRange(MON), now: longAgo });
  assert.deepEqual(
    slots.map((s) => [times([s], IST)[0], s.hostIds]),
    [['09:00', ['a']], ['09:30', ['b', 'a']], ['10:00', ['b']], ['10:30', ['b']]],
  );
  const panel = generateSlots({ eventType: { durationMin: 30 }, hosts, range: dayRange(MON), now: longAgo, mode: 'all' });
  assert.deepEqual(times(panel, IST), ['09:30'], 'mode all needs every host free');
});

test('checkSlot re-validates one start before booking', () => {
  const base = {
    eventType: { durationMin: 30 },
    hosts: [istHost({ busy: [{ start: localToUtcIso(MON, '10:00', IST), end: localToUtcIso(MON, '10:30', IST) }] })],
    now: longAgo,
  };
  const ok = checkSlot({ ...base, start: localToUtcIso(MON, '09:30', IST) });
  assert.deepEqual(ok, { available: true, start: '2026-11-09T04:00:00.000Z', end: '2026-11-09T04:30:00.000Z', hostIds: ['asha'] });
  assert.equal(checkSlot({ ...base, start: localToUtcIso(MON, '10:00', IST) }).available, false, 'busy');
  assert.equal(checkSlot({ ...base, start: localToUtcIso(MON, '09:10', IST) }).available, false, 'not on the grid');
  assert.equal(checkSlot({ ...base, start: localToUtcIso(MON, '09:30', IST), now: localToUtcIso(MON, '09:45', IST) }).available, false, 'past');
  assert.deepEqual(checkSlot({ ...base, start: localToUtcIso(MON, '13:00', IST) }).hostIds, []);
});

test('groupSlotsByLocalDate groups by the viewer zone', () => {
  const host = istHost({ weekly: { mon: ['09:00-10:00', '20:00-21:00'] } });
  const slots = generateSlots({ eventType: { durationMin: 60 }, hosts: [host], range: dayRange(MON), now: longAgo });
  const days = groupSlotsByLocalDate(slots, 'America/New_York');
  assert.deepEqual(
    days.map((d) => [d.date, d.slots.map((s) => s.localTime)]),
    [['2026-11-08', ['22:30']], ['2026-11-09', ['09:30']]],
    'IST 09:00 Monday is Sunday 22:30 in New York',
  );
  assert.throws(() => groupSlotsByLocalDate(slots, 'EST'), RangeError);
});

test('invalid input is refused with field paths', () => {
  const ok = { eventType: { durationMin: 30 }, hosts: [istHost()], range: dayRange(MON), now: longAgo };
  const cases = [
    [{ ...ok, hosts: [istHost({ timeZone: 'IST' })] }, 'slots.hosts.0.timeZone'],
    [{ ...ok, hosts: [istHost({ weekly: { mon: ['9:00-10:00'] } })] }, 'slots.hosts.0.weekly.mon.0.start'],
    [{ ...ok, hosts: [istHost({ weekly: { mon: ['10:00-10:00'] } })] }, 'slots.hosts.0.weekly.mon.0'],
    [{ ...ok, hosts: [istHost({ weekly: { monday: ['09:00-10:00'] } })] }, 'slots.hosts.0.weekly'],
    [{ ...ok, hosts: [istHost({ overrides: { '2026-02-30': [] } })] }, 'slots.hosts.0.overrides'],
    [{ ...ok, hosts: [istHost({ busy: [{ start: '2026-11-09T10:00:00', end: '2026-11-09T11:00:00Z' }] })] }, 'slots.hosts.0.busy.0.start'],
    [{ ...ok, hosts: [istHost({ busy: [{ start: '2026-11-09T11:00:00Z', end: '2026-11-09T10:00:00Z' }] })] }, 'slots.hosts.0.busy.0'],
    [{ ...ok, hosts: [] }, 'slots.hosts'],
    [{ ...ok, eventType: { durationMin: 0 } }, 'slots.eventType.durationMin'],
    [{ ...ok, eventType: { durationMin: 30, slotIntervalMin: 2 } }, 'slots.eventType.slotIntervalMin'],
    [{ ...ok, range: { from: ok.range.to, to: ok.range.from } }, 'slots.range'],
    [{ ...ok, range: { from: '2026-01-01T00:00:00Z', to: '2026-12-31T00:00:00Z' } }, 'slots.range'],
    [{ ...ok, now: 'soon' }, 'slots.now'],
  ];
  for (const [input, path] of cases) {
    assert.throws(
      () => generateSlots(input),
      (error) => error instanceof SchedulingInputError && error.issues.some((i) => i.path.startsWith(path)),
      path,
    );
  }
  assert.ok(MAX_RANGE_DAYS >= 62, 'two months of slots fit in one call');
});

test('a full month for ten hosts stays fast', () => {
  const hosts = Array.from({ length: 10 }, (_, i) => ({
    id: `h${i}`,
    timeZone: ['Asia/Kolkata', 'Asia/Kathmandu', 'Asia/Dubai', 'Europe/London', 'America/New_York'][i % 5],
    weekly: Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri'].map((d) => [d, ['09:00-13:00', '14:00-18:00']])),
    busy: Array.from({ length: 50 }, (_, j) => ({
      start: Date.UTC(2026, 10, 1) + j * 13 * 3_600_000,
      end: Date.UTC(2026, 10, 1) + j * 13 * 3_600_000 + 3_600_000,
    })),
    bookedCountByDate: {},
  }));
  const began = performance.now();
  const slots = generateSlots({
    eventType: { durationMin: 30, slotIntervalMin: 15, maxPerDay: 8 },
    hosts,
    range: { from: '2026-11-01T00:00:00Z', to: '2026-12-01T00:00:00Z' },
    now: longAgo,
  });
  assert.ok(slots.length > 1000);
  assert.ok(performance.now() - began < 2000, 'well under two seconds');
});
