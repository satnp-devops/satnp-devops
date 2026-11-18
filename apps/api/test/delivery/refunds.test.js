import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeWithdrawalRefund } from '../../src/modules/delivery/refunds.js';

// Pro-rata refunds (MoE coaching guidelines 2024 cl. 8(iv)): the remaining period is refunded
// within 10 days of the request. docs/delivery/DELIVERY.md §5.

const base = {
  feeMinor: 10_000_000, // ₹1,00,000
  paidMinor: 10_000_000,
  currency: 'INR',
  startsOn: '2026-01-01',
  endsOn: '2026-04-10', // 100 days, inclusive
  enrolledAt: '2025-12-20T06:00:00.000Z',
  receivedAt: '2026-01-30T10:00:00.000Z',
  effectiveOn: '2026-01-30',
  slaDays: 10,
};

test('the remaining days of the course are refunded', () => {
  const result = computeWithdrawalRefund(base);
  assert.equal(result.basis.totalUnits, 100);
  assert.equal(result.basis.usedUnits, 30);
  assert.equal(result.basis.consumedMinor, 3_000_000);
  assert.equal(result.refundMinor, 7_000_000);
  assert.equal(result.basis.rule, 'pro_rata_remaining_period');
  assert.equal(result.coolingOff, false);
});

test('the deadline counts from when the request was received', () => {
  const result = computeWithdrawalRefund(base);
  assert.equal(result.dueAt, '2026-02-09T10:00:00.000Z');
  assert.equal(result.basis.receivedOn, '2026-01-30');
  assert.equal(result.basis.dueOn, '2026-02-09');
  assert.equal(computeWithdrawalRefund({ ...base, slaDays: 15 }).basis.dueOn, '2026-02-14');
  // 00:00 in India is already the next calendar day there.
  assert.equal(computeWithdrawalRefund({ ...base, receivedAt: '2026-01-30T18:30:00.000Z' }).basis.receivedOn, '2026-01-31');
});

test('leaving before the course starts refunds everything; after it ends, nothing', () => {
  assert.equal(computeWithdrawalRefund({ ...base, effectiveOn: '2025-12-31' }).refundMinor, 10_000_000);
  assert.equal(computeWithdrawalRefund({ ...base, effectiveOn: '2026-04-10' }).refundMinor, 0);
  assert.equal(computeWithdrawalRefund({ ...base, effectiveOn: '2026-06-01' }).refundMinor, 0);
});

test('instalment payers get back what they paid beyond what they used, never a negative amount', () => {
  // Half the course used, 40% paid: nothing comes back.
  assert.equal(computeWithdrawalRefund({ ...base, paidMinor: 4_000_000, effectiveOn: '2026-02-19' }).refundMinor, 0);
  // 30 days used (30%), 60% paid: 30% back.
  assert.equal(computeWithdrawalRefund({ ...base, paidMinor: 6_000_000 }).refundMinor, 3_000_000);
  // An unknown fee counts what was paid as the fee.
  assert.equal(computeWithdrawalRefund({ ...base, feeMinor: null, paidMinor: 5_000_000 }).refundMinor, 3_500_000);
});

test('rounding favours the student', () => {
  const result = computeWithdrawalRefund({ ...base, feeMinor: 1000, paidMinor: 1000, startsOn: '2026-01-01', endsOn: '2026-01-03', effectiveOn: '2026-01-01' });
  assert.equal(result.basis.consumedMinor, 333);
  assert.equal(result.refundMinor, 667);
});

test('batches refunded by class count the classes attended', () => {
  const result = computeWithdrawalRefund({ ...base, feeMinor: 4_000_000, paidMinor: 4_000_000, refundUnit: 'classes', totalClasses: 40, classesAttended: 10 });
  assert.equal(result.basis.unit, 'classes');
  assert.equal(result.refundMinor, 3_000_000);
  assert.equal(computeWithdrawalRefund({ ...base, refundUnit: 'classes', totalClasses: 40, classesAttended: 99 }).refundMinor, 0);
});

test('a full-refund window (state rules) returns everything paid', () => {
  const early = computeWithdrawalRefund({ ...base, coolingOffDays: 10, enrolledAt: '2026-01-25T06:00:00.000Z' });
  assert.equal(early.coolingOff, true);
  assert.equal(early.refundMinor, 10_000_000);
  assert.equal(early.basis.rule, 'cooling_off_full_refund');
  const late = computeWithdrawalRefund({ ...base, coolingOffDays: 10, enrolledAt: '2026-01-20T06:00:00.000Z' });
  assert.equal(late.coolingOff, false);
  assert.equal(late.refundMinor, 7_000_000);
});

test('bad dates are rejected', () => {
  assert.throws(() => computeWithdrawalRefund({ ...base, receivedAt: 'yesterday' }), RangeError);
});
