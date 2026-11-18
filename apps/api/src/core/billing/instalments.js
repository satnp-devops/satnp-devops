/**
 * Instalment plans: split a fee into N payments and reschedule what is still owed.
 *
 * Amounts are integer minor units and always add up to the total exactly. Instalments are equal
 * (optionally in whole rupees, `roundingUnitMinor: 100`) and the leftover goes to one instalment
 * chosen by `remainderOn` ("last" by default), so the same input always gives the same plan.
 * Due dates are calendar dates in the company's zone (see dates.js).
 */
import { z } from 'zod';
import { errors } from '../../lib/errors.js';
import { parseOrThrow } from '../../lib/validate.js';
import { addMonths, compareDates, isCalendarDate, parseDate } from './dates.js';
import { sumMinor } from './money.js';

const calendarDate = z.string().refine(isCalendarDate, 'Enter a date as YYYY-MM-DD');

const scheduleSchema = z.discriminatedUnion('frequency', [
  z.object({
    frequency: z.literal('monthly'),
    startDate: calendarDate,
    /** Day of month for the second and later instalments (defaults to the start date's day). */
    dayOfMonth: z.number().int().min(1).max(31).optional(),
    intervalMonths: z.number().int().min(1).max(12).default(1),
  }),
  z.object({ frequency: z.literal('custom'), dates: z.array(calendarDate).min(1) }),
]);

const optionsShape = {
  count: z.number().int().min(1).max(120),
  schedule: scheduleSchema,
  /** A fixed first payment (registration fee, down payment); the rest is split equally. */
  firstAmountMinor: z.number().int().nonnegative().optional(),
  /** Make equal instalments multiples of this (100 = whole rupees). */
  roundingUnitMinor: z.number().int().min(1).default(1),
  /** Which of the equal instalments absorbs the leftover. */
  remainderOn: z.enum(['first', 'last']).default('last'),
};

export const splitInstalmentsSchema = z.object({ totalMinor: z.number().int().nonnegative(), ...optionsShape });

/**
 * @typedef {object} Instalment
 * @property {number} number 1-based position in the plan
 * @property {string} dueDate YYYY-MM-DD
 * @property {number} amountMinor
 */

/**
 * @param {z.output<typeof scheduleSchema>} schedule
 * @param {number} count
 * @returns {string[]}
 */
export function dueDates(schedule, count) {
  if (schedule.frequency === 'custom') {
    if (schedule.dates.length !== count) {
      throw errors.validation([{ path: 'schedule.dates', message: `Give exactly ${count} dates` }]);
    }
    schedule.dates.forEach((date, i) => {
      if (i > 0 && compareDates(date, schedule.dates[i - 1]) <= 0) {
        throw errors.validation([{ path: `schedule.dates.${i}`, message: 'Dates must be in order, one per day at most' }]);
      }
    });
    return [...schedule.dates];
  }
  const anchor = schedule.dayOfMonth ?? parseDate(schedule.startDate).day;
  return Array.from({ length: count }, (_, i) =>
    i === 0 ? schedule.startDate : addMonths(schedule.startDate, i * schedule.intervalMonths, anchor),
  );
}

/**
 * Split an amount into `count` equal parts in multiples of `unit`; the leftover goes on one part.
 * @param {number} amount
 * @param {number} count
 * @param {number} unit
 * @param {'first' | 'last'} remainderOn
 */
function equalParts(amount, count, unit, remainderOn) {
  const base = Math.floor(amount / count / unit) * unit;
  const parts = Array(count).fill(base);
  parts[remainderOn === 'first' ? 0 : count - 1] += amount - base * count;
  return parts;
}

/**
 * @param {number} totalMinor
 * @param {z.output<z.ZodObject<typeof optionsShape>>} options
 * @returns {number[]}
 */
