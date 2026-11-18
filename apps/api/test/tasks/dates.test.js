import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayBounds, isValidTimeZone, localDateKey, resolveTimeZone, startOfLocalDay, taskGroup } from '../../src/modules/tasks/dates.js';

// "Today" for My tasks: due times are UTC, days are the viewer's (docs/crm/PHASE2_CONTRACT.md §9.9).

const iso = (date) => date.toISOString();

test('India: a day starts at 18:30 UTC the evening before', () => {
  const now = new Date('2026-11-06T20:00:00Z'); // 01:30 on 7 Nov in Kolkata
  const { startOfToday, startOfTomorrow } = dayBounds(now, 'Asia/Kolkata');
  assert.equal(iso(startOfToday), '2026-11-06T18:30:00.000Z');
  assert.equal(iso(startOfTomorrow), '2026-11-07T18:30:00.000Z');
});

test('the same instant is a different day in different zones', () => {
  const now = new Date('2026-11-06T20:00:00Z');
  assert.equal(localDateKey(now, 'Asia/Kolkata'), '2026-11-07');
  assert.equal(localDateKey(now, 'America/New_York'), '2026-11-06');
  assert.equal(iso(dayBounds(now, 'America/New_York').startOfToday), '2026-11-06T05:00:00.000Z');
  assert.equal(iso(dayBounds(now, 'UTC').startOfToday), '2026-11-06T00:00:00.000Z');
});

test('45-minute and 13-hour offsets', () => {
  const now = new Date('2026-06-01T12:00:00Z');
  assert.equal(iso(dayBounds(now, 'Asia/Kathmandu').startOfToday), '2026-05-31T18:15:00.000Z');
  assert.equal(iso(dayBounds(now, 'Pacific/Tongatapu').startOfToday), '2026-06-01T11:00:00.000Z');
});

test('DST: a 23-hour and a 25-hour day in New York', () => {
  // 8 March 2026: clocks go from 02:00 to 03:00 (EST -5 → EDT -4).
  const spring = dayBounds(new Date('2026-03-08T15:00:00Z'), 'America/New_York');
  assert.equal(iso(spring.startOfToday), '2026-03-08T05:00:00.000Z');
  assert.equal(iso(spring.startOfTomorrow), '2026-03-09T04:00:00.000Z');
  assert.equal(spring.startOfTomorrow - spring.startOfToday, 23 * 3_600_000);
  // 1 November 2026: clocks go back from 02:00 to 01:00.
  const autumn = dayBounds(new Date('2026-11-01T15:00:00Z'), 'America/New_York');
  assert.equal(autumn.startOfTomorrow - autumn.startOfToday, 25 * 3_600_000);
});

test('DST at midnight: the day starts at the first instant that exists', () => {
  // Chile: on 6 Sep 2026 clocks jump from 00:00 to 01:00, so the day starts at 01:00 local (-03).
  const start = startOfLocalDay(new Date('2026-09-06T15:00:00Z'), 'America/Santiago');
  assert.equal(localDateKey(start, 'America/Santiago'), '2026-09-06');
  assert.equal(localDateKey(new Date(start.getTime() - 1), 'America/Santiago'), '2026-09-05');
});

test('start of day is stable for every instant of the day', () => {
  const zone = 'Europe/London';
  const expected = iso(startOfLocalDay(new Date('2026-07-10T00:00:00+01:00'), zone));
  for (const time of ['2026-07-10T00:00:00+01:00', '2026-07-10T12:34:56+01:00', '2026-07-10T23:59:59.999+01:00']) {
    assert.equal(iso(startOfLocalDay(new Date(time), zone)), expected);
  }
  assert.equal(expected, '2026-07-09T23:00:00.000Z');
});

test('time zone resolution: query, then user, then setting, then the fallback', () => {
  assert.equal(isValidTimeZone('Asia/Kolkata'), true);
  assert.equal(isValidTimeZone('Mars/Olympus'), false);
  assert.equal(isValidTimeZone(''), false);
  assert.equal(resolveTimeZone([undefined, 'Europe/Paris', 'Asia/Kolkata']), 'Europe/Paris');
  assert.equal(resolveTimeZone(['Nope/Nope', null]), 'Asia/Kolkata');
  assert.equal(resolveTimeZone([null], null), null);
});

test('task groups: overdue before now, today until midnight in the viewer zone, then upcoming', () => {
  const now = new Date('2026-11-06T10:00:00Z'); // 15:30 in Kolkata
  const bounds = { now, ...dayBounds(now, 'Asia/Kolkata') };
  const group = (dueAt, status = 'open') => taskGroup({ status, dueAt }, bounds);
  assert.equal(group('2026-11-06T09:59:00Z'), 'overdue');
  assert.equal(group('2026-11-06T18:29:59Z'), 'today'); // 23:59:59 in Kolkata
  assert.equal(group('2026-11-06T18:30:00Z'), 'upcoming'); // midnight in Kolkata
  assert.equal(group(null), 'none');
  assert.equal(group('2026-11-01T00:00:00Z', 'done'), 'done');
  // In New York the same task due at 23:00 UTC is still today (18:00 local).
  const ny = { now, ...dayBounds(now, 'America/New_York') };
  assert.equal(taskGroup({ status: 'open', dueAt: '2026-11-06T23:00:00Z' }, ny), 'today');
  assert.equal(taskGroup({ status: 'open', dueAt: '2026-11-06T23:00:00Z' }, bounds), 'upcoming');
});
