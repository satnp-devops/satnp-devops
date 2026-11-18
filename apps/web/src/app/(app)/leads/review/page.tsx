import type { Metadata } from 'next';
import { Suspense } from 'react';
import { PageLoading } from '@/components/ui';
import { ReviewView } from './ReviewView';

export const metadata: Metadata = { title: 'Review queue' };

export default function ReviewPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <ReviewView />
    </Suspense>
  );
}
