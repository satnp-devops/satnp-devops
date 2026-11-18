import { db } from '../../lib/db.js';
import { AppError, errors } from '../../lib/errors.js';
import { idsFromPath, isWithin, outermostPaths } from '../orgTree.js';
import { permissionLevel } from '../permissions.js';

// Company scoping for CRM records (docs/crm/PHASE2_CONTRACT.md §4).
//
// Every company-owned record stores group_id, company_id and unit_id (the owning unit inside the
// company). A user sees a record when they hold the permission at its unit (roles flow down the
// tree); with an ":own" grant only when they own it (owner_user_id, or another owner column).
// Lists filter with "unit_id IN (units under the user's roots)", using the org tree's paths, so
// moving a unit never rewrites CRM rows. Records the user can't see are 404.
//
// People and institutes are stored once per group: contacts and accounts become visible to a
// company through link rows (contact_companies / account_companies), which carry the unit and owner.

const UNITS = Symbol('crm.units');

const UNIT_COLUMNS = ['id', 'parent_id', 'root_id', 'type', 'name', 'code', 'path', 'depth', 'status'];

// ---------- Units and companies ----------

/**
 * Every unit of the groups the user works in, keyed by id, loaded once per request.
 * Units are few (tens to hundreds per group), so keeping them in memory is cheap.
 * @returns {Promise<Map<string, { id: string, parent_id: string | null, root_id: string, type: string, name: string, code: string, path: string, depth: number, status: string }>>}
 */
export async function unitsIndex(req, trx = db) {
  if (req[UNITS]) return req[UNITS];
  const groupIds = req.access.groupIds();
  const rows = groupIds.length ? await trx('org_units').whereIn('root_id', groupIds).select(UNIT_COLUMNS) : [];
  req[UNITS] = new Map(rows.map((row) => [row.id, row]));
  return req[UNITS];
}

/** The company a unit belongs to: the nearest ancestor-or-self of type "company", or null for a group. */
export function companyOf(unit, unitsById) {
  if (!unit) return null;
  const ids = idsFromPath(unit.path);
  for (let i = ids.length - 1; i >= 0; i -= 1) {
    const candidate = ids[i] === unit.id ? unit : unitsById.get(ids[i]);
    if (candidate?.type === 'company') return candidate;
  }
  return null;
}

/** Same as companyOf, straight from the database (for seeds, workers and handlers). */
export async function companyForUnit(unitOrId, trx = db) {
  const unit = typeof unitOrId === 'string' ? await trx('org_units').where({ id: unitOrId }).first() : unitOrId;
  if (!unit) return null;
  if (unit.type === 'company') return unit;
  const row = await trx('org_units')
    .whereIn('id', idsFromPath(unit.path))
    .where({ type: 'company' })
    .orderBy('depth', 'desc')
    .first();
  return row ?? null;
}

/** Ids of the units inside any of the paths (each path includes its own unit). */
export function unitIdsWithin(unitsById, paths) {
  if (paths.length === 0) return [];
  const ids = [];
  for (const unit of unitsById.values()) if (paths.some((path) => isWithin(unit.path, path))) ids.push(unit.id);
  return ids;
}

// ---------- List scope ----------

/**
 * The outermost units where the user holds a permission for every record ("all"), and the
 * outermost units where they hold it only for their own records ("own"), leaving out own paths
 * already covered by an all path. Pure.
 */
export function scopePaths(access, permission) {
  const all = [];
  const own = [];
  for (const assignment of access.assignments) {
    const level = permissionLevel(assignment.permissions, permission);
    if (level === 'all') all.push(assignment.unitPath);
    else if (level === 'own') own.push(assignment.unitPath);
  }
  const allPaths = outermostPaths(all);
  const ownPaths = outermostPaths(own).filter((path) => !allPaths.some((kept) => isWithin(path, kept)));
  return { all: allPaths, own: ownPaths };
}

/** Clip paths to a working unit: a path above it becomes the unit itself, paths inside it stay, others go. Pure. */
export function narrowPaths(paths, withinPath) {
  if (!withinPath) return outermostPaths(paths);
  const out = [];
  for (const path of paths) {
    if (isWithin(withinPath, path)) out.push(withinPath);
    else if (isWithin(path, withinPath)) out.push(path);
  }
  return outermostPaths(out);
}

