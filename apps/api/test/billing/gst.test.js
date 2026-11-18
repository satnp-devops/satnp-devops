import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ENDORSEMENTS,
  SUPPLY_TYPES,
  computeTax,
  defaultPlaceOfSupply,
  determineSupply,
  splitInclusiveAmount,
  taxOnTaxableValue,
} from '../../src/core/billing/gst.js';
import { assertValidation, seededRandom } from './helpers.js';

const COACHING = '999293'; // commercial training and coaching services
const SOFTWARE = '997331'; // licensing services for the right to use computer software

const intra = (lines, extra = {}) => computeTax({ supplierStateCode: '27', placeOfSupplyStateCode: '27', lines, ...extra });
const inter = (lines, extra = {}) => computeTax({ supplierStateCode: '27', placeOfSupplyStateCode: '29', lines, ...extra });

test('intra-state supply splits 18% into CGST 9% + SGST 9%', () => {
  const result = intra([{ sac: COACHING, amountMinor: 1_000_000, taxRateBp: 1800 }]);
  assert.equal(result.supplyType, SUPPLY_TYPES.INTRA_STATE);
  assert.equal(result.taxKind, 'cgst_sgst');
  assert.equal(result.stateTaxLabel, 'SGST');
  const [line] = result.lines;
  assert.equal(line.taxableValueMinor, 1_000_000);
  assert.equal(line.cgstRateBp, 900);
  assert.equal(line.sgstRateBp, 900);
  assert.equal(line.igstRateBp, 0);
  assert.equal(line.cgstMinor, 90_000);
  assert.equal(line.sgstMinor, 90_000);
  assert.equal(line.igstMinor, 0);
  assert.equal(line.totalMinor, 1_180_000);
  assert.equal(result.totals.taxMinor, 180_000);
  assert.equal(result.totals.grandTotalMinor, 1_180_000);
  assert.equal(result.documentType, 'tax_invoice');
  assert.equal(result.endorsement, null);
  assert.equal(result.placeOfSupplyName, 'Maharashtra');
});

test('inter-state supply charges IGST at the full rate', () => {
  const result = inter([{ sac: SOFTWARE, amountMinor: 1_000_000, taxRateBp: 1800 }]);
  assert.equal(result.supplyType, SUPPLY_TYPES.INTER_STATE);
  assert.equal(result.taxKind, 'igst');
  assert.equal(result.stateTaxLabel, null);
  assert.equal(result.lines[0].igstMinor, 180_000);
  assert.equal(result.lines[0].igstRateBp, 1800);
  assert.equal(result.lines[0].cgstMinor + result.lines[0].sgstMinor, 0);
  assert.equal(result.totals.igstMinor, 180_000);
  assert.equal(result.placeOfSupplyName, 'Karnataka');
});

test('a supply inside a UT without a legislature is labelled UTGST', () => {
  const chandigarh = computeTax({ supplierStateCode: '04', placeOfSupplyStateCode: '04', lines: [{ sac: COACHING, amountMinor: 10_000, taxRateBp: 1800 }] });
  assert.equal(chandigarh.stateTaxLabel, 'UTGST');
  assert.equal(chandigarh.lines[0].sgstMinor, 900);
  const delhi = computeTax({ supplierStateCode: 7, placeOfSupplyStateCode: '07', lines: [{ sac: COACHING, amountMinor: 10_000, taxRateBp: 1800 }] });
  assert.equal(delhi.stateTaxLabel, 'SGST');
  assert.equal(delhi.supplierStateCode, '07');
});

test('each tax component is rounded to the paisa, half up, per line', () => {
  // 50 paise × 9% = 4.5 paise → 5 for CGST and 5 for SGST; IGST 50 × 18% = 9 exactly.
  const half = intra([{ sac: COACHING, amountMinor: 50, taxRateBp: 1800 }]).lines[0];
  assert.deepEqual([half.cgstMinor, half.sgstMinor, half.taxMinor], [5, 5, 10]);
  assert.equal(inter([{ sac: COACHING, amountMinor: 50, taxRateBp: 1800 }]).lines[0].igstMinor, 9);
  // 25 paise × 18% = 4.5 → 5 IGST; × 9% = 2.25 → 2 each side.
  assert.equal(inter([{ sac: COACHING, amountMinor: 25, taxRateBp: 1800 }]).lines[0].igstMinor, 5);
  assert.equal(intra([{ sac: COACHING, amountMinor: 25, taxRateBp: 1800 }]).lines[0].cgstMinor, 2);
  // 999 × 18% = 179.82 → 180.
  assert.equal(inter([{ sac: COACHING, amountMinor: 999, taxRateBp: 1800 }]).lines[0].igstMinor, 180);
});

