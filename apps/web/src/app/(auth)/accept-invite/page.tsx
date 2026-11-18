import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AuthCard } from '@/components/AuthCard';
import { AcceptInviteView } from './AcceptInviteView';

export const metadata: Metadata = { title: 'Accept your invitation' };

export default function AcceptInvitePage() {
  return (
    <Suspense fallback={<AuthCard title="Join Phoenix Platform" />}>
      <AcceptInviteView />
    </Suspense>
  );
}
