import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCreditNote, creditNoteTaxDeadline } from '../../src/core/billing/creditNote.js';
import { computeTax } from '../../src/core/billing/gst.js';
import { assertValidation, seededRandom } from './helpers.js';

const SOFTWARE = '997331';
const COACHING = '999293';

/** Inter-state invoice: 3 licences, a tax-inclusive coaching fee and an exempt line. */
const interInvoice = {
  supplierStateCode: '27',
  placeOfSupplyStateCode: '29',
  lines: [
    { sac: SOFTWARE, quantity: 3, unitPriceMinor: 99_900, taxRateBp: 1800 },
    { sac: COACHING, amountMinor: 1_180_000, taxRateBp: 1800, priceIncludesTax: true },
    { sac: '999210', amountMinor: 50_000, taxability: 'exempt' },
  ],
};

/** Intra-state invoice: one ₹11,800 fee including 18% GST. */
const feeInvoice = {
  supplierStateCode: '27',
  placeOfSupplyStateCode: '27',
  lines: [{ sac: COACHING, amountMinor: 1_180_000, taxRateBp: 1800, priceIncludesTax: true }],
};

const parts = (line) => [line.taxableValueMinor, line.cgstMinor, line.sgstMinor, line.igstMinor];
const FIELDS = ['taxableValueMinor', 'cgstMinor', 'sgstMinor', 'igstMinor', 'taxMinor', 'grandTotalMinor', 'roundOffMinor'];

test('a full credit note mirrors the invoice exactly', () => {
  const invoice = computeTax(interInvoice);
  const credit = computeCreditNote({ invoice: interInvoice, mode: 'full', against: { number: 'PVI/2627/00001', date: '2026-05-10' } });
  assert.equal(credit.documentType, 'credit_note');
  assert.equal(credit.reason, 'refund');
  assert.deepEqual(credit.against, { number: 'PVI/2627/00001', date: '2026-05-10' });
  assert.equal(credit.supplyType, 'inter_state');
  assert.equal(credit.placeOfSupplyStateCode, '29');
  for (const field of FIELDS) assert.equal(credit.totals[field], invoice.totals[field], field);
  assert.equal(credit.totals.exemptValueMinor, 50_000);
  assert.deepEqual(credit.lines.map((l) => l.line), [0, 1, 2]);
  assert.deepEqual(credit.lines.map((l) => l.quantity), [3, 1, 1]);
  assert.equal(credit.fullyCredited, true);
  assert.ok(credit.remaining.every((r) => r.totalMinor === 0 && r.quantity === 0));
});

test('a full credit note on a rounded-off invoice carries the same round-off', () => {
  const rounded = { ...feeInvoice, roundOff: true, lines: [{ sac: COACHING, amountMinor: 1_234_567, taxRateBp: 1800 }] };
  const invoice = computeTax(rounded);
  const credit = computeCreditNote({ invoice: rounded, mode: 'full' });
  assert.equal(credit.totals.roundOffMinor, 11);
  assert.equal(credit.totals.grandTotalMinor, invoice.totals.grandTotalMinor);
  const partial = computeCreditNote({ invoice: rounded, mode: 'partial', refundAmountMinor: 100_050 });
  assert.equal(partial.totals.grandTotalMinor % 100, 0, 'partial notes inherit the round-off setting');
  const exact = computeCreditNote({ invoice: rounded, mode: 'partial', refundAmountMinor: 100_050, roundOff: false });
  assert.equal(exact.totals.grandTotalMinor, 100_050);
});

test('returning some of the quantity credits that share, and the last return takes the rest', () => {
  const first = computeCreditNote({ invoice: interInvoice, mode: 'partial', lines: [{ line: 0, quantity: 1 }] });
  assert.deepEqual(parts(first.lines[0]), [99_900, 0, 0, 17_982]);
  assert.equal(first.lines[0].quantity, 1);
  assert.equal(first.remaining[0].quantity, 2);
  assert.equal(first.fullyCredited, false);
  const second = computeCreditNote({ invoice: interInvoice, mode: 'partial', lines: [{ line: 0, quantity: 2 }], previousCredits: [first] });
  assert.deepEqual(parts(second.lines[0]), [199_800, 0, 0, 35_964]);
  assert.equal(second.remaining[0].totalMinor, 0);
  assert.equal(second.remaining[0].quantity, 0);
  assertValidation(() => computeCreditNote({ invoice: interInvoice, mode: 'partial', lines: [{ line: 0, quantity: 3 }], previousCredits: [first] }), 'lines.0.quantity');
});

