import { db } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { applyListScope, levelForRecord, listScope, unitsIndex } from '../../core/crm/scope.js';
import { SENIOR_ROLES } from './constants.js';

// Scoping for billing records (docs/crm/PHASE2_CONTRACT.md §4 rules, applied through the deal).
// Quotes, payments, invoices, instalments, agreements, refunds and subscriptions all belong to a
// deal; a user sees one when they hold billing.view at the deal's unit (own level: the deal's
// owner). Records outside that are 404. Lists join deals as `d` and filter with the deal's unit
// and owner, plus the record's own company_id / group_id so the company-leading indexes are used.

export const DEAL_COLUMNS = [
  'd.unit_id as deal_unit_id',
  'd.owner_user_id as deal_owner_user_id',
  'd.ref as deal_ref',
  'd.title as deal_title',
  'd.kind as deal_kind',
  'd.status as deal_status',
  'd.primary_contact_id as deal_primary_contact_id',
  'd.account_id as deal_account_id',
];

const RECORD_OPTS = { unitColumn: 'deal_unit_id', ownerColumns: ['deal_owner_user_id'] };

/** Level ('all' | 'own' | null) for a permission on a billing row loaded with DEAL_COLUMNS. */
export async function billingLevel(req, permission, row, trx = db) {
  const index = await unitsIndex(req, trx);
  return levelForRecord(req.access, index, permission, row, { userId: req.auth.user.id, ...RECORD_OPTS });
}

/**
 * Load a billing record the user may see (billing.view), or 404. With `permission` also require
 * that permission on it (403 when visible but not allowed). forUpdate locks the record's row.
 */
export async function loadBillingRecord(req, table, id, { permission = null, notFound = 'Item', trx = db, forUpdate = false } = {}) {
  const query = trx(`${table} as r`).join('deals as d', 'd.id', 'r.deal_id').where('r.id', id).first(['r.*', ...DEAL_COLUMNS]);
  if (forUpdate) query.forUpdate('r');
  const row = await query;
  if (!row) throw errors.notFound(notFound);
  const viewLevel = await billingLevel(req, 'billing.view', row, trx);
  if (!viewLevel) throw errors.notFound(notFound);
  if (permission && permission !== 'billing.view') {
    const level = await billingLevel(req, permission, row, trx);
    if (!level) throw errors.forbidden();
  }
  return row;
}

/**
 * A deal referenced by a request body (dealId). Invisible → 422 on the field (contract §4.1 rule 8);
 * visible without the permission → 403. Archived deals take no new billing documents.
 */
export async function loadDealForBilling(req, dealId, permission, { trx = db, forUpdate = false, path = 'body.dealId' } = {}) {
  const query = trx('deals').where({ id: dealId }).first();
  if (forUpdate) query.forUpdate();
  const deal = await query;
  const notFound = () => errors.validation([{ path, message: 'Deal not found' }]);
  if (!deal) throw notFound();
  const index = await unitsIndex(req, trx);
  const opts = { userId: req.auth.user.id, unitColumn: 'unit_id', ownerColumns: ['owner_user_id'] };
  if (!levelForRecord(req.access, index, 'billing.view', deal, opts)) throw notFound();
  if (!levelForRecord(req.access, index, permission, deal, opts)) throw errors.forbidden();
  if (deal.archived_at) throw errors.conflict('This deal is archived');
  return { deal, unit: index.get(deal.unit_id), company: index.get(deal.company_id) };
}

/** A deal the user can see billing for, by path parameter (404 otherwise). */
export async function loadDealVisible(req, dealId, trx = db) {
  const deal = await trx('deals').where({ id: dealId }).first();
  if (!deal) throw errors.notFound('Deal');
  const index = await unitsIndex(req, trx);
  const opts = { userId: req.auth.user.id, unitColumn: 'unit_id', ownerColumns: ['owner_user_id'] };
  const level = levelForRecord(req.access, index, 'billing.view', deal, opts);
  if (!level) throw errors.notFound('Deal');
  return { deal, unit: index.get(deal.unit_id), canManage: Boolean(levelForRecord(req.access, index, 'billing.manage', deal, opts)) };
}

/** listScope for billing lists (404 invisible working unit, 403 no permission there). */
export const billingListScope = (req, permission, unitId) => listScope(req, permission, { unitId });

/** Filter a query that joins `deals as d` to a billing scope. */
export function applyBillingScope(query, scope, alias) {
  return applyListScope(query, scope, {
    unitColumn: 'd.unit_id',
    ownerColumns: ['d.owner_user_id'],
    companyColumn: `${alias}.company_id`,
    groupColumn: `${alias}.group_id`,
  });
}

/**
 * Role keys the user holds at a unit (roles at the unit or above), with the built-in roles that
 * senior roles stand in for (SENIOR_ROLES). Used by the discount policy. Pure.
 */
export function roleKeysAt(access, unitPath) {
  const keys = new Set();
  for (const assignment of access.covering(unitPath)) {
    keys.add(assignment.roleKey);
    for (const junior of SENIOR_ROLES[assignment.roleKey] ?? []) keys.add(junior);
  }
  return [...keys];
}

/** Is the user allowed `permission` at the deal's unit (own level counts when they own the deal)? */
export async function canOnDeal(req, permission, deal, trx = db) {
  const index = await unitsIndex(req, trx);
  return Boolean(levelForRecord(req.access, index, permission, deal, { userId: req.auth.user.id, unitColumn: 'unit_id', ownerColumns: ['owner_user_id'] }));
}
