import type { Metadata } from 'next';
import { Suspense } from 'react';
import { CommissionsView } from '@/components/partners/CommissionsView';

export const metadata: Metadata = { title: 'Partner commissions' };

export default function PartnerCommissionsPage() {
  return (
    <Suspense>
      <CommissionsView />
    </Suspense>
  );
}
