import type { Metadata } from 'next';
import { Suspense } from 'react';
import { PageLoading } from '@/components/ui';
import { SearchView } from './SearchView';

export const metadata: Metadata = { title: 'Search' };

export default function SearchPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <SearchView />
    </Suspense>
  );
}
