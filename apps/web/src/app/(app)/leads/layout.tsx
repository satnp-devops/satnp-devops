'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { PageHeader } from '@/components/ui';
import { useSession } from '@/lib/session';
import { trailOf } from '@/lib/tree';

const TABS = [
  { label: 'Leads', href: '/leads', permission: 'deals.view' },
  { label: 'Contacts', href: '/leads/contacts', permission: 'contacts.view' },
  { label: 'Review queue', href: '/leads/review', permission: 'intake.review' },
  { label: 'Import', href: '/leads/import', permission: 'intake.import' },
] as const;

/** The list pages share a header with Leads and Contacts tabs; a lead's profile (/leads/[id]) has its own header. */
export default function LeadsLayout({ children }: Readonly<{ children: ReactNode }>) {
  const session = useSession();
  const pathname = usePathname();
  const isList =
    pathname === '/leads' || ['/leads/contacts', '/leads/review', '/leads/import'].some((p) => pathname === p || pathname.startsWith(`${p}/`));
  if (!isList) return <>{children}</>;

  const tabs = TABS.filter((tab) => session.canAnywhere(tab.permission));
  const trail = trailOf(session.scope, session.unitsById)
    .map((unit) => unit.name)
    .join(' › ');
  const current = (href: string) => (href === '/leads' ? pathname === '/leads' : pathname.startsWith(href));

  return (
    <>
      <PageHeader title="Leads" description={`Working in ${trail}`} />
      {tabs.length > 0 ? (
        <nav className="tabs" aria-label="Leads sections">
          {tabs.map((tab) => (
            <Link key={tab.href} href={tab.href} aria-current={current(tab.href) ? 'page' : undefined}>
              {tab.label}
            </Link>
          ))}
        </nav>
      ) : null}
      <div className="content">{children}</div>
    </>
  );
}
