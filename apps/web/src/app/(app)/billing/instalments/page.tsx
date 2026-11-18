import type { Metadata } from 'next';
import { Suspense } from 'react';
import { InstalmentsList } from '../BillingLists';

export const metadata: Metadata = { title: 'Instalments' };

export default function Page() {
  return (
    <Suspense>
      <InstalmentsList />
    </Suspense>
  );
}
