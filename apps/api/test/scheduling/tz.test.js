import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DAY_MS,
  MINUTE_MS,
  addDays,
  assertTimeZone,
  daysBetween,
  formatClock,
  formatInZone,
  formatOffset,
  inspectLocalTime,
  isLocalDate,
  isValidTimeZone,
  localDayLengthMinutes,
  localToUtc,
  localToUtcIso,
  normalizeTimeZone,
  offsetMinutesAt,
  parseClock,
  parseLocalDate,
  startOfLocalDay,
  toEpochMs,
  toIso,
  toZonedIsoString,
  toZonedParts,
  weekdayOf,
  zoneDisplayName,
  zoneLabel,
} from '../../src/core/scheduling/tz.js';

const iso = (ms) => new Date(ms).toISOString();

test('toEpochMs accepts epoch ms, Dates and ISO strings with an offset only', () => {
  assert.equal(toEpochMs(0), 0);
  assert.equal(toEpochMs(new Date('2026-11-05T10:00:00Z')), Date.UTC(2026, 10, 5, 10));
  assert.equal(toEpochMs('2026-11-05T10:00:00Z'), Date.UTC(2026, 10, 5, 10));
  assert.equal(toEpochMs('2026-11-05T15:30:00+05:30'), Date.UTC(2026, 10, 5, 10));
  assert.equal(toEpochMs('2026-11-05T10:00Z'), Date.UTC(2026, 10, 5, 10));
  assert.equal(toEpochMs('2026-11-05T10:00:00.123Z'), Date.UTC(2026, 10, 5, 10, 0, 0, 123));
  assert.throws(() => toEpochMs('2026-11-05T10:00:00'), RangeError, 'a wall-clock string is not an instant');
  assert.throws(() => toEpochMs('2026-11-05'), RangeError);
  assert.throws(() => toEpochMs('tomorrow'), RangeError);
  assert.throws(() => toEpochMs(Number.NaN), RangeError);
  assert.throws(() => toEpochMs(new Date('nope')), RangeError);
  assert.throws(() => toEpochMs(9e15), RangeError);
  assert.throws(() => toEpochMs(null), TypeError);
  assert.throws(() => toEpochMs({}), TypeError);
  assert.equal(toIso(0), '1970-01-01T00:00:00.000Z');
});

test('normalizeTimeZone returns current IANA names and accepts aliases and any case', () => {
  assert.equal(normalizeTimeZone('Asia/Kolkata'), 'Asia/Kolkata');
  assert.equal(normalizeTimeZone('Asia/Calcutta'), 'Asia/Kolkata', 'ICU reports the old spelling; we store the new one');
  assert.equal(normalizeTimeZone('asia/kolkata'), 'Asia/Kolkata');
  assert.equal(normalizeTimeZone('  Asia/Kolkata  '), 'Asia/Kolkata');
  assert.equal(normalizeTimeZone('Asia/Kathmandu'), 'Asia/Kathmandu');
  assert.equal(normalizeTimeZone('Asia/Katmandu'), 'Asia/Kathmandu');
  assert.equal(normalizeTimeZone('Europe/Kyiv'), 'Europe/Kyiv');
  assert.equal(normalizeTimeZone('Europe/Kiev'), 'Europe/Kyiv');
  assert.equal(normalizeTimeZone('Asia/Saigon'), 'Asia/Ho_Chi_Minh');
  assert.equal(normalizeTimeZone('US/Eastern'), 'America/New_York');
  assert.equal(normalizeTimeZone('Australia/ACT'), 'Australia/Sydney');
  assert.equal(normalizeTimeZone('America/New_York'), 'America/New_York');
  assert.equal(normalizeTimeZone('Europe/London'), 'Europe/London');
  assert.equal(normalizeTimeZone('Europe/Amsterdam'), 'Europe/Amsterdam', 'merged zones keep their own name');
  assert.equal(normalizeTimeZone('Asia/Dubai'), 'Asia/Dubai');
  assert.equal(normalizeTimeZone('Etc/GMT-5'), 'Etc/GMT-5');
  for (const utc of ['UTC', 'utc', 'Etc/UTC', 'GMT', 'Etc/GMT', 'Zulu']) assert.equal(normalizeTimeZone(utc), 'UTC', utc);
});

