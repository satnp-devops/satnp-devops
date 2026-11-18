import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prorateAmount, prorateChange, termEndFor } from '../../src/core/billing/proration.js';
import { assertValidation } from './helpers.js';

test('term ends keep the start day and clamp in short months', () => {
  assert.equal(termEndFor('2026-04-01', 'month'), '2026-05-01');
  assert.equal(termEndFor('2026-01-31', 'month'), '2026-02-28');
  assert.equal(termEndFor('2026-01-31', 'month', 2), '2026-03-31');
  assert.equal(termEndFor('2026-04-01', 'year'), '2027-04-01');
  assert.equal(termEndFor('2028-02-29', 'year'), '2029-02-28');
  assert.equal(termEndFor('2026-04-15', 'month', 3), '2026-07-15');
  assertValidation(() => termEndFor('2026-04-01', 'week'), 'interval');
});

test('prorateAmount rounds once to the paisa', () => {
  assert.equal(prorateAmount(1_200_000, 182, 365), 598_356);
  assert.equal(prorateAmount(100, 1, 3), 33);
  assert.equal(prorateAmount(100, 2, 3), 67);
  assert.equal(prorateAmount(100, 3, 3), 100);
});

test('adding seats mid-year: credit unused time, charge the rest at the new size', () => {
  const result = prorateChange({
    termStart: '2026-04-01',
    interval: 'year',
    changeAt: '2026-10-01',
    from: { unitPriceMinor: 120_000, quantity: 10 },
    to: { unitPriceMinor: 120_000, quantity: 15 },
  });
  assert.equal(result.termEnd, '2027-04-01');
  assert.equal(result.termDays, 365);
  assert.equal(result.usedDays, 183);
  assert.equal(result.remainingDays, 182);
  assert.equal(result.direction, 'upgrade');
  assert.equal(result.effective, 'now');
  assert.equal(result.effectiveDate, '2026-10-01');
  assert.equal(result.creditMinor, 598_356);
  assert.equal(result.chargeMinor, 897_534);
  assert.equal(result.netMinor, 299_178);
});

test('a monthly plan change by days', () => {
  const result = prorateChange({
    termStart: '2026-02-01',
    interval: 'month',
    changeAt: '2026-02-15',
    from: { unitPriceMinor: 50_000, quantity: 10 },
    to: { unitPriceMinor: 50_000, quantity: 12 },
  });
  assert.equal(result.termDays, 28);
  assert.equal(result.remainingDays, 14);
  assert.equal(result.creditMinor, 250_000);
  assert.equal(result.chargeMinor, 300_000);
  assert.equal(result.netMinor, 50_000);
});

test('a change on the first day swaps the whole term; on the last day, one day', () => {
  const base = { termStart: '2026-04-01', termEnd: '2026-05-01', from: { amountMinor: 300_000 }, to: { amountMinor: 600_000 } };
  const first = prorateChange({ ...base, changeAt: '2026-04-01' });
  assert.deepEqual([first.remainingDays, first.creditMinor, first.chargeMinor, first.netMinor], [30, 300_000, 600_000, 300_000]);
  const last = prorateChange({ ...base, changeAt: '2026-04-30' });
  assert.deepEqual([last.remainingDays, last.creditMinor, last.chargeMinor], [1, 10_000, 20_000]);
});

test('the change must fall inside the term', () => {
  const base = { termStart: '2026-04-01', termEnd: '2026-05-01', from: { amountMinor: 300_000 }, to: { amountMinor: 600_000 } };
  assertValidation(() => prorateChange({ ...base, changeAt: '2026-05-01' }), 'changeAt');
  assertValidation(() => prorateChange({ ...base, changeAt: '2026-03-31' }), 'changeAt');
  assertValidation(() => prorateChange({ ...base, termEnd: '2026-04-01', changeAt: '2026-04-01' }), 'termEnd');
  assertValidation(() => prorateChange({ termStart: '2026-04-01', changeAt: '2026-04-02', from: { amountMinor: 1 }, to: { amountMinor: 2 } }), 'termEnd');
});

test('downgrades wait for renewal unless asked to apply now', () => {
  const base = {
    termStart: '2026-04-01',
    interval: 'year',
    changeAt: '2026-10-01',
    from: { unitPriceMinor: 120_000, quantity: 15 },
    to: { unitPriceMinor: 120_000, quantity: 10 },
  };
  const later = prorateChange(base);
  assert.equal(later.direction, 'downgrade');
  assert.equal(later.effective, 'renewal');
  assert.equal(later.effectiveDate, '2027-04-01');
  assert.deepEqual([later.creditMinor, later.chargeMinor, later.netMinor], [0, 0, 0]);
  const now = prorateChange({ ...base, downgrade: 'immediate' });
  assert.equal(now.effective, 'now');
  assert.deepEqual([now.creditMinor, now.chargeMinor, now.netMinor], [897_534, 598_356, -299_178]);
});

test('cancelling all seats immediately credits the unused time', () => {
  const result = prorateChange({
    termStart: '2026-04-01',
    termEnd: '2026-05-01',
    changeAt: '2026-04-16',
    from: { unitPriceMinor: 10_000, quantity: 3 },
    to: { unitPriceMinor: 10_000, quantity: 0 },
    downgrade: 'immediate',
  });
  assert.deepEqual([result.remainingDays, result.creditMinor, result.chargeMinor, result.netMinor], [15, 15_000, 0, -15_000]);
});

test('a change of plan at the same price changes nothing', () => {
  const result = prorateChange({ termStart: '2026-04-01', interval: 'month', changeAt: '2026-04-10', from: { amountMinor: 5000 }, to: { unitPriceMinor: 2500, quantity: 2 } });
  assert.equal(result.direction, 'none');
  assert.equal(result.effective, 'now');
  assert.equal(result.netMinor, 0);
});

test('instants are read as dates in the company zone', () => {
  const result = prorateChange({
    termStart: '2026-02-01',
    interval: 'month',
    changeAt: '2026-02-14T19:00:00Z', // 15 February, 00:30 in India
    from: { amountMinor: 280_000 },
    to: { amountMinor: 560_000 },
  });
  assert.equal(result.changeDate, '2026-02-15');
  assert.equal(result.remainingDays, 14);
  const london = prorateChange({
    termStart: '2026-02-01',
    interval: 'month',
    changeAt: '2026-02-14T19:00:00Z',
    timeZone: 'Europe/London',
    from: { amountMinor: 280_000 },
    to: { amountMinor: 560_000 },
  });
  assert.equal(london.changeDate, '2026-02-14');
});

test('inputs are validated', () => {
  const base = { termStart: '2026-04-01', interval: 'month', changeAt: '2026-04-10' };
  assertValidation(() => prorateChange({ ...base, from: { amountMinor: -1 }, to: { amountMinor: 1 } }), 'from');
  assertValidation(() => prorateChange({ ...base, from: { unitPriceMinor: 1, quantity: 1.5 }, to: { amountMinor: 1 } }), 'from');
  assertValidation(() => prorateChange({ ...base, termStart: '2026-04-31', from: { amountMinor: 1 }, to: { amountMinor: 2 } }), 'termStart');
});