/**
 * Work out what a list may show, inside the working scope ("Working in": the group, a company or a team).
 *   404 when the unit isn't visible, 403 when the user holds the permission nowhere in or above it.
 * @returns {Promise<ListScope>}
 * @typedef {{
 *   permission: string, userId: string, unit: object, company: object | null, groupId: string,
 *   allUnitIds: string[], ownUnitIds: string[], ownOnly: boolean
 * }} ListScope
 */
export async function listScope(req, permission, { unitId, trx = db } = {}) {
  const index = await unitsIndex(req, trx);
  const unit = index.get(unitId);
  if (!unit || !req.access.canSee(unit.path)) throw errors.notFound('Unit');
  if (!req.access.canAnywhereWithin(permission, unit.path)) throw errors.forbidden();
  return scopeFromPaths({
    permission,
    userId: req.auth.user.id,
    unit,
    unitsById: index,
    paths: scopePaths(req.access, permission),
  });
}

/** The pure part of listScope, for tests and for callers that already hold the units. */
export function scopeFromPaths({ permission, userId, unit, unitsById, paths }) {
  const allUnitIds = unitIdsWithin(unitsById, narrowPaths(paths.all, unit.path));
  const ownUnitIds = unitIdsWithin(unitsById, narrowPaths(paths.own, unit.path));
  return {
    permission,
    userId,
    unit,
    company: companyOf(unit, unitsById),
    groupId: unit.root_id,
    allUnitIds,
    ownUnitIds,
    ownOnly: allUnitIds.length === 0,
  };
}

/**
 * Add the unit and owner part of a scope to a query:
 *   (unit IN all-units) OR (unit IN own-units AND (owner column = me OR ...))
 * A scope with nothing in it matches no rows.
 */
export function applyUnitFilter(query, scope, { unitColumn = 'unit_id', ownerColumns = ['owner_user_id'] } = {}) {
  const { allUnitIds, ownUnitIds, userId } = scope;
  const ownApplies = ownUnitIds.length > 0 && ownerColumns.length > 0;
  return query.where((where) => {
    if (allUnitIds.length > 0) where.orWhereIn(unitColumn, allUnitIds);
    if (ownApplies) {
      where.orWhere((own) => {
        own.whereIn(unitColumn, ownUnitIds).andWhere((who) => {
          for (const column of ownerColumns) who.orWhere(column, userId);
        });
      });
    }
    if (allUnitIds.length === 0 && !ownApplies) where.whereRaw('false');
  });
}

/**
 * Filter a list of company-owned records (deals, tasks, saved views...) to a scope. Adds
 * company_id = <company> when the working unit is inside a company (group_id = <group> otherwise),
 * so the company-leading indexes are used, then the unit and owner filter.
 */
export function applyListScope(
  query,
  scope,
  { unitColumn = 'unit_id', ownerColumns = ['owner_user_id'], companyColumn = 'company_id', groupColumn = 'group_id' } = {},
) {
  if (scope.company && companyColumn) query.where(companyColumn, scope.company.id);
  else if (groupColumn) query.where(groupColumn, scope.groupId);
  return applyUnitFilter(query, scope, { unitColumn, ownerColumns });
}

/**
 * Keep people or institutes that have a company link in scope (contacts.view → contact_companies,
 * accounts.view → account_companies). Archived links are left out unless asked for.
 *   whereLinkedInScope(db('contacts as c'), scope, { idColumn: 'c.id' })
 */
export function whereLinkedInScope(
  query,
  scope,
  { linkTable = 'contact_companies', foreignKey = 'contact_id', idColumn = 'c.id', includeArchived = false } = {},
) {
  return query.whereExists(function linked() {
    this.select(db.raw('1')).from(`${linkTable} as l`).whereRaw('?? = ??', [`l.${foreignKey}`, idColumn]);
    if (!includeArchived) this.whereNull('l.archived_at');
    if (scope.company) this.where('l.company_id', scope.company.id);
    applyUnitFilter(this, scope, { unitColumn: 'l.unit_id', ownerColumns: ['l.owner_user_id'] });
  });
}

// ---------- One record ----------

