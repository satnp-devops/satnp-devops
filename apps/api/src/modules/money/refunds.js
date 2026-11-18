import { randomUUID } from 'node:crypto';
import { db, json } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { writeAudit } from '../../core/audit.js';
import { emitEvent } from '../../core/events.js';
import { billingLevel, loadBillingRecord } from './access.js';
import { issueCreditNote } from './invoicing.js';
import { listRecords } from './lists.js';
import { ports } from './ports.js';
import { presentRefund, usersById } from './present.js';
import { auditUnit, companyContext, dealTimeline, minor, money, nextCompanyNumber, refFor } from './util.js';

// Refunds need finance approval: anyone who works the deal may request one (billing.manage);
// someone else holding billing.approve_refunds approves or rejects it. Approval calls the provider
// outside the transaction with a stable idempotency key, so a retry never refunds twice. The
// provider's refund webhook (or an immediate "processed" answer) completes it: the payment's
// refunded amount goes up, a GST credit note is issued against the invoice and refund.processed
// is emitted. Offline payments are refunded offline: approval completes them directly.

const loadRefund = (req, id, opts = {}) => loadBillingRecord(req, 'refunds', id, { notFound: 'Refund', ...opts });

const refundEvent = (trx, refund, deal, type, actorUserId, extra = {}) =>
  emitEvent(trx, {
    type,
    groupId: deal.group_id,
    unitId: deal.unit_id,
    aggregateType: 'refund',
    aggregateId: refund.id,
    actorUserId,
    payload: {
      refundId: refund.id,
      ref: refund.ref,
      paymentId: refund.payment_id,
      dealId: deal.id,
      companyId: refund.company_id,
      amountMinor: minor(refund.amount_minor),
      currency: refund.currency,
      reason: refund.reason,
      status: refund.status,
      ...extra,
    },
  });

async function refundCan(req, row) {
  const approve = await billingLevel(req, 'billing.approve_refunds', row);
  const mine = row.requested_by === req.auth.user.id;
  return {
    approve: Boolean(approve) && row.status === 'requested' && !mine,
    reject: Boolean(approve) && row.status === 'requested',
    retry: Boolean(approve) && row.status === 'failed',
  };
}

async function presentOne(req, id) {
  const row = await loadRefund(req, id);
  const users = await usersById(db, [row.requested_by, row.reviewed_by]);
  return presentRefund(row, { users, can: await refundCan(req, row) });
}

export const getRefund = presentOne;

export async function listRefunds(req, query) {
  const { page, nextCursor } = await listRecords(req, {
    table: 'refunds',
    unitId: query.unitId,
    cursor: query.cursor,
    limit: query.limit,
    filter: (q) => {
      if (query.status?.length) q.whereIn('r.status', query.status);
      if (query.dealId) q.where('r.deal_id', query.dealId);
    },
  });
  const users = await usersById(db, page.flatMap((r) => [r.requested_by, r.reviewed_by]));
  return { data: await Promise.all(page.map(async (row) => presentRefund(row, { users, can: await refundCan(req, row) }))), nextCursor };
}

export async function requestRefund(req, body) {
  const id = await db.transaction(async (trx) => {
    const payment = await loadBillingRecord(req, 'payments', body.paymentId, { permission: 'billing.manage', notFound: 'Payment', trx, forUpdate: true }).catch((err) => {
      if (err.status === 404) throw errors.validation([{ path: 'body.paymentId', message: 'Payment not found' }]);
      throw err;
    });
    if (payment.status !== 'succeeded') throw errors.conflict('Only a received payment can be refunded');
    const open = await trx('refunds').where({ payment_id: payment.id }).whereIn('status', ['requested', 'approved', 'processing', 'processed']).sum({ total: 'amount_minor' }).first();
    const left = minor(payment.amount_minor) - minor(open?.total);
    if (body.amountMinor > left) throw errors.validation([{ path: 'body.amountMinor', message: `At most ${money(left, payment.currency)} can be refunded` }]);
    const deal = await trx('deals').where({ id: payment.deal_id }).first();
    const unit = await trx('org_units').where({ id: deal.unit_id }).first();
    const ctx = await companyContext(unit, trx);
    const number = await nextCompanyNumber(trx, payment.company_id, 'refund');
    const refundId = randomUUID();
    const [refund] = await trx('refunds')
      .insert({
        id: refundId,
        group_id: payment.group_id,
        company_id: payment.company_id,
        deal_id: payment.deal_id,
        payment_id: payment.id,
        invoice_id: payment.invoice_id ?? null,
        number,
        ref: refFor(ctx.prefix, 'RF', number),
        amount_minor: body.amountMinor,
        currency: payment.currency,
        reason: body.reason,
        note: body.note ?? null,
        status: 'requested',
        requested_by: req.auth.user.id,
        provider: payment.provider,
        idempotency_key: `refund:${refundId}`,
      })
      .returning('*');
    await writeAudit(trx, req, { action: 'refund.requested', entityType: 'refund', entityId: refund.id, unit: auditUnit(deal), after: { amountMinor: refund.amount_minor, currency: refund.currency, reason: refund.reason, paymentId: payment.id } });
    await refundEvent(trx, refund, deal, 'refund.requested', req.auth.user.id);
    return refund.id;
  });
  return presentOne(req, id);
}