test('every zone Intl knows normalises to a usable name that normalises to itself', () => {
  const zones = Intl.supportedValuesOf('timeZone');
  assert.ok(zones.length > 300);
  for (const zone of zones) {
    const name = normalizeTimeZone(zone);
    assert.ok(name, zone);
    assert.equal(normalizeTimeZone(name), name, `${zone} → ${name} is stable`);
    assert.equal(typeof offsetMinutesAt(name, 0), 'number');
  }
});

test('normalizeTimeZone refuses offsets, abbreviations and unknown names', () => {
  for (const bad of ['IST', 'EST', 'EST5EDT', 'PST', '+05:30', '-04:00', 'GMT+5', 'Asia', 'Mars/Phobos', 'Asia/Kolkata/', '../etc/passwd', 'Asia/Kolkata;DROP', '', '   ']) {
    assert.equal(normalizeTimeZone(bad), null, bad);
    assert.equal(isValidTimeZone(bad), false, bad);
  }
  for (const bad of [null, undefined, 330, {}, ['Asia/Kolkata']]) assert.equal(normalizeTimeZone(bad), null);
  assert.equal(normalizeTimeZone(`Asia/${'x'.repeat(80)}`), null);
  assert.throws(() => assertTimeZone('IST'), RangeError);
  assert.equal(assertTimeZone('asia/calcutta'), 'Asia/Kolkata');
});

test('offsetMinutesAt reads the offset of a zone at an instant', () => {
  const jan = '2026-01-15T12:00:00Z';
  const jul = '2026-07-15T12:00:00Z';
  assert.equal(offsetMinutesAt('Asia/Kolkata', jan), 330);
  assert.equal(offsetMinutesAt('Asia/Kolkata', jul), 330);
  assert.equal(offsetMinutesAt('Asia/Kathmandu', jan), 345);
  assert.equal(offsetMinutesAt('Asia/Kathmandu', '1980-06-01T00:00:00Z'), 330, 'Nepal moved from +05:30 to +05:45 in 1986');
  assert.equal(offsetMinutesAt('America/New_York', jan), -300);
  assert.equal(offsetMinutesAt('America/New_York', jul), -240);
  assert.equal(offsetMinutesAt('Europe/London', jan), 0);
  assert.equal(offsetMinutesAt('Europe/London', jul), 60);
  assert.equal(offsetMinutesAt('Australia/Sydney', jan), 660);
  assert.equal(offsetMinutesAt('Australia/Sydney', jul), 600);
  assert.equal(offsetMinutesAt('Asia/Dubai', jan), 240);
  assert.equal(offsetMinutesAt('UTC', jan), 0);
  assert.equal(offsetMinutesAt('Etc/GMT-5', jan), 300, 'POSIX sign: Etc/GMT-5 is UTC+5');
  assert.throws(() => offsetMinutesAt('IST', jan), RangeError);
});

test('offsets flip exactly at the transition instants', () => {
  // New York: 2026-03-08 07:00Z (02:00 EST → 03:00 EDT); 2026-11-01 06:00Z (02:00 EDT → 01:00 EST).
  assert.equal(offsetMinutesAt('America/New_York', Date.UTC(2026, 2, 8, 7) - 1), -300);
  assert.equal(offsetMinutesAt('America/New_York', Date.UTC(2026, 2, 8, 7)), -240);
  assert.equal(offsetMinutesAt('America/New_York', Date.UTC(2026, 10, 1, 6) - 1), -240);
  assert.equal(offsetMinutesAt('America/New_York', Date.UTC(2026, 10, 1, 6)), -300);
  // London: 2026-03-29 01:00Z and 2026-10-25 01:00Z.
  assert.equal(offsetMinutesAt('Europe/London', Date.UTC(2026, 2, 29, 1) - 1), 0);
  assert.equal(offsetMinutesAt('Europe/London', Date.UTC(2026, 2, 29, 1)), 60);
  assert.equal(offsetMinutesAt('Europe/London', Date.UTC(2026, 9, 25, 1) - 1), 60);
  assert.equal(offsetMinutesAt('Europe/London', Date.UTC(2026, 9, 25, 1)), 0);
  // Sydney: DST ends 2026-04-04 16:00Z (03:00 AEDT → 02:00 AEST), starts 2026-10-03 16:00Z (02:00 AEST → 03:00 AEDT).
  assert.equal(offsetMinutesAt('Australia/Sydney', Date.UTC(2026, 3, 4, 16) - 1), 660);
  assert.equal(offsetMinutesAt('Australia/Sydney', Date.UTC(2026, 3, 4, 16)), 600);
  assert.equal(offsetMinutesAt('Australia/Sydney', Date.UTC(2026, 9, 3, 16) - 1), 600);
  assert.equal(offsetMinutesAt('Australia/Sydney', Date.UTC(2026, 9, 3, 16)), 660);
});

