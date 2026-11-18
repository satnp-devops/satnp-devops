'use client';

import type { ReactNode } from 'react';
import { Tabs, type TabItem } from '@/components/crm';
import { Guard } from '@/components/Guard';
import { useSession } from '@/lib/session';
import '@/components/integrations/integrations.css';

// Settings › Integrations (docs/platform/INTEGRATIONS.md): connections per company, the channels
// enquiries arrive on, what the mock adapters sent, API keys, and webhook deliveries and background
// jobs (docs/platform/WEBHOOKS_AND_JOBS.md).

export default function IntegrationsLayout({ children }: Readonly<{ children: ReactNode }>) {
  const { canAnywhere } = useSession();
  const canView = canAnywhere('integrations.view');
  const canWebhooks = canAnywhere('webhooks.view');
  const tabs: TabItem[] = [
    ...(canView
      ? [
          { href: '/settings/integrations', label: 'Connections', exact: true },
          { href: '/settings/integrations/channels', label: 'Channels' },
          { href: '/settings/integrations/sandbox', label: 'Sandbox outbox' },
        ]
      : []),
    ...(canWebhooks || canAnywhere('jobs.view')
      ? [{ href: canWebhooks ? '/settings/integrations/webhooks' : '/settings/integrations/webhooks/jobs', label: 'Webhooks and jobs' }]
      : []),
    ...(canAnywhere('api_keys.manage') ? [{ href: '/settings/integrations/api-keys', label: 'API keys' }] : []),
  ];
  return (
    <Guard anyOf={['integrations.view', 'api_keys.manage', 'webhooks.view', 'jobs.view']} anywhere>
      <div className="stack gap-16">
        {tabs.length > 1 ? <Tabs items={tabs} label="Integrations sections" /> : null}
        {children}
      </div>
    </Guard>
  );
}
