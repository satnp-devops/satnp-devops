'use client';

import type { ReactNode } from 'react';
import { Tabs } from '@/components/crm';
import { EmptyState, PageHeader } from '@/components/ui';
import { useSession } from '@/lib/session';

const TABS = [
  { href: '/partner-portal', label: 'Overview', exact: true },
  { href: '/partner-portal/links', label: 'Links' },
  { href: '/partner-portal/leads', label: 'Referred leads' },
  { href: '/partner-portal/commissions', label: 'Commissions' },
  { href: '/partner-portal/payouts', label: 'Payouts' },
];

/** The partner portal: a broker or referral partner's own links, leads, commissions and payouts. */
export default function PartnerPortalLayout({ children }: Readonly<{ children: ReactNode }>) {
  const { canAnywhere } = useSession();
  if (!canAnywhere('partners.portal') || canAnywhere('partners.view')) {
    return (
      <div className="content">
        <EmptyState icon="handshake" title="The partner portal is for partners">
          Staff see partners, their links and commissions under Partners in the sidebar.
        </EmptyState>
      </div>
    );
  }
  return (
    <>
      <PageHeader title="Partner portal" description="Your referral links, the leads you referred, your commissions and payouts." />
      <Tabs items={TABS} label="Partner portal sections" variant="page" />
      <div className="content">{children}</div>
    </>
  );
}