test('toZonedParts gives wall-clock fields, weekday and offset', () => {
  const kolkata = toZonedParts('2026-11-05T20:00:00Z', 'Asia/Kolkata');
  assert.equal(kolkata.date, '2026-11-06', '20:00Z is 01:30 the next day in India');
  assert.equal(kolkata.time, '01:30');
  assert.equal(kolkata.weekday, 5);
  assert.equal(kolkata.weekdayKey, 'fri');
  assert.equal(kolkata.offsetMinutes, 330);
  assert.equal(kolkata.timeZone, 'Asia/Kolkata');

  const kathmandu = toZonedParts('2026-11-05T12:00:00Z', 'Asia/Kathmandu');
  assert.deepEqual([kathmandu.date, kathmandu.time, kathmandu.offsetMinutes], ['2026-11-05', '17:45', 345]);

  const ny = toZonedParts('2026-11-05T03:00:00.250Z', 'America/New_York');
  assert.deepEqual([ny.date, ny.time, ny.weekdayKey, ny.millisecond], ['2026-11-04', '22:00', 'wed', 250]);

  const midnight = toZonedParts('2026-11-05T18:30:00Z', 'Asia/Kolkata');
  assert.deepEqual([midnight.date, midnight.time, midnight.hour], ['2026-11-06', '00:00', 0], 'midnight is hour 0, never 24');

  const beforeEpoch = toZonedParts(-1, 'UTC');
  assert.deepEqual([beforeEpoch.date, beforeEpoch.second, beforeEpoch.millisecond], ['1969-12-31', 59, 999]);
  assert.equal(toZonedParts('0050-06-01T00:00:00Z', 'UTC').date, '0050-06-01', 'two-digit years are not read as 19xx');
});

test('New York spring-forward gap (2026-03-08 02:00–03:00 does not exist)', () => {
  const info = inspectLocalTime('2026-03-08', '02:30', 'America/New_York');
  assert.equal(info.status, 'gap');
  assert.deepEqual(info.instants, []);
  assert.equal(info.gapMinutes, 60);
  assert.equal(info.offsetBeforeMinutes, -300);
  assert.equal(info.offsetAfterMinutes, -240);

  // Default (RFC 5545 §3.3.5): read with the offset before the gap → 03:30 EDT.
  assert.equal(localToUtcIso('2026-03-08', '02:30', 'America/New_York'), '2026-03-08T07:30:00.000Z');
  assert.equal(toZonedParts(localToUtc('2026-03-08', '02:30', 'America/New_York'), 'America/New_York').time, '03:30');
  assert.equal(localToUtcIso('2026-03-08', '02:30', 'America/New_York', { disambiguation: 'later' }), '2026-03-08T07:30:00.000Z');
  assert.equal(localToUtcIso('2026-03-08', '02:30', 'America/New_York', { disambiguation: 'earlier' }), '2026-03-08T06:30:00.000Z');
  assert.throws(() => localToUtc('2026-03-08', '02:30', 'America/New_York', { disambiguation: 'reject' }), /skipped/);

  // Edges of the gap.
  assert.equal(localToUtcIso('2026-03-08', '01:59', 'America/New_York'), '2026-03-08T06:59:00.000Z');
  assert.equal(inspectLocalTime('2026-03-08', '02:00', 'America/New_York').status, 'gap');
  assert.equal(localToUtcIso('2026-03-08', '02:00', 'America/New_York'), '2026-03-08T07:00:00.000Z');
  assert.equal(inspectLocalTime('2026-03-08', '03:00', 'America/New_York').status, 'valid');
  assert.equal(localToUtcIso('2026-03-08', '03:00', 'America/New_York'), '2026-03-08T07:00:00.000Z');
});

