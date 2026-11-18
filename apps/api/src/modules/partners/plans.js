import { db } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { writeAudit } from '../../core/audit.js';
import { emitEvent } from '../../core/events.js';
import { companiesInScope, requireCompany, unitsIndex } from '../../core/crm/scope.js';
import { PERMISSIONS } from './constants.js';
import { loadRefs, presentPlan } from './present.js';
import { planAmountIssues } from './schemas.js';

// Commission plans (Settings > Partner programmes): per company and optionally product line,
// a percent of the fee or a fixed amount, earned on the first payment or when the fee is fully
// paid, with a clawback window. Plans are never deleted (commissions refer to them); turn them off.

async function presentPlans(req, rows, trx = db) {
  if (rows.length === 0) return [];
  const [index, refs] = await Promise.all([unitsIndex(req, trx), loadRefs({ productLineIds: rows.map((r) => r.product_line_id) }, trx)]);
  return rows.map((row) => presentPlan(row, { unitsById: index, refs }));
}

/** GET /commission-plans?companyId | ?unitId: every plan of the companies in scope (tens per company). */
export async function listPlans(req, { unitId, companyId }) {
  const companies = companyId
    ? [await requireCompany(req, companyId, PERMISSIONS.view)]
    : await companiesInScope(req, unitId, PERMISSIONS.view);
  if (companies.length === 0) return [];
  const rows = await db('commission_plans')
    .whereIn(
      'company_id',
      companies.map((c) => c.id),
    )
    .orderBy([{ column: 'company_id' }, { column: 'position' }, { column: 'created_at' }, { column: 'id' }])
    .limit(1000);
  return presentPlans(req, rows);
}

async function checkProductLine(trx, companyId, productLineId) {
  if (!productLineId) return null;
  const line = await trx('product_lines').where({ id: productLineId, company_id: companyId }).first('id');
  if (!line) throw errors.validation([{ path: 'body.productLineId', message: 'Pick a product line of this company' }]);
  return line.id;
}

const toRow = (body) => {
  const row = {};
  if (body.name !== undefined) row.name = body.name;
  if (body.description !== undefined) row.description = body.description;
  if (body.basis !== undefined) row.basis = body.basis;
  if (body.rateBps !== undefined) row.rate_bps = body.rateBps;
  if (body.fixedMinor !== undefined) row.fixed_minor = body.fixedMinor;
  if (body.currency !== undefined) row.currency = body.currency;
  if (body.trigger !== undefined) row.trigger = body.trigger;
  if (body.clawbackDays !== undefined) row.clawback_days = body.clawbackDays;
  if (body.capMinor !== undefined) row.cap_minor = body.capMinor;
  if (body.active !== undefined) row.active = body.active;
  if (body.position !== undefined) row.position = body.position;
  return row;
};

/** The amount columns that matter for the plan's basis (a percent plan keeps no fixed amount). */
function tidyAmounts(row) {
  if (row.basis === 'percent') row.fixed_minor = null;
  if (row.basis === 'fixed') row.rate_bps = null;
  return row;
}

const camel = (row) => ({
  name: row.name,
  basis: row.basis,
  rateBps: row.rate_bps ?? null,
  fixedMinor: row.fixed_minor != null ? Number(row.fixed_minor) : null,
  currency: row.currency ?? null,
  trigger: row.trigger,
  clawbackDays: row.clawback_days,
  capMinor: row.cap_minor != null ? Number(row.cap_minor) : null,
  active: row.active,
  productLineId: row.product_line_id ?? null,
});

/** POST /commission-plans (partners.manage_plans at the company). */
export async function createPlan(req, body) {
  const company = await requireCompany(req, body.companyId, PERMISSIONS.managePlans, { write: true, path: 'body.companyId' });
  const issues = planAmountIssues(body);
  if (issues.length) throw errors.validation(issues);
  const id = await db.transaction(async (trx) => {
    const productLineId = await checkProductLine(trx, company.id, body.productLineId);
    const [row] = await trx('commission_plans')
      .insert(
        tidyAmounts({
          group_id: company.root_id,
          company_id: company.id,
          product_line_id: productLineId,
          ...toRow(body),
          created_by: req.auth.user.id,
        }),
      )
      .returning('*');
    await writeAudit(trx, req, { action: 'commission_plan.created', entityType: 'commission_plan', entityId: row.id, unit: company, after: camel(row) });
    await emitEvent(trx, {
      type: 'commission_plan.created',
      groupId: company.root_id,
      unitId: company.id,
      aggregateType: 'commission_plan',
      aggregateId: row.id,
      actorUserId: req.auth.user.id,
      payload: { planId: row.id, companyId: company.id, basis: row.basis, trigger: row.trigger },
    });
    return row.id;
  });
  return (await presentPlans(req, [await db('commission_plans').where({ id }).first()]))[0];
}

/** PATCH /commission-plans/:id. Commissions already accrued keep the terms they were earned on. */
export async function updatePlan(req, planId, body) {
  await db.transaction(async (trx) => {
    const plan = await trx('commission_plans').where({ id: planId }).forUpdate().first();
    if (!plan) throw errors.notFound('Commission plan');
    const index = await unitsIndex(req, trx);
    const company = index.get(plan.company_id);
    if (!company || !req.access.canSee(company.path) || !req.access.canAnywhereWithin(PERMISSIONS.view, company.path)) {
      throw errors.notFound('Commission plan');
    }
    if (!req.access.can(PERMISSIONS.managePlans, company.path)) throw errors.forbidden();
    const patch = toRow(body);
    if (body.productLineId !== undefined) patch.product_line_id = await checkProductLine(trx, plan.company_id, body.productLineId);
    const merged = tidyAmounts({ ...plan, ...patch });
    const issues = planAmountIssues({
      basis: merged.basis,
      rateBps: merged.rate_bps,
      fixedMinor: merged.fixed_minor,
      currency: merged.currency,
      capMinor: merged.cap_minor,
    });
    if (issues.length) throw errors.validation(issues);
    const before = camel(plan);
    const after = camel(merged);
    const changed = Object.keys(after).filter((key) => JSON.stringify(after[key]) !== JSON.stringify(before[key]));
    if (changed.length === 0) return;
    await trx('commission_plans')
      .where({ id: planId })
      .update({ ...patch, rate_bps: merged.rate_bps, fixed_minor: merged.fixed_minor, updated_at: trx.fn.now() });
    await writeAudit(trx, req, { action: 'commission_plan.updated', entityType: 'commission_plan', entityId: planId, unit: company, before, after });
    await emitEvent(trx, {
      type: 'commission_plan.updated',
      groupId: plan.group_id,
      unitId: plan.company_id,
      aggregateType: 'commission_plan',
      aggregateId: planId,
      actorUserId: req.auth.user.id,
      payload: { planId, companyId: plan.company_id, changes: changed },
    });
  });
  return (await presentPlans(req, [await db('commission_plans').where({ id: planId }).first()]))[0];
}
