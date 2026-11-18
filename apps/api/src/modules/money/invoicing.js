import { json } from '../../lib/db.js';
import { AppError, errors } from '../../lib/errors.js';
import { writeAudit } from '../../core/audit.js';
import { emitEvent } from '../../core/events.js';
import {
  amountInWords,
  computeCreditNote,
  computeTax,
  financialYear,
  formatDocumentNumber,
  maxSequence,
  stateByCode,
} from '../../core/billing/index.js';
import { invoiceLinesForAmount, presentTaxLine, taxInputFor } from './pricing.js';
import { auditUnit, minor } from './util.js';

// GST invoices and credit notes. Numbers come from billing_number_counters inside the issuing
// transaction (BILLING_CORE §5): the upsert locks the counter row until commit, so concurrent
// issuers queue and a rollback leaves no gap. Validate and compute first, allocate last.

export const billingNotSetUp = (message) => new AppError(409, 'billing_not_set_up', message);

/** The series spec the engine formats with, from a billing_number_series row. */
export const seriesSpec = (row) => ({
  documentType: row.document_type,
  prefix: row.prefix,
  format: row.format,
  fyStyle: row.fy_style,
  padding: row.padding,
  gstin: row.gstin,
});

/** Supplier details (company billing profile) for tax maths and printing. */
export function supplierFrom(profile) {
  return {
    legalName: profile.legal_name,
    tradeName: profile.trade_name ?? null,
    gstin: profile.gstin ?? null,
    stateCode: profile.state_code,
    stateName: stateByCode(profile.state_code)?.name ?? null,
    pan: profile.pan ?? null,
    address: profile.address ?? {},
    email: profile.email ?? null,
    phone: profile.phone ?? null,
    lutNumber: profile.lut_number ?? null,
    lutValidUntil: profile.lut_valid_until ?? null,
    roundOff: profile.round_off,
  };
}

/** The company's billing profile and default series of a type, or 409 billing_not_set_up. */
export async function issuingSetup(trx, companyId, documentType) {
  const [profile, series] = await Promise.all([
    trx('billing_profiles').where({ company_id: companyId }).first(),
    trx('billing_number_series').where({ company_id: companyId, document_type: documentType, is_default: true, active: true }).first(),
  ]);
  if (!profile?.gstin) throw billingNotSetUp('Add the company GSTIN in Settings > Billing before issuing invoices');
  if (!series) throw billingNotSetUp(`Add a ${documentType.replace('_', ' ')} series in Settings > Billing`);
  if (series.gstin !== profile.gstin) throw billingNotSetUp('The invoice series belongs to another GSTIN: update it in Settings > Billing');
  return { profile, series };
}

/**
 * Allocate the next number of a series for a document date. Gap-free and unique per financial year;
 * refuses a date earlier than the series' last document (numbers rise with dates).
 */
export async function allocateNumber(trx, series, issueDate, timeZone) {
  const fy = financialYear(issueDate, timeZone);
  const { rows } = await trx.raw(
    `insert into billing_number_counters (series_id, fy_start_year, last_sequence, last_document_date)
     values (?, ?, 1, ?)
     on conflict (series_id, fy_start_year) do update
       set last_sequence = billing_number_counters.last_sequence + 1,
           last_document_date = greatest(billing_number_counters.last_document_date, excluded.last_document_date)
     returning last_sequence, last_document_date::text as last_document_date`,
    [series.id, fy.startYear, issueDate],
  );
  const { last_sequence: sequence, last_document_date: lastDate } = rows[0];
  if (lastDate > issueDate) {
    throw errors.conflict(`The series already has a document dated ${lastDate}; documents can't be dated earlier`);
  }
  const spec = seriesSpec(series);
  if (sequence > maxSequence(spec)) throw billingNotSetUp(`The series ${series.prefix} is full for ${fy.label}: add a new series`);
  return { fyStartYear: fy.startYear, sequence, number: formatDocumentNumber(spec, { sequence, fyStartYear: fy.startYear }) };
}

