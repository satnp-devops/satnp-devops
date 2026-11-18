/**
 * GST maths for invoices: taxable value per line, CGST + SGST/UTGST for intra-state supplies,
 * IGST for inter-state supplies, zero-rated exports and SEZ supplies (with or without a Letter of
 * Undertaking), totals, rate and SAC summaries and the optional rupee round-off.
 *
 * Rounding: tax is worked out per line and rounded to the paisa (half away from zero), then
 * summed. The invoice total can optionally be rounded to the nearest rupee, shown as a separate
 * "Round off" line. Pure: no I/O, the same input always gives the same result.
 */
import { z } from 'zod';
import { errors } from '../../lib/errors.js';
import { parseOrThrow } from '../../lib/validate.js';
import { BP, mulDivRound, quantityToMilli, roundToUnit, sumMinor } from './money.js';
import { OUTSIDE_INDIA_CODE, isValidStateCode, normaliseStateCode, stateByCode, validateGstin } from './gstin.js';

/** GST rates in use (basis points). Others are allowed but produce a warning. */
export const STANDARD_RATES_BP = Object.freeze([0, 10, 25, 100, 150, 300, 500, 600, 1200, 1800, 2800, 4000]);

/** taxable (including 0%), nil_rated, exempt, or non_gst (outside GST altogether). */
export const TAXABILITY = /** @type {const} */ (['taxable', 'nil_rated', 'exempt', 'non_gst']);

export const SUPPLY_TYPES = Object.freeze({
  INTRA_STATE: 'intra_state',
  INTER_STATE: 'inter_state',
  EXPORT_WITH_IGST: 'export_with_igst',
  EXPORT_UNDER_LUT: 'export_under_lut',
  SEZ_WITH_IGST: 'sez_with_igst',
  SEZ_UNDER_LUT: 'sez_under_lut',
});

/** Endorsements required on export and SEZ invoices (CGST Rules, rule 46, proviso). */
export const ENDORSEMENTS = Object.freeze({
  withIgst:
    'SUPPLY MEANT FOR EXPORT/SUPPLY TO SEZ UNIT OR SEZ DEVELOPER FOR AUTHORISED OPERATIONS ON PAYMENT OF INTEGRATED TAX',
  underLut:
    'SUPPLY MEANT FOR EXPORT/SUPPLY TO SEZ UNIT OR SEZ DEVELOPER FOR AUTHORISED OPERATIONS UNDER BOND OR LETTER OF UNDERTAKING WITHOUT PAYMENT OF INTEGRATED TAX',
});

const stateCodeInput = z.union([z.string(), z.number()]).transform((value, ctx) => {
  const code = normaliseStateCode(value);
  if (!code) {
    ctx.addIssue({ code: 'custom', message: 'Enter a two-digit GST state code' });
    return z.NEVER;
  }
  return code;
});

const lineSchema = z
  .object({
    id: z.string().max(100).optional(),
    description: z.string().max(500).optional(),
    sac: z
      .string()
      .regex(/^\d{4}(\d{2}){0,2}$/, 'Enter a 4, 6 or 8 digit SAC or HSN code')
      .optional(),
    quantity: z.number().positive().max(1e9).default(1),
    unitPriceMinor: z.number().int().nonnegative().optional(),
    amountMinor: z.number().int().nonnegative().optional(),
    discountMinor: z.number().int().nonnegative().default(0),
    taxRateBp: z.number().int().min(0).max(BP).default(0),
    taxability: z.enum(TAXABILITY).default('taxable'),
    priceIncludesTax: z.boolean().default(false),
  })
  .superRefine((line, ctx) => {
    if ((line.unitPriceMinor === undefined) === (line.amountMinor === undefined)) {
      ctx.addIssue({ code: 'custom', path: ['amountMinor'], message: 'Give either unitPriceMinor or amountMinor' });
    }
    if (Math.abs(Math.round(line.quantity * 1000) - line.quantity * 1000) > 1e-6) {
      ctx.addIssue({ code: 'custom', path: ['quantity'], message: 'Quantity can have at most three decimals' });
    }
    if (line.taxability !== 'taxable' && line.taxRateBp !== 0) {
      ctx.addIssue({ code: 'custom', path: ['taxRateBp'], message: `A ${line.taxability} line has no tax rate` });
    }
  });

const zeroRatedOption = z.object({ lut: z.boolean() }).nullable().optional();

