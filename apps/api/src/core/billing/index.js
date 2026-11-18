/**
 * Billing engine: GST maths, GSTIN checks, document numbering, instalments, proration, discount
 * approval, amounts in words and credit notes. Pure functions only; see docs/platform/BILLING_CORE.md.
 */
export * from './gstin.js';
export * from './gst.js';
export * from './invoiceNumber.js';
export * from './instalments.js';
export * from './proration.js';
export * from './discounts.js';
export * from './amountInWords.js';
export * from './creditNote.js';
export {
  BP,
  allocateProportionally,
  assertMinor,
  mulDivFloor,
  mulDivRound,
  quantityToMilli,
  roundToUnit,
  sumMinor,
} from './money.js';
export {
  DEFAULT_TIME_ZONE,
  addDays,
  addMonths,
  compareDates,
  daysBetween,
  daysInMonth,
  isCalendarDate,
  localDate,
  toCalendarDate,
  zonedDateTimeToInstant,
} from './dates.js';
