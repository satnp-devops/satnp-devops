import type { Metadata } from 'next';
import { Suspense } from 'react';
import { PageLoading } from '@/components/ui';
import { BookingsView } from './BookingsView';

export const metadata: Metadata = { title: 'Bookings' };

export default function BookingsPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <BookingsView />
    </Suspense>
  );
}