test('tax is summed from rounded lines, not recomputed on the invoice total', () => {
  const result = intra([
    { sac: COACHING, amountMinor: 50, taxRateBp: 1800 },
    { sac: COACHING, amountMinor: 50, taxRateBp: 1800 },
  ]);
  assert.equal(result.totals.cgstMinor, 10, 'two lines of 5 paise, not round(100 × 9%) = 9');
  assert.equal(result.rateSummary.length, 1);
  assert.equal(result.rateSummary[0].cgstMinor, 10);
});

test('odd basis-point rates split evenly between CGST and SGST', () => {
  // 0.25% → 0.125% each side; 1,00,000 rupees × 0.125% = 125 rupees.
  const line = intra([{ sac: '711311', amountMinor: 10_000_000, taxRateBp: 25 }]).lines[0];
  assert.equal(line.cgstRateBp, 12.5);
  assert.equal(line.cgstMinor, 12_500);
  assert.equal(line.sgstMinor, 12_500);
});

test('quantity × unit price, with up to three decimals', () => {
  const lines = inter([
    { sac: SOFTWARE, quantity: 3, unitPriceMinor: 99_900, taxRateBp: 1800 },
    { sac: SOFTWARE, quantity: 1.5, unitPriceMinor: 333, taxRateBp: 1800 },
  ]).lines;
  assert.equal(lines[0].grossMinor, 299_700);
  assert.equal(lines[0].igstMinor, 53_946);
  assert.equal(lines[1].grossMinor, 500, '1.5 × 333 = 499.5 → 500');
  assertValidation(() => inter([{ sac: SOFTWARE, quantity: 1.0005, unitPriceMinor: 100, taxRateBp: 1800 }]), 'lines.0.quantity');
  assertValidation(() => inter([{ sac: SOFTWARE, quantity: 0, unitPriceMinor: 100, taxRateBp: 1800 }]), 'lines.0.quantity');
});

test('a line takes either an amount or a unit price', () => {
  assertValidation(() => inter([{ sac: SOFTWARE, taxRateBp: 1800 }]), 'lines.0.amountMinor');
  assertValidation(() => inter([{ sac: SOFTWARE, amountMinor: 100, unitPriceMinor: 100, taxRateBp: 1800 }]), 'lines.0.amountMinor');
  assertValidation(() => inter([{ sac: SOFTWARE, amountMinor: 10.5, taxRateBp: 1800 }]), 'lines.0.amountMinor');
  assertValidation(() => inter([{ sac: SOFTWARE, amountMinor: -1, taxRateBp: 1800 }]), 'lines.0.amountMinor');
  assertValidation(() => inter([]), 'lines');
});

test('discounts reduce the taxable value', () => {
  const line = intra([{ sac: COACHING, amountMinor: 100_000, discountMinor: 10_000, taxRateBp: 1800 }]).lines[0];
  assert.equal(line.grossMinor, 100_000);
  assert.equal(line.discountMinor, 10_000);
  assert.equal(line.taxableValueMinor, 90_000);
  assert.equal(line.taxMinor, 16_200);
  assert.equal(line.totalMinor, 106_200);
  const full = intra([{ sac: COACHING, amountMinor: 100_000, discountMinor: 100_000, taxRateBp: 1800 }]).lines[0];
  assert.equal(full.totalMinor, 0);
  assertValidation(() => intra([{ sac: COACHING, amountMinor: 100, discountMinor: 101, taxRateBp: 1800 }]), 'lines.0.discountMinor');
});

