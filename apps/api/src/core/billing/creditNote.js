/**
 * Credit notes against an issued invoice (CGST Act s.34, CGST Rules 53(1A)): full and partial
 * refunds, quantity returns, post-supply discounts.
 *
 * A credit note reverses tax on the original invoice's terms: same supply type, place of supply
 * and rates, so it starts from the computeTax input the invoice was issued with. Earlier credit
 * notes are passed in so cumulative credits can never exceed the invoice, and the credit that
 * closes a line takes exactly what is left (no paisa drift across several partial refunds).
 */
import { z } from 'zod';
import { errors } from '../../lib/errors.js';
import { parseOrThrow } from '../../lib/validate.js';
import { compareDates, isCalendarDate } from './dates.js';
import { computeTax, splitInclusiveAmount, sumTaxLines, taxOnTaxableValue, taxTotal } from './gst.js';
import { financialYear } from './invoiceNumber.js';
import { allocateProportionally, mulDivRound, quantityToMilli, sumMinor } from './money.js';

export const CREDIT_NOTE_REASONS = /** @type {const} */ ([
  'refund',
  'cancellation',
  'post_supply_discount',
  'deficiency',
  'excess_value',
  'excess_tax',
  'other',
]);

const COMPONENTS = /** @type {const} */ (['taxableValueMinor', 'cgstMinor', 'sgstMinor', 'igstMinor']);

const creditLineSchema = z
  .object({
    line: z.number().int().nonnegative(),
    quantity: z.number().positive().optional(),
    /** Tax-exclusive value to credit. */
    taxableValueMinor: z.number().int().positive().optional(),
    /** Tax-inclusive amount to give back. */
    amountMinor: z.number().int().positive().optional(),
  })
  .refine((l) => [l.quantity, l.taxableValueMinor, l.amountMinor].filter((v) => v !== undefined).length === 1, {
    message: 'Give one of quantity, taxableValueMinor or amountMinor',
  });

const previousLineSchema = z
  .object({
    line: z.number().int().nonnegative(),
    quantity: z.number().nonnegative().nullable().optional(),
    taxableValueMinor: z.number().int().nonnegative(),
    cgstMinor: z.number().int().nonnegative(),
    sgstMinor: z.number().int().nonnegative(),
    igstMinor: z.number().int().nonnegative(),
  })
  .passthrough();

export const creditNoteInputSchema = z.object({
  invoice: z.record(z.string(), z.unknown()),
  mode: z.enum(['full', 'partial']),
  lines: z.array(creditLineSchema).min(1).optional(),
  refundAmountMinor: z.number().int().positive().optional(),
  previousCredits: z.array(z.object({ lines: z.array(previousLineSchema).max(1000) }).passthrough()).max(500).default([]),
  roundOff: z.boolean().optional(),
  reason: z.enum(CREDIT_NOTE_REASONS).default('refund'),
  against: z.object({ number: z.string(), date: z.string().refine(isCalendarDate) }).optional(),
});

/**
 * @typedef {{ taxableValueMinor: number, cgstMinor: number, sgstMinor: number, igstMinor: number }} Parts
 */

const zeroParts = () => ({ taxableValueMinor: 0, cgstMinor: 0, sgstMinor: 0, igstMinor: 0 });
/** @param {Parts} p */
const partsTotal = (p) => p.taxableValueMinor + taxTotal(p);

/**
 * Keep a credit within what is left on the line. Tax components are capped first; if the
 * taxable value then overflows, the excess moves into tax components that still have room
 * (the total stays the same, which the inclusive-amount mode needs).
 * @param {Parts} credit
 * @param {Parts} remaining
 * @returns {Parts}
 */
function clamp(credit, remaining) {
  const out = { ...credit };
  let overflow = 0;
  for (const key of ['cgstMinor', 'sgstMinor', 'igstMinor']) {
    if (out[key] > remaining[key]) {
      overflow += out[key] - remaining[key];
      out[key] = remaining[key];
    }
  }
  out.taxableValueMinor += overflow;
  if (out.taxableValueMinor > remaining.taxableValueMinor) {
    let excess = out.taxableValueMinor - remaining.taxableValueMinor;
    out.taxableValueMinor = remaining.taxableValueMinor;
    for (const key of ['cgstMinor', 'sgstMinor', 'igstMinor']) {
      const room = remaining[key] - out[key];
      const move = Math.min(room, excess);
      out[key] += move;
      excess -= move;
    }
    if (excess > 0) throw new RangeError('Credit is larger than what remains on the line');
  }
  return out;
}

