import type { ReactNode } from 'react';
import type { IconName } from '../icons';
import { Card, EmptyState } from '../ui';

/**
 * Placeholder for a phase 2 page that another engineer is building (docs/crm/PHASE2_CONTRACT.md §15.2).
 * Each slice replaces its stub page and stops using this component.
 */
export function BeingBuilt({ icon, children }: { icon: IconName; children: ReactNode }) {
  return (
    <Card>
      <EmptyState icon={icon} title="Being built in this phase">
        {children}
      </EmptyState>
    </Card>
  );
}