test('tax-inclusive prices are split back into taxable value and tax', () => {
  const exact = intra([{ sac: COACHING, amountMinor: 1_180_000, taxRateBp: 1800, priceIncludesTax: true }]).lines[0];
  assert.deepEqual([exact.taxableValueMinor, exact.cgstMinor, exact.sgstMinor, exact.totalMinor], [1_000_000, 90_000, 90_000, 1_180_000]);
  // ₹1.05 at 5%: base 100, 2.5 → 3 each side, so the taxable value absorbs the paisa: 99 + 3 + 3.
  const absorbed = intra([{ sac: COACHING, amountMinor: 105, taxRateBp: 500, priceIncludesTax: true }]).lines[0];
  assert.deepEqual([absorbed.taxableValueMinor, absorbed.cgstMinor, absorbed.sgstMinor, absorbed.totalMinor], [99, 3, 3, 105]);
  const igst = inter([{ sac: COACHING, amountMinor: 105, taxRateBp: 500, priceIncludesTax: true }]).lines[0];
  assert.deepEqual([igst.taxableValueMinor, igst.igstMinor], [100, 5]);
  const odd = inter([{ sac: COACHING, amountMinor: 100_001, taxRateBp: 1800, priceIncludesTax: true }]).lines[0];
  assert.deepEqual([odd.taxableValueMinor, odd.igstMinor, odd.totalMinor], [84_747, 15_254, 100_001]);
  // Inclusive discount: ₹11,800 less ₹1,180 inclusive → ₹10,620 inclusive → ₹9,000 + ₹1,620.
  const discounted = intra([{ sac: COACHING, amountMinor: 1_180_000, discountMinor: 118_000, taxRateBp: 1800, priceIncludesTax: true }]).lines[0];
  assert.deepEqual([discounted.taxableValueMinor, discounted.taxMinor, discounted.totalMinor], [900_000, 162_000, 1_062_000]);
});

test('splitInclusiveAmount and taxOnTaxableValue are usable on their own', () => {
  assert.deepEqual(splitInclusiveAmount(1_180_000, 1800, 'igst'), { taxableValueMinor: 1_000_000, cgstMinor: 0, sgstMinor: 0, igstMinor: 180_000 });
  assert.deepEqual(splitInclusiveAmount(500, 0, 'igst'), { taxableValueMinor: 500, cgstMinor: 0, sgstMinor: 0, igstMinor: 0 });
  assert.deepEqual(splitInclusiveAmount(500, 1800, 'none'), { taxableValueMinor: 500, cgstMinor: 0, sgstMinor: 0, igstMinor: 0 });
  assert.deepEqual(taxOnTaxableValue(1000, 1800, 'cgst_sgst'), { cgstMinor: 90, sgstMinor: 90, igstMinor: 0 });
  assert.deepEqual(taxOnTaxableValue(1000, 1800, 'none'), { cgstMinor: 0, sgstMinor: 0, igstMinor: 0 });
});

test('exempt, nil-rated and non-GST lines carry no tax and are reported separately', () => {
  const result = intra([
    { sac: COACHING, amountMinor: 1_000_000, taxRateBp: 1800 },
    { sac: '999210', amountMinor: 500_000, taxability: 'exempt' },
    { sac: '490110', amountMinor: 20_000, taxability: 'nil_rated' },
    { sac: '999294', amountMinor: 30_000, taxRateBp: 0 },
    { amountMinor: 7_000, taxability: 'non_gst' },
  ]);
  assert.equal(result.totals.taxableValueMinor, 1_000_000);
  assert.equal(result.totals.exemptValueMinor, 500_000);
  assert.equal(result.totals.nilRatedValueMinor, 50_000, 'a 0% taxable line is reported as nil-rated');
  assert.equal(result.totals.nonGstValueMinor, 7_000);
  assert.equal(result.totals.assessableValueMinor, 1_557_000);
  assert.equal(result.totals.taxMinor, 180_000);
  assert.equal(result.totals.grandTotalMinor, 1_737_000);
  assert.equal(result.lines[3].taxability, 'nil_rated');
  assert.equal(result.documentType, 'tax_invoice');
  assert.equal(result.mixedTaxableAndExempt, true);
  assert.ok(!result.warnings.some((w) => w.line === 4), 'non-GST lines need no SAC');
  assertValidation(() => intra([{ sac: '999210', amountMinor: 1, taxability: 'exempt', taxRateBp: 1800 }]), 'lines.0.taxRateBp');
});

