'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AuthCard } from '@/components/AuthCard';
import { NewPasswordFields, isNewPasswordReady } from '@/components/NewPasswordFields';
import { Button, ErrorAlert, Field, Spinner } from '@/components/ui';
import { api, fieldErrorsOf, formErrorOf } from '@/lib/api';
import type { InviteInfo } from '@/lib/types';

export function AcceptInviteView() {
  const token = useSearchParams().get('token') ?? '';
  const invite = useQuery({
    queryKey: ['invite', token],
    queryFn: () => api.get<InviteInfo>(`/auth/invites/${encodeURIComponent(token)}`),
    enabled: token !== '',
    retry: false,
    staleTime: Infinity,
  });

  if (!token || invite.isError) {
    return (
      <AuthCard
        title="This invitation can't be used"
        subtitle="It may have expired, been used already, or been replaced by a newer one. Ask the person who invited you to send it again."
        footer={<Link href="/login">Go to sign in</Link>}
      />
    );
  }
  if (invite.isPending) {
    return (
      <AuthCard title="Join Phoenix Platform">
        <Spinner />
      </AuthCard>
    );
  }
  return <AcceptForm token={token} invite={invite.data} />;
}

function AcceptForm({ token, invite }: { token: string; invite: InviteInfo }) {
  const [name, setName] = useState(invite.name);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [attempted, setAttempted] = useState(false);
  const accept = useMutation({
    mutationFn: () => api.post('/auth/invites/accept', { token, name, password }),
    // The API signs the new account in; load the app fresh with that session.
    onSuccess: () => window.location.assign('/'),
  });
  const errors = fieldErrorsOf(accept.error);

  return (
    <AuthCard
      title="Join Phoenix Platform"
      subtitle={
        invite.invitedBy
          ? `${invite.invitedBy} invited ${invite.email}. Set a password to get started.`
          : `Set a password for ${invite.email} to get started.`
      }
    >
      <form
        className="stack gap-16"
        onSubmit={(event) => {
          event.preventDefault();
          setAttempted(true);
          if (isNewPasswordReady(password, confirm) && name.trim()) accept.mutate();
        }}
      >
        <ErrorAlert error={formErrorOf(accept.error, ['name', 'password'])} />
        <input type="email" value={invite.email} autoComplete="username" readOnly hidden />
        <Field label="Your name" error={errors.name ?? (attempted && !name.trim() ? 'Enter your name' : undefined)}>
          {(control) => (
            <input
              {...control}
              className="input"
              autoComplete="name"
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          )}
        </Field>
        <NewPasswordFields
          label="Password"
          password={password}
          confirm={confirm}
          onPasswordChange={setPassword}
          onConfirmChange={setConfirm}
          serverError={errors.password}
          showProblems={attempted}
        />
        <Button type="submit" variant="primary" block loading={accept.isPending || accept.isSuccess}>
          Create my account
        </Button>
      </form>
    </AuthCard>
  );
}
