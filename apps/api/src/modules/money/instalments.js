import { db, json } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { writeAudit } from '../../core/audit.js';
import { emitEvent } from '../../core/events.js';
import { unitsIndex } from '../../core/crm/scope.js';
import { addDays, rescheduleInstalments } from '../../core/billing/index.js';
import { loadBillingRecord } from './access.js';
import { listRecords } from './lists.js';
import { ports } from './ports.js';
import { presentInstalment } from './present.js';
import { auditUnit, companyContext, minor } from './util.js';

// Instalments: lists for the Fees and billing page (due this week, overdue, upcoming, paid) and
// rescheduling a plan when a family needs more time (rescheduleInstalments: paid parts are closed,
// the unpaid balance is spread over a new plan; the old plan is kept as 'rescheduled').

export async function listInstalments(req, query) {
  const index = await unitsIndex(req);
  const unit = index.get(query.unitId);
  const ctx = unit ? await companyContext(unit) : null;
  const today = ctx?.today() ?? new Date().toISOString().slice(0, 10);
  const { page, nextCursor } = await listRecords(req, {
    table: 'instalments',
    unitId: query.unitId,
    cursor: query.cursor,
    limit: query.limit,
    sortColumn: 'due_date',
    sortOrder: query.state === 'paid' ? 'desc' : 'asc',
    select: ['p.count as plan_count'],
    filter: (q) => {
      q.join('instalment_plans as p', 'p.id', 'r.plan_id');
      if (query.dealId) q.where('r.deal_id', query.dealId);
      if (query.state === 'paid') q.where('r.status', 'paid');
      else if (query.state !== 'all') q.where('r.status', 'pending');
      if (query.state === 'overdue') q.where('r.due_date', '<', today);
      if (query.state === 'due') q.where('r.due_date', '>=', today).where('r.due_date', '<=', addDays(today, 7));
      if (query.state === 'upcoming') q.where('r.due_date', '>=', today);
    },
  });
  return { data: page.map((row) => presentInstalment(row, today)), nextCursor, today };
}