test('an invoice of only exempt supplies is a bill of supply', () => {
  const result = intra([{ sac: '999210', amountMinor: 500_000, taxability: 'exempt' }]);
  assert.equal(result.documentType, 'bill_of_supply');
  assert.equal(result.mixedTaxableAndExempt, false);
  assert.equal(result.totals.taxMinor, 0);
  assert.equal(intra([{ sac: COACHING, amountMinor: 100, taxRateBp: 0 }]).documentType, 'bill_of_supply');
});

test('export of services under LUT is zero-rated with no tax', () => {
  const result = computeTax({
    supplierStateCode: '27',
    exportOfService: { lut: true },
    currency: 'USD',
    lines: [{ sac: SOFTWARE, amountMinor: 1_000_000, taxRateBp: 1800 }],
  });
  assert.equal(result.supplyType, SUPPLY_TYPES.EXPORT_UNDER_LUT);
  assert.equal(result.taxKind, 'none');
  assert.equal(result.zeroRated, true);
  assert.equal(result.lut, true);
  assert.equal(result.placeOfSupplyStateCode, '96');
  assert.equal(result.placeOfSupplyName, 'Outside India');
  assert.equal(result.endorsement, ENDORSEMENTS.underLut);
  assert.equal(result.currency, 'USD');
  assert.equal(result.lines[0].taxRateBp, 1800);
  assert.equal(result.lines[0].appliedRateBp, 0);
  assert.equal(result.lines[0].taxMinor, 0);
  assert.equal(result.totals.zeroRatedValueMinor, 1_000_000);
  assert.equal(result.totals.grandTotalMinor, 1_000_000);
  assert.equal(result.rateSummary[0].taxRateBp, 1800);
  assert.equal(result.rateSummary[0].appliedRateBp, 0);
  assert.equal(result.documentType, 'tax_invoice', 'zero-rated supplies are taxable supplies');
  // A price quoted inclusive of tax stays what the customer pays.
  const inclusive = computeTax({ supplierStateCode: '27', placeOfSupplyStateCode: '96', exportOfService: { lut: true }, lines: [{ sac: SOFTWARE, amountMinor: 118_000, taxRateBp: 1800, priceIncludesTax: true }] });
  assert.equal(inclusive.lines[0].taxableValueMinor, 118_000);
});

test('export of services without LUT pays IGST even from the same state', () => {
  const result = computeTax({ supplierStateCode: '27', exportOfService: { lut: false }, lines: [{ sac: SOFTWARE, amountMinor: 1_000_000, taxRateBp: 1800 }] });
  assert.equal(result.supplyType, SUPPLY_TYPES.EXPORT_WITH_IGST);
  assert.equal(result.taxKind, 'igst');
  assert.equal(result.lines[0].igstMinor, 180_000);
  assert.equal(result.totals.zeroRatedValueMinor, 1_000_000);
  assert.equal(result.endorsement, ENDORSEMENTS.withIgst);
});

test('an export needs a place of supply outside India, and vice versa', () => {
  const line = [{ sac: SOFTWARE, amountMinor: 100, taxRateBp: 1800 }];
  assertValidation(() => computeTax({ supplierStateCode: '27', placeOfSupplyStateCode: '29', exportOfService: { lut: true }, lines: line }), 'placeOfSupplyStateCode');
  assertValidation(() => computeTax({ supplierStateCode: '27', placeOfSupplyStateCode: '96', lines: line }), 'placeOfSupplyStateCode');
  assertValidation(() => computeTax({ supplierStateCode: '27', lines: line }), 'placeOfSupplyStateCode');
});

test('supplies to an SEZ are zero-rated and inter-state even inside one state', () => {
  const line = [{ sac: SOFTWARE, amountMinor: 1_000_000, taxRateBp: 1800 }];
  const paid = computeTax({ supplierStateCode: '27', placeOfSupplyStateCode: '27', supplyToSez: { lut: false }, lines: line });
  assert.equal(paid.supplyType, SUPPLY_TYPES.SEZ_WITH_IGST);
  assert.equal(paid.lines[0].igstMinor, 180_000);
  assert.equal(paid.lines[0].cgstMinor, 0);
  const lut = computeTax({ supplierStateCode: '27', placeOfSupplyStateCode: '27', supplyToSez: { lut: true }, lines: line });
  assert.equal(lut.supplyType, SUPPLY_TYPES.SEZ_UNDER_LUT);
  assert.equal(lut.totals.taxMinor, 0);
  assert.equal(lut.endorsement, ENDORSEMENTS.underLut);
  assertValidation(() => computeTax({ supplierStateCode: '27', placeOfSupplyStateCode: '27', supplyToSez: { lut: true }, exportOfService: { lut: true }, lines: line }), 'supplyToSez');
});

