import { db } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { writeAudit } from '../../core/audit.js';
import { emitEvent } from '../../core/events.js';
import { minorFromDb } from '../../core/crm/money.js';
import { crmSetting } from '../../core/crm/settings.js';
import { levelForRecord, listScope, unitsIndex } from '../../core/crm/scope.js';
import { dealVisibility, LINK_SCOPE, loadVisibleLink, requireOnLink, scopeThroughLink } from './access.js';
import { PERMISSIONS } from './constants.js';
import { loadRefs, presentClawback, presentCommission } from './present.js';
import { choosePlan, clawbackFor, clawbackUntil, computeCommission, shouldAccrue } from './rules.js';
import { paymentSucceededPayload, refundProcessedPayload } from './schemas.js';
import { attributionModelSetting } from './settings.js';
import { recomputeDraftPayout } from './payouts.js';
import { cursorAt, instantOr, lockKey, newestFirst, newestPage } from './util.js';

// Commissions: accrued when a referred deal's payment succeeds (payment.succeeded), clawed back
// when it is refunded inside the plan's window (refund.processed), approved by finance, then paid
// in a payout batch (payouts.js). Both event handlers are idempotent: one commission per payment
// (unique company + payment id) and one clawback per commission and refund.

const systemAudit = (trx, entry) => writeAudit(trx, null, { actorType: 'system', ...entry });

// ---------- Accrual (payment.succeeded) ----------

/**
 * Accrue the commission a payment earns, if any.
 * @returns {Promise<{ status: 'accrued' | 'duplicate' | 'ignored', reason?: string, commissionId?: string }>}
 */
export async function accrueCommission(trx, rawPayload, { eventId = null } = {}) {
  const parsed = paymentSucceededPayload.safeParse(rawPayload);
  if (!parsed.success) return { status: 'ignored', reason: 'invalid_payload' };
  const payment = parsed.data;
  await lockKey(trx, `partners:deal:${payment.dealId}`);

  const existing = await trx('partner_commissions').where({ company_id: payment.companyId, payment_id: payment.paymentId }).first('id');
  if (existing) return { status: 'duplicate', commissionId: existing.id };

  const deal = await trx('deals')
    .where({ id: payment.dealId, company_id: payment.companyId })
    .first('id', 'group_id', 'company_id', 'unit_id', 'product_line_id', 'value_minor', 'currency');
  if (!deal) return { status: 'ignored', reason: 'deal_not_found' };

  const attributions = await trx('partner_attributions').where({ deal_id: deal.id });
  if (attributions.length === 0) return { status: 'ignored', reason: 'not_referred' };
  const company = await trx('org_units').where({ id: deal.company_id }).first('id', 'path', 'root_id', 'type');
  const model = await crmSetting(company, attributionModelSetting, trx);
  const preferred = model === 'last_touch' ? 'last' : 'first';
  const attribution = attributions.find((a) => a.touch === preferred) ?? attributions[0];

  const link = await trx('partner_companies').where({ partner_id: attribution.partner_id, company_id: deal.company_id }).first();
  if (!link || link.status !== 'active') return { status: 'ignored', reason: 'partnership_inactive' };

  const plans = await trx('commission_plans').where({ company_id: deal.company_id });
  const plan = choosePlan(plans, {
    overridePlanId: link.commission_plan_id,
    productLineId: payment.productLineId ?? deal.product_line_id,
    currency: payment.currency,
  });
  if (!plan) return { status: 'ignored', reason: 'no_plan' };

  const earned = await trx('partner_commissions').where({ deal_id: deal.id }).whereNot('status', 'rejected').first('id');
  const decision = shouldAccrue(plan, payment, { alreadyEarned: Boolean(earned) });
  if (!decision.accrue) return { status: 'ignored', reason: decision.reason };
  const amount = computeCommission(plan, payment, deal);
  if (!amount) return { status: 'ignored', reason: 'nothing_earned' };

  const earnedAt = instantOr(payment.paidAt);
  const [row] = await trx('partner_commissions')
    .insert({
      group_id: deal.group_id,
      company_id: deal.company_id,
      partner_id: attribution.partner_id,
      plan_id: plan.id,
      attribution_id: attribution.id,
      deal_id: deal.id,
      payment_id: payment.paymentId,
      source_event_id: eventId,
      trigger: plan.trigger,
      basis: plan.basis,
      rate_bps: amount.rateBps,
      base_minor: amount.baseMinor,
      base_currency: amount.baseCurrency,
      amount_minor: amount.amountMinor,
      currency: amount.currency,
      status: 'pending',
      earned_at: earnedAt,
      clawback_until: clawbackUntil(earnedAt, plan.clawback_days),
      plan_snapshot: JSON.stringify({
        name: plan.name,
        basis: plan.basis,
        rateBps: plan.rate_bps,
        fixedMinor: plan.fixed_minor != null ? Number(plan.fixed_minor) : null,
        currency: plan.currency,
        trigger: plan.trigger,
        clawbackDays: plan.clawback_days,
        capMinor: plan.cap_minor != null ? Number(plan.cap_minor) : null,
        attributionModel: model,
      }),
    })
    .onConflict(['company_id', 'payment_id'])
    .ignore()
    .returning('*');
  if (!row) return { status: 'duplicate' };

  const unit = { id: link.unit_id, root_id: link.group_id };
  await systemAudit(trx, {
    action: 'partner.commission_accrued',
    entityType: 'partner_commission',
    entityId: row.id,
    unit,
    after: { partnerId: row.partner_id, dealId: deal.id, paymentId: row.payment_id, amountMinor: amount.amountMinor, currency: amount.currency, planId: plan.id },
  });
  await emitEvent(trx, {
    type: 'partner.commission_accrued',
    groupId: deal.group_id,
    unitId: link.unit_id,
    aggregateType: 'partner_commission',
    aggregateId: row.id,
    payload: {
      commissionId: row.id,
      partnerId: row.partner_id,
      companyId: deal.company_id,
      dealId: deal.id,
      paymentId: row.payment_id,
      amountMinor: amount.amountMinor,
      currency: amount.currency,
      planId: plan.id,
    },
  });
  return { status: 'accrued', commissionId: row.id };
}

