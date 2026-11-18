'use client';

import { useEffect, useMemo, useState } from 'react';
import { useSession } from '../session';
import { isWithin } from '../tree';
import type { OrgUnit } from '../types';

// Configuration belongs to a company. The screens offer the companies of the user's working scope
// ("Working in": a company, or every company at group scope) where they can read the configuration,
// and say whether they can change it (the manage permission at the company itself).

export interface ConfigCompany {
  unit: OrgUnit;
  canManage: boolean;
}

/** Companies in the working scope where the user holds `view` (at, above or inside the company). */
export function useConfigCompanies(view: string, manage: string): ConfigCompany[] {
  const { units, scope, can, canAnywhere } = useSession();
  return useMemo(
    () =>
      units
        .filter(
          (unit) =>
            unit.type === 'company' &&
            unit.status === 'active' &&
            (isWithin(unit.path, scope.path) || isWithin(scope.path, unit.path)) &&
            canAnywhere(view, unit),
        )
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((unit) => ({ unit, canManage: can(manage, unit) })),
    [units, scope, can, canAnywhere, view, manage],
  );
}

const STORAGE_KEY = 'phoenix.config.company';

function readStored(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** The chosen company (remembered per browser), falling back to the first one in scope. */
export function useCompanyChoice(companies: readonly ConfigCompany[]) {
  const [chosenId, setChosenId] = useState<string | null>(null);

  useEffect(() => {
    setChosenId(readStored());
  }, []);

  const current = companies.find((company) => company.unit.id === chosenId) ?? companies[0] ?? null;

  const choose = (id: string) => {
    setChosenId(id);
    try {
      window.localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // Private windows: the choice just isn't remembered.
    }
  };

  return { current, choose };
}