function planAmounts(totalMinor, { count, firstAmountMinor, roundingUnitMinor, remainderOn }) {
  if (firstAmountMinor === undefined) return equalParts(totalMinor, count, roundingUnitMinor, remainderOn);
  if (firstAmountMinor === 0 && totalMinor > 0) {
    throw errors.validation([{ path: 'firstAmountMinor', message: 'The first payment must be more than zero; leave it out for equal instalments' }]);
  }
  if (firstAmountMinor > totalMinor) {
    throw errors.validation([{ path: 'firstAmountMinor', message: 'The first payment is more than the total' }]);
  }
  if (count === 1) {
    if (firstAmountMinor !== totalMinor) {
      throw errors.validation([{ path: 'firstAmountMinor', message: 'With one instalment the first payment is the whole amount' }]);
    }
    return [totalMinor];
  }
  return [firstAmountMinor, ...equalParts(totalMinor - firstAmountMinor, count - 1, roundingUnitMinor, remainderOn)];
}

/**
 * Split a total into instalments.
 * @param {z.input<typeof splitInstalmentsSchema>} input
 * @returns {{ totalMinor: number, instalments: Instalment[] }}
 */
export function splitInstalments(input) {
  const data = parseOrThrow(splitInstalmentsSchema, input);
  const amounts = planAmounts(data.totalMinor, data);
  if (data.totalMinor > 0 && amounts.some((a) => a === 0)) {
    throw errors.validation([{ path: 'count', message: 'Too many instalments for this amount: some would be zero' }]);
  }
  const dates = dueDates(data.schedule, data.count);
  return {
    totalMinor: data.totalMinor,
    instalments: amounts.map((amountMinor, i) => ({ number: i + 1, dueDate: dates[i], amountMinor })),
  };
}

export const rescheduleSchema = z.object({
  instalments: z
    .array(
      z.object({
        number: z.number().int().positive().optional(),
        dueDate: calendarDate,
        amountMinor: z.number().int().nonnegative(),
        paidMinor: z.number().int().nonnegative().default(0),
      }),
    )
    .min(1),
  ...optionsShape,
});

/**
 * Reschedule what is still owed. Every instalment with a payment against it is closed at the
 * amount paid (a part-paid instalment's unpaid balance moves into the new plan); unpaid
 * instalments are replaced by `count` new ones, numbered after the closed ones. The plan's total
 * never changes: closed + new = original total.
 * @param {z.input<typeof rescheduleSchema>} input
 * @returns {{ totalMinor: number, paidMinor: number, outstandingMinor: number,
 *   settled: Array<Instalment & { originalAmountMinor: number }>, rescheduled: Instalment[], instalments: Instalment[] }}
 */
export function rescheduleInstalments(input) {
  const data = parseOrThrow(rescheduleSchema, input);
  const totalMinor = sumMinor(data.instalments.map((i) => i.amountMinor));
  const paidMinor = sumMinor(data.instalments.map((i) => i.paidMinor));
  if (paidMinor > totalMinor) {
    throw errors.validation([{ path: 'instalments', message: 'More has been paid than the plan is worth; refund the excess instead' }]);
  }
  const settled = data.instalments
    .filter((i) => i.paidMinor > 0)
    .map((i, index) => ({ number: index + 1, dueDate: i.dueDate, amountMinor: i.paidMinor, originalAmountMinor: i.amountMinor }));
  const outstandingMinor = totalMinor - paidMinor;
  if (outstandingMinor === 0) {
    return { totalMinor, paidMinor, outstandingMinor, settled, rescheduled: [], instalments: settled.map(stripOriginal) };
  }
  const plan = splitInstalments({
    totalMinor: outstandingMinor,
    count: data.count,
    schedule: data.schedule,
    firstAmountMinor: data.firstAmountMinor,
    roundingUnitMinor: data.roundingUnitMinor,
    remainderOn: data.remainderOn,
  });
  const rescheduled = plan.instalments.map((i) => ({ ...i, number: settled.length + i.number }));
  return {
    totalMinor,
    paidMinor,
    outstandingMinor,
    settled,
    rescheduled,
    instalments: [...settled.map(stripOriginal), ...rescheduled],
  };
}

/** @param {Instalment & { originalAmountMinor: number }} i @returns {Instalment} */
const stripOriginal = ({ originalAmountMinor, ...rest }) => rest;