test('New York fall-back overlap (2026-11-01 01:00–02:00 happens twice)', () => {
  const info = inspectLocalTime('2026-11-01', '01:30', 'America/New_York');
  assert.equal(info.status, 'overlap');
  assert.deepEqual(info.instants.map(iso), ['2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z']);
  // Default: the first occurrence (EDT).
  assert.equal(localToUtcIso('2026-11-01', '01:30', 'America/New_York'), '2026-11-01T05:30:00.000Z');
  assert.equal(localToUtcIso('2026-11-01', '01:30', 'America/New_York', { disambiguation: 'earlier' }), '2026-11-01T05:30:00.000Z');
  assert.equal(localToUtcIso('2026-11-01', '01:30', 'America/New_York', { disambiguation: 'later' }), '2026-11-01T06:30:00.000Z');
  assert.throws(() => localToUtc('2026-11-01', '01:30', 'America/New_York', { disambiguation: 'reject' }), /repeated/);
  assert.equal(localToUtcIso('2026-11-01', '00:59', 'America/New_York'), '2026-11-01T04:59:00.000Z');
  assert.equal(inspectLocalTime('2026-11-01', '01:00', 'America/New_York').status, 'overlap');
  assert.equal(inspectLocalTime('2026-11-01', '02:00', 'America/New_York').status, 'valid');
  assert.equal(localToUtcIso('2026-11-01', '02:00', 'America/New_York'), '2026-11-01T07:00:00.000Z');
});

test('the RFC 5545 §3.3.5 examples resolve as the RFC says', () => {
  // "TZID=America/New_York:20071104T013000 indicates November 4, 2007 at 1:30 A.M. EDT (UTC-04:00)."
  assert.equal(localToUtcIso('2007-11-04', '01:30', 'America/New_York'), '2007-11-04T05:30:00.000Z');
  // "TZID=America/New_York:20070311T023000 indicates March 11, 2007 at 3:30 A.M. EDT (UTC-04:00)."
  assert.equal(localToUtcIso('2007-03-11', '02:30', 'America/New_York'), '2007-03-11T07:30:00.000Z');
});

test('Europe/London gap and overlap', () => {
  assert.equal(inspectLocalTime('2026-03-29', '01:30', 'Europe/London').status, 'gap');
  assert.equal(localToUtcIso('2026-03-29', '01:30', 'Europe/London'), '2026-03-29T01:30:00.000Z', '→ 02:30 BST');
  assert.equal(localToUtcIso('2026-03-29', '00:59', 'Europe/London'), '2026-03-29T00:59:00.000Z');
  assert.equal(localToUtcIso('2026-03-29', '02:00', 'Europe/London'), '2026-03-29T01:00:00.000Z');
  assert.equal(inspectLocalTime('2026-10-25', '01:30', 'Europe/London').status, 'overlap');
  assert.equal(localToUtcIso('2026-10-25', '01:30', 'Europe/London'), '2026-10-25T00:30:00.000Z', 'first: 01:30 BST');
  assert.equal(localToUtcIso('2026-10-25', '01:30', 'Europe/London', { disambiguation: 'later' }), '2026-10-25T01:30:00.000Z');
  assert.equal(localToUtcIso('2026-07-01', '09:00', 'Europe/London'), '2026-07-01T08:00:00.000Z');
  assert.equal(localToUtcIso('2026-12-01', '09:00', 'Europe/London'), '2026-12-01T09:00:00.000Z');
});

test('Australia/Sydney (southern hemisphere: DST starts in October, ends in April)', () => {
  assert.equal(inspectLocalTime('2026-10-04', '02:30', 'Australia/Sydney').status, 'gap');
  assert.equal(localToUtcIso('2026-10-04', '02:30', 'Australia/Sydney'), '2026-10-03T16:30:00.000Z', '→ 03:30 AEDT');
  assert.equal(inspectLocalTime('2026-04-05', '02:30', 'Australia/Sydney').status, 'overlap');
  assert.equal(localToUtcIso('2026-04-05', '02:30', 'Australia/Sydney'), '2026-04-04T15:30:00.000Z', 'first: 02:30 AEDT');
  assert.equal(localToUtcIso('2026-04-05', '02:30', 'Australia/Sydney', { disambiguation: 'later' }), '2026-04-04T16:30:00.000Z');
  assert.equal(localToUtcIso('2026-01-10', '09:00', 'Australia/Sydney'), '2026-01-09T22:00:00.000Z');
  assert.equal(localToUtcIso('2026-07-10', '09:00', 'Australia/Sydney'), '2026-07-09T23:00:00.000Z');
});

