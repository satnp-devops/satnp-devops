import type { Metadata } from 'next';
import { Suspense } from 'react';
import { PaymentsList } from './BillingLists';

export const metadata: Metadata = { title: 'Fees and billing' };

export default function Page() {
  return (
    <Suspense>
      <PaymentsList />
    </Suspense>
  );
}
