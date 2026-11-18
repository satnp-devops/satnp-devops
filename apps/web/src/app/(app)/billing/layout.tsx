'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { Guard } from '@/components/Guard';
import { PageHeader } from '@/components/ui';
import { formatCount } from '@/lib/crm/format';
import { moneyList } from '@/lib/money/format';
import { useBillingOverview } from '@/lib/money/queries';
import { useSession } from '@/lib/session';
import { trailOf } from '@/lib/tree';
import '@/components/money/money.css';

const TABS = [
  { label: 'Payments', href: '/billing' },
  { label: 'Invoices', href: '/billing/invoices' },
  { label: 'Instalments', href: '/billing/instalments' },
  { label: 'Refunds', href: '/billing/refunds' },
  { label: 'Agreements', href: '/billing/agreements' },
  { label: 'Approvals', href: '/billing/approvals' },
] as const;

/** Fees and billing: overview figures and the lists; a deal's billing page (/billing/deals/[id]) has its own header. */
export default function BillingLayout({ children }: Readonly<{ children: ReactNode }>) {
  const session = useSession();
  const pathname = usePathname();
  if (pathname.startsWith('/billing/deals/')) return <>{children}</>;
  const trail = trailOf(session.scope, session.unitsById)
    .map((unit) => unit.name)
    .join(' › ');
  const current = (href: string) => (href === '/billing' ? pathname === '/billing' : pathname.startsWith(href));
  return (
    <>
      <PageHeader title="Fees and billing" description={`Working in ${trail}`} />
      <Guard anyOf={['billing.view']} anywhere>
        <Overview />
        <nav className="tabs" aria-label="Fees and billing sections">
          {TABS.map((tab) => (
            <Link key={tab.href} href={tab.href} aria-current={current(tab.href) ? 'page' : undefined}>
              {tab.label}
            </Link>
          ))}
        </nav>
        <div className="content">{children}</div>
      </Guard>
    </>
  );
}

function Overview() {
  const { scope } = useSession();
  const overview = useBillingOverview(scope.id);
  const data = overview.data;
  if (!data) return null;
  const tiles = [
    { label: 'Collected this month', value: moneyList(data.collectedThisMonth), href: '/billing' },
    { label: 'Instalments overdue', value: formatCount(data.instalmentsOverdue), href: '/billing/instalments?state=overdue', tone: data.instalmentsOverdue ? 'alert' : undefined },
    { label: 'Instalments due this week', value: formatCount(data.instalmentsDueThisWeek), href: '/billing/instalments' },
    { label: 'Refunds awaiting approval', value: formatCount(data.refundsAwaitingApproval), href: '/billing/refunds', tone: data.refundsAwaitingApproval && data.canApproveRefunds ? 'warn' : undefined },
    { label: 'Agreements awaiting signature', value: formatCount(data.agreementsAwaitingSignature), href: '/billing/agreements' },
    { label: 'Discounts awaiting approval', value: formatCount(data.discountsAwaitingApproval), href: '/billing/approvals', tone: data.discountsAwaitingApproval ? 'warn' : undefined },
    { label: 'Failed payments', value: formatCount(data.failedPayments), href: '/billing?status=failed', tone: data.failedPayments ? 'alert' : undefined },
  ];
  return (
    <div className="content money-overview">
      <div className="money-stats">
        {tiles.map((tile) => (
          <Link key={tile.label} href={tile.href} className={`money-stat${tile.tone ? ` money-stat--${tile.tone}` : ''}`}>
            <span className="money-stat__value">{tile.value}</span>
            <span className="money-stat__label">{tile.label}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
