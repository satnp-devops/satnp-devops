'use client';

import { useId } from 'react';
import { useSession } from '@/lib/session';
import { UnitSelect } from '../UnitSelect';

/** Pick the unit you're working in. Pages show that unit and everything under it. */
export function ScopeSwitcher({ disabled = false }: { disabled?: boolean }) {
  const { workUnits, scope, setScope } = useSession();
  const id = useId();

  if (workUnits.length <= 1) {
    return (
      <div className="scope-select">
        <span className="scope-select__label">Working in</span>
        <span className="scope-select__single">{scope.name}</span>
      </div>
    );
  }

  return (
    <div className="scope-select">
      <label htmlFor={id}>Working in</label>
      <UnitSelect control={{ id }} units={workUnits} value={scope.id} onChange={setScope} disabled={disabled} className="" />
    </div>
  );
}
