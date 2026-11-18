import { db } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { isWithin } from '../../core/orgTree.js';
import { permissionLevel } from '../../core/permissions.js';
import { applyUnitFilter, companyOf, levelForRecord, listScope, unitsIndex } from '../../core/crm/scope.js';

// Who sees and changes what (the phase 2 scoping rules, docs/crm/PHASE2_CONTRACT.md §4, applied to scheduling):
//
// - Event types are company configuration owned by a unit. Reading needs scheduling.view at, above
//   or anywhere inside that unit (counsellors in a team see their company's event types); writing
//   needs scheduling.configure at the unit itself.
// - Bookings are company-owned records (unit_id = the deal's unit, else the event type's unit).
//   "own" means the user hosts the booking or owns its deal. A host always sees and works the
//   bookings they host inside the working scope, even when the booking's unit is above their team
//   (a company-wide event type hosted by a counsellor).
// - Anything outside the user's scope is 404.

export const BOOKING_OWNER_COLUMNS = ['host_user_id', 'owner_user_id'];

/** 'all' | 'own' | null for a permission on a booking (pure). */
export function bookingLevel(access, unitsById, permission, booking, userId) {
  const level = levelForRecord(access, unitsById, permission, booking, { userId, ownerColumns: BOOKING_OWNER_COLUMNS });
  if (level) return level;
  if (booking.host_user_id && booking.host_user_id === userId) {
    const company = unitsById.get(booking.company_id);
    if (company && access.canAnywhereWithin(permission, company.path)) return 'own';
  }
  return null;
}

/** Ids of the units on the path to the working unit (its ancestors inside the company) and inside it. */
export function unitsAroundWorkingUnit(unitsById, unit) {
  const ids = [];
  for (const candidate of unitsById.values()) {
    if (isWithin(candidate.path, unit.path) || isWithin(unit.path, candidate.path)) ids.push(candidate.id);
  }
  return ids;
}

/** The list scope for bookings: the CRM list scope plus the host rule. */
export async function bookingListScope(req, permission, unitId) {
  const scope = await listScope(req, permission, { unitId });
  const index = await unitsIndex(req);
  const hostUnitIds = unitsAroundWorkingUnit(index, scope.unit).filter((id) => {
    const unit = index.get(id);
    return unit.type !== 'group' && req.access.canAnywhereWithin(permission, unit.path);
  });
  return { ...scope, hostUnitIds };
}

/** Restrict a bookings query (alias b) to a scope. */
export function applyBookingScope(query, scope) {
  if (scope.company) query.where('b.company_id', scope.company.id);
  else query.where('b.group_id', scope.groupId);
  return query.where((where) => {
    where.where((inner) => applyUnitFilter(inner, scope, { unitColumn: 'b.unit_id', ownerColumns: BOOKING_OWNER_COLUMNS.map((c) => `b.${c}`) }));
    if (scope.hostUnitIds.length) where.orWhere((host) => host.where('b.host_user_id', scope.userId).whereIn('b.unit_id', scope.hostUnitIds));
  });
}

/** Load a booking the user may see (404 otherwise). */
export async function loadVisibleBooking(req, id, { permission = 'scheduling.view', trx = db, forUpdate = false } = {}) {
  const query = trx('bookings').where({ id }).first();
  if (forUpdate) query.forUpdate();
  const booking = await query;
  if (!booking) throw errors.notFound('Booking');
  const index = await unitsIndex(req, trx);
  const level = bookingLevel(req.access, index, 'scheduling.view', booking, req.auth.user.id);
  if (!level) throw errors.notFound('Booking');
  if (permission !== 'scheduling.view' && !bookingLevel(req.access, index, permission, booking, req.auth.user.id)) throw errors.forbidden();
  return { booking, level, unitsById: index };
}

/** Units whose event types a working unit shows: its ancestors in the company and everything inside it, where the user may read them. */
export async function eventTypeUnitIdsInScope(req, unitId, trx = db) {
  const index = await unitsIndex(req, trx);
  const unit = index.get(unitId);
  if (!unit || !req.access.canSee(unit.path)) throw errors.notFound('Unit');
  if (!req.access.canAnywhereWithin('scheduling.view', unit.path)) throw errors.forbidden();
  return unitsAroundWorkingUnit(index, unit).filter((id) => {
    const candidate = index.get(id);
    return candidate.type !== 'group' && req.access.canAnywhereWithin('scheduling.view', candidate.path);
  });
}

/**
 * Load an event type the user may read (404 otherwise); with write, also require scheduling.configure
 * at its unit (403 when only readable).
 */
export async function loadEventType(req, id, { write = false, trx = db, forUpdate = false } = {}) {
  const query = trx('scheduling_event_types').where({ id }).first();
  if (forUpdate) query.forUpdate();
  const row = await query;
  if (!row) throw errors.notFound('Event type');
  const index = await unitsIndex(req, trx);
  const unit = index.get(row.unit_id);
  if (!unit || !req.access.canAnywhereWithin('scheduling.view', unit.path)) throw errors.notFound('Event type');
  if (write && !req.access.can('scheduling.configure', unit.path)) throw errors.forbidden();
  return { eventType: row, unit, company: companyOf(unit, index), unitsById: index };
}

/** Can the user change this person's availability? Themselves always; others need scheduling.configure over every place they work. */
export async function canEditAvailability(req, userId, trx = db) {
  if (userId === req.auth.user.id) return true;
  const rows = await trx('role_assignments as ra').join('org_units as o', 'o.id', 'ra.org_unit_id').where('ra.user_id', userId).select('o.path');
  if (rows.length === 0) return false;
  return rows.every((row) => req.access.can('scheduling.configure', row.path));
}

/** Can the user see this person's availability? Themselves, or anyone sharing a unit where they hold scheduling.view. */
export async function canSeeAvailability(req, userId, trx = db) {
  if (userId === req.auth.user.id) return true;
  const rows = await trx('role_assignments as ra').join('org_units as o', 'o.id', 'ra.org_unit_id').where('ra.user_id', userId).select('o.path');
  return rows.some((row) => req.access.canSee(row.path) && req.access.canAnywhereWithin('scheduling.view', row.path));
}

/**
 * People who may host an event type owned by a unit: active users holding scheduling.manage (any
 * level) through a role at the unit, above it or inside it.
 */
export async function hostCandidates(unit, { trx = db, userIds } = {}) {
  const ancestors = unit.path.split('/').filter(Boolean);
  const rows = await trx('role_assignments as ra')
    .join('users as u', 'u.id', 'ra.user_id')
    .join('roles as r', 'r.id', 'ra.role_id')
    .join('org_units as o', 'o.id', 'ra.org_unit_id')
    .where('u.status', 'active')
    .where('o.status', 'active')
    .where((where) => where.whereIn('o.id', ancestors).orWhere('o.path', 'like', `${unit.path}%`))
    .modify((query) => {
      if (userIds) query.whereIn('u.id', userIds);
    })
    .select('u.id', 'u.name', 'u.email', 'r.permissions', 'o.path');
  const people = new Map();
  for (const row of rows) {
    if (!permissionLevel(row.permissions ?? [], 'scheduling.manage')) continue;
    // inside: works in this unit or below it (not only through a role higher up, like a group owner).
    const inside = row.path.startsWith(unit.path) || Boolean(people.get(row.id)?.inside);
    people.set(row.id, { id: row.id, name: row.name, email: row.email, inside });
  }
  return [...people.values()].sort((a, b) => a.name.localeCompare(b.name));
}
