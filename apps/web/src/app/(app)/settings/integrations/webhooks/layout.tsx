'use client';

import type { ReactNode } from 'react';
import { Tabs, type TabItem } from '@/components/crm';
import { Guard } from '@/components/Guard';
import { useSession } from '@/lib/session';
import '@/components/webhooks/webhooks.css';

// Settings › Integrations › Webhooks and jobs (docs/platform/WEBHOOKS_AND_JOBS.md): what providers
// delivered and how processing went, the dead letters, and background jobs with their progress.

export default function WebhooksLayout({ children }: Readonly<{ children: ReactNode }>) {
  const { canAnywhere } = useSession();
  const webhooks = canAnywhere('webhooks.view');
  const tabs: TabItem[] = [
    ...(webhooks ? [{ href: '/settings/integrations/webhooks', label: 'Deliveries', exact: true }] : []),
    { href: '/settings/integrations/webhooks/dead-letters', label: 'Dead letters' },
    { href: '/settings/integrations/webhooks/jobs', label: 'Background jobs' },
  ];
  return (
    <Guard anyOf={['webhooks.view', 'jobs.view']} anywhere>
      <div className="stack gap-16">
        <Tabs items={tabs} label="Webhooks and jobs sections" />
        {children}
      </div>
    </Guard>
  );
}