/**
 * The last day a credit note can still reduce output tax for an invoice: 30 November after the
 * end of the invoice's financial year, or the date the annual return was filed if that is earlier
 * (CGST Act s.34(2)).
 * @param {string} invoiceDate YYYY-MM-DD
 * @param {{ annualReturnFiledOn?: string }} [options]
 * @returns {string}
 */
export function creditNoteTaxDeadline(invoiceDate, { annualReturnFiledOn } = {}) {
  const fy = financialYear(invoiceDate);
  const november = `${fy.endYear}-11-30`;
  if (annualReturnFiledOn && compareDates(annualReturnFiledOn, november) < 0) return annualReturnFiledOn;
  return november;
}

/**
 * Compute a credit note.
 * @param {z.input<typeof creditNoteInputSchema>} input
 */
export function computeCreditNote(input) {
  const data = parseOrThrow(creditNoteInputSchema, input);
  if (data.mode === 'full' && (data.lines || data.refundAmountMinor !== undefined)) {
    throw errors.validation([{ path: 'mode', message: 'A full credit note takes no lines or refund amount' }]);
  }
  if (data.mode === 'partial' && (data.lines === undefined) === (data.refundAmountMinor === undefined)) {
    throw errors.validation([{ path: 'lines', message: 'Give either lines or refundAmountMinor' }]);
  }
  const invoice = computeTax(/** @type {any} */ (data.invoice));
  const { taxKind } = invoice;

  // What earlier credit notes already took, per original line.
  const previous = invoice.lines.map(() => ({ ...zeroParts(), quantity: 0 }));
  for (const [n, note] of data.previousCredits.entries()) {
    for (const line of note.lines) {
      const slot = previous[line.line];
      if (!slot) throw errors.validation([{ path: `previousCredits.${n}`, message: `Invoice has no line ${line.line}` }]);
      for (const key of COMPONENTS) slot[key] += line[key];
      slot.quantity += line.quantity ?? 0;
    }
  }
  const remaining = invoice.lines.map((line, i) => {
    const left = { ...zeroParts(), quantity: Math.round((line.quantity - previous[i].quantity) * 1000) / 1000 };
    for (const key of COMPONENTS) {
      left[key] = line[key] - previous[i][key];
      if (left[key] < 0) throw errors.validation([{ path: 'previousCredits', message: `Earlier credits exceed line ${i} of the invoice` }]);
    }
    return left;
  });
  const remainingTotal = sumMinor(remaining.map(partsTotal));
  if (remainingTotal === 0) throw errors.validation([{ path: 'invoice', message: 'The invoice has already been fully credited' }]);

  /** @type {Map<number, Parts & { quantity: number | null }>} */
  const credits = new Map();
  const takeAll = (i) => credits.set(i, { ...pick(remaining[i]), quantity: remaining[i].quantity > 0 ? remaining[i].quantity : null });

  /** Credit a tax-inclusive amount on line i. */
  const creditAmount = (i, amount, path) => {
    const left = remaining[i];
    if (amount > partsTotal(left)) throw errors.validation([{ path, message: `Only ${partsTotal(left)} is left to credit on line ${i}` }]);
    if (amount === partsTotal(left)) return takeAll(i);
    const split = splitInclusiveAmount(amount, invoice.lines[i].appliedRateBp, taxKind);
    credits.set(i, { ...clamp(split, left), quantity: null });
  };

  if (data.mode === 'full') {
    remaining.forEach((left, i) => partsTotal(left) > 0 && takeAll(i));
  } else if (data.refundAmountMinor !== undefined) {
    if (data.refundAmountMinor > remainingTotal) {
      throw errors.validation([{ path: 'refundAmountMinor', message: `Only ${remainingTotal} is left to credit on this invoice` }]);
    }
    const shares = allocateProportionally(data.refundAmountMinor, remaining.map(partsTotal));
    shares.forEach((share, i) => share > 0 && creditAmount(i, share, 'refundAmountMinor'));
  } else {
    for (const [n, request] of /** @type {NonNullable<typeof data.lines>} */ (data.lines).entries()) {
      const path = `lines.${n}`;
      const i = request.line;
      const original = invoice.lines[i];
      if (!original) throw errors.validation([{ path: `${path}.line`, message: `Invoice has no line ${i}` }]);
      if (credits.has(i)) throw errors.validation([{ path: `${path}.line`, message: 'Credit each line once per note' }]);
      const left = remaining[i];
      if (request.quantity !== undefined) {
        const q = quantityToMilli(request.quantity);
        const leftQ = quantityToMilli(left.quantity);
        if (q > leftQ) throw errors.validation([{ path: `${path}.quantity`, message: `Only ${left.quantity} left to credit` }]);
        if (q === leftQ) {
          takeAll(i);
          continue;
        }
        const totalQ = quantityToMilli(original.quantity);
        /** @type {Parts} */
        const share = zeroParts();
        for (const key of COMPONENTS) share[key] = mulDivRound(original[key], q, totalQ);
        if (partsTotal(share) > partsTotal(left)) {
          throw errors.validation([
            { path: `${path}.quantity`, message: `Earlier credits leave only ${partsTotal(left)} on line ${i}; credit an amount instead` },
          ]);
        }
        credits.set(i, { ...clamp(share, left), quantity: request.quantity });
      } else if (request.taxableValueMinor !== undefined) {
        const t = request.taxableValueMinor;
        if (t > left.taxableValueMinor) {
          throw errors.validation([{ path: `${path}.taxableValueMinor`, message: `Only ${left.taxableValueMinor} of taxable value is left` }]);
        }
        if (t === left.taxableValueMinor) {
          takeAll(i);
          continue;
        }
        const tax = taxOnTaxableValue(t, original.appliedRateBp, taxKind);
        const capped = { taxableValueMinor: t, ...tax };
        for (const key of ['cgstMinor', 'sgstMinor', 'igstMinor']) capped[key] = Math.min(capped[key], left[key]);
        credits.set(i, { ...capped, quantity: null });
      } else {
        creditAmount(i, /** @type {number} */ (request.amountMinor), `${path}.amountMinor`);
      }
    }
  }

  const lines = [...credits.entries()]
    .sort(([a], [b]) => a - b)
    .map(([i, credit]) => {
      const original = invoice.lines[i];
      const taxMinor = taxTotal(credit);
      return {
        line: i,
        ...(original.id !== undefined && { id: original.id }),
        ...(original.description !== undefined && { description: original.description }),
        ...(original.sac !== undefined && { sac: original.sac }),
        quantity: credit.quantity,
        taxability: original.taxability,
        taxRateBp: original.taxRateBp,
        appliedRateBp: original.appliedRateBp,
        cgstRateBp: original.cgstRateBp,
        sgstRateBp: original.sgstRateBp,
        igstRateBp: original.igstRateBp,
        grossMinor: credit.taxableValueMinor,
        discountMinor: 0,
        taxableValueMinor: credit.taxableValueMinor,
        cgstMinor: credit.cgstMinor,
        sgstMinor: credit.sgstMinor,
        igstMinor: credit.igstMinor,
        taxMinor,
        totalMinor: credit.taxableValueMinor + taxMinor,
      };
    });

  const after = remaining.map((left, i) => {
    const credit = credits.get(i);
    const out = { line: i, quantity: Math.round((left.quantity - (credit?.quantity ?? 0)) * 1000) / 1000, ...zeroParts() };
    if (credit && credit.quantity === null && partsTotal(credit) === partsTotal(left)) out.quantity = 0;
    for (const key of COMPONENTS) out[key] = left[key] - (credit?.[key] ?? 0);
    return { ...out, totalMinor: partsTotal(out) };
  });

  return {
    documentType: 'credit_note',
    mode: data.mode,
    reason: data.reason,
    ...(data.against && { against: data.against }),
    currency: invoice.currency,
    supplierStateCode: invoice.supplierStateCode,
    placeOfSupplyStateCode: invoice.placeOfSupplyStateCode,
    supplyType: invoice.supplyType,
    taxKind,
    stateTaxLabel: invoice.stateTaxLabel,
    zeroRated: invoice.zeroRated,
    lut: invoice.lut,
    lines,
    totals: sumTaxLines(lines, { zeroRated: invoice.zeroRated, roundOff: data.roundOff ?? invoice.roundOff }),
    remaining: after,
    fullyCredited: after.every((l) => l.totalMinor === 0),
  };
}

/** @param {Parts} p @returns {Parts} */
const pick = (p) => ({ taxableValueMinor: p.taxableValueMinor, cgstMinor: p.cgstMinor, sgstMinor: p.sgstMinor, igstMinor: p.igstMinor });
