'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Dialog, DialogBody, DialogFooter } from '@/components/dialog';
import { Alert, Avatar, Badge, Button, CopyButton, ErrorAlert, Field } from '@/components/ui';
import { api, fieldErrorsOf, formErrorOf } from '@/lib/api';
import { formatDate, formatRelative } from '@/lib/format';
import { keys, usePerson, useRoles, useUnitTypes } from '@/lib/queries';
import { useSession } from '@/lib/session';
import type { Assignment, Person } from '@/lib/types';
import { AccessPicker, useAssignableUnits, useDefaultChoice, type AccessChoice } from './AccessPicker';
import { StatusBadge } from './StatusBadge';

export function PersonDialog({ person, onClose }: { person: Person | null; onClose: () => void }) {
  return (
    <Dialog open={person !== null} onClose={onClose} size="lg" title={person?.name ?? ''} description={person?.email}>
      {person ? <PersonPanel initial={person} onClose={onClose} /> : null}
    </Dialog>
  );
}

function PersonPanel({ initial, onClose }: { initial: Person; onClose: () => void }) {
  const { user: me, unitsById, can } = useSession();
  const queryClient = useQueryClient();
  const query = usePerson(initial.id);
  const person = query.data ?? initial;
  const isSelf = person.id === me.id;

  const canManageAt = (assignment: Assignment) => {
    const unit = unitsById.get(assignment.unit.id);
    return unit ? can('users.manage', unit) : false;
  };
  // Changing someone's account needs the right over every place they work.
  const canManage = !isSelf && person.assignments.length > 0 && person.assignments.every(canManageAt);
  const assignableUnits = useAssignableUnits();
  const canAddRoles = !isSelf && person.status !== 'disabled' && assignableUnits.length > 0;

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: keys.person(person.id) }),
      queryClient.invalidateQueries({ queryKey: keys.peopleAll }),
    ]);
  };

  const removeRole = useMutation({
    mutationFn: (assignmentId: string) => api.delete(`/users/${person.id}/assignments/${assignmentId}`),
    onSuccess: refresh,
  });

  return (
    <>
      <DialogBody>
        <div className="row gap-12">
          <Avatar name={person.name} size={44} />
          <div className="stack gap-2 grow">
            <div className="row gap-8">
              <StatusBadge status={person.status} />
              {person.mfaEnabled ? <Badge tone="success">Two-step on</Badge> : <Badge>Two-step off</Badge>}
              {isSelf ? <Badge tone="accent">You</Badge> : null}
            </div>
            <p className="small muted">
              {person.status === 'invited'
                ? `Invited ${formatDate(person.createdAt)}, hasn't joined yet`
                : `Last signed in ${formatRelative(person.lastLoginAt).toLowerCase()}`}
              {person.phone ? ` · ${person.phone}` : ''}
            </p>
          </div>
        </div>
        <ErrorAlert error={query.error} />

        <section className="stack gap-8" aria-labelledby="person-roles">
          <p className="section-title" id="person-roles">
            Roles
          </p>
          {person.assignments.length === 0 ? (
            <p className="muted">No roles that you can see.</p>
          ) : (
            <ul className="list list--bordered">
              {person.assignments.map((assignment) => (
                <li key={assignment.id} className="list__item">
                  <div className="list__text">
                    <span className="strong">{assignment.role.name}</span>
                    <span className="muted"> at {assignment.unit.name}</span>
                  </div>
                  {assignment.unit.status === 'archived' ? <Badge tone="warning">Unit archived</Badge> : null}
                  {!isSelf && canManageAt(assignment) ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon="trash"
                      aria-label={`Remove ${assignment.role.name} at ${assignment.unit.name}`}
                      loading={removeRole.isPending && removeRole.variables === assignment.id}
                      onClick={() => removeRole.mutate(assignment.id)}
                    >
                      Remove
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          <ErrorAlert error={removeRole.error} />
          {canAddRoles ? (
            <AddRole personId={person.id} near={person.assignments.map((a) => a.unit.id)} onAdded={refresh} />
          ) : null}
          {isSelf ? <p className="small muted">Ask another admin to change your own roles.</p> : null}
        </section>

        {canManage ? (
          <>
            <hr className="divider" />
            <DetailsForm person={person} onSaved={refresh} />
            <hr className="divider" />
            <AccountActions person={person} onChanged={refresh} />
          </>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>Close</Button>
      </DialogFooter>
    </>
  );
}

function AddRole({ personId, near, onAdded }: { personId: string; near: string[]; onAdded: () => Promise<void> }) {
  const { scope } = useSession();
  const roles = useRoles(scope.groupId);
  const types = useUnitTypes();
  // Start where they already work.
  const defaultChoice = useDefaultChoice(roles.data, near);
  const [chosen, setChosen] = useState<AccessChoice | null>(null);
  const choice = chosen ?? defaultChoice;
  const add = useMutation({
    mutationFn: () => api.post(`/users/${personId}/assignments`, choice),
    onSuccess: async () => {
      setChosen(null);
      await onAdded();
    },
  });

  if (!roles.isSuccess) return null;
  return (
    <form
      className="stack gap-8 add-role"
      onSubmit={(event) => {
        event.preventDefault();
        add.mutate();
      }}
    >
      <p className="small strong">Give another role</p>
      <AccessPicker value={choice} onChange={setChosen} roles={roles.data} types={types.data} />
      <ErrorAlert error={add.error} />
      <div>
        <Button type="submit" size="sm" icon="plus" loading={add.isPending} disabled={!choice.roleId || !choice.unitId}>
          Add role
        </Button>
      </div>
    </form>
  );
}

function DetailsForm({ person, onSaved }: { person: Person; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(person.name);
  const [phone, setPhone] = useState(person.phone ?? '');
  const save = useMutation({
    mutationFn: () => api.patch<Person>(`/users/${person.id}`, { name, phone: phone.trim() || null }),
    onSuccess: onSaved,
  });
  const errors = fieldErrorsOf(save.error);
  const changed = name !== person.name || phone !== (person.phone ?? '');

  return (
    <form
      className="stack gap-12"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <p className="section-title">Details</p>
      <ErrorAlert error={formErrorOf(save.error, ['name', 'phone'])} />
      <div className="form-grid">
        <Field label="Name" error={errors.name}>
          {(control) => <input {...control} className="input" required value={name} onChange={(event) => setName(event.target.value)} />}
        </Field>
        <Field label="Phone" optional error={errors.phone}>
          {(control) => <input {...control} className="input" type="tel" value={phone} onChange={(event) => setPhone(event.target.value)} />}
        </Field>
      </div>
      <div className="row gap-8">
        <Button type="submit" size="sm" variant="primary" loading={save.isPending} disabled={!changed}>
          Save details
        </Button>
        {save.isSuccess && !changed ? <span className="small muted">Saved</span> : null}
      </div>
    </form>
  );
}

function AccountActions({ person, onChanged }: { person: Person; onChanged: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const setStatus = useMutation({
    mutationFn: (status: 'active' | 'disabled') => api.patch<Person>(`/users/${person.id}`, { status }),
    onSuccess: async () => {
      setConfirming(false);
      await onChanged();
    },
  });
  const resend = useMutation({ mutationFn: () => api.post<{ inviteUrl?: string }>(`/users/${person.id}/invite`) });

  return (
    <section className="stack gap-12" aria-labelledby="person-account">
      <p className="section-title" id="person-account">
        Account
      </p>
      <ErrorAlert error={setStatus.error ?? resend.error} />

      {person.status === 'invited' ? (
        <div className="stack gap-8">
          <div className="row gap-8">
            <Button size="sm" icon="mail" loading={resend.isPending} onClick={() => resend.mutate()}>
              Send the invitation again
            </Button>
            {resend.isSuccess ? <span className="small muted">Sent. The previous link no longer works.</span> : null}
          </div>
          {resend.data?.inviteUrl ? (
            <div className="row gap-8 nowrap">
              <input className="input mono" readOnly value={resend.data.inviteUrl} aria-label="Invitation link" />
              <CopyButton text={resend.data.inviteUrl} />
            </div>
          ) : null}
        </div>
      ) : null}

      {person.status === 'disabled' ? (
        <div className="row gap-8">
          <Button size="sm" icon="restore" loading={setStatus.isPending} onClick={() => setStatus.mutate('active')}>
            Re-enable account
          </Button>
          <span className="small muted">They can sign in again with their existing password.</span>
        </div>
      ) : confirming ? (
        <Alert
          tone="warning"
          title={`Disable ${person.name}'s account?`}
          action={
            <div className="row gap-8 nowrap">
              <Button size="sm" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button size="sm" variant="danger" loading={setStatus.isPending} onClick={() => setStatus.mutate('disabled')}>
                Disable
              </Button>
            </div>
          }
        >
          They&apos;re signed out everywhere straight away. Their roles and history are kept, so you can re-enable them later.
        </Alert>
      ) : (
        <div>
          <Button size="sm" variant="danger" icon="lock" onClick={() => setConfirming(true)}>
            Disable account
          </Button>
        </div>
      )}
    </section>
  );
}
