import { allocateProportionally, computeTax, defaultPlaceOfSupply, OUTSIDE_INDIA_CODE } from '../../core/billing/index.js';
import { errors } from '../../lib/errors.js';

// Pure pricing: quote lines → the computeTax input and its totals; a payment amount → invoice lines.
// Every figure is integer minor units; computeTax does the GST maths (BILLING_CORE §2).

/**
 * @typedef {{ id: string, planId?: string | null, description: string, sac?: string | null, quantity: number,
 *   unitPriceMinor: number, discountMinor?: number, taxRateBp: number, taxability?: string }} QuoteLine
 * @typedef {{ gstin?: string | null, stateCode?: string | null, outsideIndia?: boolean, name?: string | null, sez?: boolean }} Recipient
 * @typedef {{ stateCode: string, gstin?: string | null, lutNumber?: string | null, lutValidUntil?: string | null, roundOff?: boolean }} Supplier
 */

/** True when the supplier holds a letter of undertaking valid on the date (exports without IGST). */
export function lutValid(supplier, onDate) {
  if (!supplier?.lutNumber) return false;
  return !supplier.lutValidUntil || supplier.lutValidUntil >= onDate;
}

/**
 * Build the computeTax input for lines sold by a supplier to a recipient.
 * @param {{ lines: QuoteLine[], pricesIncludeTax: boolean, supplier: Supplier, recipient: Recipient, currency: string, onDate: string }} input
 */
export function taxInputFor({ lines, pricesIncludeTax, supplier, recipient, currency, onDate }) {
  if (!lines.length) throw errors.validation([{ path: 'body.lines', message: 'Add at least one line' }]);
  const { placeOfSupplyStateCode } = defaultPlaceOfSupply({
    supplierStateCode: supplier.stateCode,
    recipientGstin: recipient?.gstin || undefined,
    recipientStateCode: recipient?.stateCode || undefined,
    recipientOutsideIndia: Boolean(recipient?.outsideIndia),
  });
  const exportOfService = placeOfSupplyStateCode === OUTSIDE_INDIA_CODE ? { lut: lutValid(supplier, onDate) } : undefined;
  const supplyToSez = !exportOfService && recipient?.sez ? { lut: lutValid(supplier, onDate) } : undefined;
  return {
    currency,
    lines: lines.map((line) => ({
      id: line.id,
      description: line.description,
      ...(line.sac ? { sac: line.sac } : {}),
      quantity: line.quantity,
      unitPriceMinor: line.unitPriceMinor,
      discountMinor: line.discountMinor ?? 0,
      taxRateBp: line.taxRateBp,
      taxability: line.taxability ?? 'taxable',
      priceIncludesTax: pricesIncludeTax,
    })),
    supplierStateCode: supplier.stateCode,
    placeOfSupplyStateCode,
    ...(exportOfService ? { exportOfService } : {}),
    ...(supplyToSez ? { supplyToSez } : {}),
    ...(supplier.gstin ? { supplierGstin: supplier.gstin } : {}),
    roundOff: Boolean(supplier.roundOff),
  };
}

/**
 * Price a quote: totals for the list, the discount (for the approval policy) and GST.
 * The list amount and discount are what the customer saw (tax-inclusive when the price list is).
 */
export function priceQuote(input) {
  const taxInput = taxInputFor(input);
  const result = computeTax(taxInput);
  return {
    taxInput,
    result,
    subtotalMinor: result.totals.grossMinor,
    discountMinor: result.totals.discountMinor,
    taxableMinor: result.totals.taxableValueMinor,
    taxMinor: result.totals.taxMinor,
    totalMinor: result.totals.grandTotalMinor,
  };
}

/** The parts of a computeTax result worth keeping on a quote or invoice (no inputs repeated). */
export function taxSummary(result) {
  return {
    supplyType: result.supplyType,
    taxKind: result.taxKind,
    stateTaxLabel: result.stateTaxLabel,
    documentType: result.documentType,
    placeOfSupplyStateCode: result.placeOfSupplyStateCode,
    placeOfSupplyName: result.placeOfSupplyName,
    zeroRated: result.zeroRated,
    endorsement: result.endorsement,
    warnings: result.warnings,
    lines: result.lines.map(presentTaxLine),
    totals: result.totals,
  };
}

export function presentTaxLine(line) {
  return {
    id: line.id ?? null,
    description: line.description ?? null,
    sac: line.sac ?? null,
    quantity: line.quantity,
    grossMinor: line.grossMinor,
    discountMinor: line.discountMinor,
    taxableValueMinor: line.taxableValueMinor,
    taxRateBp: line.appliedRateBp,
    taxability: line.taxability,
    cgstRateBp: line.cgst?.rateBp ?? line.cgstRateBp ?? 0,
    cgstMinor: line.cgst?.amountMinor ?? line.cgstMinor ?? 0,
    sgstRateBp: line.sgst?.rateBp ?? line.sgstRateBp ?? 0,
    sgstMinor: line.sgst?.amountMinor ?? line.sgstMinor ?? 0,
    igstRateBp: line.igst?.rateBp ?? line.igstRateBp ?? 0,
    igstMinor: line.igst?.amountMinor ?? line.igstMinor ?? 0,
    taxMinor: line.taxMinor,
    totalMinor: line.totalMinor,
  };
}

/**
 * Invoice lines for a payment against priced lines. A payment of the whole total invoices the lines
 * as they were priced. A part payment (an instalment) is spread over the lines in proportion to
 * each line's total, as tax-inclusive amounts at each line's rate, so the invoice totals exactly
 * what was paid and keeps the quote's SAC codes and rates. Pure.
 * @param {{ lines: QuoteLine[], pricedTotals: number[], totalMinor: number, amountMinor: number, label: string | null, pricesIncludeTax: boolean }} input
 * @returns {{ lines: QuoteLine[], pricesIncludeTax: boolean }}
 */
export function invoiceLinesForAmount({ lines, pricedTotals, totalMinor, amountMinor, label, pricesIncludeTax }) {
  if (amountMinor === totalMinor) return { lines, pricesIncludeTax };
  if (amountMinor > totalMinor) throw new RangeError('A payment cannot be more than what it pays for');
  const shares = allocateProportionally(amountMinor, pricedTotals);
  const out = [];
  lines.forEach((line, index) => {
    if (shares[index] === 0) return;
    out.push({
      id: line.id,
      planId: line.planId ?? null,
      description: label ? `${line.description} (${label})` : line.description,
      sac: line.sac ?? null,
      quantity: 1,
      unitPriceMinor: shares[index],
      discountMinor: 0,
      taxRateBp: line.taxRateBp,
      taxability: line.taxability ?? 'taxable',
    });
  });
  return { lines: out, pricesIncludeTax: true };
}

/** Sum a list of numbers that are minor units. */
export const total = (values) => values.reduce((sum, value) => sum + value, 0);
