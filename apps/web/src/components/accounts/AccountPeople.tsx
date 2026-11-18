'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { Menu, Section, StatusPill } from '@/components/crm';
import { ConfirmDialog, Dialog, DialogBody, DialogFooter } from '@/components/dialog';
import { Avatar, Button, EmptyState, ErrorAlert, Field, Spinner } from '@/components/ui';
import { fieldErrorsOf, formErrorOf } from '@/lib/api';
import { CONTACT_ROLES, CONTACT_ROLE_LABELS } from '@/lib/accounts/labels';
import { useAddAccountContact, useContactSearch, useRemoveAccountContact, useUpdateAccountContact } from '@/lib/accounts/queries';
import type { AccountContact, AccountContactRole, AccountDetail, ContactListItem } from '@/lib/crm/types';
import { useDebounced } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { PiiText } from './parts';
import './accounts.css';

/** Decision makers and other people at the institute, with add, link, change and remove. */
export function AccountPeople({ account }: { account: AccountDetail }) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<AccountContact | null>(null);
  const [removing, setRemoving] = useState<AccountContact | null>(null);
  const update = useUpdateAccountContact(account.id);
  const remove = useRemoveAccountContact(account.id);
  const canManage = account.can.manage;

  return (
    <Section
      title="Decision makers and contacts"
      count={account.contacts.length}
      flush
      actions={
        canManage ? (
          <Button size="sm" icon="plus" onClick={() => setAdding(true)}>
            Add person
          </Button>
        ) : undefined
      }
    >
      {account.contacts.length === 0 ? (
        <EmptyState
          icon="users"
          title="No people yet"
          action={
            canManage ? (
              <Button size="sm" icon="plus" onClick={() => setAdding(true)}>
                Add the decision maker
              </Button>
            ) : undefined
          }
        >
          Add the director, principal or owner who decides on software, and the people who use it.
        </EmptyState>
      ) : (
        <ul className="accounts-people" aria-label="People at this institute">
          {account.contacts.map((person) => (
            <li key={person.contact.id} className="accounts-person">
              <Avatar name={person.contact.displayName} size={36} />
              <div className="accounts-person__main">
                <div className="accounts-person__name">
                  <Link href={`/leads/contacts?contact=${person.contact.id}`}>{person.contact.displayName}</Link>
                  {person.isPrimary ? (
                    <StatusPill tone="accent" icon="star">
                      Main contact
                    </StatusPill>
                  ) : null}
                </div>
                <div className="accounts-person__meta">
                  <span className={person.role === 'decision_maker' ? 'accounts-role accounts-role--decision' : 'accounts-role'}>
                    {CONTACT_ROLE_LABELS[person.role]}
                  </span>
                  {person.title ? <span>{person.title}</span> : null}
                </div>
                <div className="accounts-person__reach">
                  {person.contact.primaryPhone ? <PiiText value={person.contact.primaryPhone} masked={person.contact.piiMasked} kind="phone" /> : null}
                  {person.contact.primaryEmail ? <PiiText value={person.contact.primaryEmail} masked={person.contact.piiMasked} kind="email" /> : null}
                </div>
              </div>
              {canManage ? (
                <Menu
                  label={`Actions for ${person.contact.displayName}`}
                  placement="bottom-end"
                  trigger={(trigger) => <Button {...trigger} variant="ghost" size="sm" iconOnly icon="more" aria-label={`Actions for ${person.contact.displayName}`} />}
                  items={[
                    ...(person.isPrimary
                      ? []
                      : [
                          {
                            key: 'primary',
                            label: 'Make main contact',
                            icon: 'star' as const,
                            onSelect: () => update.mutate({ contactId: person.contact.id, input: { isPrimary: true } }),
                          },
                        ]),
                    { key: 'edit', label: 'Change role or title', icon: 'edit', onSelect: () => setEditing(person) },
                    { key: 'remove', label: 'Remove from institute', icon: 'trash', danger: true, onSelect: () => setRemoving(person) },
                  ]}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {update.isError && !editing ? (
        <div className="card__body">
          <ErrorAlert error={update.error} />
        </div>
      ) : null}

      <AddPersonDialog account={account} open={adding} onClose={() => setAdding(false)} />
      <EditPersonDialog accountId={account.id} person={editing} onClose={() => setEditing(null)} />
      <ConfirmDialog
        open={removing !== null}
        onClose={() => {
          setRemoving(null);
          remove.reset();
        }}
        title={`Remove ${removing?.contact.displayName ?? 'this person'}?`}
        confirmLabel="Remove"
        danger
        pending={remove.isPending}
        error={remove.error}
        onConfirm={() => {
          if (removing) remove.mutate(removing.contact.id, { onSuccess: () => setRemoving(null) });
        }}
      >
        <p>They stay in your contacts, with their deals and history. Only their link to {account.name} goes.</p>
      </ConfirmDialog>
    </Section>
  );
}

function RoleSelect({ value, onChange, id }: { value: AccountContactRole; onChange: (role: AccountContactRole) => void; id?: string }) {
  return (
    <select id={id} className="select" value={value} onChange={(event) => onChange(event.target.value as AccountContactRole)}>
      {CONTACT_ROLES.map((role) => (
        <option key={role} value={role}>
          {CONTACT_ROLE_LABELS[role]}
        </option>
      ))}
    </select>
  );
}

type Mode = 'new' | 'existing';

function AddPersonDialog({ account, open, onClose }: { account: AccountDetail; open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title={`Add a person to ${account.name}`} description="Someone already in the group with the same phone or email is reused, not copied.">
      {open ? <AddPersonForm account={account} onClose={onClose} /> : null}
    </Dialog>
  );
}

function AddPersonForm({ account, onClose }: { account: AccountDetail; onClose: () => void }) {
  const { scope } = useSession();
  const add = useAddAccountContact(account.id);
  const [mode, setMode] = useState<Mode>('new');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [title, setTitle] = useState('');
  const [role, setRole] = useState<AccountContactRole>(account.contacts.length === 0 ? 'decision_maker' : 'influencer');
  const [isPrimary, setIsPrimary] = useState(account.contacts.length === 0);
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<ContactListItem | null>(null);
  const q = useDebounced(search.trim(), 300);
  const results = useContactSearch(scope.id, mode === 'existing' ? q : '');
  const errors = fieldErrorsOf(add.error);
  const alreadyHere = new Set(account.contacts.map((person) => person.contact.id));

  const canSubmit = mode === 'existing' ? picked !== null : [firstName, lastName, phone, email].some((value) => value.trim() !== '');

  function submit(event: FormEvent) {
    event.preventDefault();
    const common = { title: title.trim() || undefined, role, isPrimary };
    if (mode === 'existing') {
      if (!picked) return;
      add.mutate({ contactId: picked.id, ...common }, { onSuccess: onClose });
      return;
    }
    add.mutate(
      {
        contact: {
          kind: 'staff',
          firstName: firstName.trim() || undefined,
          lastName: lastName.trim() || undefined,
          phones: phone.trim() ? [phone.trim()] : undefined,
          emails: email.trim() ? [email.trim()] : undefined,
        },
        ...common,
      },
      { onSuccess: onClose },
    );
  }

  return (
    <form onSubmit={submit} noValidate>
      <DialogBody>
        <div className="accounts-segmented" role="radiogroup" aria-label="Who to add">
          <label className="chip-toggle">
            <input type="radio" name="person-mode" checked={mode === 'new'} onChange={() => setMode('new')} />
            New person
          </label>
          <label className="chip-toggle">
            <input type="radio" name="person-mode" checked={mode === 'existing'} onChange={() => setMode('existing')} />
            Someone in your contacts
          </label>
        </div>
        <ErrorAlert error={formErrorOf(add.error, ['contact', 'contact.phones.0', 'contact.emails.0', 'contactId', 'title', 'role'])} />

        {mode === 'new' ? (
          <div className="accounts-form-grid">
            <Field label="First name" error={errors.contact}>
              {(control) => <input {...control} className="input" value={firstName} autoFocus onChange={(event) => setFirstName(event.target.value)} />}
            </Field>
            <Field label="Last name" optional>
              {(control) => <input {...control} className="input" value={lastName} onChange={(event) => setLastName(event.target.value)} />}
            </Field>
            <Field label="Phone" optional error={errors['contact.phones.0']}>
              {(control) => <input {...control} className="input" type="tel" value={phone} onChange={(event) => setPhone(event.target.value)} />}
            </Field>
            <Field label="Email" optional error={errors['contact.emails.0']}>
              {(control) => <input {...control} className="input" type="email" value={email} onChange={(event) => setEmail(event.target.value)} />}
            </Field>
          </div>
        ) : (
          <div className="stack gap-8">
            <Field label="Find a contact" hint="Name, phone or email" error={errors.contactId}>
              {(control) => (
                <input
                  {...control}
                  className="input"
                  type="search"
                  autoFocus
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setPicked(null);
                  }}
                />
              )}
            </Field>
            {q.length < 2 ? null : results.isPending ? (
              <Spinner label="Searching contacts" />
            ) : results.isError ? (
              <ErrorAlert error={results.error} title="Couldn't search contacts" />
            ) : (results.data?.data.length ?? 0) === 0 ? (
              <p className="small muted">Nobody matches. Switch to New person to add them.</p>
            ) : (
              <div className="accounts-results" role="radiogroup" aria-label="Contacts found">
                {results.data?.data.map((contact) => {
                  const here = alreadyHere.has(contact.id);
                  return (
                    <label key={contact.id} className={here ? 'accounts-result accounts-result--disabled' : 'accounts-result'}>
                      <input type="radio" name="picked-contact" disabled={here} checked={picked?.id === contact.id} onChange={() => setPicked(contact)} />
                      <span className="accounts-result__name">{contact.displayName}</span>
                      <span className="small muted">{here ? 'Already at this institute' : [contact.city, contact.primaryPhone ?? contact.primaryEmail].filter(Boolean).join(' · ')}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        )}

        <div className="accounts-form-grid">
          <Field label="Title" optional error={errors.title}>
            {(control) => <input {...control} className="input" placeholder="Director, Principal…" value={title} onChange={(event) => setTitle(event.target.value)} />}
          </Field>
          <Field label="Role" error={errors.role}>
            {(control) => <RoleSelect id={control.id} value={role} onChange={setRole} />}
          </Field>
        </div>
        <label className="check">
          <input type="checkbox" checked={isPrimary} onChange={(event) => setIsPrimary(event.target.checked)} />
          <span>Main contact for this institute</span>
        </label>
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" loading={add.isPending} disabled={!canSubmit}>
          Add person
        </Button>
      </DialogFooter>
    </form>
  );
}

function EditPersonDialog({ accountId, person, onClose }: { accountId: string; person: AccountContact | null; onClose: () => void }) {
  return (
    <Dialog open={person !== null} onClose={onClose} title={person ? `${person.contact.displayName} at this institute` : 'Person'}>
      {person ? <EditPersonForm accountId={accountId} person={person} onClose={onClose} /> : null}
    </Dialog>
  );
}

function EditPersonForm({ accountId, person, onClose }: { accountId: string; person: AccountContact; onClose: () => void }) {
  const update = useUpdateAccountContact(accountId);
  const [title, setTitle] = useState(person.title ?? '');
  const [role, setRole] = useState<AccountContactRole>(person.role);
  const [isPrimary, setIsPrimary] = useState(person.isPrimary);
  const errors = fieldErrorsOf(update.error);

  function submit(event: FormEvent) {
    event.preventDefault();
    update.mutate(
      { contactId: person.contact.id, input: { title: title.trim() || null, role, isPrimary } },
      { onSuccess: onClose },
    );
  }

  return (
    <form onSubmit={submit} noValidate>
      <DialogBody>
        <ErrorAlert error={formErrorOf(update.error, ['title', 'role'])} />
        <Field label="Title" optional error={errors.title}>
          {(control) => <input {...control} className="input" value={title} autoFocus onChange={(event) => setTitle(event.target.value)} />}
        </Field>
        <Field label="Role" error={errors.role}>
          {(control) => <RoleSelect id={control.id} value={role} onChange={setRole} />}
        </Field>
        <label className="check">
          <input type="checkbox" checked={isPrimary} onChange={(event) => setIsPrimary(event.target.checked)} />
          <span>Main contact for this institute</span>
        </label>
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" loading={update.isPending}>
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}
