'use client';

import { useId } from 'react';
import { UnitSelect } from '@/components/UnitSelect';
import { Button } from '@/components/ui';
import { useSession } from '@/lib/session';
import type { OrgUnit, Role, UnitType } from '@/lib/types';

export interface AccessChoice {
  unitId: string;
  roleId: string;
}

/** Units where the user may give people roles, inside the current scope. */
export function useAssignableUnits(): OrgUnit[] {
  const { workUnits, scope, can } = useSession();
  return workUnits.filter((unit) => unit.path.startsWith(scope.path) && can('users.manage', unit));
}

/** Roles the user could give at a unit: never more than they hold there themselves. */
export function useGrantableRoles(roles: readonly Role[] | undefined, unitId: string): Role[] {
  const { unitsById, canGrant } = useSession();
  const unit = unitsById.get(unitId);
  if (!roles || !unit) return [];
  return roles.filter((role) => canGrant(role.permissions, unit));
}

/** A starting choice: a preferred unit (or the scope) if possible, and the most common role. */
export function useDefaultChoice(roles: readonly Role[] | undefined, preferredUnitIds: readonly string[] = []): AccessChoice {
  const units = useAssignableUnits();
  const { scope } = useSession();
  const unit =
    preferredUnitIds.map((id) => units.find((item) => item.id === id)).find((item) => item !== undefined) ??
    units.find((item) => item.id === scope.id) ??
    units[0];
  const grantable = useGrantableRoles(roles, unit?.id ?? '');
  const role = grantable.find((item) => item.key === 'counsellor') ?? grantable[0];
  return { unitId: unit?.id ?? '', roleId: role?.id ?? '' };
}

/** Pick "which role, where". */
export function AccessPicker({
  value,
  onChange,
  roles,
  types,
  onRemove,
  error,
}: {
  value: AccessChoice;
  onChange: (value: AccessChoice) => void;
  roles: readonly Role[] | undefined;
  types: readonly UnitType[] | undefined;
  onRemove?: () => void;
  error?: string | undefined;
}) {
  const units = useAssignableUnits();
  const grantable = useGrantableRoles(roles, value.unitId);
  const { unitsById, canGrant } = useSession();
  const unitFieldId = useId();
  const roleFieldId = useId();

  function changeUnit(unitId: string) {
    const unit = unitsById.get(unitId);
    const current = roles?.find((role) => role.id === value.roleId);
    // Keep the role if it can still be given at the new unit.
    const keep = unit && current && canGrant(current.permissions, unit);
    const fallback = roles?.find((role) => unit && canGrant(role.permissions, unit));
    onChange({ unitId, roleId: keep ? value.roleId : (fallback?.id ?? '') });
  }

  return (
    <div className="access-picker">
      <div className="field">
        <label className="field__label" htmlFor={roleFieldId}>
          Role
        </label>
        <select
          id={roleFieldId}
          className="select"
          value={value.roleId}
          aria-invalid={error ? true : undefined}
          onChange={(event) => onChange({ ...value, roleId: event.target.value })}
        >
          {grantable.length === 0 ? <option value="">No roles you can give here</option> : null}
          {grantable.map((role) => (
            <option key={role.id} value={role.id}>
              {role.name}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label className="field__label" htmlFor={unitFieldId}>
          At
        </label>
        <UnitSelect control={{ id: unitFieldId }} units={units} value={value.unitId} onChange={changeUnit} types={types} />
      </div>
      {onRemove ? (
        <Button variant="ghost" iconOnly icon="x" aria-label="Remove this role" onClick={onRemove} className="access-picker__remove" />
      ) : null}
      {error ? <p className="field__error access-picker__error">{error}</p> : null}
    </div>
  );
}