test('round-off to the rupee is shown as a separate amount', () => {
  const at = (amountMinor) => intra([{ sac: '999210', amountMinor, taxability: 'exempt' }], { roundOff: true }).totals;
  assert.deepEqual([at(1_180_050).roundOffMinor, at(1_180_050).grandTotalMinor], [50, 1_180_100]);
  assert.deepEqual([at(1_180_049).roundOffMinor, at(1_180_049).grandTotalMinor], [-49, 1_180_000]);
  assert.deepEqual([at(1_180_000).roundOffMinor, at(1_180_000).grandTotalMinor], [0, 1_180_000]);
  const off = intra([{ sac: '999210', amountMinor: 1_180_049, taxability: 'exempt' }]).totals;
  assert.deepEqual([off.roundOffMinor, off.grandTotalMinor, off.totalBeforeRoundOffMinor], [0, 1_180_049, 1_180_049]);
  // A typical fee: ₹12,345.67 + 18% = ₹14,567.89 → ₹14,568, round-off +11 paise.
  const fee = intra([{ sac: COACHING, amountMinor: 1_234_567, taxRateBp: 1800 }], { roundOff: true }).totals;
  assert.equal(fee.totalBeforeRoundOffMinor, 1_456_789);
  assert.equal(fee.roundOffMinor, 11);
  assert.equal(fee.grandTotalMinor, 1_456_800);
});

test('state codes are checked', () => {
  const line = [{ sac: COACHING, amountMinor: 100, taxRateBp: 1800 }];
  assertValidation(() => computeTax({ supplierStateCode: '40', placeOfSupplyStateCode: '27', lines: line }), 'supplierStateCode');
  assertValidation(() => computeTax({ supplierStateCode: '27', placeOfSupplyStateCode: '28', lines: line }), 'placeOfSupplyStateCode');
  assertValidation(() => computeTax({ supplierStateCode: 'MH', placeOfSupplyStateCode: '27', lines: line }), 'supplierStateCode');
  assertValidation(() => computeTax({ supplierStateCode: '27', placeOfSupplyStateCode: '99', lines: line }), 'placeOfSupplyStateCode');
});

test('a supplier GSTIN must match the supplier state', () => {
  const line = [{ sac: COACHING, amountMinor: 100, taxRateBp: 1800 }];
  assert.equal(computeTax({ supplierGstin: '27AAPFU0939F1ZV', supplierStateCode: '27', placeOfSupplyStateCode: '27', lines: line }).totals.taxMinor, 18);
  assertValidation(() => computeTax({ supplierGstin: '27AAPFU0939F1ZV', supplierStateCode: '29', placeOfSupplyStateCode: '27', lines: line }), 'supplierStateCode');
  assertValidation(() => computeTax({ supplierGstin: '27AAPFU0939F1ZA', supplierStateCode: '27', placeOfSupplyStateCode: '27', lines: line }), 'supplierGstin');
});

test('warnings for unusual rates and missing SAC codes', () => {
  const result = intra([
    { amountMinor: 100, taxRateBp: 1800 },
    { sac: COACHING, amountMinor: 100, taxRateBp: 1300 },
    { sac: COACHING, amountMinor: 100, taxRateBp: 4000 },
  ]);
  assert.deepEqual(result.warnings.map((w) => [w.code, w.line]), [['missing_sac', 0], ['unusual_rate', 1]]);
  assertValidation(() => intra([{ sac: '99929', amountMinor: 100, taxRateBp: 1800 }]), 'lines.0.sac');
  assertValidation(() => intra([{ sac: COACHING, amountMinor: 100, taxRateBp: 10_001 }]), 'lines.0.taxRateBp');
});