/** 'all', 'own' or null for a permission on a record, given the units map. Pure. */
export function levelForRecord(access, unitsById, permission, record, { userId, unitColumn = 'unit_id', ownerColumns = ['owner_user_id'] } = {}) {
  const unit = unitsById.get(record?.[unitColumn]);
  if (!unit) return null;
  const level = access.level(permission, unit.path);
  if (level === 'all') return 'all';
  if (level === 'own') return ownerColumns.some((column) => record[column] && record[column] === userId) ? 'own' : null;
  return null;
}

/** The user's level for a permission on a record: 'all', 'own' or null. */
export async function recordLevel(req, permission, record, { unitColumn, ownerColumns, trx = db } = {}) {
  const index = await unitsIndex(req, trx);
  return levelForRecord(req.access, index, permission, record, { userId: req.auth.user.id, unitColumn, ownerColumns });
}

/**
 * Load a company-owned record the user may see, or throw 404.
 *   const { row: deal, level } = await loadVisible(req, { table: 'deals', id, permission: 'deals.view', notFound: 'Deal' });
 * Pass forUpdate: true inside a transaction to lock the row.
 */
export async function loadVisible(
  req,
  { table, id, permission, unitColumn = 'unit_id', ownerColumns = ['owner_user_id'], notFound = 'Item', trx = db, forUpdate = false },
) {
  const query = trx(table).where({ id }).first();
  if (forUpdate) query.forUpdate();
  const row = await query;
  if (!row) throw errors.notFound(notFound);
  const level = await recordLevel(req, permission, row, { unitColumn, ownerColumns, trx });
  if (!level) throw errors.notFound(notFound);
  return { row, level };
}

/** Throw 403 unless the user holds a permission on a record they can already see (own scope respected). */
export async function requireRecord(req, permission, record, { unitColumn, ownerColumns, trx = db, message } = {}) {
  const level = await recordLevel(req, permission, record, { unitColumn, ownerColumns, trx });
  if (!level) throw errors.forbidden(message);
  return level;
}

/**
 * Check the unit a new company-owned record will belong to.
 *   404 not visible · 403 no permission there · 409 archived · 422 not inside a company (the group itself)
 * @returns {Promise<{ unit: object, company: object, level: 'all' | 'own' }>}
 */
export async function requireCreateUnit(req, unitId, permission, { trx = db, path = 'body.unitId' } = {}) {
  const index = await unitsIndex(req, trx);
  const unit = index.get(unitId);
  if (!unit || !req.access.canSee(unit.path)) throw errors.notFound('Unit');
  const level = req.access.level(permission, unit.path);
  if (!level) throw errors.forbidden();
  if (unit.status !== 'active') throw errors.conflict(`${unit.name} is archived`);
  const company = companyOf(unit, index);
  if (!company) {
    throw errors.validation([{ path, message: 'Pick a company, branch or team: records belong to a company' }]);
  }
  return { unit, company, level };
}

/** The ownership columns every company-owned record starts with. */
export const ownedColumns = ({ unit, company }) => ({ group_id: unit.root_id, company_id: company.id, unit_id: unit.id });

/**
 * Read company-level configuration (pipelines, products, custom fields) when the user holds the
 * view permission anywhere in or above the company. Writes need the manage permission at the company.
 * @returns {Promise<object>} the company unit
 */
export async function requireCompany(req, companyId, permission, { write = false, trx = db, path = 'companyId' } = {}) {
  const index = await unitsIndex(req, trx);
  const company = index.get(companyId);
  if (!company || !req.access.canSee(company.path)) throw errors.notFound('Company');
  if (company.type !== 'company') throw errors.validation([{ path, message: 'Pick a company' }]);
  const allowed = write ? req.access.can(permission, company.path) : req.access.canAnywhereWithin(permission, company.path);
  if (!allowed) throw errors.forbidden();
  return company;
}

/**
 * The companies a configuration list covers when it is asked for by working unit: the unit's own
 * company when the unit is inside one, otherwise every company under it (a group). Only companies
 * where the user holds the permission at, above or anywhere inside are kept. Sorted by name.
 *   404 when the unit isn't visible.
 * @returns {Promise<object[]>} company units
 */
