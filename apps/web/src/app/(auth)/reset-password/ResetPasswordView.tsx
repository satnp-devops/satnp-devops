'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { AuthCard } from '@/components/AuthCard';
import { NewPasswordFields, isNewPasswordReady } from '@/components/NewPasswordFields';
import { Button, ButtonLink, ErrorAlert } from '@/components/ui';
import { api, fieldErrorsOf, formErrorOf } from '@/lib/api';

export function ResetPasswordView() {
  const token = useSearchParams().get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [attempted, setAttempted] = useState(false);
  const reset = useMutation({ mutationFn: () => api.post('/auth/password/reset', { token, password }) });

  if (!token) {
    return (
      <AuthCard
        title="This link is incomplete"
        subtitle="Open the link from your email again, or ask for a new one."
        footer={<Link href="/login">Back to sign in</Link>}
      >
        <ButtonLink href="/forgot-password" variant="primary" block>
          Send a new link
        </ButtonLink>
      </AuthCard>
    );
  }

  if (reset.isSuccess) {
    return (
      <AuthCard
        title="Password updated"
        subtitle="Sign in with your new password. For safety, you've been signed out on every other device."
      >
        <ButtonLink href="/login" variant="primary" block>
          Sign in
        </ButtonLink>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Choose a new password" footer={<Link href="/login">Back to sign in</Link>}>
      <form
        className="stack gap-16"
        onSubmit={(event) => {
          event.preventDefault();
          setAttempted(true);
          if (isNewPasswordReady(password, confirm)) reset.mutate();
        }}
      >
        <ErrorAlert error={formErrorOf(reset.error, ['password'])} />
        <NewPasswordFields
          password={password}
          confirm={confirm}
          onPasswordChange={setPassword}
          onConfirmChange={setConfirm}
          serverError={fieldErrorsOf(reset.error).password}
          showProblems={attempted}
        />
        <Button type="submit" variant="primary" block loading={reset.isPending}>
          Save new password
        </Button>
        {reset.error ? (
          <Link href="/forgot-password" className="small">
            Need a new link?
          </Link>
        ) : null}
      </form>
    </AuthCard>
  );
}
