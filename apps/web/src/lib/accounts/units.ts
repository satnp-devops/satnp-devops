import type { Session } from '@/lib/session';
import { idsFromPath, isWithin } from '@/lib/tree';
import type { OrgUnit } from '@/lib/types';

/** The company a unit belongs to (nearest ancestor-or-self of type "company"), or null for a group. */
export function companyOfUnit(unit: OrgUnit | undefined, unitsById: ReadonlyMap<string, OrgUnit>): OrgUnit | null {
  if (!unit) return null;
  const ids = idsFromPath(unit.path);
  for (let i = ids.length - 1; i >= 0; i -= 1) {
    const id = ids[i];
    const candidate = id === unit.id ? unit : id ? unitsById.get(id) : undefined;
    if (candidate?.type === 'company') return candidate;
  }
  return null;
}

/**
 * Units in the working scope where the user may add institutes: inside a company, active, with
 * accounts.manage there.
 */
export function unitsForNewAccount(session: Pick<Session, 'workUnits' | 'unitsById' | 'scope' | 'can'>): OrgUnit[] {
  const { workUnits, unitsById, scope, can } = session;
  return workUnits
    .filter((unit) => isWithin(unit.path, scope.path))
    .filter((unit) => companyOfUnit(unit, unitsById) !== null && can('accounts.manage', unit));
}
