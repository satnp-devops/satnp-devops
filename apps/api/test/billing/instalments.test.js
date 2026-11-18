import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dueDates, rescheduleInstalments, splitInstalments } from '../../src/core/billing/instalments.js';
import { assertValidation, seededRandom } from './helpers.js';

const monthly = (startDate, extra = {}) => ({ frequency: 'monthly', startDate, ...extra });
const amounts = (plan) => plan.instalments.map((i) => i.amountMinor);
const dates = (plan) => plan.instalments.map((i) => i.dueDate);

test('equal instalments put the leftover paisa on the last one by default', () => {
  const plan = splitInstalments({ totalMinor: 10_000_000, count: 3, schedule: monthly('2026-04-10') });
  assert.deepEqual(amounts(plan), [3_333_333, 3_333_333, 3_333_334]);
  assert.deepEqual(plan.instalments.map((i) => i.number), [1, 2, 3]);
  assert.equal(plan.totalMinor, 10_000_000);
});

test('the leftover can go on the first instalment instead', () => {
  const plan = splitInstalments({ totalMinor: 10_000_000, count: 3, schedule: monthly('2026-04-10'), remainderOn: 'first' });
  assert.deepEqual(amounts(plan), [3_333_334, 3_333_333, 3_333_333]);
});

test('instalments can be kept to whole rupees', () => {
  const plan = splitInstalments({ totalMinor: 10_000_000, count: 3, schedule: monthly('2026-04-10'), roundingUnitMinor: 100 });
  assert.deepEqual(amounts(plan), [3_333_300, 3_333_300, 3_333_400]);
  const odd = splitInstalments({ totalMinor: 10_000_050, count: 4, schedule: monthly('2026-04-10'), roundingUnitMinor: 100, remainderOn: 'first' });
  assert.deepEqual(amounts(odd), [2_500_050, 2_500_000, 2_500_000, 2_500_000]);
});

test('a fixed first payment, with the rest split equally', () => {
  const plan = splitInstalments({ totalMinor: 5_000_000, count: 5, firstAmountMinor: 1_000_000, schedule: monthly('2026-04-10') });
  assert.deepEqual(amounts(plan), [1_000_000, 1_000_000, 1_000_000, 1_000_000, 1_000_000]);
  const odd = splitInstalments({ totalMinor: 1_000_001, count: 4, firstAmountMinor: 100_000, schedule: monthly('2026-04-10') });
  assert.deepEqual(amounts(odd), [100_000, 300_000, 300_000, 300_001]);
  const first = splitInstalments({ totalMinor: 1_000_001, count: 4, firstAmountMinor: 100_000, schedule: monthly('2026-04-10'), remainderOn: 'first' });
  assert.deepEqual(amounts(first), [100_000, 300_001, 300_000, 300_000], 'the leftover goes on the first equal instalment, not the fixed one');
  assertValidation(() => splitInstalments({ totalMinor: 300, count: 3, firstAmountMinor: 0, schedule: monthly('2026-04-10') }), 'firstAmountMinor');
});

test('one instalment is the whole amount', () => {
  assert.deepEqual(amounts(splitInstalments({ totalMinor: 999, count: 1, schedule: monthly('2026-04-10') })), [999]);
  assert.deepEqual(amounts(splitInstalments({ totalMinor: 999, count: 1, firstAmountMinor: 999, schedule: monthly('2026-04-10') })), [999]);
  assertValidation(() => splitInstalments({ totalMinor: 999, count: 1, firstAmountMinor: 500, schedule: monthly('2026-04-10') }), 'firstAmountMinor');
});

test('impossible plans are refused', () => {
  assertValidation(() => splitInstalments({ totalMinor: 100, count: 2, firstAmountMinor: 101, schedule: monthly('2026-04-10') }), 'firstAmountMinor');
  assertValidation(() => splitInstalments({ totalMinor: 2, count: 3, schedule: monthly('2026-04-10') }), 'count');
  assertValidation(() => splitInstalments({ totalMinor: 150, count: 2, schedule: monthly('2026-04-10'), roundingUnitMinor: 100 }), 'count');
  assertValidation(() => splitInstalments({ totalMinor: 100, count: 0, schedule: monthly('2026-04-10') }), 'count');
  assertValidation(() => splitInstalments({ totalMinor: 100.5, count: 2, schedule: monthly('2026-04-10') }), 'totalMinor');
  assertValidation(() => splitInstalments({ totalMinor: 100, count: 2, schedule: monthly('2026-02-30') }), 'schedule.startDate');
  assertValidation(() => splitInstalments({ totalMinor: 100, count: 2, schedule: { frequency: 'weekly' } }), 'schedule.frequency');
  assert.deepEqual(amounts(splitInstalments({ totalMinor: 0, count: 3, schedule: monthly('2026-04-10') })), [0, 0, 0], 'a free plan is fine');
});