test('a quantity return worth more than what earlier refunds left is refused', () => {
  const refund = computeCreditNote({ invoice: interInvoice, mode: 'partial', lines: [{ line: 0, amountMinor: 300_000 }] });
  // One licence is worth ₹1,178.82 with tax, but only ₹536.46 is left on the line.
  assertValidation(
    () => computeCreditNote({ invoice: interInvoice, mode: 'partial', lines: [{ line: 0, quantity: 1 }], previousCredits: [refund] }),
    'lines.0.quantity',
  );
  const rest = computeCreditNote({ invoice: interInvoice, mode: 'partial', lines: [{ line: 0, quantity: 3 }], previousCredits: [refund] });
  assert.equal(rest.lines[0].totalMinor, 53_646, 'returning every unit takes what is left');
});

test('crediting a taxable value charges tax back at the line rate', () => {
  const credit = computeCreditNote({ invoice: interInvoice, mode: 'partial', reason: 'post_supply_discount', lines: [{ line: 0, taxableValueMinor: 50_000 }] });
  assert.equal(credit.reason, 'post_supply_discount');
  assert.deepEqual(parts(credit.lines[0]), [50_000, 0, 0, 9_000]);
  assert.equal(credit.lines[0].quantity, null);
  assertValidation(() => computeCreditNote({ invoice: interInvoice, mode: 'partial', lines: [{ line: 0, taxableValueMinor: 299_701 }] }), 'lines.0.taxableValueMinor');
  const all = computeCreditNote({ invoice: interInvoice, mode: 'partial', lines: [{ line: 0, taxableValueMinor: 299_700 }] });
  assert.deepEqual(parts(all.lines[0]), [299_700, 0, 0, 53_946], 'the whole taxable value takes the whole tax');
});

test('refunding part of a tax-inclusive fee splits the refund into value and tax', () => {
  const first = computeCreditNote({ invoice: feeInvoice, mode: 'partial', lines: [{ line: 0, amountMinor: 500_000 }] });
  assert.equal(first.stateTaxLabel, 'SGST');
  assert.deepEqual(parts(first.lines[0]), [423_728, 38_136, 38_136, 0]);
  assert.equal(first.totals.grandTotalMinor, 500_000);
  const rest = computeCreditNote({ invoice: feeInvoice, mode: 'partial', lines: [{ line: 0, amountMinor: 680_000 }], previousCredits: [first] });
  assert.deepEqual(parts(rest.lines[0]), [576_272, 51_864, 51_864, 0]);
  assert.equal(rest.fullyCredited, true);
  assertValidation(
    () => computeCreditNote({ invoice: feeInvoice, mode: 'partial', lines: [{ line: 0, amountMinor: 680_001 }], previousCredits: [first] }),
    'lines.0.amountMinor',
  );
});

test('an invoice-level refund is spread over the lines in proportion', () => {
  const credit = computeCreditNote({ invoice: interInvoice, mode: 'partial', refundAmountMinor: 100_000 });
  assert.equal(credit.totals.grandTotalMinor, 100_000);
  assert.equal(credit.lines.length, 3);
  const exempt = credit.lines.find((l) => l.line === 2);
  assert.equal(exempt?.taxMinor, 0);
  assert.equal(exempt?.taxability, 'exempt');
  assert.ok(credit.lines[1].totalMinor > credit.lines[0].totalMinor, 'the bigger line takes the bigger share');
  const remainingTotal = computeTax(interInvoice).totals.grandTotalMinor - 100_000;
  assertValidation(
    () => computeCreditNote({ invoice: interInvoice, mode: 'partial', refundAmountMinor: remainingTotal + 1, previousCredits: [credit] }),
    'refundAmountMinor',
  );
  const rest = computeCreditNote({ invoice: interInvoice, mode: 'partial', refundAmountMinor: remainingTotal, previousCredits: [credit] });
  assert.equal(rest.fullyCredited, true);
});

