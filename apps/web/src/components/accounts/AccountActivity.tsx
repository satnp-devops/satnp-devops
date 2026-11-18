'use client';

import { Timeline } from '@/components/timeline';
import type { CompanyRef } from '@/lib/crm/types';

/**
 * The institute's activity: the shared timeline (notes, calls, emails, messages and system entries
 * such as "Institute added" and people joining or leaving) across the companies the viewer can
 * see. Institute mutations refresh it through crmKeys.timeline.subject('account', accountId).
 */
export function AccountActivity({ accountId, companies }: { accountId: string; companies?: readonly CompanyRef[] }) {
  return <Timeline subject={{ accountId }} companies={companies} title="Activity" />;
}
