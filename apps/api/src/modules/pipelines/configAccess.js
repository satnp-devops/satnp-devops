import { z } from 'zod';
import { db } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { writeAudit } from '../../core/audit.js';
import { emitEvent } from '../../core/events.js';
import { companiesInScope, requireCompany, unitsIndex } from '../../core/crm/scope.js';
import { booleanQuery } from '../../core/crm/schemas.js';

// Shared by the configuration modules (pipelines, catalog, fields): docs/crm/PHASE2_CONTRACT.md §4.1 rule 6.
// Configuration belongs to a company. Reading needs the view permission at, above or anywhere
// inside the company; writing needs the manage permission at the company itself (or above).
// Records of companies the user can't read are 404; readable but not manageable is 403.

/** Query part shared by the configuration lists: exactly one of unitId (working unit) or companyId. */
export const configScopeShape = {
  unitId: z.uuid().optional(),
  companyId: z.uuid().optional(),
  includeArchived: booleanQuery.optional(),
};

/** Adds the "exactly one of unitId or companyId" rule to a list query schema. */
export function exactlyOneScope(value, ctx) {
  if (Boolean(value.unitId) === Boolean(value.companyId)) {
    ctx.addIssue({ code: 'custom', path: ['unitId'], message: 'Give either unitId or companyId' });
  }
}

/**
 * The companies a configuration list covers: one company by id, or every company the working
 * unit belongs to or contains (all companies at group scope). 404 for an invisible unit or
 * company; 403 when the user holds the permission nowhere in or above the working unit.
 * @returns {Promise<object[]>} company units, sorted by name
 */
export async function configCompanies(req, { unitId, companyId }, permission, { trx = db } = {}) {
  if (companyId) return [await requireCompany(req, companyId, permission, { trx, path: 'query.companyId' })];
  const companies = await companiesInScope(req, unitId, permission, { trx });
  if (companies.length === 0) {
    const unit = (await unitsIndex(req, trx)).get(unitId);
    if (!unit || !req.access.canAnywhereWithin(permission, unit.path)) throw errors.forbidden();
  }
  return companies;
}

/** Sort rows by the order of their company in `companies` (by name), then by `compare`. */
export function sortByCompany(rows, companies, compare) {
  const order = new Map(companies.map((company, index) => [company.id, index]));
  return [...rows].sort((a, b) => (order.get(a.company_id) ?? 0) - (order.get(b.company_id) ?? 0) || compare(a, b));
}

export const byPosition = (a, b) => a.position - b.position || String(a.name ?? a.label ?? '').localeCompare(String(b.name ?? b.label ?? ''));

/**
 * Load one configuration row and check access to its company.
 *   read  (manage omitted): the view permission at, above or inside the company, else 404
 *   write (manage given):   404 when the user can't read it, 403 without the manage permission at the company
 * @returns {Promise<{ row: object, company: object }>}
 */
export async function loadConfigRow(req, { table, id, view, manage, notFound, trx = db, forUpdate = false }) {
  const row = await trx(table)
    .where({ id })
    .modify((query) => {
      if (forUpdate) query.forUpdate();
    })
    .first();
  if (!row) throw errors.notFound(notFound);
  const company = (await unitsIndex(req, trx)).get(row.company_id);
  if (!company || !req.access.canSee(company.path) || !req.access.canAnywhereWithin(view, company.path)) {
    throw errors.notFound(notFound);
  }
  if (manage && !req.access.can(manage, company.path)) throw errors.forbidden();
  return { row, company };
}

/** The company for a write that names it (POST bodies): 404 invisible, 403 without manage, 422 not a company. */
export const requireManagedCompany = (req, companyId, permission, { trx = db, path = 'body.companyId' } = {}) =>
  requireCompany(req, companyId, permission, { write: true, trx, path });

/**
 * Audit entry and domain event for one configuration change, in the change's transaction.
 * Configuration is owned by the company, so both are recorded at the company unit.
 */
export async function recordChange(trx, req, { company, action, entityType, entityId, before, after, meta, event }) {
  await writeAudit(trx, req, {
    action,
    entityType,
    entityId,
    unit: { id: company.id, root_id: company.root_id },
    before,
    after,
    meta,
  });
  await emitEvent(trx, {
    type: event?.type ?? action,
    groupId: company.root_id,
    unitId: company.id,
    aggregateType: entityType,
    aggregateId: entityId,
    actorUserId: req.auth.user.id,
    payload: event?.payload ?? {},
  });
}

/** Postgres unique violations (23505) on a named index become a 409 with a readable message. */
export function isUniqueViolation(error, constraint) {
  return error?.code === '23505' && (!constraint || error.constraint === constraint);
}

/** Run a write and turn unique violations on the given indexes into 409s: { indexName: message }. */
export async function withUniqueConflicts(messages, fn) {
  try {
    return await fn();
  } catch (error) {
    if (error?.code === '23505' && messages[error.constraint]) throw errors.conflict(messages[error.constraint]);
    throw error;
  }
}

/** The next free position in a company's list (max + 1, or 0). */
export async function nextPosition(trx, table, where) {
  const row = await trx(table).where(where).max('position as max').first();
  return row?.max === null || row?.max === undefined ? 0 : Number(row.max) + 1;
}

/** ISO string in UTC for timestamps that come back as text (json_agg) or Date objects. */
export const toIso = (value) => (value ? new Date(value).toISOString() : null);

/** Field names whose values differ, for event payloads ({ changes: [...] }). */
export function changedKeys(before, after) {
  return Object.keys(after).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
}

/** Pick keys of an object. */
export const pick = (object, keys) => Object.fromEntries(keys.filter((key) => key in object).map((key) => [key, object[key]]));
