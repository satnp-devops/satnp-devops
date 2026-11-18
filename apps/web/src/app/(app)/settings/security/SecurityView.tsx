'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Icon } from '@/components/icons';
import { NewPasswordFields, isNewPasswordReady } from '@/components/NewPasswordFields';
import { Alert, Badge, Button, Card, ErrorAlert, Field, Spinner, cx } from '@/components/ui';
import { api, fieldErrorsOf, formErrorOf } from '@/lib/api';
import { describeDevice, formatDateTime, formatRelative } from '@/lib/format';
import { keys, useDeviceSessions } from '@/lib/queries';
import { useSession } from '@/lib/session';
import type { MfaSetup, User } from '@/lib/types';
import { RecoveryCodes } from './RecoveryCodes';

export function SecurityView() {
  const { mfaSetupRequired } = useSession();
  // Positions stay fixed (null placeholders) so the two-step card keeps its state when the
  // requirement is met and the other cards appear.
  return (
    <div className="stack gap-16">
      {mfaSetupRequired ? (
        <Alert tone="warning" title="Set up two-step verification to continue">
          Your organisation asks everyone to use it. It takes about a minute with an authenticator app such as Google
          Authenticator, Microsoft Authenticator or 1Password.
        </Alert>
      ) : null}
      <TwoStepCard />
      {mfaSetupRequired ? null : (
        <>
          <div className="grid-cards">
            <ProfileCard />
            <PasswordCard />
          </div>
          <DevicesCard />
        </>
      )}
    </div>
  );
}

// ---------- Profile ----------

function timeZones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return ['Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London', 'America/New_York', 'Australia/Sydney'];
  }
}