export async function reviewRefund(req, id, { approve, note }) {
  await db.transaction(async (trx) => {
    const refund = await loadRefund(req, id, { permission: 'billing.approve_refunds', trx, forUpdate: true });
    if (refund.status !== 'requested') throw errors.conflict(`This refund is already ${refund.status}`);
    if (approve && refund.requested_by === req.auth.user.id) throw errors.forbidden('Someone else must approve a refund you requested');
    const deal = await trx('deals').where({ id: refund.deal_id }).first();
    const [saved] = await trx('refunds')
      .where({ id })
      .update({ status: approve ? 'approved' : 'rejected', reviewed_by: req.auth.user.id, reviewed_at: trx.fn.now(), review_note: note ?? null, updated_at: trx.fn.now() })
      .returning('*');
    const action = approve ? 'refund.approved' : 'refund.rejected';
    await writeAudit(trx, req, { action, entityType: 'refund', entityId: id, unit: auditUnit(deal), before: { status: 'requested' }, after: { status: saved.status }, meta: note ? { note } : undefined });
    await refundEvent(trx, saved, deal, action, req.auth.user.id, { requestedBy: refund.requested_by });
  });
  if (approve) await processRefund(id, { req });
  return presentOne(req, id);
}

export async function retryRefund(req, id) {
  const refund = await loadRefund(req, id, { permission: 'billing.approve_refunds' });
  if (refund.status !== 'failed') throw errors.conflict('Only a failed refund can be retried');
  await db('refunds').where({ id, status: 'failed' }).update({ status: 'approved', updated_at: db.fn.now() });
  await processRefund(id, { req });
  return presentOne(req, id);
}

/**
 * Send an approved refund to the provider (or complete an offline one). Safe to call again: the
 * idempotency key is the refund's own, so the provider returns the same refund.
 */
export async function processRefund(id, { req = null } = {}) {
  const refund = await db('refunds').where({ id }).first();
  if (!refund || refund.status !== 'approved') return refund;
  const actorUserId = req?.auth?.user?.id ?? null;
  if (refund.provider === 'manual') {
    await db.transaction(async (trx) => {
      const locked = await trx('refunds').where({ id }).forUpdate().first();
      if (locked.status !== 'approved') return;
      await markRefundProcessed(trx, locked, { actorUserId, req });
    });
    return db('refunds').where({ id }).first();
  }
  const payment = await db('payments').where({ id: refund.payment_id }).first();
  const account = payment.account_id ? await db('billing_payment_accounts').where({ id: payment.account_id }).first() : null;
  await db('refunds').where({ id }).update({ attempts: db.raw('attempts + 1'), updated_at: db.fn.now() });
  let result;
  try {
    const gateway = await ports.paymentGateway({ companyId: refund.company_id, provider: refund.provider, account });
    result = await gateway.createRefund({
      providerPaymentId: payment.provider_payment_id,
      amountMinor: minor(refund.amount_minor),
      currency: refund.currency,
      reference: refund.ref,
      refundId: refund.id,
      idempotencyKey: refund.idempotency_key,
    });
  } catch (err) {
    logger.warn({ refundId: id, code: err.code, outcomeUnknown: err.details?.outcomeUnknown ?? false }, 'money: refund call failed');
    await db.transaction(async (trx) => {
      const deal = await trx('deals').where({ id: refund.deal_id }).first();
      const [saved] = await trx('refunds')
        .where({ id, status: 'approved' })
        .update({ status: 'failed', failure: json({ code: err.code ?? 'provider_error', message: err.message?.slice(0, 300) ?? null, outcomeUnknown: err.details?.outcomeUnknown ?? false }), updated_at: trx.fn.now() })
        .returning('*');
      if (saved) await refundEvent(trx, saved, deal, 'refund.failed', actorUserId, { code: err.code ?? null });
    });
    return db('refunds').where({ id }).first();
  }
  await db.transaction(async (trx) => {
    const locked = await trx('refunds').where({ id }).forUpdate().first();
    if (locked.status !== 'approved') return;
    const [saved] = await trx('refunds').where({ id }).update({ status: 'processing', provider_refund_id: result.refundId, failure: null, updated_at: trx.fn.now() }).returning('*');
    if (result.status === 'processed') await markRefundProcessed(trx, saved, { actorUserId, req });
  });
  return db('refunds').where({ id }).first();
}

