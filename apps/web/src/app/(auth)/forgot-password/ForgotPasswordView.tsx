'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { AuthCard } from '@/components/AuthCard';
import { Alert, Button, ErrorAlert, Field } from '@/components/ui';
import { api, fieldErrorsOf, formErrorOf } from '@/lib/api';

export function ForgotPasswordView() {
  const [email, setEmail] = useState('');
  const request = useMutation({ mutationFn: () => api.post('/auth/password/forgot', { email }) });

  if (request.isSuccess) {
    return (
      <AuthCard
        title="Check your email"
        subtitle={`If there's an account for ${email.trim()}, we've sent a link to choose a new password. It works once and expires in 1 hour.`}
        footer={<Link href="/login">Back to sign in</Link>}
      >
        {process.env.NODE_ENV !== 'production' ? (
          <Alert tone="info">Running locally? Emails are printed in the worker&apos;s log.</Alert>
        ) : null}
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Reset your password"
      subtitle="Enter your work email and we'll send you a link."
      footer={<Link href="/login">Back to sign in</Link>}
    >
      <form
        className="stack gap-16"
        onSubmit={(event) => {
          event.preventDefault();
          request.mutate();
        }}
      >
        <ErrorAlert error={formErrorOf(request.error, ['email'])} />
        <Field label="Email" error={fieldErrorsOf(request.error).email}>
          {(control) => (
            <input
              {...control}
              className="input"
              type="email"
              autoComplete="username"
              autoFocus
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          )}
        </Field>
        <Button type="submit" variant="primary" block loading={request.isPending}>
          Send reset link
        </Button>
      </form>
    </AuthCard>
  );
}