/**
 * Issue a GST invoice for a successful payment, inside the caller's transaction.
 * Lines: the quote's lines when the payment covers it whole; otherwise the paid amount spread over
 * them (instalments). Subscriptions pass their own lines.
 * @returns {Promise<object>} the invoice row
 */
export async function issueInvoiceForPayment(trx, { payment, deal, source, timeZone, issueDate, req = null, actorUserId = null }) {
  const { lines, pricesIncludeTax, recipient, label, pricedTotals, totalMinor } = source;
  const invoiceLines = invoiceLinesForAmount({
    lines,
    pricedTotals,
    totalMinor,
    amountMinor: minor(payment.amount_minor),
    label,
    pricesIncludeTax,
  });
  const profile = await trx('billing_profiles').where({ company_id: payment.company_id }).first();
  if (!profile?.gstin) throw billingNotSetUp('Add the company GSTIN in Settings > Billing before issuing invoices');
  const supplier = supplierFrom(profile);
  const taxInput = taxInputFor({ ...invoiceLines, supplier, recipient, currency: payment.currency, onDate: issueDate });
  const result = computeTax(taxInput);
  if (result.totals.grandTotalMinor !== minor(payment.amount_minor) && !profile.round_off) {
    // Tax-exclusive quote paid in part: the share is tax-inclusive, so the total always matches.
    throw new RangeError('Invoice total does not match the payment');
  }
  const seriesType = result.documentType === 'bill_of_supply' ? 'bill_of_supply' : 'invoice';
  const { series } = await issuingSetup(trx, payment.company_id, seriesType);
  const allocated = await allocateNumber(trx, series, issueDate, timeZone);
  const totals = result.totals;
  const [invoice] = await trx('invoices')
    .insert({
      group_id: payment.group_id,
      company_id: payment.company_id,
      deal_id: payment.deal_id,
      payment_id: payment.id,
      subscription_id: payment.subscription_id ?? null,
      series_id: series.id,
      supplier_gstin: series.gstin,
      series_document_type: seriesType,
      fy_start_year: allocated.fyStartYear,
      sequence: allocated.sequence,
      number: allocated.number,
      document_type: result.documentType,
      status: 'issued',
      issue_date: issueDate,
      supplier: json(supplier),
      recipient: json(recipient ?? {}),
      place_of_supply_state_code: result.placeOfSupplyStateCode,
      supply_type: result.supplyType,
      tax_kind: result.taxKind,
      currency: payment.currency,
      lines: json(result.lines.map(presentTaxLine)),
      tax_input: json(taxInput),
      totals: json(totals),
      sac_summary: json(result.sacSummary ?? []),
      taxable_minor: totals.taxableValueMinor,
      cgst_minor: totals.cgstMinor,
      sgst_minor: totals.sgstMinor,
      igst_minor: totals.igstMinor,
      tax_minor: totals.taxMinor,
      round_off_minor: totals.roundOffMinor,
      total_minor: totals.grandTotalMinor,
      amount_in_words: amountInWords(totals.grandTotalMinor, { currency: payment.currency }),
      endorsement: result.endorsement ?? null,
      notes: profile.invoice_notes ?? null,
      created_by: actorUserId ?? req?.auth?.user?.id ?? null,
    })
    .returning('*');
  await trx('payments').where({ id: payment.id }).update({ invoice_id: invoice.id, invoice_error: null, updated_at: trx.fn.now() });
  await writeAudit(trx, req, {
    action: 'invoice.issued',
    entityType: 'invoice',
    entityId: invoice.id,
    unit: auditUnit(deal),
    groupId: deal.group_id,
    actorUserId,
    after: { number: invoice.number, totalMinor: invoice.total_minor, currency: invoice.currency, paymentId: payment.id },
  });
  await emitEvent(trx, {
    type: 'invoice.issued',
    groupId: deal.group_id,
    unitId: deal.unit_id,
    aggregateType: 'invoice',
    aggregateId: invoice.id,
    actorUserId,
    payload: {
      invoiceId: invoice.id,
      number: invoice.number,
      companyId: invoice.company_id,
      dealId: deal.id,
      paymentId: payment.id,
      subscriptionId: invoice.subscription_id,
      totalMinor: minor(invoice.total_minor),
      taxMinor: minor(invoice.tax_minor),
      currency: invoice.currency,
      issueDate,
    },
  });
  return invoice;
}

