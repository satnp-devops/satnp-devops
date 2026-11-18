import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allocateProportionally,
  assertMinor,
  mulDivFloor,
  mulDivRound,
  quantityToMilli,
  roundToUnit,
  sumMinor,
} from '../../src/core/billing/money.js';
import {
  addDays,
  addMonths,
  compareDates,
  daysBetween,
  daysInMonth,
  isCalendarDate,
  localDate,
  toCalendarDate,
  zonedDateTimeToInstant,
} from '../../src/core/billing/dates.js';
import { assertValidation, seededRandom } from './helpers.js';

test('mulDivRound rounds half away from zero', () => {
  assert.equal(mulDivRound(5, 1, 2), 3);
  assert.equal(mulDivRound(-5, 1, 2), -3);
  assert.equal(mulDivRound(4, 1, 3), 1);
  assert.equal(mulDivRound(5, 1, 3), 2);
  assert.equal(mulDivRound(7, 1, -2), -4);
  assert.equal(mulDivRound(0, 5, 7), 0);
  assert.equal(Object.is(mulDivRound(-0, 5, 7), -0), false, 'never returns negative zero');
  assert.throws(() => mulDivRound(1, 1, 0), RangeError);
});

test('mulDivRound is exact beyond 2^53 intermediate products', () => {
  // 9,007,199,254,740 × 1800 overflows a double's exact range; BigInt keeps it exact.
  assert.equal(mulDivRound(9_007_199_254_740, 1800, 10_000), 1_621_295_865_853);
  assert.throws(() => mulDivRound(Number.MAX_SAFE_INTEGER, 10, 1), RangeError);
  assert.equal(mulDivFloor(10, 2, 3), 6);
  assert.throws(() => mulDivFloor(-1, 2, 3), RangeError);
});

test('roundToUnit rounds to whole rupees, fifty paise up', () => {
  assert.equal(roundToUnit(150, 100), 200);
  assert.equal(roundToUnit(149, 100), 100);
  assert.equal(roundToUnit(1_180_050, 100), 1_180_100);
  assert.equal(roundToUnit(1_180_049, 100), 1_180_000);
});

test('allocateProportionally keeps the exact total with largest remainders', () => {
  assert.deepEqual(allocateProportionally(100, [1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(allocateProportionally(10, [0, 0]), [5, 5]);
  assert.deepEqual(allocateProportionally(7, [0, 1, 1]), [0, 4, 3]);
  assert.deepEqual(allocateProportionally(0, [1, 2]), [0, 0]);
  assert.deepEqual(allocateProportionally(1000, [700, 200, 100]), [700, 200, 100]);
  assert.throws(() => allocateProportionally(10, []), RangeError);
  assert.throws(() => allocateProportionally(10, [-1, 2]), RangeError);
  const random = seededRandom(7);
  for (let run = 0; run < 300; run += 1) {
    const weights = Array.from({ length: random.int(1, 8) }, () => random.int(0, 1_000_000));
    const total = random.int(0, 10_000_000);
    const parts = allocateProportionally(total, weights);
    assert.equal(sumMinor(parts), total);
    if (weights.some((w) => w > 0)) weights.forEach((w, i) => w === 0 && assert.equal(parts[i], 0));
  }
});

test('assertMinor and quantityToMilli guard their inputs', () => {
  assert.equal(assertMinor(5), 5);
  assertValidation(() => assertMinor(1.5, 'x'), 'x');
  assertValidation(() => assertMinor(-1));
  assert.equal(assertMinor(-1, 'x', { allowNegative: true }), -1);
  assertValidation(() => assertMinor('5'));
  assert.equal(quantityToMilli(1.005), 1005);
  assert.equal(quantityToMilli(3), 3000);
  assert.throws(() => quantityToMilli(1.0005), RangeError);
});

test('calendar dates are validated', () => {
  assert.ok(isCalendarDate('2028-02-29'));
  assert.ok(!isCalendarDate('2026-02-29'));
  assert.ok(!isCalendarDate('2026-13-01'));
  assert.ok(!isCalendarDate('2026-4-1'));
  assert.ok(!isCalendarDate(20260401));
  assert.equal(daysInMonth(2028, 2), 29);
  assert.equal(daysInMonth(2100, 2), 28);
});

test('month arithmetic clamps to the end of short months without drifting', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2026-01-31', 2), '2026-03-31');
  assert.equal(addMonths('2028-01-31', 1), '2028-02-29');
  assert.equal(addMonths('2026-11-15', 2), '2027-01-15');
  assert.equal(addMonths('2026-03-31', -1), '2026-02-28');
  assert.equal(addMonths('2026-04-20', 1, 5), '2026-05-05');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(daysBetween('2028-02-28', '2028-03-01'), 2);
  assert.equal(daysBetween('2026-04-01', '2027-04-01'), 365);
  assert.equal(compareDates('2026-01-02', '2026-01-01'), 1);
  assert.equal(compareDates('2026-01-01', '2026-01-01'), 0);
});

test('instants become calendar dates in the company zone', () => {
  assert.equal(localDate('2026-03-31T18:29:59Z', 'Asia/Kolkata'), '2026-03-31');
  assert.equal(localDate('2026-03-31T18:30:00Z', 'Asia/Kolkata'), '2026-04-01');
  assert.equal(localDate(Date.UTC(2026, 3, 1, 3), 'America/Los_Angeles'), '2026-03-31');
  assert.equal(toCalendarDate('2026-04-01'), '2026-04-01');
  assert.equal(toCalendarDate(new Date('2026-03-31T20:00:00Z')), '2026-04-01');
  assertValidation(() => toCalendarDate('2026-02-30'));
  assertValidation(() => toCalendarDate('not a date'));
  assertValidation(() => localDate('2026-04-01T00:00:00Z', 'Mars/Olympus'), 'timeZone');
});

test('wall-clock times in a zone become UTC instants', () => {
  assert.equal(zonedDateTimeToInstant('2026-04-30', 'Asia/Kolkata', '23:59:59'), '2026-04-30T18:29:59.000Z');
  assert.equal(zonedDateTimeToInstant('2026-04-30'), '2026-04-29T18:30:00.000Z');
  // New York springs forward on 8 March 2026: noon is EDT (UTC-4) that day, EST (UTC-5) the day before.
  assert.equal(zonedDateTimeToInstant('2026-03-08', 'America/New_York', '12:00'), '2026-03-08T16:00:00.000Z');
  assert.equal(zonedDateTimeToInstant('2026-03-07', 'America/New_York', '12:00'), '2026-03-07T17:00:00.000Z');
  assertValidation(() => zonedDateTimeToInstant('2026-04-30', 'Asia/Kolkata', '25:00:00x'), 'time');
});
