import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AuthCard } from '@/components/AuthCard';
import { ResetPasswordView } from './ResetPasswordView';

export const metadata: Metadata = { title: 'Choose a new password' };

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<AuthCard title="Choose a new password" />}>
      <ResetPasswordView />
    </Suspense>
  );
}
