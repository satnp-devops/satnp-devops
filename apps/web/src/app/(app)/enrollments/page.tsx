import type { Metadata } from 'next';
import { Suspense } from 'react';
import { PageLoading } from '@/components/ui';
import { EnrollmentsView } from './EnrollmentsView';

export const metadata: Metadata = { title: 'Enrollments' };

export default function EnrollmentsPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <EnrollmentsView />
    </Suspense>
  );
}
