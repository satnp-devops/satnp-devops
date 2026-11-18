import { addDays, daysBetween, localDate, DEFAULT_TIME_ZONE } from '../../core/billing/dates.js';

// Pro-rata refunds when a student leaves mid-course (docs/delivery/DELIVERY.md §5).
//
// Source: Ministry of Education, Guidelines for Registration and Regulation of Coaching Center 2024,
// cl. 8(iv): "If the student has paid for the course in full and is leaving the course in the middle
// of the prescribed period, student will be refunded from out of the fees deposited earlier for the
// remaining period, on pro-rata basis within 10 days." States differ (Rajasthan: same; J&K: full
// refund within 10 days of registration), so the deadline and the full-refund window are settings.
//
// Choices where the rules are silent (open questions Q4-Q6 in the research note), all in the
// student's favour:
//   - the clock starts when the request is received (not when it is approved), calendar days;
//   - the unit is calendar days of the course period, or classes when the batch says so;
//   - the day the student leaves counts as used; days before the course starts are never used;
//   - instalment payers get back what they paid minus what they used (never negative);
//   - the used part is rounded down and no deductions are made.
// The money module stays the authority on what is actually paid out: it receives this as the
// suggested amount with every input (refund.requested), so the computation is auditable.

/**
 * @param {{
 *   feeMinor: number | null,      // the fee locked at enrollment (null: unknown, use what was paid)
 *   paidMinor: number,            // what the family has paid so far
 *   currency: string,
 *   startsOn: string, endsOn: string,       // the prescribed course period (YYYY-MM-DD, inclusive)
 *   effectiveOn: string,          // the last day the student attends (inclusive)
 *   enrolledAt: string | Date,    // for the full-refund window
 *   receivedAt: string | Date,    // when the request arrived: the clock starts here
 *   refundUnit?: 'days' | 'classes', totalClasses?: number | null, classesAttended?: number | null,
 *   coolingOffDays?: number, slaDays: number, timeZone?: string,
 * }} input
 */
export function computeWithdrawalRefund(input) {
  const timeZone = input.timeZone ?? DEFAULT_TIME_ZONE;
  const paid = BigInt(Math.max(0, Math.trunc(input.paidMinor ?? 0)));
  const fee = input.feeMinor === null || input.feeMinor === undefined ? paid : BigInt(Math.max(0, Math.trunc(input.feeMinor)));
  const receivedAt = new Date(input.receivedAt);
  const enrolledAt = new Date(input.enrolledAt);
  if (Number.isNaN(receivedAt.getTime()) || Number.isNaN(enrolledAt.getTime())) throw new RangeError('Invalid date');

  const unit = input.refundUnit === 'classes' ? 'classes' : 'days';
  let totalUnits;
  let usedUnits;
  if (unit === 'classes') {
    totalUnits = Math.max(1, Math.trunc(input.totalClasses ?? 0));
    usedUnits = clamp(Math.trunc(input.classesAttended ?? 0), 0, totalUnits);
  } else {
    totalUnits = Math.max(1, daysBetween(input.startsOn, input.endsOn) + 1);
    usedUnits = clamp(daysBetween(input.startsOn, input.effectiveOn) + 1, 0, totalUnits);
  }
  const remainingUnits = totalUnits - usedUnits;

  const coolingOffDays = Math.max(0, Math.trunc(input.coolingOffDays ?? 0));
  const receivedDay = localDate(receivedAt.getTime(), timeZone);
  const enrolledDay = localDate(enrolledAt.getTime(), timeZone);
  const daysSinceEnrolment = daysBetween(enrolledDay, receivedDay);
  const coolingOff = coolingOffDays > 0 && daysSinceEnrolment < coolingOffDays;

  // Used value, rounded down (in the student's favour): fee × used / total.
  const consumed = (fee * BigInt(usedUnits)) / BigInt(totalUnits);
  const refund = coolingOff ? paid : paid > consumed ? paid - consumed : 0n;

  const slaDays = Math.max(1, Math.trunc(input.slaDays));
  const dueAt = new Date(receivedAt.getTime() + slaDays * 86_400_000);

  return {
    refundMinor: Number(refund),
    currency: input.currency,
    coolingOff,
    dueAt: dueAt.toISOString(),
    basis: {
      rule: coolingOff ? 'cooling_off_full_refund' : 'pro_rata_remaining_period',
      unit,
      totalUnits,
      usedUnits,
      remainingUnits,
      feeMinor: Number(fee),
      paidMinor: Number(paid),
      consumedMinor: coolingOff ? 0 : Number(consumed > paid ? paid : consumed),
      startsOn: input.startsOn,
      endsOn: input.endsOn,
      effectiveOn: input.effectiveOn,
      receivedAt: receivedAt.toISOString(),
      receivedOn: receivedDay,
      enrolledOn: enrolledDay,
      coolingOffDays,
      slaDays,
      dueOn: addDays(receivedDay, slaDays),
      timeZone,
      deductionsMinor: 0,
    },
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
