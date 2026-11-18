import type { Metadata } from 'next';
import { Suspense } from 'react';
import { PageLoading } from '@/components/ui';
import { ContactsView } from './ContactsView';

export const metadata: Metadata = { title: 'Contacts' };

/** Parents, students and institute staff of the group; `?contact=<id>` opens the contact drawer. */
export default function ContactsPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <ContactsView />
    </Suspense>
  );
}
