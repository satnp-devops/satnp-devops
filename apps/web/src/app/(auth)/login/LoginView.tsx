'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AuthCard } from '@/components/AuthCard';
import { Button, ErrorAlert, Field, Spinner, cx } from '@/components/ui';
import { api, fieldErrorsOf, formErrorOf } from '@/lib/api';
import { safeNextPath } from '@/lib/objects';
import { fetchMe, keys } from '@/lib/queries';
import { useSignOut } from '@/lib/useSignOut';

/**
 * One page for both steps. Which step shows depends on the session itself:
 * no session → email and password; a session waiting for its second step → the code.
 */
export function LoginView() {
  const params = useSearchParams();
  const next = safeNextPath(params.get('next'));
  const router = useRouter();
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: keys.me, queryFn: fetchMe, retry: false });

  const signedIn = me.isSuccess && !me.data.session.mfaPending;
  useEffect(() => {
    if (signedIn) router.replace(next);
  }, [signedIn, next, router]);

  const refreshSession = () => queryClient.invalidateQueries({ queryKey: keys.me });

  if (me.isPending || signedIn) {
    return (
      <AuthCard title="Signing you in">
        <Spinner />
      </AuthCard>
    );
  }
  if (me.isSuccess && me.data.session.mfaPending) {
    return <CodeStep email={me.data.user.email} onVerified={refreshSession} />;
  }
  return <PasswordStep onSignedIn={refreshSession} />;
}

function PasswordStep({ onSignedIn }: { onSignedIn: () => Promise<void> }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const login = useMutation({
    mutationFn: async () => {
      await api.post<{ mfaRequired: boolean }>('/auth/login', { email, password });
      await onSignedIn();
    },
  });
  const fieldErrors = fieldErrorsOf(login.error);

  return (
    <AuthCard title="Sign in" subtitle="Use your work email and password." footer="New here? Use the invitation link from your email.">
      <form
        className="stack gap-16"
        onSubmit={(event) => {
          event.preventDefault();
          login.mutate();
        }}
      >
        <ErrorAlert error={formErrorOf(login.error, ['email', 'password'])} />
        <Field label="Email" error={fieldErrors.email}>
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
        <Field label="Password" error={fieldErrors.password}>
          {(control) => (
            <input
              {...control}
              className="input"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          )}
        </Field>
        <Button type="submit" variant="primary" block loading={login.isPending}>
          Sign in
        </Button>
        <Link href="/forgot-password" className="small">
          Forgot your password?
        </Link>
      </form>
    </AuthCard>
  );
}

function CodeStep({ email, onVerified }: { email: string; onVerified: () => Promise<void> }) {
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const signOut = useSignOut();
  const verify = useMutation({
    mutationFn: async () => {
      await api.post('/auth/mfa/verify', { code });
      await onVerified();
    },
  });

  return (
    <AuthCard title="Two-step verification" subtitle={`Signing in as ${email}`}>
      <form
        className="stack gap-16"
        onSubmit={(event) => {
          event.preventDefault();
          verify.mutate();
        }}
      >
        <ErrorAlert error={verify.error} />
        <Field
          label={useRecovery ? 'Recovery code' : 'Verification code'}
          hint={
            useRecovery
              ? 'One of the codes you saved when you turned this on. Each code works once.'
              : 'Open your authenticator app and enter the 6-digit code for Phoenix Platform.'
          }
        >
          {(control) => (
            <input
              {...control}
              key={useRecovery ? 'recovery' : 'totp'}
              className={cx('input', !useRecovery && 'input--code')}
              inputMode={useRecovery ? 'text' : 'numeric'}
              autoComplete="one-time-code"
              autoFocus
              required
              maxLength={useRecovery ? 16 : 6}
              placeholder={useRecovery ? 'XXXXX-XXXXX' : '000000'}
              value={code}
              onChange={(event) => setCode(useRecovery ? event.target.value : event.target.value.replace(/\D/g, ''))}
            />
          )}
        </Field>
        <Button type="submit" variant="primary" block loading={verify.isPending} disabled={code.trim().length < 6}>
          Verify
        </Button>
        <div className="row small">
          <button
            type="button"
            className="link-button"
            onClick={() => {
              setUseRecovery((value) => !value);
              setCode('');
              verify.reset();
            }}
          >
            {useRecovery ? 'Use the authenticator app' : 'Use a recovery code'}
          </button>
          <span className="spacer" />
          <button type="button" className="link-button" onClick={() => signOut.mutate()} disabled={signOut.isPending}>
            Sign in as someone else
          </button>
        </div>
      </form>
    </AuthCard>
  );
}