test('a full credit note after partial ones credits only what is left', () => {
  const invoice = computeTax(interInvoice);
  const first = computeCreditNote({ invoice: interInvoice, mode: 'partial', refundAmountMinor: 333_333 });
  const rest = computeCreditNote({ invoice: interInvoice, mode: 'full', previousCredits: [first] });
  for (const field of ['taxableValueMinor', 'igstMinor', 'taxMinor', 'grandTotalMinor']) {
    assert.equal(first.totals[field] + rest.totals[field], invoice.totals[field], field);
  }
  assertValidation(() => computeCreditNote({ invoice: interInvoice, mode: 'full', previousCredits: [first, rest] }), 'invoice');
});

test('zero-rated invoices credit no tax', () => {
  const exportInvoice = { supplierStateCode: '27', exportOfService: { lut: true }, lines: [{ sac: SOFTWARE, amountMinor: 1_000_000, taxRateBp: 1800 }] };
  const credit = computeCreditNote({ invoice: exportInvoice, mode: 'partial', lines: [{ line: 0, amountMinor: 250_000 }] });
  assert.equal(credit.supplyType, 'export_under_lut');
  assert.equal(credit.zeroRated, true);
  assert.deepEqual(parts(credit.lines[0]), [250_000, 0, 0, 0]);
  assert.equal(credit.totals.zeroRatedValueMinor, 250_000);
  const paid = { ...exportInvoice, exportOfService: { lut: false } };
  assert.deepEqual(parts(computeCreditNote({ invoice: paid, mode: 'partial', lines: [{ line: 0, taxableValueMinor: 250_000 }] }).lines[0]), [250_000, 0, 0, 45_000]);
});

test('requests are validated', () => {
  assertValidation(() => computeCreditNote({ invoice: interInvoice, mode: 'full', lines: [{ line: 0, quantity: 1 }] }), 'mode');
  assertValidation(() => computeCreditNote({ invoice: interInvoice, mode: 'full', refundAmountMinor: 5 }), 'mode');
  assertValidation(() => computeCreditNote({ invoice: interInvoice, mode: 'partial' }), 'lines');
  assertValidation(() => computeCreditNote({ invoice: interInvoice, mode: 'partial', refundAmountMinor: 5, lines: [{ line: 0, quantity: 1 }] }), 'lines');
  assertValidation(() => computeCreditNote({ invoice: interInvoice, mode: 'partial', lines: [{ line: 9, quantity: 1 }] }), 'lines.0.line');
  assertValidation(() => computeCreditNote({ invoice: interInvoice, mode: 'partial', lines: [{ line: 0, quantity: 1 }, { line: 0, quantity: 1 }] }), 'lines.1.line');
  assertValidation(() => computeCreditNote({ invoice: interInvoice, mode: 'partial', lines: [{ line: 0, quantity: 1, amountMinor: 5 }] }), 'lines.0');
  assertValidation(() => computeCreditNote({ invoice: interInvoice, mode: 'partial', lines: [{ line: 0, amountMinor: 0 }] }), 'lines.0.amountMinor');
  assertValidation(() => computeCreditNote({ invoice: interInvoice, mode: 'partial', refundAmountMinor: 1, reason: 'whim' }), 'reason');
  assertValidation(() => computeCreditNote({ invoice: { ...interInvoice, placeOfSupplyStateCode: '96' }, mode: 'full' }), 'placeOfSupplyStateCode');
});

test('earlier credits must belong to the invoice and not exceed it', () => {
  const fake = { lines: [{ line: 0, quantity: 1, taxableValueMinor: 400_000, cgstMinor: 0, sgstMinor: 0, igstMinor: 0 }] };
  assertValidation(() => computeCreditNote({ invoice: interInvoice, mode: 'full', previousCredits: [fake] }), 'previousCredits');
  const stray = { lines: [{ line: 7, taxableValueMinor: 1, cgstMinor: 0, sgstMinor: 0, igstMinor: 0 }] };
  assertValidation(() => computeCreditNote({ invoice: interInvoice, mode: 'full', previousCredits: [stray] }), 'previousCredits.0');
});