test('monthly due dates keep the day and clamp to short months', () => {
  assert.deepEqual(dates(splitInstalments({ totalMinor: 400, count: 4, schedule: monthly('2026-01-31') })), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
  assert.deepEqual(dates(splitInstalments({ totalMinor: 200, count: 2, schedule: monthly('2028-01-31') })), ['2028-01-31', '2028-02-29']);
  assert.deepEqual(dates(splitInstalments({ totalMinor: 300, count: 3, schedule: monthly('2026-11-15') })), ['2026-11-15', '2026-12-15', '2027-01-15']);
});

test('a day of month and an interval can be set', () => {
  assert.deepEqual(
    dates(splitInstalments({ totalMinor: 300, count: 3, schedule: monthly('2026-04-20', { dayOfMonth: 5 }) })),
    ['2026-04-20', '2026-05-05', '2026-06-05'],
  );
  assert.deepEqual(
    dates(splitInstalments({ totalMinor: 400, count: 4, schedule: monthly('2026-04-01', { intervalMonths: 3 }) })),
    ['2026-04-01', '2026-07-01', '2026-10-01', '2027-01-01'],
  );
  assert.deepEqual(dueDates({ frequency: 'monthly', startDate: '2026-04-10', dayOfMonth: 31, intervalMonths: 1 }, 3), ['2026-04-10', '2026-05-31', '2026-06-30']);
});

test('custom dates must match the count and be in order', () => {
  const plan = splitInstalments({ totalMinor: 300, count: 3, schedule: { frequency: 'custom', dates: ['2026-04-01', '2026-06-15', '2026-12-31'] } });
  assert.deepEqual(dates(plan), ['2026-04-01', '2026-06-15', '2026-12-31']);
  assertValidation(() => splitInstalments({ totalMinor: 300, count: 3, schedule: { frequency: 'custom', dates: ['2026-04-01', '2026-06-15'] } }), 'schedule.dates');
  assertValidation(() => splitInstalments({ totalMinor: 300, count: 2, schedule: { frequency: 'custom', dates: ['2026-06-15', '2026-04-01'] } }), 'schedule.dates.1');
  assertValidation(() => splitInstalments({ totalMinor: 300, count: 2, schedule: { frequency: 'custom', dates: ['2026-04-01', '2026-04-01'] } }), 'schedule.dates.1');
  assertValidation(() => splitInstalments({ totalMinor: 300, count: 1, schedule: { frequency: 'custom', dates: ['01/04/2026'] } }), 'schedule.dates.0');
});

test('plans always add up to the total', () => {
  const random = seededRandom(42);
  for (let run = 0; run < 500; run += 1) {
    const count = random.int(1, 24);
    const unit = random.pick([1, 100]);
    const totalMinor = random.int(count * unit * 2, 100_000_000);
    const withFirst = count > 1 && random() < 0.4;
    const plan = splitInstalments({
      totalMinor,
      count,
      schedule: monthly('2026-01-31'),
      roundingUnitMinor: unit,
      remainderOn: random.pick(['first', 'last']),
      ...(withFirst && { firstAmountMinor: random.int(1, Math.floor(totalMinor / 2)) }),
    });
    assert.equal(amounts(plan).reduce((a, b) => a + b, 0), totalMinor);
    assert.equal(plan.instalments.length, count);
    const equal = amounts(plan).slice(withFirst ? 1 : 0);
    const spread = Math.max(...equal) - Math.min(...equal);
    assert.ok(spread < count * unit, 'equal instalments differ by less than the leftover');
  }
});

test('rescheduling closes paid instalments and re-splits what is owed', () => {
  const original = splitInstalments({ totalMinor: 10_000_000, count: 3, schedule: monthly('2026-04-10') }).instalments;
  const result = rescheduleInstalments({
    instalments: [
      { ...original[0], paidMinor: 3_333_333 },
      { ...original[1], paidMinor: 1_000_000 },
      { ...original[2], paidMinor: 0 },
    ],
    count: 2,
    schedule: monthly('2026-07-01'),
  });
  assert.equal(result.paidMinor, 4_333_333);
  assert.equal(result.outstandingMinor, 5_666_667);
  assert.deepEqual(result.settled.map((i) => [i.number, i.amountMinor, i.originalAmountMinor]), [[1, 3_333_333, 3_333_333], [2, 1_000_000, 3_333_333]]);
  assert.deepEqual(result.rescheduled.map((i) => [i.number, i.dueDate, i.amountMinor]), [[3, '2026-07-01', 2_833_333], [4, '2026-08-01', 2_833_334]]);
  assert.equal(result.instalments.reduce((a, i) => a + i.amountMinor, 0), 10_000_000, 'the total never changes');
  assert.ok(result.instalments.every((i) => !('originalAmountMinor' in i)));
});

test('rescheduling keeps the same options as splitting', () => {
  const result = rescheduleInstalments({
    instalments: [{ dueDate: '2026-04-10', amountMinor: 600_000, paidMinor: 100_000 }, { dueDate: '2026-05-10', amountMinor: 400_000 }],
    count: 3,
    firstAmountMinor: 300_000,
    roundingUnitMinor: 100,
    schedule: { frequency: 'custom', dates: ['2026-06-01', '2026-07-01', '2026-08-01'] },
  });
  assert.deepEqual(result.rescheduled.map((i) => i.amountMinor), [300_000, 300_000, 300_000]);
});

test('rescheduling a fully paid plan leaves nothing to schedule', () => {
  const result = rescheduleInstalments({
    instalments: [{ dueDate: '2026-04-10', amountMinor: 500, paidMinor: 700 }, { dueDate: '2026-05-10', amountMinor: 500, paidMinor: 300 }],
    count: 2,
    schedule: monthly('2026-06-01'),
  });
  assert.equal(result.outstandingMinor, 0);
  assert.deepEqual(result.rescheduled, []);
  assert.deepEqual(result.instalments.map((i) => i.amountMinor), [700, 300], 'an overpaid instalment closes at what was paid');
});

test('rescheduling refuses an overpaid plan', () => {
  assertValidation(
    () => rescheduleInstalments({ instalments: [{ dueDate: '2026-04-10', amountMinor: 500, paidMinor: 501 }], count: 1, schedule: monthly('2026-06-01') }),
    'instalments',
  );
  assertValidation(() => rescheduleInstalments({ instalments: [], count: 1, schedule: monthly('2026-06-01') }), 'instalments');
});