/**
 * Issue a credit note against an invoice (refunds, cancellations), inside the caller's transaction.
 * Earlier credit notes on the invoice are passed to the engine so cumulative credits never exceed it.
 */
export async function issueCreditNote(
  trx,
  { invoice, deal, mode, refundAmountMinor, reason = 'refund', refundId = null, issueDate, timeZone, req = null, actorUserId = null, notes = null },
) {
  if (invoice.status !== 'issued') throw errors.conflict('This invoice is cancelled');
  const previous = await trx('credit_notes').where({ invoice_id: invoice.id, status: 'issued' }).orderBy('created_at').select('result');
  const result = computeCreditNote({
    invoice: invoice.tax_input,
    mode,
    ...(mode === 'partial' ? { refundAmountMinor } : {}),
    previousCredits: previous.map((row) => row.result),
    reason,
    against: { number: invoice.number, date: invoice.issue_date },
  });
  const { series } = await issuingSetup(trx, invoice.company_id, 'credit_note');
  if (series.gstin !== invoice.supplier_gstin) throw billingNotSetUp('The credit note series must use the invoice GSTIN');
  const allocated = await allocateNumber(trx, series, issueDate, timeZone);
  const totals = result.totals;
  const [note] = await trx('credit_notes')
    .insert({
      group_id: invoice.group_id,
      company_id: invoice.company_id,
      deal_id: invoice.deal_id,
      invoice_id: invoice.id,
      refund_id: refundId,
      series_id: series.id,
      supplier_gstin: series.gstin,
      fy_start_year: allocated.fyStartYear,
      sequence: allocated.sequence,
      number: allocated.number,
      issue_date: issueDate,
      reason,
      mode,
      currency: invoice.currency,
      lines: json(result.lines.map(presentTaxLine)),
      result: json(result),
      taxable_minor: totals.taxableValueMinor,
      tax_minor: totals.taxMinor,
      total_minor: totals.grandTotalMinor,
      amount_in_words: amountInWords(totals.grandTotalMinor, { currency: invoice.currency }),
      notes,
      created_by: actorUserId ?? req?.auth?.user?.id ?? null,
    })
    .returning('*');
  await trx('invoices')
    .where({ id: invoice.id })
    .update({ credited_minor: trx.raw('credited_minor + ?', [totals.grandTotalMinor]), updated_at: trx.fn.now() });
  await writeAudit(trx, req, {
    action: 'credit_note.issued',
    entityType: 'credit_note',
    entityId: note.id,
    unit: auditUnit(deal),
    groupId: deal.group_id,
    actorUserId,
    after: { number: note.number, invoiceId: invoice.id, totalMinor: note.total_minor, reason },
  });
  await emitEvent(trx, {
    type: 'credit_note.issued',
    groupId: deal.group_id,
    unitId: deal.unit_id,
    aggregateType: 'credit_note',
    aggregateId: note.id,
    actorUserId,
    payload: {
      creditNoteId: note.id,
      number: note.number,
      invoiceId: invoice.id,
      refundId,
      companyId: invoice.company_id,
      dealId: deal.id,
      totalMinor: minor(note.total_minor),
      currency: note.currency,
      fullyCredited: result.fullyCredited,
    },
  });
  return note;
}
