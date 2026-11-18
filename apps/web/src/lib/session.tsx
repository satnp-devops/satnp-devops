'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { coversPermission, permissionLevel } from './permissions';
import { isWithin } from './tree';
import type { Me, OrgUnit, PermissionLevel, User } from './types';

// The signed-in user, the units they can see, and the unit they're working in ("scope").
// Everything below the scope is included: pick a company to see all of it, or a team to focus.

const SCOPE_KEY = 'phoenix.scope';

export interface Session {
  me: Me;
  user: User;
  /** Every unit the user can see, including ancestors shown for context. */
  units: OrgUnit[];
  unitsById: ReadonlyMap<string, OrgUnit>;
  /** Active units the user works in (their assignments and everything below). */
  workUnits: OrgUnit[];
  scope: OrgUnit;
  setScope: (unitId: string) => void;
  /** Permission level at a unit (default: the scope). */
  level: (permission: string, unit?: OrgUnit) => PermissionLevel | null;
  can: (permission: string, unit?: OrgUnit) => boolean;
  /** Does the user hold a permission at, above or anywhere inside a unit (default: the scope)? */
  canAnywhere: (permission: string, unit?: OrgUnit) => boolean;
  /** Could the user hand these permissions to someone at a unit? (Nobody can give what they don't have.) */
  canGrant: (permissions: readonly string[], unit: OrgUnit) => boolean;
  mfaSetupRequired: boolean;
}

const SessionContext = createContext<Session | null>(null);

function readStoredScope(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(SCOPE_KEY);
  } catch {
    return null;
  }
}

function storeScope(unitId: string): void {
  try {
    window.localStorage.setItem(SCOPE_KEY, unitId);
  } catch {
    // Private windows and blocked storage: the choice just won't be remembered.
  }
}

export function SessionProvider({ me, children }: { me: Me; children: ReactNode }) {
  const [scopeId, setScopeId] = useState<string | null>(readStoredScope);

  const value = useMemo<Session | null>(() => {
    const unitsById = new Map(me.units.map((unit) => [unit.id, unit]));
    const workUnits = me.units.filter((unit) => unit.access !== 'context' && unit.status === 'active');

    // Grants paired with the path of the unit they were given at.
    const grants = me.grants.flatMap((grant) => {
      const unit = unitsById.get(grant.unitId);
      return unit ? [{ path: unit.path, permissions: grant.permissions }] : [];
    });

    // Default scope: the highest place the user works.
    const assignmentUnits = me.assignments
      .map((assignment) => unitsById.get(assignment.unitId))
      .filter((unit): unit is OrgUnit => unit !== undefined)
      .sort((a, b) => a.depth - b.depth);
    const fallback = assignmentUnits[0] ?? workUnits[0];
    if (!fallback) return null;
    const scope = workUnits.find((unit) => unit.id === scopeId) ?? fallback;

    const level = (permission: string, unit: OrgUnit = scope): PermissionLevel | null => {
      let best: PermissionLevel | null = null;
      for (const grant of grants) {
        if (!isWithin(unit.path, grant.path)) continue;
        const found = permissionLevel(grant.permissions, permission);
        if (found === 'all') return 'all';
        if (found === 'own') best = 'own';
      }
      return best;
    };

    const canAnywhere = (permission: string, unit: OrgUnit = scope): boolean =>
      grants.some(
        (grant) =>
          (isWithin(grant.path, unit.path) || isWithin(unit.path, grant.path)) &&
          permissionLevel(grant.permissions, permission) !== null,
      );

    const canGrant = (permissions: readonly string[], unit: OrgUnit): boolean => {
      const held = grants.filter((grant) => isWithin(unit.path, grant.path)).flatMap((grant) => grant.permissions);
      return permissions.every((permission) => coversPermission(held, permission));
    };

    return {
      me,
      user: me.user,
      units: me.units,
      unitsById,
      workUnits,
      scope,
      setScope: () => undefined,
      level,
      can: (permission, unit) => level(permission, unit) !== null,
      canAnywhere,
      canGrant,
      mfaSetupRequired: me.session.mfaSetupRequired,
    };
  }, [me, scopeId]);

  const setScope = useCallback((unitId: string) => {
    setScopeId(unitId);
    storeScope(unitId);
  }, []);

  const session = useMemo(() => (value ? { ...value, setScope } : null), [value, setScope]);
  if (!session) return null;
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession must be used inside <SessionProvider>');
  return session;
}
