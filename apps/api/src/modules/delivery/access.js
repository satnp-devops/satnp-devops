import { db } from '../../lib/db.js';
import { AppError, errors } from '../../lib/errors.js';
import { decodeCursor } from '../../lib/pagination.js';
import { loadVisible, loadVisibleAccount, loadVisibleContact, unitsIndex, userLevelAt } from '../../core/crm/scope.js';

// Small route helpers shared by the delivery routes: scoping of referenced ids (contract §4.1
// rule 8: invisible → 422 "not found" on the field), owner checks and keyset cursors.

export const PERMISSIONS = Object.freeze({
  view: 'enrollments.view',
  manage: 'enrollments.manage',
  withdraw: 'enrollments.withdraw',
  batches: 'enrollments.manage_batches',
  onboardingView: 'onboarding.view',
  onboardingManage: 'onboarding.manage',
  configure: 'onboarding.configure',
  renewals: 'onboarding.view_renewals',
});

export const fieldError = (path, message) => errors.validation([{ path, message }]);

/** Run a loader; a 404 (or merged) becomes a 422 on the field, never revealing whether it exists. */
export async function asField(path, load, message = 'Not found') {
  try {
    return await load();
  } catch (err) {
    if (err instanceof AppError && err.status === 404) throw fieldError(path, err.code === 'merged' ? 'This record was merged; pick the surviving one' : message);
    throw err;
  }
}

export const visibleContactField = (req, id, path, trx = db) => asField(path, () => loadVisibleContact(req, id, { trx }));
export const visibleAccountField = (req, id, path, trx = db) => asField(path, () => loadVisibleAccount(req, id, { trx }));
export const visibleDealField = (req, id, path, trx = db) =>
  asField(path, async () => (await loadVisible(req, { table: 'deals', id, permission: 'deals.view', notFound: 'Deal', trx })).row);

/** A person who may own a record at a unit (they hold the permission there). */
export async function assertOwner(userId, unit, permission, path, trx = db) {
  if (!userId) return;
  const level = await userLevelAt(userId, unit, permission, { trx });
  if (!level) throw fieldError(path, "This person can't work here");
}

/** The owner a new record gets: users with only "own" rights always own what they create. */
export function ownerFor(req, level, requested) {
  const me = req.auth.user.id;
  if (level === 'own') {
    if (requested && requested !== me) throw errors.forbidden('You can only create records you own');
    return me;
  }
  return requested === undefined ? me : requested;
}

/** Product of the same company (422 otherwise). */
export async function productOfCompany(productId, companyId, path, trx = db) {
  const product = await trx('products as p')
    .join('product_lines as l', 'l.id', 'p.product_line_id')
    .where('p.id', productId)
    .select('p.*', 'l.audience', 'l.kind as line_kind', 'l.name as line_name')
    .first();
  if (!product) throw fieldError(path, 'Not found');
  if (product.company_id !== companyId) throw fieldError(path, 'Pick a programme of the same company');
  return product;
}

/** Keyset cursor on (timestamp-or-date desc, id desc). */
export function applyDescCursor(query, cursor, column, idColumn) {
  const value = decodeCursor(cursor);
  if (!value) return query;
  if (typeof value.k !== 'string' || typeof value.id !== 'string') throw errors.badRequest('Invalid cursor');
  return query.whereRaw(`(${column}, ${idColumn}) < (?, ?)`, [value.k, value.id]);
}

/** Keyset cursor on (value asc, id asc). */
export function applyAscCursor(query, cursor, column, idColumn) {
  const value = decodeCursor(cursor);
  if (!value) return query;
  if (typeof value.k !== 'string' && typeof value.k !== 'number') throw errors.badRequest('Invalid cursor');
  return query.whereRaw(`(${column}, ${idColumn}) > (?, ?)`, [value.k, value.id]);
}

export const isoKey = (value) => (value instanceof Date ? value.toISOString() : String(value));

/** Units map and a per-row PII decision for presenters. */
export async function viewContext(req, trx = db) {
  const units = await unitsIndex(req, trx);
  const piiCache = new Map();
  const canViewPii = (row) => {
    const key = row.unit_id;
    if (!piiCache.has(key)) {
      const unit = units.get(key);
      piiCache.set(key, unit ? req.access.can('contacts.view_pii', unit.path) : false);
    }
    return piiCache.get(key);
  };
  return { units, canViewPii };
}

/** Owner filter: 'me', 'none' or a user id. */
export function applyOwnerFilter(query, owner, column, me) {
  if (!owner) return query;
  if (owner === 'me') return query.where(column, me);
  if (owner === 'none') return query.whereNull(column);
  return query.where(column, owner);
}

export const isUniqueViolation = (err, constraint) => err?.code === '23505' && (!constraint || err.constraint === constraint);
