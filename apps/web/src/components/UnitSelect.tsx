'use client';

import { flattenUnits, indentLabel, unitTypeLabel } from '@/lib/tree';
import type { OrgUnit, UnitType } from '@/lib/types';
import type { ControlProps } from './ui';

/** A native select of units, indented to show the tree. */
export function UnitSelect({
  units,
  value,
  onChange,
  types,
  placeholder,
  disabled,
  control,
  className = 'select',
}: {
  units: readonly OrgUnit[];
  value: string;
  onChange: (unitId: string) => void;
  types?: readonly UnitType[] | undefined;
  placeholder?: string;
  disabled?: boolean;
  control?: ControlProps;
  className?: string;
}) {
  const flat = flattenUnits(units);
  return (
    <select {...control} className={className} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
      {placeholder ? (
        <option value="" disabled>
          {placeholder}
        </option>
      ) : null}
      {flat.map(({ unit, level }) => (
        <option key={unit.id} value={unit.id}>
          {indentLabel(types ? `${unit.name} · ${unitTypeLabel(types, unit.type)}` : unit.name, level)}
        </option>
      ))}
    </select>
  );
}
