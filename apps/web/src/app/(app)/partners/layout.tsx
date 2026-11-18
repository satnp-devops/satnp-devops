'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { Tabs } from '@/components/crm';
import { EmptyState, PageHeader, PageLoading } from '@/components/ui';
import { useSession } from '@/lib/session';
import { trailOf } from '@/lib/tree';

const TABS = [
  { label: 'Partners', href: '/partners', exact: true, anyOf: ['partners.view'] },
  { label: 'Referral links', href: '/partners/links', anyOf: ['partners.view'] },
  { label: 'Referred leads', href: '/partners/leads', anyOf: ['partners.view'] },
  { label: 'Commissions', href: '/partners/commissions', anyOf: ['partners.view'] },
  { label: 'Payouts', href: '/partners/payouts', anyOf: ['partners.manage_payouts', 'partners.approve_payouts'] },
] as const;

const LIST_PATHS = new Set(TABS.map((tab) => tab.href as string));

/**
 * Staff pages share a header with tabs; a partner's profile and a payout batch have their own.
 * Partners themselves (partners.portal without partners.view) go to their portal.
 */
export default function PartnersLayout({ children }: Readonly<{ children: ReactNode }>) {
  const session = useSession();
  const pathname = usePathname();
  const router = useRouter();
  const staff = session.canAnywhere('partners.view');
  const partner = !staff && session.workUnits.length > 0 && session.canAnywhere('partners.portal');

  useEffect(() => {
    if (partner) router.replace('/partner-portal');
  }, [partner, router]);

  if (partner) return <PageLoading />;
  if (!staff) {
    return (
      <div className="content">
        <EmptyState icon="handshake" title="Partners isn’t part of your work here">
          Ask an admin for a role with partner access, or pick another place in “Working in”.
        </EmptyState>
      </div>
    );
  }
  if (!LIST_PATHS.has(pathname)) return <>{children}</>;

  const trail = trailOf(session.scope, session.unitsById)
    .map((unit) => unit.name)
    .join(' › ');
  const tabs = TABS.filter((tab) => tab.anyOf.some((permission) => session.canAnywhere(permission)));
  return (
    <>
      <PageHeader title="Partners" description={`Brokers and referral partners · Working in ${trail}`} />
      <Tabs items={tabs.map((tab) => ({ href: tab.href, label: tab.label, exact: 'exact' in tab ? tab.exact : false }))} label="Partner sections" variant="page" />
      <div className="content">{children}</div>
    </>
  );
}
