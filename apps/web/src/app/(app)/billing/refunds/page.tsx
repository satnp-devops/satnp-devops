import type { Metadata } from 'next';
import { Suspense } from 'react';
import { RefundsList } from '../BillingLists';

export const metadata: Metadata = { title: 'Refunds' };

export default function Page() {
  return (
    <Suspense>
      <RefundsList />
    </Suspense>
  );
}