export const computeTaxInputSchema = z.object({
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .default('INR'),
  lines: z.array(lineSchema).min(1).max(1000),
  supplierStateCode: stateCodeInput,
  placeOfSupplyStateCode: stateCodeInput.nullable().optional(),
  exportOfService: zeroRatedOption,
  supplyToSez: zeroRatedOption,
  supplierGstin: z.string().optional(),
  roundOff: z.boolean().default(false),
});

/**
 * @typedef {'cgst_sgst' | 'igst' | 'none'} TaxKind
 * @typedef {object} Supply
 * @property {string} supplyType one of SUPPLY_TYPES
 * @property {TaxKind} taxKind
 * @property {'SGST' | 'UTGST' | null} stateTaxLabel label for the state part of an intra-state supply
 * @property {boolean} zeroRated
 * @property {boolean} lut
 * @property {string} placeOfSupplyStateCode "96" for exports
 * @property {string | null} endorsement text the invoice must carry
 */

const invalid = (path, message) => errors.validation([{ path, message }]);

/**
 * Decide how a supply is taxed.
 *  - export of services: zero-rated; under LUT no tax, otherwise IGST (IGST Act s.16)
 *  - supply to an SEZ unit/developer: zero-rated and always inter-state, even inside one state
 *  - supplier and place of supply in the same state/UT: CGST + SGST (or UTGST)
 *  - otherwise: IGST
 * @param {{ supplierStateCode: string, placeOfSupplyStateCode?: string | null,
 *   exportOfService?: { lut: boolean } | null, supplyToSez?: { lut: boolean } | null }} input
 * @returns {Supply}
 */
export function determineSupply({ supplierStateCode, placeOfSupplyStateCode, exportOfService, supplyToSez }) {
  const supplier = normaliseStateCode(supplierStateCode);
  if (!supplier || !isValidStateCode(supplier)) throw invalid('supplierStateCode', 'Unknown GST state code');
  const pos = placeOfSupplyStateCode == null ? null : normaliseStateCode(placeOfSupplyStateCode);
  if (exportOfService && supplyToSez) {
    throw invalid('supplyToSez', 'A supply is either an export or a supply to an SEZ, not both');
  }
  if (exportOfService) {
    if (pos !== null && pos !== OUTSIDE_INDIA_CODE) {
      throw invalid('placeOfSupplyStateCode', 'An export of services has its place of supply outside India (code 96)');
    }
    const lut = exportOfService.lut;
    return {
      supplyType: lut ? SUPPLY_TYPES.EXPORT_UNDER_LUT : SUPPLY_TYPES.EXPORT_WITH_IGST,
      taxKind: lut ? 'none' : 'igst',
      stateTaxLabel: null,
      zeroRated: true,
      lut,
      placeOfSupplyStateCode: OUTSIDE_INDIA_CODE,
      endorsement: lut ? ENDORSEMENTS.underLut : ENDORSEMENTS.withIgst,
    };
  }
  if (pos === null) throw invalid('placeOfSupplyStateCode', 'Place of supply is required');
  if (pos === OUTSIDE_INDIA_CODE) {
    throw invalid('placeOfSupplyStateCode', 'Place of supply is outside India: mark the supply as an export of services');
  }
  if (!isValidStateCode(pos)) throw invalid('placeOfSupplyStateCode', 'Unknown GST state code');
  if (supplyToSez) {
    const lut = supplyToSez.lut;
    return {
      supplyType: lut ? SUPPLY_TYPES.SEZ_UNDER_LUT : SUPPLY_TYPES.SEZ_WITH_IGST,
      taxKind: lut ? 'none' : 'igst',
      stateTaxLabel: null,
      zeroRated: true,
      lut,
      placeOfSupplyStateCode: pos,
      endorsement: lut ? ENDORSEMENTS.underLut : ENDORSEMENTS.withIgst,
    };
  }
  if (pos === supplier) {
    return {
      supplyType: SUPPLY_TYPES.INTRA_STATE,
      taxKind: 'cgst_sgst',
      stateTaxLabel: /** @type {'SGST' | 'UTGST'} */ (stateByCode(pos)?.localTax ?? 'SGST'),
      zeroRated: false,
      lut: false,
      placeOfSupplyStateCode: pos,
      endorsement: null,
    };
  }
  return {
    supplyType: SUPPLY_TYPES.INTER_STATE,
    taxKind: 'igst',
    stateTaxLabel: null,
    zeroRated: false,
    lut: false,
    placeOfSupplyStateCode: pos,
    endorsement: null,
  };
}

