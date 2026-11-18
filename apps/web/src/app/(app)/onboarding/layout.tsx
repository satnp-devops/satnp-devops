'use client';

import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { Tabs } from '@/components/crm';
import { PageHeader } from '@/components/ui';
import { useSession } from '@/lib/session';
import { trailOf } from '@/lib/tree';

const TABS = [
  { href: '/onboarding', label: 'Student checklists', permission: 'onboarding.view', exact: true },
  { href: '/onboarding/projects', label: 'Implementation', permission: 'onboarding.view', exact: false },
  { href: '/onboarding/renewals', label: 'Renewals', permission: 'onboarding.view_renewals', exact: false },
] as const;

/** Onboarding: B2C checklists, B2B implementation projects and renewals. A project page has its own header. */
export default function OnboardingLayout({ children }: Readonly<{ children: ReactNode }>) {
  const session = useSession();
  const pathname = usePathname();
  if (/^\/onboarding\/projects\/[^/]+/.test(pathname)) return <>{children}</>;
  const trail = trailOf(session.scope, session.unitsById)
    .map((unit) => unit.name)
    .join(' › ');
  const tabs = TABS.filter((tab) => session.canAnywhere(tab.permission));
  return (
    <>
      <PageHeader title="Onboarding" description={`Getting students started and institutes live · ${trail}`} />
      {tabs.length > 1 ? <Tabs label="Onboarding sections" variant="page" items={tabs.map(({ href, label, exact }) => ({ href, label, exact }))} /> : null}
      <div className="content">{children}</div>
    </>
  );
}