test('rate and SAC summaries group lines', () => {
  const result = inter([
    { sac: COACHING, amountMinor: 1000, taxRateBp: 1800, quantity: 1 },
    { sac: COACHING, quantity: 2, unitPriceMinor: 500, taxRateBp: 1800 },
    { sac: '490110', amountMinor: 300, taxRateBp: 500 },
    { sac: '999210', amountMinor: 400, taxability: 'exempt' },
  ]);
  assert.deepEqual(
    result.rateSummary.map((r) => [r.taxRateBp, r.taxableValueMinor, r.igstMinor]),
    [[1800, 2000, 360], [500, 300, 15]],
  );
  assert.deepEqual(
    result.sacSummary.map((s) => [s.sac, s.taxability, s.quantity, s.taxableValueMinor, s.taxMinor]),
    [[COACHING, 'taxable', 3, 2000, 360], ['490110', 'taxable', 1, 300, 15], ['999210', 'exempt', 1, 400, 0]],
  );
});

test('very large amounts stay exact', () => {
  // ₹90,07,19,92,547.40 (about 900 crore) at 18%.
  const line = inter([{ sac: SOFTWARE, amountMinor: 9_007_199_254_740, taxRateBp: 1800 }]).lines[0];
  assert.equal(line.igstMinor, 1_621_295_865_853);
  assert.equal(line.totalMinor, 10_628_495_120_593);
});

test('determineSupply and defaultPlaceOfSupply', () => {
  assert.equal(determineSupply({ supplierStateCode: '27', placeOfSupplyStateCode: '27' }).supplyType, 'intra_state');
  assert.equal(determineSupply({ supplierStateCode: '27', placeOfSupplyStateCode: '97' }).supplyType, 'inter_state');
  assert.deepEqual(defaultPlaceOfSupply({ supplierStateCode: '27', recipientGstin: '33GSPTN3382G1Z4' }), { placeOfSupplyStateCode: '33', source: 'recipient_gstin' });
  assert.deepEqual(defaultPlaceOfSupply({ supplierStateCode: '27', recipientStateCode: '9' }), { placeOfSupplyStateCode: '09', source: 'recipient_address' });
  assert.deepEqual(defaultPlaceOfSupply({ supplierStateCode: '27' }), { placeOfSupplyStateCode: '27', source: 'supplier_location' });
  assert.deepEqual(defaultPlaceOfSupply({ supplierStateCode: '27', recipientOutsideIndia: true }), { placeOfSupplyStateCode: '96', source: 'outside_india' });
  assertValidation(() => defaultPlaceOfSupply({ supplierStateCode: '27', recipientGstin: '33GSPTN3382G1Z5' }), 'recipientGstin');
});

test('invariants hold for random invoices', () => {
  const random = seededRandom(2026);
  const rates = [0, 25, 300, 500, 1200, 1800, 2800, 4000];
  for (let run = 0; run < 400; run += 1) {
    const lines = Array.from({ length: random.int(1, 6) }, () => {
      const gross = random.int(0, 50_000_000);
      return {
        sac: COACHING,
        amountMinor: gross,
        discountMinor: random.int(0, gross),
        taxRateBp: random.pick(rates),
        priceIncludesTax: random() < 0.5,
      };
    });
    const pos = random.pick(['27', '29', '04']);
    const result = computeTax({ supplierStateCode: pos === '04' ? '04' : '27', placeOfSupplyStateCode: pos, lines, roundOff: random() < 0.5 });
    for (const [i, line] of result.lines.entries()) {
      const net = lines[i].amountMinor - lines[i].discountMinor;
      assert.equal(line.totalMinor, line.taxableValueMinor + line.taxMinor);
      assert.equal(line.taxMinor, line.cgstMinor + line.sgstMinor + line.igstMinor);
      assert.equal(line.cgstMinor, line.sgstMinor);
      if (lines[i].priceIncludesTax) assert.equal(line.totalMinor, net, 'inclusive lines keep their price');
      else assert.equal(line.taxableValueMinor, net);
      const exact = (line.taxableValueMinor * line.appliedRateBp) / 10_000;
      assert.ok(Math.abs(line.taxMinor - exact) <= 1.5, `tax ${line.taxMinor} is within rounding of ${exact}`);
    }
    const t = result.totals;
    assert.equal(t.totalBeforeRoundOffMinor, t.assessableValueMinor + t.taxMinor);
    assert.equal(t.grandTotalMinor, t.totalBeforeRoundOffMinor + t.roundOffMinor);
    assert.ok(t.roundOffMinor >= -49 && t.roundOffMinor <= 50);
    if (result.roundOff) assert.equal(t.grandTotalMinor % 100, 0);
  }
});
