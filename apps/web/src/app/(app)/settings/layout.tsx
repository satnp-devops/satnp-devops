'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { PageHeader } from '@/components/ui';
import { useSession } from '@/lib/session';
import { visibleSettingsTabs } from '@/lib/settingsTabs';
import { trailOf } from '@/lib/tree';

export default function SettingsLayout({ children }: Readonly<{ children: ReactNode }>) {
  const session = useSession();
  const pathname = usePathname();
  const tabs = visibleSettingsTabs(session);
  const trail = trailOf(session.scope, session.unitsById)
    .map((unit) => unit.name)
    .join(' › ');

  return (
    <>
      <PageHeader title="Settings" description={`Working in ${trail}`} />
      <nav className="tabs" aria-label="Settings sections">
        {tabs.map((tab) => (
          <Link key={tab.href} href={tab.href} aria-current={pathname.startsWith(tab.href) ? 'page' : undefined}>
            {tab.label}
          </Link>
        ))}
      </nav>
      <div className="content">{children}</div>
    </>
  );
}