// ---------- Clawback (refund.processed) ----------

/**
 * Claw back commissions for a refund: the payment's commission (by payment id), or the deal's when
 * the refund names only the deal. Inside the plan's window only.
 *   not yet paid → netted (the commission is just smaller; a draft batch holding it is recounted)
 *   paid, or in an approved batch → deduct (recovered from the partner's next payout)
 * @returns {Promise<Array<{ commissionId: string, status: 'clawed_back' | 'duplicate' | 'ignored', reason?: string, amountMinor?: number }>>}
 */
export async function clawbackCommissions(trx, rawPayload, { eventId = null } = {}) {
  const parsed = refundProcessedPayload.safeParse(rawPayload);
  if (!parsed.success) return [{ commissionId: null, status: 'ignored', reason: 'invalid_payload' }];
  const refund = parsed.data;
  if (!refund.paymentId && !refund.dealId) return [{ commissionId: null, status: 'ignored', reason: 'no_payment' }];

  const lookup = trx('partner_commissions').whereNot('status', 'rejected');
  if (refund.paymentId) lookup.where('payment_id', refund.paymentId);
  else lookup.where('deal_id', refund.dealId);
  if (refund.companyId) lookup.where('company_id', refund.companyId);
  const candidates = await lookup.select('id', 'deal_id');
  const results = [];
  for (const { id, deal_id: dealId } of candidates) {
    await lockKey(trx, `partners:deal:${dealId}`);
    const commission = await trx('partner_commissions').where({ id }).forUpdate().first();
    const already = await trx('partner_commission_clawbacks').where({ commission_id: id, refund_id: refund.refundId }).first('id');
    if (already) {
      results.push({ commissionId: id, status: 'duplicate' });
      continue;
    }
    const refundedAt = instantOr(refund.processedAt);
    const { amountMinor, reason } = clawbackFor(commission, {
      amountMinor: refund.amountMinor,
      currency: refund.currency,
      full: refund.full,
      refundedAt,
    });
    if (!amountMinor) {
      results.push({ commissionId: id, status: 'ignored', reason });
      continue;
    }
    const payout = commission.payout_id ? await trx('partner_payouts').where({ id: commission.payout_id }).forUpdate().first() : null;
    const recovery = commission.status === 'paid' || payout?.status === 'approved' || payout?.status === 'paid' ? 'deduct' : 'netted';
    const [clawback] = await trx('partner_commission_clawbacks')
      .insert({
        group_id: commission.group_id,
        company_id: commission.company_id,
        commission_id: id,
        partner_id: commission.partner_id,
        refund_id: refund.refundId,
        payment_id: refund.paymentId ?? commission.payment_id,
        source_event_id: eventId,
        amount_minor: amountMinor,
        currency: commission.currency,
        recovery,
        refunded_at: refundedAt,
      })
      .onConflict(['commission_id', 'refund_id'])
      .ignore()
      .returning('*');
    if (!clawback) {
      results.push({ commissionId: id, status: 'duplicate' });
      continue;
    }
    const clawed = Number(commission.clawed_back_minor) + amountMinor;
    const fully = clawed >= Number(commission.amount_minor);
    const patch = { clawed_back_minor: clawed, updated_at: trx.fn.now() };
    if (fully) {
      patch.status = 'clawed_back';
      patch.clawed_back_at = trx.fn.now();
    }
    // A fully clawed-back commission leaves a draft batch; a partial one stays with a smaller amount.
    const inDraft = payout?.status === 'draft';
    if (fully && inDraft) patch.payout_id = null;
    await trx('partner_commissions').where({ id }).update(patch);
    if (inDraft) await recomputeDraftPayout(trx, payout.id);

    const link = await trx('partner_companies').where({ partner_id: commission.partner_id, company_id: commission.company_id }).first('unit_id', 'group_id');
    const unitId = link?.unit_id ?? commission.company_id;
    await systemAudit(trx, {
      action: 'partner.commission_clawed_back',
      entityType: 'partner_commission',
      entityId: id,
      unit: { id: unitId, root_id: commission.group_id },
      before: { clawedBackMinor: Number(commission.clawed_back_minor), status: commission.status },
      after: { clawedBackMinor: clawed, status: patch.status ?? commission.status, refundId: refund.refundId, recovery },
    });
    await emitEvent(trx, {
      type: 'partner.commission_clawed_back',
      groupId: commission.group_id,
      unitId,
      aggregateType: 'partner_commission',
      aggregateId: id,
      payload: {
        commissionId: id,
        clawbackId: clawback.id,
        partnerId: commission.partner_id,
        companyId: commission.company_id,
        dealId: commission.deal_id,
        refundId: refund.refundId,
        amountMinor,
        currency: commission.currency,
        recovery,
        fully,
      },
    });
    results.push({ commissionId: id, status: 'clawed_back', amountMinor, recovery });
  }
  if (results.length === 0) results.push({ commissionId: null, status: 'ignored', reason: 'no_commission' });
  return results;
}