export async function companiesInScope(req, unitId, permission, { trx = db } = {}) {
  const index = await unitsIndex(req, trx);
  const unit = index.get(unitId);
  if (!unit || !req.access.canSee(unit.path)) throw errors.notFound('Unit');
  const own = companyOf(unit, index);
  const candidates = own ? [own] : [...index.values()].filter((u) => u.type === 'company' && isWithin(u.path, unit.path));
  return candidates
    .filter((company) => req.access.canAnywhereWithin(permission, company.path))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---------- People who can work somewhere ----------

/**
 * Active people holding a permission at a unit (from a role at the unit or above it), for owner
 * and assignee pickers and for validating them. Sorted by name.
 * @returns {Promise<Array<{ id: string, name: string, email: string, level: 'all' | 'own' }>>}
 */
export async function usersWithPermissionAt(unit, permission, { trx = db, userIds } = {}) {
  const rows = await trx('role_assignments as ra')
    .join('users as u', 'u.id', 'ra.user_id')
    .join('roles as r', 'r.id', 'ra.role_id')
    .join('org_units as o', 'o.id', 'ra.org_unit_id')
    .where('u.status', 'active')
    .where('o.status', 'active')
    .whereIn('o.id', idsFromPath(unit.path))
    .modify((query) => {
      if (userIds) query.whereIn('u.id', userIds);
    })
    .select('u.id', 'u.name', 'u.email', 'r.permissions');
  const best = new Map();
  for (const row of rows) {
    const level = permissionLevel(row.permissions ?? [], permission);
    if (!level) continue;
    const current = best.get(row.id);
    if (!current || (current.level === 'own' && level === 'all')) best.set(row.id, { id: row.id, name: row.name, email: row.email, level });
  }
  return [...best.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The level a person holds for a permission at a unit, or null (for checking owners and assignees). */
export async function userLevelAt(userId, unit, permission, { trx = db } = {}) {
  const [match] = await usersWithPermissionAt(unit, permission, { trx, userIds: [userId] });
  return match?.level ?? null;
}

// ---------- Contacts and accounts ----------

/**
 * Decide how a user can reach a person or institute. Pure.
 * A contact (or account) is visible through
 *   (a) a company link in the user's view scope (own: the link's owner), or
 *   (b) a deal the user can see that involves it.
 * Personal details are shown when the user holds contacts.view_pii at a unit they see it through.
 *
 * @param {{ access: object, unitsById: Map, userId: string, links: object[], deals?: object[], kind?: 'contact' | 'account' }} input
 */
export function decideRecordAccess({ access, unitsById, userId, links, deals = [], kind = 'contact' }) {
  const viewPermission = kind === 'contact' ? 'contacts.view' : 'accounts.view';
  const managePermission = kind === 'contact' ? 'contacts.manage' : 'accounts.manage';
  const linkOptions = { userId, unitColumn: 'unit_id', ownerColumns: ['owner_user_id'] };
  const dealOptions = { userId, unitColumn: 'unit_id', ownerColumns: ['owner_user_id'] };

  const visibleLinks = [];
  let canManage = false;
  let canViewPii = false;
  for (const link of links) {
    if (!levelForRecord(access, unitsById, viewPermission, link, linkOptions)) continue;
    visibleLinks.push(link);
    const path = unitsById.get(link.unit_id).path;
    if (levelForRecord(access, unitsById, managePermission, link, linkOptions)) canManage = true;
    if (access.can('contacts.view_pii', path)) canViewPii = true;
  }

  const visibleDeals = [];
  for (const deal of deals) {
    if (!levelForRecord(access, unitsById, 'deals.view', deal, dealOptions)) continue;
    visibleDeals.push(deal);
    const path = unitsById.get(deal.unit_id).path;
    // Working a deal lets you keep its people's details up to date.
    if (levelForRecord(access, unitsById, managePermission, deal, dealOptions)) canManage = true;
    if (access.can('contacts.view_pii', path)) canViewPii = true;
  }

  const companyIds = [...new Set([...visibleLinks, ...visibleDeals].map((row) => row.company_id))];
  const everyLink = (permission) =>
    links.length > 0 && links.every((link) => access.can(permission, unitsById.get(link.unit_id)?.path ?? '\u0000'));
  return {
    canView: visibleLinks.length > 0 || visibleDeals.length > 0,
    canManage,
    canViewPii,
    /** Merge and privacy requests touch every company that knows the person, so they need the permission at all of them. */
    canMerge: kind === 'contact' && everyLink('contacts.merge'),
    canPrivacy: kind === 'contact' && everyLink('contacts.privacy'),
    visibleLinks,
    visibleDealIds: visibleDeals.map((deal) => deal.id),
    companyIds,
  };
}

function mergedError(row) {
  return new AppError(404, 'merged', 'This record was merged into another one', { mergedIntoId: row.merged_into_id });
}

/**
 * Load a contact with how the user can reach it, or throw 404 (code "merged", details.mergedIntoId,
 * for a record merged into another). Erased contacts load (they show as "Erased contact").
 * @returns {Promise<{ contact: object, links: object[] } & ReturnType<typeof decideRecordAccess>>}
 */
export async function loadVisibleContact(req, contactId, { trx = db, forUpdate = false } = {}) {
  const query = trx('contacts').where({ id: contactId }).first();
  if (forUpdate) query.forUpdate();
  const contact = await query;
  if (!contact) throw errors.notFound('Contact');
  if (contact.merged_into_id) throw mergedError(contact);
  const [index, links] = await Promise.all([unitsIndex(req, trx), trx('contact_companies').where({ contact_id: contactId })]);
  const userId = req.auth.user.id;
  let decision = decideRecordAccess({ access: req.access, unitsById: index, userId, links });
  if (!decision.canView || !decision.canManage || !decision.canViewPii) {
    const deals = await trx('deal_contacts as dc')
      .join('deals as d', 'd.id', 'dc.deal_id')
      .where('dc.contact_id', contactId)
      .whereNull('d.archived_at')
      .select('d.id', 'd.unit_id', 'd.company_id', 'd.owner_user_id');
    decision = decideRecordAccess({ access: req.access, unitsById: index, userId, links, deals });
  }
  if (!decision.canView) throw errors.notFound('Contact');
  return { contact, links, ...decision };
}

/** Same as loadVisibleContact for an institute (account_companies, deals.account_id). */
export async function loadVisibleAccount(req, accountId, { trx = db, forUpdate = false } = {}) {
  const query = trx('accounts').where({ id: accountId }).first();
  if (forUpdate) query.forUpdate();
  const account = await query;
  if (!account) throw errors.notFound('Institute');
  if (account.merged_into_id) throw mergedError(account);
  const [index, links] = await Promise.all([unitsIndex(req, trx), trx('account_companies').where({ account_id: accountId })]);
  const userId = req.auth.user.id;
  let decision = decideRecordAccess({ access: req.access, unitsById: index, userId, links, kind: 'account' });
  if (!decision.canView || !decision.canManage || !decision.canViewPii) {
    const deals = await trx('deals')
      .where({ account_id: accountId })
      .whereNull('archived_at')
      .select('id', 'unit_id', 'company_id', 'owner_user_id');
    decision = decideRecordAccess({ access: req.access, unitsById: index, userId, links, deals, kind: 'account' });
  }
  if (!decision.canView) throw errors.notFound('Institute');
  return { account, links, ...decision };
}

/** Does the user hold contacts.view_pii at any of these units? For masking rows in lists. */
export function canViewPiiAt(access, unitsById, unitIds) {
  return unitIds.some((id) => {
    const unit = unitsById.get(id);
    return unit ? access.can('contacts.view_pii', unit.path) : false;
  });
}

// ---------- Org tree guard ----------

const UNIT_OWNED_TABLES = ['deals', 'tasks', 'contact_companies', 'account_companies', 'saved_views'];

/**
 * A unit that holds CRM records can't move to another company: its records would point at the
 * old company's pipelines and products. Called by the org module before moving a unit.
 */
export async function assertUnitCanChangeCompany(trx, unit) {
  const ids = await trx('org_units').where('path', 'like', `${unit.path}%`).pluck('id');
  const checks = UNIT_OWNED_TABLES.map((table) => `exists (select 1 from ${table} where unit_id = any(?::uuid[]))`);
  const { rows } = await trx.raw(`select (${checks.join(' or ')}) as used`, UNIT_OWNED_TABLES.map(() => ids));
  if (rows[0]?.used) {
    throw errors.conflict(
      'This unit has leads, contacts or tasks, so it can only move within its company. Move or archive them first.',
    );
  }
}