/**
 * Place of supply for services under the default rule (IGST Act s.12(2)): a registered recipient's
 * location (its GSTIN state); an unregistered recipient's address when on record; otherwise the
 * supplier's location. Callers handle the special rules (e.g. training to unregistered persons).
 * @param {{ supplierStateCode: string, recipientGstin?: string | null, recipientStateCode?: string | null,
 *   recipientOutsideIndia?: boolean }} input
 * @returns {{ placeOfSupplyStateCode: string, source: 'outside_india' | 'recipient_gstin' | 'recipient_address' | 'supplier_location' }}
 */
export function defaultPlaceOfSupply({ supplierStateCode, recipientGstin, recipientStateCode, recipientOutsideIndia }) {
  if (recipientOutsideIndia) return { placeOfSupplyStateCode: OUTSIDE_INDIA_CODE, source: 'outside_india' };
  if (recipientGstin) {
    const check = validateGstin(recipientGstin, { allowSpecial: true });
    if (!check.valid) throw invalid('recipientGstin', check.message ?? 'Enter a valid GSTIN');
    return { placeOfSupplyStateCode: /** @type {string} */ (check.stateCode), source: 'recipient_gstin' };
  }
  const address = recipientStateCode == null ? null : normaliseStateCode(recipientStateCode);
  if (address && isValidStateCode(address)) return { placeOfSupplyStateCode: address, source: 'recipient_address' };
  const supplier = normaliseStateCode(supplierStateCode);
  if (!supplier || !isValidStateCode(supplier)) throw invalid('supplierStateCode', 'Unknown GST state code');
  return { placeOfSupplyStateCode: supplier, source: 'supplier_location' };
}

/**
 * @typedef {object} TaxComponents
 * @property {number} cgstMinor
 * @property {number} sgstMinor SGST or UTGST
 * @property {number} igstMinor
 */

/**
 * Tax on a taxable value, each component rounded to the paisa. CGST and SGST are each half the
 * rate and are always equal.
 * @param {number} taxableMinor
 * @param {number} rateBp
 * @param {TaxKind} taxKind
 * @returns {TaxComponents}
 */
export function taxOnTaxableValue(taxableMinor, rateBp, taxKind) {
  if (taxKind === 'cgst_sgst') {
    const half = mulDivRound(taxableMinor, rateBp, 2 * BP);
    return { cgstMinor: half, sgstMinor: half, igstMinor: 0 };
  }
  if (taxKind === 'igst') return { cgstMinor: 0, sgstMinor: 0, igstMinor: mulDivRound(taxableMinor, rateBp, BP) };
  return { cgstMinor: 0, sgstMinor: 0, igstMinor: 0 };
}

/** @param {TaxComponents} c */
export const taxTotal = (c) => c.cgstMinor + c.sgstMinor + c.igstMinor;

/**
 * Split a tax-inclusive amount into taxable value and tax so that they add back to the amount
 * exactly: taxable ≈ amount × 100 / (100 + rate), tax from that, and the taxable value absorbs the
 * last paisa. CGST and SGST stay equal.
 * @param {number} inclusiveMinor
 * @param {number} rateBp
 * @param {TaxKind} taxKind
 * @returns {TaxComponents & { taxableValueMinor: number }}
 */
export function splitInclusiveAmount(inclusiveMinor, rateBp, taxKind) {
  if (rateBp === 0 || taxKind === 'none') {
    return { taxableValueMinor: inclusiveMinor, cgstMinor: 0, sgstMinor: 0, igstMinor: 0 };
  }
  const base = mulDivRound(inclusiveMinor, BP, BP + rateBp);
  const components = taxOnTaxableValue(base, rateBp, taxKind);
  return { taxableValueMinor: inclusiveMinor - taxTotal(components), ...components };
}

/**
 * @typedef {object} TaxLine
 * @property {number} index position in the input
 * @property {string} [id]
 * @property {string} [description]
 * @property {string} [sac]
 * @property {number} quantity
 * @property {number} [unitPriceMinor]
 * @property {boolean} priceIncludesTax
 * @property {number} grossMinor quantity × unit price (or the amount given)
 * @property {number} discountMinor
 * @property {'taxable' | 'nil_rated' | 'exempt' | 'non_gst'} taxability a taxable line at 0% is reported as nil_rated
 * @property {number} taxRateBp the line's GST rate
 * @property {number} appliedRateBp the rate actually charged (0 under LUT or when not taxable)
 * @property {number} cgstRateBp
 * @property {number} sgstRateBp
 * @property {number} igstRateBp
 * @property {number} taxableValueMinor
 * @property {number} cgstMinor
 * @property {number} sgstMinor
 * @property {number} igstMinor
 * @property {number} taxMinor
 * @property {number} totalMinor
 */

