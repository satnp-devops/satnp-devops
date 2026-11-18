import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AgreementsList } from '../BillingLists';

export const metadata: Metadata = { title: 'Agreements' };

export default function Page() {
  return (
    <Suspense>
      <AgreementsList />
    </Suspense>
  );
}