test('random sequences of partial credits never exceed the invoice and close it exactly', () => {
  const random = seededRandom(34);
  for (let run = 0; run < 150; run += 1) {
    const invoiceInput = {
      supplierStateCode: '27',
      placeOfSupplyStateCode: random.pick(['27', '29']),
      lines: Array.from({ length: random.int(1, 4) }, () => ({
        sac: COACHING,
        quantity: random.int(1, 5),
        unitPriceMinor: random.int(1, 2_000_000),
        taxRateBp: random.pick([0, 500, 1800, 4000]),
        priceIncludesTax: random() < 0.5,
      })),
    };
    const invoice = computeTax(invoiceInput);
    const notes = [];
    for (let step = 0; step < random.int(0, 4); step += 1) {
      const left = notes.length ? notes[notes.length - 1].remaining : invoice.lines.map((l, i) => ({ line: i, quantity: l.quantity, totalMinor: l.totalMinor, taxableValueMinor: l.taxableValueMinor }));
      const open = left.filter((l) => l.totalMinor > 1);
      if (open.length === 0) break;
      const target = random.pick(open);
      const kind = random.pick(['amount', 'refund', 'taxable', 'quantity']);
      let request;
      if (kind === 'refund') request = { refundAmountMinor: random.int(1, left.reduce((a, l) => a + l.totalMinor, 0)) };
      else if (kind === 'amount') request = { lines: [{ line: target.line, amountMinor: random.int(1, target.totalMinor) }] };
      else if (kind === 'taxable' && target.taxableValueMinor > 0) request = { lines: [{ line: target.line, taxableValueMinor: random.int(1, target.taxableValueMinor) }] };
      else if (kind === 'quantity' && target.quantity >= 1) {
        request = { lines: [{ line: target.line, quantity: random.int(1, Math.floor(target.quantity)) }] };
      } else continue;
      let note;
      try {
        note = computeCreditNote({ invoice: invoiceInput, mode: 'partial', previousCredits: notes, ...request });
      } catch (error) {
        // A quantity share can be worth more than earlier amount refunds left on the line.
        assert.equal(error.status, 422);
        assert.ok(kind === 'quantity', `only quantity credits may be refused, got ${kind}: ${error.message}`);
        continue;
      }
      for (const line of note.lines) {
        assert.equal(line.totalMinor, line.taxableValueMinor + line.taxMinor);
        assert.ok(line.taxableValueMinor >= 0 && line.cgstMinor >= 0 && line.sgstMinor >= 0 && line.igstMinor >= 0);
      }
      if (request.refundAmountMinor) assert.equal(note.totals.totalBeforeRoundOffMinor, request.refundAmountMinor);
      if (request.lines?.[0].amountMinor) assert.equal(note.lines[0].totalMinor, request.lines[0].amountMinor);
      notes.push(note);
    }
    if (notes.length && notes[notes.length - 1].fullyCredited) continue;
    notes.push(computeCreditNote({ invoice: invoiceInput, mode: 'full', previousCredits: notes }));
    for (const [i, line] of invoice.lines.entries()) {
      for (const key of ['taxableValueMinor', 'cgstMinor', 'sgstMinor', 'igstMinor']) {
        const credited = notes.flatMap((n) => n.lines).filter((l) => l.line === i).reduce((a, l) => a + l[key], 0);
        assert.equal(credited, line[key], `run ${run} line ${i} ${key}`);
      }
    }
  }
});

test('tax can be reduced until 30 November after the financial year, or the annual return if sooner', () => {
  assert.equal(creditNoteTaxDeadline('2026-05-10'), '2027-11-30');
  assert.equal(creditNoteTaxDeadline('2027-03-31'), '2027-11-30');
  assert.equal(creditNoteTaxDeadline('2027-04-01'), '2028-11-30');
  assert.equal(creditNoteTaxDeadline('2026-05-10', { annualReturnFiledOn: '2027-10-15' }), '2027-10-15');
  assert.equal(creditNoteTaxDeadline('2026-05-10', { annualReturnFiledOn: '2027-12-31' }), '2027-11-30');
});