/**
 * @param {z.infer<typeof lineSchema>} line
 * @param {number} index
 * @param {Supply} supply
 * @returns {TaxLine}
 */
function computeLine(line, index, supply) {
  const gross = line.amountMinor ?? mulDivRound(quantityToMilli(line.quantity), /** @type {number} */ (line.unitPriceMinor), 1000);
  if (line.discountMinor > gross) throw invalid(`lines.${index}.discountMinor`, 'Discount is more than the line amount');
  const net = gross - line.discountMinor;
  const taxability = line.taxability === 'taxable' && line.taxRateBp === 0 ? 'nil_rated' : line.taxability;
  const appliedRateBp = taxability === 'taxable' && supply.taxKind !== 'none' ? line.taxRateBp : 0;
  const parts = line.priceIncludesTax
    ? splitInclusiveAmount(net, appliedRateBp, supply.taxKind)
    : { taxableValueMinor: net, ...taxOnTaxableValue(net, appliedRateBp, supply.taxKind) };
  const taxMinor = taxTotal(parts);
  const intra = supply.taxKind === 'cgst_sgst';
  return {
    index,
    ...(line.id !== undefined && { id: line.id }),
    ...(line.description !== undefined && { description: line.description }),
    ...(line.sac !== undefined && { sac: line.sac }),
    quantity: line.quantity,
    ...(line.unitPriceMinor !== undefined && { unitPriceMinor: line.unitPriceMinor }),
    priceIncludesTax: line.priceIncludesTax,
    grossMinor: gross,
    discountMinor: line.discountMinor,
    taxability,
    taxRateBp: line.taxRateBp,
    appliedRateBp,
    cgstRateBp: intra ? appliedRateBp / 2 : 0,
    sgstRateBp: intra ? appliedRateBp / 2 : 0,
    igstRateBp: supply.taxKind === 'igst' ? appliedRateBp : 0,
    taxableValueMinor: parts.taxableValueMinor,
    cgstMinor: parts.cgstMinor,
    sgstMinor: parts.sgstMinor,
    igstMinor: parts.igstMinor,
    taxMinor,
    totalMinor: parts.taxableValueMinor + taxMinor,
  };
}

/**
 * @typedef {object} TaxTotals
 * @property {number} grossMinor
 * @property {number} discountMinor
 * @property {number} assessableValueMinor taxable value of every line (the e-invoice AssVal)
 * @property {number} taxableValueMinor value of taxable lines, including zero-rated ones
 * @property {number} zeroRatedValueMinor value of taxable lines on an export/SEZ supply
 * @property {number} nilRatedValueMinor
 * @property {number} exemptValueMinor
 * @property {number} nonGstValueMinor
 * @property {number} cgstMinor
 * @property {number} sgstMinor
 * @property {number} igstMinor
 * @property {number} taxMinor
 * @property {number} totalBeforeRoundOffMinor
 * @property {number} roundOffMinor between -49 and +50 paise (0 when round-off is off)
 * @property {number} grandTotalMinor
 */

/**
 * Add up computed lines. Shared by invoices and credit notes.
 * @param {Array<Pick<TaxLine, 'grossMinor' | 'discountMinor' | 'taxability' | 'taxableValueMinor' | 'cgstMinor' | 'sgstMinor' | 'igstMinor' | 'taxMinor' | 'totalMinor'>>} lines
 * @param {{ zeroRated: boolean, roundOff: boolean }} options
 * @returns {TaxTotals}
 */
export function sumTaxLines(lines, { zeroRated, roundOff }) {
  const total = (pick, filter = () => true) => sumMinor(lines.filter(filter).map(pick));
  const taxable = total((l) => l.taxableValueMinor, (l) => l.taxability === 'taxable');
  const totalBeforeRoundOffMinor = total((l) => l.totalMinor);
  const grandTotalMinor = roundOff ? roundToUnit(totalBeforeRoundOffMinor, 100) : totalBeforeRoundOffMinor;
  return {
    grossMinor: total((l) => l.grossMinor),
    discountMinor: total((l) => l.discountMinor),
    assessableValueMinor: total((l) => l.taxableValueMinor),
    taxableValueMinor: taxable,
    zeroRatedValueMinor: zeroRated ? taxable : 0,
    nilRatedValueMinor: total((l) => l.taxableValueMinor, (l) => l.taxability === 'nil_rated'),
    exemptValueMinor: total((l) => l.taxableValueMinor, (l) => l.taxability === 'exempt'),
    nonGstValueMinor: total((l) => l.taxableValueMinor, (l) => l.taxability === 'non_gst'),
    cgstMinor: total((l) => l.cgstMinor),
    sgstMinor: total((l) => l.sgstMinor),
    igstMinor: total((l) => l.igstMinor),
    taxMinor: total((l) => l.taxMinor),
    totalBeforeRoundOffMinor,
    roundOffMinor: grandTotalMinor - totalBeforeRoundOffMinor,
    grandTotalMinor,
  };
}

