'use client';

import type { ReactNode } from 'react';
import { Tabs, type TabItem } from '@/components/crm';
import { Guard } from '@/components/Guard';
import { useReviewSummary } from '@/lib/ai/queries';
import { useSession } from '@/lib/session';
import '@/components/ai/ai.css';

// Settings › AI (docs/platform/AI.md): the review queue (managers and counsellors too), the AI
// log, guardrails and thresholds per company, the knowledge base and the agent test panel.

export default function AiLayout({ children }: Readonly<{ children: ReactNode }>) {
  const { canAnywhere, scope } = useSession();
  const canReview = canAnywhere('ai.review');
  const canView = canAnywhere('ai.view');
  const summary = useReviewSummary(scope.id, canReview);
  const tabs: TabItem[] = [
    ...(canReview ? [{ href: '/settings/ai', label: 'Review queue', exact: true, ...(summary.data ? { count: summary.data.pending } : {}) }] : []),
    ...(canView
      ? [
          { href: '/settings/ai/activity', label: 'Activity' },
          { href: '/settings/ai/guardrails', label: 'Guardrails' },
          { href: '/settings/ai/knowledge', label: 'Knowledge base' },
        ]
      : []),
    ...(canAnywhere('ai.manage') ? [{ href: '/settings/ai/test', label: 'Test an agent' }] : []),
  ];
  return (
    <Guard anyOf={['ai.view', 'ai.review']} anywhere>
      <div className="stack gap-16">
        {tabs.length > 1 ? <Tabs items={tabs} label="AI sections" /> : null}
        {children}
      </div>
    </Guard>
  );
}
