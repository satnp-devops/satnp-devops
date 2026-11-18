import type { Metadata } from 'next';
import { Suspense } from 'react';
import { InvoicesList } from '../BillingLists';

export const metadata: Metadata = { title: 'Invoices' };

export default function Page() {
  return (
    <Suspense>
      <InvoicesList />
    </Suspense>
  );
}