function ProfileCard() {
  const { user } = useSession();
  const queryClient = useQueryClient();
  const [name, setName] = useState(user.name);
  const [phone, setPhone] = useState(user.phone ?? '');
  const [timeZone, setTimeZone] = useState(user.timeZone ?? '');
  const save = useMutation({
    mutationFn: () =>
      api.patch<User>(`/users/${user.id}`, { name, phone: phone.trim() || null, timeZone: timeZone || null }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.me }),
  });
  const errors = fieldErrorsOf(save.error);
  const changed = name !== user.name || phone !== (user.phone ?? '') || timeZone !== (user.timeZone ?? '');

  return (
    <Card title="Profile">
      <form
        className="stack gap-12"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <ErrorAlert error={formErrorOf(save.error, ['name', 'phone', 'timeZone'])} />
        <Field label="Email" hint="Ask an admin if this needs to change.">
          {(control) => <input {...control} className="input" value={user.email} disabled readOnly />}
        </Field>
        <Field label="Name" error={errors.name}>
          {(control) => (
            <input {...control} className="input" autoComplete="name" required value={name} onChange={(event) => setName(event.target.value)} />
          )}
        </Field>
        <Field label="Phone" optional error={errors.phone}>
          {(control) => (
            <input {...control} className="input" type="tel" autoComplete="tel" value={phone} onChange={(event) => setPhone(event.target.value)} />
          )}
        </Field>
        <Field label="Time zone" error={errors.timeZone}>
          {(control) => (
            <select {...control} className="select" value={timeZone} onChange={(event) => setTimeZone(event.target.value)}>
              <option value="">Same as my organisation</option>
              {timeZones().map((zone) => (
                <option key={zone} value={zone}>
                  {zone.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
          )}
        </Field>
        <div className="row gap-8">
          <Button type="submit" variant="primary" size="sm" loading={save.isPending} disabled={!changed}>
            Save profile
          </Button>
          {save.isSuccess && !changed ? <span className="small muted">Saved</span> : null}
        </div>
      </form>
    </Card>
  );
}

// ---------- Password ----------

function PasswordCard() {
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [attempted, setAttempted] = useState(false);
  const change = useMutation({
    mutationFn: () =>
      api.post<{ otherSessionsSignedOut: number }>('/auth/password/change', { currentPassword: current, newPassword: password }),
    onSuccess: () => {
      setCurrent('');
      setPassword('');
      setConfirm('');
      setAttempted(false);
    },
  });
  const errors = fieldErrorsOf(change.error);
  const signedOut = change.data?.otherSessionsSignedOut ?? 0;

  return (
    <Card title="Password">
      <form
        className="stack gap-12"
        onSubmit={(event) => {
          event.preventDefault();
          setAttempted(true);
          if (current && isNewPasswordReady(password, confirm)) change.mutate();
        }}
      >
        {change.isSuccess ? (
          <Alert tone="success">
            Password changed.{' '}
            {signedOut > 0 ? `We signed you out on ${signedOut} other ${signedOut === 1 ? 'device' : 'devices'}.` : null}
          </Alert>
        ) : null}
        <ErrorAlert error={formErrorOf(change.error, ['currentPassword', 'newPassword'])} />
        <Field label="Current password" error={errors.currentPassword ?? (attempted && !current ? 'Enter your current password' : undefined)}>
          {(control) => (
            <input
              {...control}
              className="input"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(event) => setCurrent(event.target.value)}
            />
          )}
        </Field>
        <NewPasswordFields
          password={password}
          confirm={confirm}
          onPasswordChange={setPassword}
          onConfirmChange={setConfirm}
          serverError={errors.newPassword}
          showProblems={attempted}
        />
        <div>
          <Button type="submit" variant="primary" size="sm" loading={change.isPending}>
            Change password
          </Button>
        </div>
      </form>
    </Card>
  );
}

// ---------- Two-step verification ----------

type TwoStepState =
  | { step: 'idle' }
  | { step: 'scan'; setup: MfaSetup }
  | { step: 'codes'; codes: string[]; justEnabled: boolean }
  | { step: 'disable' }
  | { step: 'regenerate' };

function TwoStepCard() {
  const { user, mfaSetupRequired } = useSession();
  const queryClient = useQueryClient();
  const router = useRouter();
  const [state, setState] = useState<TwoStepState>({ step: 'idle' });
  const [finishing, setFinishing] = useState(false);
  const refreshMe = () => queryClient.invalidateQueries({ queryKey: keys.me });

  const start = useMutation({
    mutationFn: () => api.post<MfaSetup>('/auth/mfa/setup'),
    onSuccess: (setup) => setState({ step: 'scan', setup }),
  });

  const enabled = user.mfaEnabled || (state.step === 'codes' && state.justEnabled);

  return (
    <Card
      title="Two-step verification"
      description="A code from your phone at each sign-in, so a password alone isn't enough."
      actions={enabled ? <Badge tone="success">On</Badge> : <Badge tone="warning">Off</Badge>}
    >
      {state.step === 'scan' ? (
        <ScanStep
          setup={state.setup}
          onCancel={() => setState({ step: 'idle' })}
          onEnabled={(codes) => setState({ step: 'codes', codes, justEnabled: true })}
        />
      ) : state.step === 'codes' ? (
        <div className="stack gap-12">
          <Alert tone={state.justEnabled ? 'success' : 'info'} title={state.justEnabled ? 'Two-step verification is on' : 'New recovery codes'}>
            Save these recovery codes now. Each one gets you in once if you lose your phone, and you won&apos;t see them
            again{state.justEnabled ? '' : '. Your old codes no longer work'}.
          </Alert>
          <RecoveryCodes codes={state.codes} email={user.email} />
          <div>
            <Button
              variant="primary"
              loading={finishing}
              onClick={async () => {
                // Refresh the session first: until then the app still thinks setup is required.
                setFinishing(true);
                await refreshMe();
                setFinishing(false);
                setState({ step: 'idle' });
                if (mfaSetupRequired) router.push('/');
              }}
            >
              {mfaSetupRequired ? "I've saved them, continue" : "I've saved them"}
            </Button>
          </div>
        </div>
      ) : state.step === 'disable' ? (
        <DisableForm
          onCancel={() => setState({ step: 'idle' })}
          onDisabled={() => {
            setState({ step: 'idle' });
            void refreshMe();
          }}
        />
      ) : state.step === 'regenerate' ? (
        <RegenerateForm
          onCancel={() => setState({ step: 'idle' })}
          onDone={(codes) => setState({ step: 'codes', codes, justEnabled: false })}
        />
      ) : enabled ? (
        <div className="stack gap-12">
          <p className="muted">You enter a code from your authenticator app each time you sign in.</p>
          <div className="row gap-8">
            <Button size="sm" icon="refresh" onClick={() => setState({ step: 'regenerate' })}>
              New recovery codes
            </Button>
            <Button size="sm" variant="danger" onClick={() => setState({ step: 'disable' })}>
              Turn off
            </Button>
          </div>
        </div>
      ) : (
        <div className="stack gap-12">
          <p className="muted">
            You&apos;ll need an authenticator app on your phone, such as Google Authenticator, Microsoft Authenticator or
            1Password.
          </p>
          <ErrorAlert error={start.error} />
          <div>
            <Button variant="primary" icon="shield" loading={start.isPending} onClick={() => start.mutate()}>
              Set up two-step verification
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function ScanStep({
  setup,
  onCancel,
  onEnabled,
}: {
  setup: MfaSetup;
  onCancel: () => void;
  onEnabled: (codes: string[]) => void;
}) {
  const [code, setCode] = useState('');
  const enable = useMutation({
    mutationFn: () => api.post<{ recoveryCodes: string[] }>('/auth/mfa/enable', { code }),
    onSuccess: (result) => onEnabled(result.recoveryCodes),
  });
  const grouped = setup.secret.match(/.{1,4}/g)?.join(' ') ?? setup.secret;

  return (
    <form
      className="stack gap-16"
      onSubmit={(event) => {
        event.preventDefault();
        enable.mutate();
      }}
    >
      <div className="scan">
        {/* A data: URL made by the API, so a plain <img> (next/image adds nothing here). */}
        <img className="qr" src={setup.qrDataUrl} width={176} height={176} alt="QR code to add Phoenix Platform to your authenticator app" />
        <ol className="steps">
          <li>Open your authenticator app and add an account.</li>
          <li>
            Scan this QR code. Can&apos;t scan? Type this key instead:
            <code className="secret">{grouped}</code>
          </li>
          <li>Enter the 6-digit code the app shows.</li>
        </ol>
      </div>
      <ErrorAlert error={enable.error} />
      <Field label="Code from the app">
        {(control) => (
          <input
            {...control}
            className={cx('input', 'input--code', 'input--narrow')}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="000000"
            autoFocus
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
          />
        )}
      </Field>
      <div className="row gap-8">
        <Button type="submit" variant="primary" loading={enable.isPending} disabled={code.length !== 6}>
          Turn on
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

function DisableForm({ onCancel, onDisabled }: { onCancel: () => void; onDisabled: () => void }) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const disable = useMutation({
    mutationFn: () => api.post('/auth/mfa/disable', { password, code }),
    onSuccess: onDisabled,
  });
  return (
    <form
      className="stack gap-12"
      onSubmit={(event) => {
        event.preventDefault();
        disable.mutate();
      }}
    >
      <p className="muted">Confirm it&apos;s you. Without two-step verification, your password alone opens your account.</p>
      <ErrorAlert error={disable.error} />
      <div className="form-grid">
        <Field label="Password">
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
        <Field label="Code from your app or a recovery code">
          {(control) => (
            <input
              {...control}
              className="input"
              autoComplete="one-time-code"
              required
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
          )}
        </Field>
      </div>
      <div className="row gap-8">
        <Button type="submit" variant="danger" loading={disable.isPending} disabled={!password || code.trim().length < 6}>
          Turn off
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

function RegenerateForm({ onCancel, onDone }: { onCancel: () => void; onDone: (codes: string[]) => void }) {
  const [password, setPassword] = useState('');
  const regenerate = useMutation({
    mutationFn: () => api.post<{ recoveryCodes: string[] }>('/auth/mfa/recovery-codes', { password }),
    onSuccess: (result) => onDone(result.recoveryCodes),
  });
  return (
    <form
      className="stack gap-12"
      onSubmit={(event) => {
        event.preventDefault();
        regenerate.mutate();
      }}
    >
      <p className="muted">New codes replace your old ones straight away.</p>
      <ErrorAlert error={regenerate.error} />
      <Field label="Password">
        {(control) => (
          <input
            {...control}
            className="input input--narrow"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        )}
      </Field>
      <div className="row gap-8">
        <Button type="submit" variant="primary" loading={regenerate.isPending} disabled={!password}>
          Make new codes
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

// ---------- Devices ----------

function DevicesCard() {
  const queryClient = useQueryClient();
  const sessions = useDeviceSessions();
  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.sessions });
  const signOut = useMutation({
    mutationFn: (sessionId: string) => api.delete(`/auth/sessions/${sessionId}`),
    onSuccess: refresh,
  });
  const signOutOthers = useMutation({
    mutationFn: async (ids: string[]) => {
      for (const id of ids) await api.delete(`/auth/sessions/${id}`);
    },
    onSettled: refresh,
  });
  const others = (sessions.data ?? []).filter((session) => !session.current);

  return (
    <Card
      flush
      title="Where you're signed in"
      description="Sign out anywhere you don't recognise, then change your password."
      actions={
        others.length > 1 ? (
          <Button size="sm" loading={signOutOthers.isPending} onClick={() => signOutOthers.mutate(others.map((s) => s.id))}>
            Sign out everywhere else
          </Button>
        ) : undefined
      }
    >
      {sessions.isPending ? (
        <div className="empty">
          <Spinner />
        </div>
      ) : sessions.isError ? (
        <div className="card__body">
          <ErrorAlert error={sessions.error} />
        </div>
      ) : (
        <ul className="list list--rows">
          {sessions.data.map((session) => (
            <li key={session.id} className="list__item">
              <span className="unit-mark unit-mark--sm">
                <Icon name="device" size={16} />
              </span>
              <div className="list__text">
                <div className="row gap-8">
                  <span className="strong">{describeDevice(session.userAgent)}</span>
                  {session.current ? <Badge tone="success">This device</Badge> : null}
                </div>
                <div className="small muted">
                  {session.ip ?? 'Unknown network'} · active {formatRelative(session.lastSeenAt).toLowerCase()} · signed in{' '}
                  {formatDateTime(session.createdAt)}
                </div>
              </div>
              {session.current ? null : (
                <Button
                  size="sm"
                  loading={signOut.isPending && signOut.variables === session.id}
                  onClick={() => signOut.mutate(session.id)}
                >
                  Sign out
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {signOut.error || signOutOthers.error ? (
        <div className="card__body">
          <ErrorAlert error={signOut.error ?? signOutOthers.error} />
        </div>
      ) : null}
    </Card>
  );
}
