import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AuthCard } from '@/components/AuthCard';
import { LoginView } from './LoginView';

export const metadata: Metadata = { title: 'Sign in' };

export default function LoginPage() {
  return (
    <Suspense fallback={<AuthCard title="Sign in" />}>
      <LoginView />
    </Suspense>
  );
}
