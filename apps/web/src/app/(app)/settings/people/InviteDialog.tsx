'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Dialog, DialogBody, DialogFooter } from '@/components/dialog';
import { Alert, Button, CopyButton, ErrorAlert, Field, Spinner } from '@/components/ui';
import { api, fieldErrorsOf, formErrorOf } from '@/lib/api';
import { keys, useRoles, useUnitTypes } from '@/lib/queries';
import { useSession } from '@/lib/session';
import type { InviteResult } from '@/lib/types';
import { AccessPicker, useDefaultChoice, type AccessChoice } from './AccessPicker';

export function InviteDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="Invite people"
      description="They get an email with a link to set a password. Their roles apply to everything under the unit you pick."
    >
      {open ? <InviteForm onClose={onClose} /> : null}
    </Dialog>
  );
}

function InviteForm({ onClose }: { onClose: () => void }) {
  const { scope } = useSession();
  const queryClient = useQueryClient();
  const roles = useRoles(scope.groupId);
  const types = useUnitTypes();
  const defaultChoice = useDefaultChoice(roles.data);

  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  // Until the user changes anything, follow the default (which appears once roles load).
  const [chosen, setChosen] = useState<AccessChoice[] | null>(null);
  const access = chosen ?? [defaultChoice];

  const invite = useMutation({
    mutationFn: () =>
      api.post<InviteResult>('/users/invite', {
        email,
        name,
        phone: phone.trim() || undefined,
        assignments: access.filter((row) => row.unitId && row.roleId),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.peopleAll }),
  });

  if (invite.isSuccess) {
    const result = invite.data;
    return (
      <>
        <DialogBody>
          <Alert
            tone="success"
            title={result.alreadyHadAccount ? `${result.user.name} already has an account` : `Invitation sent to ${result.user.email}`}
          >
            {result.alreadyHadAccount
              ? 'We added the new roles. They apply the next time they open the app.'
              : 'The link works once and expires in 7 days. You can resend it from their profile.'}
          </Alert>
          {result.inviteUrl ? (
            <div className="stack gap-8">
              <p className="small muted">Development only: open the invitation without waiting for email.</p>
              <div className="row gap-8 nowrap">
                <input
                  className="input mono"
                  readOnly
                  value={result.inviteUrl}
                  aria-label="Invitation link"
                  onFocus={(event) => event.target.select()}
                />
                <CopyButton text={result.inviteUrl} />
              </div>
            </div>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button
            onClick={() => {
              setEmail('');
              setName('');
              setPhone('');
              invite.reset();
            }}
          >
            Invite someone else
          </Button>
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </>
    );
  }

  const errors = fieldErrorsOf(invite.error);
  const rowError = (index: number) =>
    errors[`assignments.${index}.roleId`] ?? errors[`assignments.${index}.unitId`] ?? errors[`assignments.${index}`];
  const shownFields = ['email', 'name', 'phone', 'assignments', ...access.flatMap((_, i) => [`assignments.${i}.roleId`, `assignments.${i}.unitId`, `assignments.${i}`])];

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        invite.mutate();
      }}
    >
      <DialogBody>
        <ErrorAlert error={formErrorOf(invite.error, shownFields)} />
        <div className="form-grid">
          <Field label="Work email" error={errors.email}>
            {(control) => (
              <input
                {...control}
                className="input"
                type="email"
                autoComplete="off"
                autoFocus
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            )}
          </Field>
          <Field label="Name" error={errors.name}>
            {(control) => (
              <input {...control} className="input" required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} />
            )}
          </Field>
          <Field label="Phone" optional error={errors.phone}>
            {(control) => (
              <input {...control} className="input" type="tel" value={phone} onChange={(event) => setPhone(event.target.value)} />
            )}
          </Field>
        </div>

        <hr className="divider" />
        <div className="stack gap-12">
          <div>
            <p className="section-title">Roles</p>
            <p className="small muted">You can only give roles that you hold yourself at that place.</p>
          </div>
          {roles.isPending ? (
            <Spinner />
          ) : roles.isError ? (
            <ErrorAlert error={roles.error} />
          ) : (
            access.map((row, index) => (
              <AccessPicker
                key={index}
                value={row}
                roles={roles.data}
                types={types.data}
                error={rowError(index)}
                onChange={(next) => setChosen(access.map((item, i) => (i === index ? next : item)))}
                onRemove={access.length > 1 ? () => setChosen(access.filter((_, i) => i !== index)) : undefined}
              />
            ))
          )}
          {errors.assignments ? <p className="field__error">{errors.assignments}</p> : null}
          {access.length < 10 && roles.isSuccess ? (
            <div>
              <Button size="sm" icon="plus" variant="ghost" onClick={() => setChosen([...access, defaultChoice])}>
                Add another role
              </Button>
            </div>
          ) : null}
        </div>
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" loading={invite.isPending} disabled={!roles.isSuccess}>
          Send invitation
        </Button>
      </DialogFooter>
    </form>
  );
}