/**
 * The money went back (provider webhook, immediate answer, or an offline refund). Inside the
 * caller's transaction with the refund row locked. Idempotent: a processed refund is left alone.
 */
export async function markRefundProcessed(trx, refund, { sourceEventId = null, actorUserId = null, req = null } = {}) {
  if (refund.status === 'processed') return refund;
  const deal = await trx('deals').where({ id: refund.deal_id }).first();
  await trx('payments')
    .where({ id: refund.payment_id })
    .update({ amount_refunded_minor: trx.raw('least(amount_minor, amount_refunded_minor + ?)', [minor(refund.amount_minor)]), updated_at: trx.fn.now() });
  let creditNote = null;
  if (refund.invoice_id) {
    const invoice = await trx('invoices').where({ id: refund.invoice_id }).forUpdate().first();
    if (invoice?.status === 'issued') {
      const unit = await trx('org_units').where({ id: deal.unit_id }).first();
      const ctx = await companyContext(unit, trx);
      const whole = minor(refund.amount_minor) === minor(invoice.total_minor) && minor(invoice.credited_minor) === 0;
      try {
        creditNote = await trx.transaction((sp) =>
          issueCreditNote(sp, {
            invoice,
            deal,
            mode: whole ? 'full' : 'partial',
            refundAmountMinor: minor(refund.amount_minor),
            reason: 'refund',
            refundId: refund.id,
            issueDate: ctx.today(),
            timeZone: ctx.timeZone,
            req,
            actorUserId,
          }),
        );
      } catch (err) {
        // A missing credit-note series must not lose the refund: finance issues the note later.
        if (err?.code !== 'billing_not_set_up' && err?.status !== 422 && err?.status !== 409) throw err;
        logger.warn({ refundId: refund.id, reason: err.message }, 'money: refund processed without a credit note');
      }
    }
  }
  const [saved] = await trx('refunds')
    .where({ id: refund.id })
    .update({ status: 'processed', processed_at: trx.fn.now(), credit_note_id: creditNote?.id ?? null, updated_at: trx.fn.now() })
    .returning('*');
  await writeAudit(trx, req, { action: 'refund.processed', entityType: 'refund', entityId: refund.id, unit: auditUnit(deal), groupId: deal.group_id, actorUserId, after: { status: 'processed', creditNoteId: creditNote?.id ?? null } });
  await refundEvent(trx, saved, deal, 'refund.processed', actorUserId, { creditNoteId: creditNote?.id ?? null, creditNoteNumber: creditNote?.number ?? null });
  await dealTimeline(trx, deal, {
    kind: 'payment',
    title: `Refund processed: ${money(saved.amount_minor, saved.currency)}${creditNote ? ` · credit note ${creditNote.number}` : ''}`,
    meta: { action: 'refund.processed', refundId: saved.id, creditNoteId: creditNote?.id ?? null },
    actorUserId,
    sourceEventId,
  });
  return saved;
}

/** The provider said the refund failed (webhook). */
export async function markRefundFailed(trx, refund, { failure, sourceEventId = null }) {
  if (['processed', 'failed'].includes(refund.status)) return refund;
  const deal = await trx('deals').where({ id: refund.deal_id }).first();
  const [saved] = await trx('refunds').where({ id: refund.id }).update({ status: 'failed', failure: json(failure ?? {}), updated_at: trx.fn.now() }).returning('*');
  await refundEvent(trx, saved, deal, 'refund.failed', null, { code: failure?.code ?? null, sourceEventId });
  return saved;
}
