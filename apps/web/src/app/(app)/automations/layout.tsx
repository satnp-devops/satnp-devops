'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { PageHeader } from '@/components/ui';
import { useSession } from '@/lib/session';
import { trailOf } from '@/lib/tree';
import './automations.css';

const TABS = [
  { label: 'Flows', href: '/automations', permission: 'automations.view' },
  { label: 'Runs', href: '/automations/runs', permission: 'automations.view' },
  { label: 'Approvals', href: '/automations/approvals', permission: 'automations.approve' },
] as const;

/** The list pages share a header with Flows, Runs and Approvals tabs; the flow editor has its own header. */
export default function AutomationsLayout({ children }: Readonly<{ children: ReactNode }>) {
  const session = useSession();
  const pathname = usePathname();
  const isList = pathname === '/automations' || pathname === '/automations/runs' || pathname === '/automations/approvals';
  if (!isList) return <>{children}</>;

  const tabs = TABS.filter((tab) => session.canAnywhere(tab.permission));
  const trail = trailOf(session.scope, session.unitsById)
    .map((unit) => unit.name)
    .join(' › ');

  return (
    <>
      <PageHeader title="Automations" description={`Flows that welcome, follow up and nurture on their own · Working in ${trail}`} />
      {tabs.length > 1 ? (
        <nav className="tabs" aria-label="Automations sections">
          {tabs.map((tab) => (
            <Link key={tab.href} href={tab.href} aria-current={pathname === tab.href ? 'page' : undefined}>
              {tab.label}
            </Link>
          ))}
        </nav>
      ) : null}
      <div className="content">{children}</div>
    </>
  );
}