/**
 * Group taxable lines by rate (and by SAC for the HSN/SAC summary GSTR-1 asks for).
 * @param {TaxLine[]} lines
 * @param {(line: TaxLine) => string} keyOf
 */
function summarise(lines, keyOf) {
  /** @type {Map<string, any>} */
  const groups = new Map();
  for (const line of lines) {
    const key = keyOf(line);
    const group = groups.get(key) ?? {
      ...(line.sac !== undefined && { sac: line.sac }),
      taxability: line.taxability,
      taxRateBp: line.taxRateBp,
      appliedRateBp: line.appliedRateBp,
      quantity: 0,
      taxableValueMinor: 0,
      cgstMinor: 0,
      sgstMinor: 0,
      igstMinor: 0,
      taxMinor: 0,
      totalMinor: 0,
    };
    group.quantity = Math.round((group.quantity + line.quantity) * 1000) / 1000;
    for (const field of ['taxableValueMinor', 'cgstMinor', 'sgstMinor', 'igstMinor', 'taxMinor', 'totalMinor']) {
      group[field] += line[field];
    }
    groups.set(key, group);
  }
  return [...groups.values()];
}

/**
 * Compute the GST on an invoice.
 * @param {z.input<typeof computeTaxInputSchema>} input
 */
export function computeTax(input) {
  const data = parseOrThrow(computeTaxInputSchema, input);
  if (data.supplierGstin !== undefined) {
    const check = validateGstin(data.supplierGstin, { allowSpecial: true });
    if (!check.valid) throw invalid('supplierGstin', check.message ?? 'Enter a valid GSTIN');
    if (check.stateCode !== data.supplierStateCode) {
      throw invalid('supplierStateCode', `The supplier GSTIN is registered in state ${check.stateCode}`);
    }
  }
  const supply = determineSupply(data);
  const lines = data.lines.map((line, index) => computeLine(line, index, supply));

  /** @type {Array<{ code: string, line?: number, message: string }>} */
  const warnings = [];
  lines.forEach((line) => {
    if (line.taxability === 'taxable' && !STANDARD_RATES_BP.includes(line.taxRateBp)) {
      warnings.push({ code: 'unusual_rate', line: line.index, message: `${line.taxRateBp / 100}% is not a standard GST rate` });
    }
    if (line.taxability !== 'non_gst' && line.sac === undefined) {
      warnings.push({ code: 'missing_sac', line: line.index, message: 'Invoices must show the HSN/SAC code' });
    }
  });

  const taxableLines = lines.filter((l) => l.taxability === 'taxable');
  const hasExempt = lines.some((l) => l.taxability !== 'taxable');
  return {
    currency: data.currency,
    supplierStateCode: data.supplierStateCode,
    placeOfSupplyStateCode: supply.placeOfSupplyStateCode,
    placeOfSupplyName: supply.placeOfSupplyStateCode === OUTSIDE_INDIA_CODE ? 'Outside India' : (stateByCode(supply.placeOfSupplyStateCode)?.name ?? null),
    supplyType: supply.supplyType,
    taxKind: supply.taxKind,
    stateTaxLabel: supply.stateTaxLabel,
    zeroRated: supply.zeroRated,
    lut: supply.lut,
    endorsement: supply.endorsement,
    /** Rule 49: only exempt / nil / non-GST lines → bill of supply; rule 46A allows one combined document. */
    documentType: taxableLines.length > 0 ? 'tax_invoice' : 'bill_of_supply',
    mixedTaxableAndExempt: taxableLines.length > 0 && hasExempt,
    roundOff: data.roundOff,
    lines,
    rateSummary: summarise(taxableLines, (l) => `${l.taxRateBp}|${l.appliedRateBp}`).map(({ sac, ...rest }) => rest),
    sacSummary: summarise(lines, (l) => `${l.sac ?? ''}|${l.taxability}|${l.taxRateBp}|${l.appliedRateBp}`),
    totals: sumTaxLines(lines, { zeroRated: supply.zeroRated, roundOff: data.roundOff }),
    warnings,
  };
}