// ---------- Endpoints ----------

function commissionsQuery(scope, { partnerId, dealId, status, currency }) {
  const query = scopeThroughLink(db('partner_commissions as c'), scope, 'c');
  if (partnerId) query.where('c.partner_id', partnerId);
  if (dealId) query.where('c.deal_id', dealId);
  if (status) query.where('c.status', status);
  if (currency) query.where('c.currency', currency);
  return query;
}

async function presentCommissions(req, rows, trx = db) {
  if (rows.length === 0) return [];
  const [index, refs] = await Promise.all([
    unitsIndex(req, trx),
    loadRefs(
      {
        dealIds: rows.map((r) => r.deal_id),
        partnerIds: rows.map((r) => r.partner_id),
        planIds: rows.map((r) => r.plan_id),
        payoutIds: rows.map((r) => r.payout_id),
        userIds: rows.map((r) => r.approved_by),
      },
      trx,
    ),
  ]);
  const { visibleDealIds } = await dealVisibility(req, [...refs.deals.values()], trx);
  const userId = req.auth.user.id;
  return rows.map((row) => {
    const link = { unit_id: row.link_unit_id, owner_user_id: row.link_owner_user_id };
    const canApprove = Boolean(levelForRecord(req.access, index, PERMISSIONS.approveCommissions, link, { userId, ...LINK_SCOPE }));
    return presentCommission(row, { unitsById: index, refs, visibleDealIds, canApprove });
  });
}

/** GET /partner-commissions: newest first, with filters. */
export async function listCommissions(req, { unitId, cursor, limit, ...filters }) {
  const scope = await listScope(req, PERMISSIONS.view, { unitId });
  const query = commissionsQuery(scope, filters).select('c.*', 'pc.unit_id as link_unit_id', 'pc.owner_user_id as link_owner_user_id', cursorAt('c.created_at'));
  newestFirst(query, { cursor, limit, createdColumn: 'c.created_at', idColumn: 'c.id' });
  const { page, nextCursor } = newestPage(await query, limit);
  return { data: await presentCommissions(req, page), nextCursor };
}

/**
 * GET /partner-commissions/summary: payable totals per status and currency, and everything clawed
 * back so far (from commissions of any status) per currency.
 */
