import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ApprovalsList } from '../BillingLists';

export const metadata: Metadata = { title: 'Discount approvals' };

export default function Page() {
  return (
    <Suspense>
      <ApprovalsList />
    </Suspense>
  );
}
