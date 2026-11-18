/**
 * Proration for B2B subscriptions (institute ERP and test software): seat or plan changes in the
 * middle of a monthly or annual term.
 *
 * Rule: the customer gets credit for the unused part of what they paid for and is charged for the
 * rest of the term at the new plan, both by days. Days are calendar days in the company's zone;
 * the change date counts as a day on the new plan and the term end is exclusive (it is the next
 * renewal date). Each figure is rounded to the paisa once. Amounts are before GST: put a net
 * charge on an invoice with gst.computeTax, a net credit on a credit note with computeCreditNote.
 */
import { z } from 'zod';
import { errors } from '../../lib/errors.js';
import { parseOrThrow } from '../../lib/validate.js';
import { DEFAULT_TIME_ZONE, addMonths, daysBetween, isCalendarDate, parseDate, toCalendarDate } from './dates.js';
import { mulDivRound } from './money.js';

export const INTERVALS = /** @type {const} */ (['month', 'year']);

/**
 * The renewal date `count` terms after `start`, keeping the start day where the month allows
 * (a term starting 31 January renews 28/29 February, then 31 March).
 * @param {string} start YYYY-MM-DD
 * @param {'month' | 'year'} interval
 * @param {number} [count]
 */
export function termEndFor(start, interval, count = 1) {
  if (!INTERVALS.includes(interval)) throw errors.validation([{ path: 'interval', message: 'Use month or year' }]);
  return addMonths(start, (interval === 'year' ? 12 : 1) * count, parseDate(start, 'termStart').day);
}

/**
 * The share of a full-term amount that falls in `days` of a `termDays`-day term.
 * @param {number} amountMinor
 * @param {number} days
 * @param {number} termDays
 */
export const prorateAmount = (amountMinor, days, termDays) => mulDivRound(amountMinor, days, termDays);

const planSchema = z.union([
  z.object({ unitPriceMinor: z.number().int().nonnegative(), quantity: z.number().int().nonnegative() }),
  z.object({ amountMinor: z.number().int().nonnegative() }),
]);

const dateOrInstant = z.union([z.string(), z.number(), z.date()]);

export const prorateChangeSchema = z
  .object({
    termStart: z.string().refine(isCalendarDate, 'Enter a date as YYYY-MM-DD'),
    termEnd: z.string().refine(isCalendarDate, 'Enter a date as YYYY-MM-DD').optional(),
    interval: z.enum(INTERVALS).optional(),
    changeAt: dateOrInstant,
    timeZone: z.string().default(DEFAULT_TIME_ZONE),
    /** Price for the whole term: per seat × seats, or a flat plan amount. */
    from: planSchema,
    to: planSchema,
    /** Downgrades usually wait for renewal; "immediate" credits the difference now. */
    downgrade: z.enum(['immediate', 'at_renewal']).default('at_renewal'),
  })
  .refine((d) => d.termEnd !== undefined || d.interval !== undefined, {
    message: 'Give termEnd or interval',
    path: ['termEnd'],
  });

/** @param {z.output<typeof planSchema>} plan */
function termAmount(plan) {
  const amount = 'amountMinor' in plan ? plan.amountMinor : plan.unitPriceMinor * plan.quantity;
  if (!Number.isSafeInteger(amount)) throw errors.validation([{ path: 'from', message: 'Amount is too large' }]);
  return amount;
}

/**
 * Work out the credit and charge for a mid-term change.
 * @param {z.input<typeof prorateChangeSchema>} input
 */
export function prorateChange(input) {
  const data = parseOrThrow(prorateChangeSchema, input);
  const termStart = data.termStart;
  const termEnd = data.termEnd ?? termEndFor(termStart, /** @type {'month' | 'year'} */ (data.interval));
  const changeDate = toCalendarDate(data.changeAt, data.timeZone, 'changeAt');
  const termDays = daysBetween(termStart, termEnd);
  if (termDays <= 0) throw errors.validation([{ path: 'termEnd', message: 'The term must end after it starts' }]);
  const usedDays = daysBetween(termStart, changeDate);
  if (usedDays < 0 || usedDays >= termDays) {
    throw errors.validation([{ path: 'changeAt', message: `The change must fall within the term (${termStart} to ${termEnd})` }]);
  }
  const remainingDays = termDays - usedDays;
  const fromAmountMinor = termAmount(data.from);
  const toAmountMinor = termAmount(data.to);
  const direction = toAmountMinor > fromAmountMinor ? 'upgrade' : toAmountMinor < fromAmountMinor ? 'downgrade' : 'none';
  const base = { termStart, termEnd, changeDate, termDays, usedDays, remainingDays, fromAmountMinor, toAmountMinor, direction };

  if (direction === 'none' || (direction === 'downgrade' && data.downgrade === 'at_renewal')) {
    return { ...base, effective: direction === 'none' ? 'now' : 'renewal', effectiveDate: direction === 'none' ? changeDate : termEnd, creditMinor: 0, chargeMinor: 0, netMinor: 0 };
  }
  const creditMinor = prorateAmount(fromAmountMinor, remainingDays, termDays);
  const chargeMinor = prorateAmount(toAmountMinor, remainingDays, termDays);
  return {
    ...base,
    effective: 'now',
    effectiveDate: changeDate,
    creditMinor,
    chargeMinor,
    /** Positive: invoice this much. Negative: credit this much. */
    netMinor: chargeMinor - creditMinor,
  };
}
