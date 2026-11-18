import { db } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { writeAudit } from '../../core/audit.js';
import { emitEvent } from '../../core/events.js';
import { creditNoteTaxDeadline } from '../../core/billing/index.js';
import { billingLevel, loadBillingRecord } from './access.js';
import { issueCreditNote, issueInvoiceForPayment } from './invoicing.js';
import { listRecords } from './lists.js';
import { presentCreditNote, presentInvoice, presentInvoiceSummary } from './present.js';
import { auditUnit, companyContext, minor } from './util.js';

// GST invoices and credit notes: lists, the printable invoice (PDF-ready data: Rule 46 fields,
// tax split, SAC summary, amount in words), cancelling an invoice, credit notes by finance, and
// issuing the invoice of a payment that arrived before billing was set up.

const loadInvoice = (req, id, opts = {}) => loadBillingRecord(req, 'invoices', id, { notFound: 'Invoice', ...opts });

export async function listInvoices(req, query) {
  const { page, nextCursor } = await listRecords(req, {
    table: 'invoices',
    unitId: query.unitId,
    cursor: query.cursor,
    limit: query.limit,
    filter: (q) => {
      if (query.status) q.where('r.status', query.status);
      if (query.dealId) q.where('r.deal_id', query.dealId);
    },
  });
  return { data: page.map(presentInvoiceSummary), nextCursor };
}

export async function getInvoice(req, id) {
  const row = await loadInvoice(req, id);
  const [notes, finance] = await Promise.all([
    db('credit_notes').where({ invoice_id: id }).orderBy('created_at').select('*'),
    billingLevel(req, 'billing.finance', row),
  ]);
  const deadline = creditNoteTaxDeadline(row.issue_date);
  return {
    ...presentInvoice(row, { creditNotes: notes.map((n) => ({ ...n, deal_ref: row.deal_ref, deal_title: row.deal_title, deal_status: row.deal_status, invoice_number: row.number })) }),
    creditNoteDeadline: typeof deadline === 'string' ? deadline : (deadline?.date ?? null),
    can: {
      cancel: Boolean(finance) && row.status === 'issued' && minor(row.credited_minor) === 0,
      creditNote: Boolean(finance) && row.status === 'issued' && minor(row.credited_minor) < minor(row.total_minor),
    },
  };
}

export async function cancelInvoice(req, id, { reason }) {
  await db.transaction(async (trx) => {
    const invoice = await loadInvoice(req, id, { permission: 'billing.finance', trx, forUpdate: true });
    if (invoice.status === 'cancelled') return;
    if (minor(invoice.credited_minor) > 0) throw errors.conflict('This invoice has credit notes: credit the rest instead of cancelling');
    const deal = await trx('deals').where({ id: invoice.deal_id }).first();
    await trx('invoices').where({ id }).update({ status: 'cancelled', cancelled_at: trx.fn.now(), cancel_reason: reason, updated_at: trx.fn.now() });
    await writeAudit(trx, req, { action: 'invoice.cancelled', entityType: 'invoice', entityId: id, unit: auditUnit(deal), before: { status: 'issued' }, after: { status: 'cancelled' }, meta: { reason, number: invoice.number } });
    await emitEvent(trx, {
      type: 'invoice.cancelled',
      groupId: deal.group_id,
      unitId: deal.unit_id,
      aggregateType: 'invoice',
      aggregateId: id,
      actorUserId: req.auth.user.id,
      payload: { invoiceId: id, number: invoice.number, dealId: deal.id, companyId: invoice.company_id, reason },
    });
  });
  return getInvoice(req, id);
}

export async function createCreditNote(req, id, body) {
  await db.transaction(async (trx) => {
    const invoice = await loadInvoice(req, id, { permission: 'billing.finance', trx, forUpdate: true });
    if (invoice.status !== 'issued') throw errors.conflict('This invoice is cancelled');
    const deal = await trx('deals').where({ id: invoice.deal_id }).first();
    const unit = await trx('org_units').where({ id: deal.unit_id }).first();
    const ctx = await companyContext(unit, trx);
    const left = minor(invoice.total_minor) - minor(invoice.credited_minor);
    if (body.mode === 'partial' && body.amountMinor > left) throw errors.validation([{ path: 'body.amountMinor', message: 'That is more than is left on the invoice' }]);
    if (body.mode === 'full' && minor(invoice.credited_minor) > 0) throw errors.validation([{ path: 'body.mode', message: 'Part of this invoice is already credited: credit the rest as a partial note' }]);
    await issueCreditNote(trx, {
      invoice,
      deal,
      mode: body.mode,
      refundAmountMinor: body.amountMinor,
      reason: body.reason,
      issueDate: ctx.today(),
      timeZone: ctx.timeZone,
      req,
      notes: body.notes ?? null,
    });
  });
  return getInvoice(req, id);
}

export async function listCreditNotes(req, query) {
  const { page, nextCursor } = await listRecords(req, {
    table: 'credit_notes',
    unitId: query.unitId,
    cursor: query.cursor,
    limit: query.limit,
    select: ['i.number as invoice_number'],
    filter: (q) => {
      q.join('invoices as i', 'i.id', 'r.invoice_id');
      if (query.dealId) q.where('r.deal_id', query.dealId);
    },
  });
  return { data: page.map(presentCreditNote), nextCursor };
}

/** Issue the invoice of a payment that was received before billing was set up (finance). */
export async function issueMissingInvoice(req, paymentId) {
  const invoiceId = await db.transaction(async (trx) => {
    const payment = await loadBillingRecord(req, 'payments', paymentId, { permission: 'billing.finance', notFound: 'Payment', trx, forUpdate: true });
    if (payment.status !== 'succeeded') throw errors.conflict('Only a received payment gets an invoice');
    if (payment.invoice_id) return payment.invoice_id;
    const deal = await trx('deals').where({ id: payment.deal_id }).first();
    const unit = await trx('org_units').where({ id: deal.unit_id }).first();
    const ctx = await companyContext(unit, trx);
    const invoice = await issueInvoiceForPayment(trx, { payment, deal, source: payment.invoice_source, timeZone: ctx.timeZone, issueDate: ctx.today(), req });
    return invoice.id;
  });
  return getInvoice(req, invoiceId);
}