test('half-hour DST (Lord Howe) and odd offsets resolve', () => {
  const info = inspectLocalTime('2026-10-04', '02:15', 'Australia/Lord_Howe');
  assert.equal(info.status, 'gap');
  assert.equal(info.gapMinutes, 30);
  assert.equal(toZonedParts(localToUtc('2026-10-04', '02:15', 'Australia/Lord_Howe'), 'Australia/Lord_Howe').time, '02:45');
});

test('Asia/Kolkata (+05:30) and Asia/Kathmandu (+05:45) have no gaps and round-trip every minute of a day', () => {
  for (const zone of ['Asia/Kolkata', 'Asia/Kathmandu']) {
    for (let minute = 0; minute < 1440; minute += 1) {
      const time = formatClock(minute);
      assert.equal(inspectLocalTime('2026-11-05', time, zone).status, 'valid');
      const back = toZonedParts(localToUtc('2026-11-05', time, zone), zone);
      assert.equal(`${back.date} ${back.time}`, `2026-11-05 ${time}`);
    }
  }
  assert.equal(localToUtcIso('2026-11-05', '09:00', 'Asia/Kolkata'), '2026-11-05T03:30:00.000Z');
  assert.equal(localToUtcIso('2026-11-05', '09:00', 'Asia/Kathmandu'), '2026-11-05T03:15:00.000Z');
  assert.equal(localToUtcIso('2026-11-05', '00:00', 'Asia/Kolkata'), '2026-11-04T18:30:00.000Z');
});

test('wall clock → UTC → wall clock round-trips across a year in DST zones', () => {
  const zones = ['America/New_York', 'Europe/London', 'Australia/Sydney', 'Asia/Kolkata', 'Asia/Kathmandu', 'Australia/Lord_Howe'];
  const start = Date.UTC(2026, 0, 1);
  for (const zone of zones) {
    for (let t = start; t < start + 366 * DAY_MS; t += 97 * MINUTE_MS) {
      const p = toZonedParts(t, zone);
      const time = `${p.time}:${String(p.second).padStart(2, '0')}`;
      const info = inspectLocalTime(p.date, time, zone);
      assert.notEqual(info.status, 'gap', `${zone} ${p.date} ${time} exists`);
      assert.ok(info.instants.includes(t), `${zone} ${iso(t)} is one reading of ${p.date} ${time}`);
      const resolved = localToUtc(p.date, time, zone, { disambiguation: info.instants[0] === t ? 'earlier' : 'later' });
      assert.equal(resolved, t);
    }
  }
});

test('day boundaries: DST days are 23 or 25 hours, and a day can start at 01:00', () => {
  assert.equal(localDayLengthMinutes('2026-03-08', 'America/New_York'), 1380);
  assert.equal(localDayLengthMinutes('2026-11-01', 'America/New_York'), 1500);
  assert.equal(localDayLengthMinutes('2026-11-02', 'America/New_York'), 1440);
  assert.equal(localDayLengthMinutes('2026-03-29', 'Europe/London'), 1380);
  assert.equal(localDayLengthMinutes('2026-10-25', 'Europe/London'), 1500);
  assert.equal(localDayLengthMinutes('2026-10-04', 'Australia/Sydney'), 1380);
  assert.equal(localDayLengthMinutes('2026-04-05', 'Australia/Sydney'), 1500);
  assert.equal(localDayLengthMinutes('2026-10-04', 'Australia/Lord_Howe'), 1410);
  assert.equal(localDayLengthMinutes('2026-11-05', 'Asia/Kolkata'), 1440);
  // Chile springs forward at midnight, so 2026-09-06 begins at 01:00 local.
  const santiago = startOfLocalDay('2026-09-06', 'America/Santiago');
  assert.equal(toZonedParts(santiago, 'America/Santiago').time, '01:00');
  assert.equal(localDayLengthMinutes('2026-09-06', 'America/Santiago'), 1380);
  // Samoa skipped 2011-12-30 entirely when it crossed the date line.
  assert.equal(inspectLocalTime('2011-12-30', '12:00', 'Pacific/Apia').status, 'gap');
  assert.equal(toZonedParts(localToUtc('2011-12-30', '12:00', 'Pacific/Apia'), 'Pacific/Apia').date, '2011-12-31');
  // '24:00' is midnight at the end of the date.
  assert.equal(localToUtcIso('2026-11-05', '24:00', 'Asia/Kolkata'), localToUtcIso('2026-11-06', '00:00', 'Asia/Kolkata'));
});

