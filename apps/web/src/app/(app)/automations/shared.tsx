'use client';

import type { ReactNode } from 'react';
import { StatusPill } from '@/components/crm';
import { cx } from '@/components/ui';
import { APPROVAL_STATUS, FLOW_STATUS, RUN_STATUS } from '@/lib/automations/queries';
import type { ApprovalStatus, AutomationCatalog, FlowStatus, RunStatus } from '@/lib/automations/types';
import type { Session } from '@/lib/session';
import type { OrgUnit } from '@/lib/types';

/** Companies a list in the working scope covers, where the person holds the permission (at, above or inside). */
export function companiesInScope(session: Session, permission: string, { manage = false } = {}): OrgUnit[] {
  const { scope, unitsById, units } = session;
  const own = companyOf(scope, unitsById);
  const candidates = own ? [own] : units.filter((u) => u.type === 'company' && u.path.startsWith(scope.path));
  return candidates
    .filter((company) => (manage ? session.can(permission, company) : session.canAnywhere(permission, company)))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function companyOf(unit: OrgUnit, unitsById: ReadonlyMap<string, OrgUnit>): OrgUnit | null {
  const ids = unit.path.split('/').filter(Boolean).reverse();
  for (const id of ids) {
    const candidate = id === unit.id ? unit : unitsById.get(id);
    if (candidate?.type === 'company') return candidate;
  }
  return null;
}

export function triggerLabel(catalog: AutomationCatalog | undefined, key: string): string {
  return catalog?.triggers.find((t) => t.key === key)?.label ?? key;
}

export function actionLabel(catalog: AutomationCatalog | undefined, key: string): string {
  if (key === 'ai.run') return 'AI agent';
  if (key === 'automation.request_approval') return 'Approval request';
  return catalog?.actions.find((a) => a.key === key)?.label ?? key;
}

export function FlowStatusPill({ status }: { status: FlowStatus }) {
  const s = FLOW_STATUS[status];
  return <StatusPill tone={s.tone}>{s.label}</StatusPill>;
}

export function RunStatusPill({ status }: { status: RunStatus }) {
  const s = RUN_STATUS[status];
  return <StatusPill tone={s.tone}>{s.label}</StatusPill>;
}

export function ApprovalStatusPill({ status, canDecide }: { status: ApprovalStatus; canDecide?: boolean }) {
  const s = APPROVAL_STATUS[status];
  return <StatusPill tone={s.tone}>{status === 'pending' && !canDecide ? 'Pending' : s.label}</StatusPill>;
}

/** Single-choice buttons (status filters). */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { value: T; label: ReactNode }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="auto-seg" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={cx('auto-seg__item', option.value === value && 'is-on')}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** JSON shown in a scrollable mono block. */
export function JsonBlock({ value, label }: { value: unknown; label?: string }) {
  return (
    <pre className="auto-json" aria-label={label} tabIndex={0}>
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}