export async function commissionSummary(req, { unitId, partnerId }) {
  const scope = await listScope(req, PERMISSIONS.view, { unitId });
  const rows = await commissionsQuery(scope, { partnerId })
    .groupBy('c.status', 'c.currency')
    .select('c.status', 'c.currency', db.raw('count(*)::int as n'), db.raw('sum(c.amount_minor - c.clawed_back_minor) as total'), db.raw('sum(c.clawed_back_minor) as clawed'));
  const clawed = new Map();
  for (const row of rows) clawed.set(row.currency, (clawed.get(row.currency) ?? 0) + minorFromDb(row.clawed));
  return {
    statuses: rows.map((row) => ({ status: row.status, count: row.n, total: { valueMinor: minorFromDb(row.total), currency: row.currency } })),
    clawedBack: [...clawed].filter(([, minor]) => minor > 0).map(([currency, valueMinor]) => ({ valueMinor, currency })),
  };
}

async function loadScopedCommission(req, id, trx, { forUpdate = false } = {}) {
  const query = trx('partner_commissions').where({ id }).first();
  if (forUpdate) query.forUpdate();
  const row = await query;
  if (!row) throw errors.notFound('Commission');
  const link = await loadVisibleLink(req, { partnerId: row.partner_id, companyId: row.company_id, trx, notFound: 'Commission' });
  return { row: { ...row, link_unit_id: link.unit_id, link_owner_user_id: link.owner_user_id }, link };
}

/** GET /partner-commissions/:id with its clawbacks. */
export async function getCommission(req, id) {
  const { row } = await loadScopedCommission(req, id, db);
  const [presented] = await presentCommissions(req, [row]);
  const clawbacks = await db('partner_commission_clawbacks').where({ commission_id: id }).orderBy('created_at');
  return { ...presented, clawbacks: clawbacks.map(presentClawback), planTerms: row.plan_snapshot ?? {} };
}

async function decide(req, id, { to, reason = null }) {
  await db.transaction(async (trx) => {
    const { row, link } = await loadScopedCommission(req, id, trx, { forUpdate: true });
    await requireOnLink(req, PERMISSIONS.approveCommissions, link, trx, 'Only finance can approve commissions');
    if (to === 'approved' && row.status !== 'pending') throw errors.conflict(`This commission is ${row.status.replace('_', ' ')}; only pending ones can be approved`);
    if (to === 'rejected' && !(row.status === 'pending' || (row.status === 'approved' && !row.payout_id))) {
      throw errors.conflict('Only pending commissions, or approved ones not yet in a payout, can be rejected');
    }
    const patch =
      to === 'approved'
        ? { status: 'approved', approved_by: req.auth.user.id, approved_at: trx.fn.now() }
        : { status: 'rejected', rejected_by: req.auth.user.id, rejected_at: trx.fn.now(), rejection_reason: reason };
    await trx('partner_commissions')
      .where({ id })
      .update({ ...patch, updated_at: trx.fn.now() });
    const action = to === 'approved' ? 'partner.commission_approved' : 'partner.commission_rejected';
    await writeAudit(trx, req, {
      action,
      entityType: 'partner_commission',
      entityId: id,
      unit: { id: link.unit_id, root_id: link.group_id },
      before: { status: row.status },
      after: { status: to, ...(reason ? { reason } : {}) },
    });
    await emitEvent(trx, {
      type: action,
      groupId: row.group_id,
      unitId: link.unit_id,
      aggregateType: 'partner_commission',
      aggregateId: id,
      actorUserId: req.auth.user.id,
      payload: { commissionId: id, partnerId: row.partner_id, companyId: row.company_id, amountMinor: Number(row.amount_minor), currency: row.currency },
    });
  });
}

export async function approveCommission(req, id) {
  await decide(req, id, { to: 'approved' });
  return getCommission(req, id);
}

export async function rejectCommission(req, id, { reason }) {
  await decide(req, id, { to: 'rejected', reason });
  return getCommission(req, id);
}

/** POST /partner-commissions/approve: up to 100 at once, one transaction each. */
export async function bulkApprove(req, { ids }) {
  const approved = [];
  const skipped = [];
  for (const id of [...new Set(ids)]) {
    try {
      await decide(req, id, { to: 'approved' });
      approved.push(id);
    } catch (error) {
      if (!error.status || error.status >= 500) throw error;
      skipped.push({ id, code: error.code, message: error.message });
    }
  }
  return { approved, skipped };
}