export async function reschedulePlan(req, planId, body) {
  const cancelLinks = [];
  const newPlanId = await db.transaction(async (trx) => {
    const plan = await loadBillingRecord(req, 'instalment_plans', planId, { permission: 'billing.manage', notFound: 'Instalment plan', trx, forUpdate: true });
    if (plan.status !== 'active') throw errors.conflict(`A ${plan.status} plan can't be rescheduled`);
    const inFlight = await trx('payments as p')
      .join('instalments as i', 'i.id', 'p.instalment_id')
      .where('i.plan_id', planId)
      .whereIn('p.status', ['creating', 'pending'])
      .first('p.id');
    if (inFlight) throw errors.conflict('A payment for this plan is in progress: wait for it to finish');
    const current = await trx('instalments').where({ plan_id: planId }).orderBy('number').forUpdate();
    const schedule =
      body.frequency === 'custom'
        ? { frequency: 'custom', dates: body.dates ?? [] }
        : { frequency: 'monthly', startDate: body.startDate, ...(body.dayOfMonth ? { dayOfMonth: body.dayOfMonth } : {}) };
    if (body.frequency === 'monthly' && !body.startDate) throw errors.validation([{ path: 'body.startDate', message: 'Pick the first new due date' }]);
    const result = rescheduleInstalments({
      instalments: current.filter((i) => i.status !== 'cancelled').map((i) => ({ dueDate: i.due_date, amountMinor: minor(i.amount_minor), paidMinor: minor(i.paid_minor) })),
      count: body.count,
      schedule,
    });
    if (!result.rescheduled.length) throw errors.conflict('Nothing is left to pay on this plan');
    // Close the old plan: part-paid instalments become paid at what was paid, unpaid ones cancelled.
    for (const instalment of current) {
      if (instalment.status !== 'pending') continue;
      const paid = minor(instalment.paid_minor);
      await trx('instalments')
        .where({ id: instalment.id })
        .update(paid > 0 ? { amount_minor: paid, status: 'paid', paid_at: trx.fn.now(), updated_at: trx.fn.now() } : { status: 'cancelled', updated_at: trx.fn.now() });
    }
    const open = await trx('payments as p')
      .join('instalments as i', 'i.id', 'p.instalment_id')
      .where('i.plan_id', planId)
      .whereIn('p.status', ['link_sent', 'failed'])
      .select('p.id', 'p.provider', 'p.provider_link_id', 'p.account_id', 'p.company_id');
    if (open.length) {
      await trx('payments').whereIn('id', open.map((p) => p.id)).update({ status: 'cancelled', next_retry_at: null, updated_at: trx.fn.now() });
      cancelLinks.push(...open.filter((p) => p.provider_link_id));
    }
    await trx('instalment_plans').where({ id: planId }).update({ status: 'rescheduled', updated_at: trx.fn.now() });
    const [next] = await trx('instalment_plans')
      .insert({
        group_id: plan.group_id,
        company_id: plan.company_id,
        deal_id: plan.deal_id,
        quote_id: plan.quote_id,
        currency: plan.currency,
        total_minor: result.outstandingMinor,
        count: result.rescheduled.length,
        schedule: json({ ...schedule, count: body.count, reason: body.reason }),
        replaces_plan_id: planId,
        created_by: req.auth.user.id,
      })
      .returning('*');
    await trx('instalments').insert(
      result.rescheduled.map((i, n) => ({
        plan_id: next.id,
        group_id: plan.group_id,
        company_id: plan.company_id,
        deal_id: plan.deal_id,
        number: n + 1,
        due_date: i.dueDate,
        amount_minor: i.amountMinor,
        currency: plan.currency,
      })),
    );
    const deal = await trx('deals').where({ id: plan.deal_id }).first();
    // The old plan is recorded in the audit log (BILLING_CORE §6).
    await writeAudit(trx, req, {
      action: 'instalment_plan.rescheduled',
      entityType: 'instalment_plan',
      entityId: next.id,
      unit: auditUnit(deal),
      before: { planId, instalments: current.map((i) => ({ dueDate: i.due_date, amountMinor: minor(i.amount_minor), paidMinor: minor(i.paid_minor), status: i.status })) },
      after: { planId: next.id, instalments: result.rescheduled },
      meta: { reason: body.reason },
    });
    await emitEvent(trx, {
      type: 'instalment_plan.rescheduled',
      groupId: deal.group_id,
      unitId: deal.unit_id,
      aggregateType: 'instalment_plan',
      aggregateId: next.id,
      actorUserId: req.auth.user.id,
      payload: { planId: next.id, replacesPlanId: planId, dealId: deal.id, companyId: plan.company_id, outstandingMinor: result.outstandingMinor, count: result.rescheduled.length, currency: plan.currency },
    });
    return next.id;
  });
  // Best effort: deactivate the old links at the provider (the rows are already cancelled).
  for (const link of cancelLinks) {
    try {
      const account = link.account_id ? await db('billing_payment_accounts').where({ id: link.account_id }).first() : null;
      const gateway = await ports.paymentGateway({ companyId: link.company_id, provider: link.provider, account });
      await gateway.cancelPaymentLink(link.provider_link_id);
    } catch (err) {
      logger.warn({ paymentId: link.id, code: err.code }, 'money: could not cancel an old instalment link');
    }
  }
  return planSummary(req, newPlanId);
}

export async function planSummary(req, planId) {
  const plan = await loadBillingRecord(req, 'instalment_plans', planId, { notFound: 'Instalment plan' });
  const index = await unitsIndex(req);
  const ctx = await companyContext(index.get(plan.deal_unit_id));
  const instalments = await db('instalments').where({ plan_id: planId }).orderBy('number');
  const today = ctx.today();
  return {
    id: plan.id,
    quoteId: plan.quote_id ?? null,
    status: plan.status,
    replacesPlanId: plan.replaces_plan_id ?? null,
    total: { valueMinor: minor(plan.total_minor), currency: plan.currency },
    count: plan.count,
    instalments: instalments.map((i) => presentInstalment({ ...i, plan_count: plan.count, deal_ref: plan.deal_ref, deal_title: plan.deal_title, deal_status: plan.deal_status, deal_kind: plan.deal_kind }, today)),
  };
}