test('local date and clock helpers validate and do calendar arithmetic', () => {
  assert.deepEqual(parseLocalDate('2026-11-05'), { year: 2026, month: 11, day: 5 });
  assert.throws(() => parseLocalDate('2026-02-29'), RangeError);
  assert.doesNotThrow(() => parseLocalDate('2028-02-29'));
  assert.throws(() => parseLocalDate('2026-13-01'), RangeError);
  assert.throws(() => parseLocalDate('2026-1-5'), RangeError);
  assert.throws(() => parseLocalDate(20261105), RangeError);
  assert.equal(isLocalDate('2026-04-31'), false);
  assert.equal(isLocalDate('2026-04-30'), true);
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2026-11-05', 0), '2026-11-05');
  assert.equal(addDays('2026-11-05', 365), '2027-11-05');
  assert.equal(weekdayOf('2026-11-05'), 4);
  assert.equal(weekdayOf('2026-11-08'), 0);
  assert.equal(daysBetween('2026-11-05', '2026-12-05'), 30);
  assert.equal(daysBetween('2026-03-01', '2026-02-27'), -2);
  assert.equal(parseClock('09:30'), 570);
  assert.equal(parseClock('00:00'), 0);
  assert.equal(parseClock('23:59:30'), 1439.5);
  assert.throws(() => parseClock('24:00'), RangeError);
  assert.equal(parseClock('24:00', { allowEndOfDay: true }), 1440);
  assert.throws(() => parseClock('24:30', { allowEndOfDay: true }), RangeError);
  assert.throws(() => parseClock('9:30'), RangeError);
  assert.throws(() => parseClock('09:60'), RangeError);
  assert.equal(formatClock(570), '09:30');
  assert.equal(formatClock(1440), '24:00');
  assert.throws(() => localToUtc('2026-02-30', '09:00', 'Asia/Kolkata'), RangeError);
  assert.throws(() => localToUtc('2026-11-05', '25:00', 'Asia/Kolkata'), RangeError);
});

test('formatting helpers', () => {
  assert.equal(formatOffset(330), '+05:30');
  assert.equal(formatOffset(345), '+05:45');
  assert.equal(formatOffset(-210), '-03:30');
  assert.equal(formatOffset(-300), '-05:00');
  assert.equal(formatOffset(0), '+00:00');
  assert.equal(formatOffset(840), '+14:00');
  assert.equal(toZonedIsoString('2026-11-05T12:00:00Z', 'Asia/Kolkata'), '2026-11-05T17:30:00+05:30');
  assert.equal(toZonedIsoString('2026-11-05T12:00:00Z', 'Asia/Kathmandu'), '2026-11-05T17:45:00+05:45');
  assert.equal(toZonedIsoString('2026-11-05T12:00:00Z', 'America/New_York'), '2026-11-05T07:00:00-05:00');
  assert.equal(toEpochMs(toZonedIsoString('2026-11-05T12:00:00Z', 'Australia/Sydney')), Date.UTC(2026, 10, 5, 12));
  assert.equal(formatInZone('2026-11-05T12:00:00Z', 'Asia/Kolkata'), '5 Nov 2026, 5:30 pm');
  assert.match(formatInZone('2026-11-05T12:00:00Z', 'America/New_York', { locale: 'en-US', timeStyle: 'short' }), /7:00\sAM/);
  assert.equal(zoneDisplayName('Asia/Kolkata', '2026-11-05T12:00:00Z'), 'India Standard Time');
  assert.equal(zoneDisplayName('America/New_York', '2026-07-01T12:00:00Z', { locale: 'en-US', style: 'short' }), 'EDT');
  assert.equal(zoneDisplayName('Asia/Kathmandu', '2026-07-01T12:00:00Z', { style: 'longOffset' }), 'GMT+05:45');
  assert.equal(zoneLabel('Asia/Kolkata', '2026-11-05T12:00:00Z'), '(GMT+05:30) Asia/Kolkata');
  assert.equal(zoneLabel('Asia/Calcutta', '2026-11-05T12:00:00Z'), '(GMT+05:30) Asia/Kolkata');
  assert.throws(() => formatInZone(0, 'IST'), RangeError);
});
