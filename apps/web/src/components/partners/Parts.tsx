'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { Icon } from '@/components/icons';
import { StatusPill } from '@/components/crm';
import { CopyButton } from '@/components/ui';
import { formatMoney } from '@/lib/crm/format';
import { COMMISSION_STATUS, PARTNERSHIP_STATUS, PAYOUT_STATUS, PORTAL_LEAD_STATUS } from '@/lib/partners/format';
import type { CommissionStatus, MoneyValue, PartnershipStatus, PayoutStatus, PortalLeadStatus } from '@/lib/partners/types';
import type { OrgUnit } from '@/lib/types';
import './partners.css';

export function PartnershipPill({ status }: { status: PartnershipStatus }) {
  const s = PARTNERSHIP_STATUS[status];
  return <StatusPill tone={s.tone}>{s.label}</StatusPill>;
}

export function CommissionPill({ status }: { status: CommissionStatus }) {
  const s = COMMISSION_STATUS[status];
  return <StatusPill tone={s.tone}>{s.label}</StatusPill>;
}

export function PayoutPill({ status }: { status: PayoutStatus }) {
  const s = PAYOUT_STATUS[status];
  return <StatusPill tone={s.tone}>{s.label}</StatusPill>;
}

export function LeadPill({ status }: { status: PortalLeadStatus }) {
  const s = PORTAL_LEAD_STATUS[status];
  return <StatusPill tone={s.tone}>{s.label}</StatusPill>;
}

export function Amount({ value, strike = false }: { value: MoneyValue; strike?: boolean }) {
  return <span className={strike ? 'partners-amount partners-amount--strike' : 'partners-amount'}>{formatMoney(value.valueMinor, value.currency)}</span>;
}

export function Stat({ label, value, meta }: { label: string; value: ReactNode; meta?: ReactNode }) {
  return (
    <div className="partners-stat">
      <p className="partners-stat__label">{label}</p>
      <p className="partners-stat__value">{value}</p>
      {meta ? <p className="partners-stat__meta">{meta}</p> : null}
    </div>
  );
}

export function Code({ children }: { children: string }) {
  return <span className="partners-code">{children}</span>;
}

/** A share link, shortened on screen, with a copy button. */
export function ShareLink({ url }: { url: string | null }) {
  if (!url) return <span className="muted small">Set a landing page in Settings › General</span>;
  return (
    <span className="partners-share">
      <span className="partners-share__url" title={url}>
        {url.replace(/^https?:\/\//, '')}
      </span>
      <CopyButton text={url} label="Copy link" />
    </span>
  );
}

/** The company a unit belongs to (nearest ancestor-or-self of type company), from the session's units. */
export function companyOf(unit: OrgUnit | undefined, unitsById: ReadonlyMap<string, OrgUnit>): OrgUnit | null {
  let current = unit;
  while (current) {
    if (current.type === 'company') return current;
    current = current.parentId ? unitsById.get(current.parentId) : undefined;
  }
  return null;
}

/** Companies in the working scope: the scope's own company, or every company under a group. */
export function companiesInScope(scope: OrgUnit, units: readonly OrgUnit[], unitsById: ReadonlyMap<string, OrgUnit>): OrgUnit[] {
  const own = companyOf(scope, unitsById);
  if (own) return [own];
  return units.filter((u) => u.type === 'company' && u.path.startsWith(scope.path)).sort((a, b) => a.name.localeCompare(b.name));
}

/** "‹ All partners": back to the list a detail page came from. */
export function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <nav aria-label="Breadcrumb">
      <Link href={href} className="partners-back">
        <Icon name="chevronRight" size={14} className="partners-back__icon" />
        {children}
      </Link>
    </nav>
  );
}
