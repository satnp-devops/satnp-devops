import { errors } from '../../lib/errors.js';
import { companyOf, unitsIndex } from '../../core/crm/scope.js';

/**
 * Integrations live at two levels: a company, or the group (shared connections and channels).
 * The working unit ("Working in") narrows to its company; the group shows every company the
 * user may see. Units outside the user's visibility are 404.
 */
export async function workingScope(req, unitId) {
  const index = await unitsIndex(req);
  const unit = index.get(unitId);
  if (!unit || !req.access.canSee(unit.path)) throw errors.notFound('Unit');
  const group = index.get(unit.root_id);
  const company = companyOf(unit, index);
  const companies = [...index.values()]
    .filter((u) => u.type === 'company' && u.root_id === unit.root_id && u.status === 'active')
    .sort((a, b) => a.name.localeCompare(b.name));
  return { index, unit, group, company, companies };
}

/**
 * Where a permission applies inside the working scope: the companies (only the working one when
 * working in a company or below) and the group itself when working at the group.
 */
export function placesWith(req, scope, permission) {
  const companies = (scope.company ? [scope.company] : scope.companies).filter((c) => req.access.can(permission, c.path));
  const group = !scope.company && scope.group && req.access.can(permission, scope.group.path) ? scope.group : null;
  return { companies, group };
}

/** 403 when the permission applies nowhere in the scope. */
export function requirePlaces(req, scope, permission) {
  const places = placesWith(req, scope, permission);
  if (places.companies.length === 0 && !places.group) throw errors.forbidden();
  return places;
}

/** A unit that may own connections and keys: the group or a company, visible to the user. */
export function ownerUnit(req, index, unitId, path = 'body.unitId') {
  const unit = index.get(unitId);
  if (!unit || !req.access.canSee(unit.path)) throw errors.notFound('Unit');
  if (unit.status !== 'active') throw errors.validation([{ path, message: 'This unit is archived' }]);
  if (unit.type !== 'group' && unit.type !== 'company') {
    throw errors.validation([{ path, message: 'Choose the group or a company' }]);
  }
  return unit;
}

export const unitRef = (unit) => (unit ? { id: unit.id, name: unit.name, type: unit.type } : null);
