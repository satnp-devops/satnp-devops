'use client';

import { useState, type FormEvent } from 'react';
import { Menu, Section, StatusPill } from '@/components/crm';
import { ConfirmDialog, Dialog, DialogBody, DialogFooter } from '@/components/dialog';
import { Avatar, Button, ErrorAlert, Field, Spinner } from '@/components/ui';
import { fieldErrorsOf, formErrorOf } from '@/lib/api';
import { HOUSEHOLD_ROLES, HOUSEHOLD_ROLE_LABELS, KIND_LABELS, nameOf } from '@/lib/contacts/labels';
import { useAddHouseholdMember, useCreateHousehold, useHousehold, useRemoveHouseholdMember } from '@/lib/contacts/queries';
import type { ContactDetail, ContactHouseholdRef, ContactKind, ContactListItem, HouseholdMember, HouseholdRole } from '@/lib/crm/types';
import { useSession } from '@/lib/session';
import { ContactPicker } from './ContactPicker';
import './contacts.css';

function defaultRole(kind: ContactKind): HouseholdRole {
  return kind === 'parent' ? 'parent' : kind === 'student' ? 'student' : 'other';
}

/** The person's households: members, siblings, add a member, create a household. */
export function HouseholdsSection({ contact, onOpenContact }: { contact: ContactDetail; onOpenContact: (id: string) => void }) {
  const [creating, setCreating] = useState(false);
  return (
    <Section
      title="Household"
      level={3}
      count={contact.households.length || undefined}
      flush
      actions={
        contact.can.manage ? (
          <Button size="sm" icon="plus" onClick={() => setCreating(true)}>
            {contact.households.length === 0 ? 'Create household' : 'New household'}
          </Button>
        ) : null
      }
    >
      {contact.households.length === 0 ? (
        <p className="contacts-empty-line">Not in a household yet. Create one to link parents, students and siblings.</p>
      ) : (
        contact.households.map((ref) => <HouseholdCard key={ref.id} entry={ref} contact={contact} onOpenContact={onOpenContact} />)
      )}
      <CreateHouseholdDialog contact={contact} open={creating} onClose={() => setCreating(false)} />
    </Section>
  );
}

function HouseholdCard({
  entry,
  contact,
  onOpenContact,
}: {
  entry: ContactHouseholdRef;
  contact: ContactDetail;
  onOpenContact: (id: string) => void;
}) {
  const household = useHousehold(entry.id);
  const remove = useRemoveHouseholdMember(entry.id);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<HouseholdMember | null>(null);

  if (household.isPending) {
    return (
      <div className="contacts-household">
        <div className="contacts-household__head">
          <h4 className="contacts-household__name">{entry.name}</h4>
          <Spinner label="Loading household" />
        </div>
      </div>
    );
  }
  if (household.isError) {
    return (
      <div className="contacts-household card__body">
        <ErrorAlert error={household.error} title={`Couldn't load ${entry.name}`} />
      </div>
    );
  }

  const data = household.data;
  const isStudent = entry.role === 'student';
  const canManage = data.can.manage;
  return (
    <div className="contacts-household">
      <div className="contacts-household__head">
        <div>
          <h4 className="contacts-household__name">{data.name}</h4>
          <span className="contacts-sub">
            {[data.city, `${HOUSEHOLD_ROLE_LABELS[entry.role]}${entry.relation ? ` (${entry.relation})` : ''} here`].filter(Boolean).join(' · ')}
          </span>
        </div>
        {canManage ? (
          <Button size="sm" icon="plus" onClick={() => setAdding(true)}>
            Add member
          </Button>
        ) : null}
      </div>
      <ul className="contacts-rows" aria-label={`Members of ${data.name}`}>
        {data.members.map((member) => {
          const self = member.contact.id === contact.id;
          const sibling = isStudent && !self && member.role === 'student';
          return (
            <li key={member.contact.id} className="contacts-row">
              <Avatar name={nameOf(member.contact)} size={28} />
              <div className="contacts-row__text">
                {self ? (
                  <span className="contacts-row__title">{nameOf(member.contact)}</span>
                ) : (
                  <button type="button" className="contacts-row__button" onClick={() => onOpenContact(member.contact.id)}>
                    {nameOf(member.contact)}
                  </button>
                )}
                <span className="contacts-sub">
                  {[HOUSEHOLD_ROLE_LABELS[member.role], member.relation, member.contact.city].filter(Boolean).join(' · ')}
                </span>
              </div>
              <div className="contacts-badges">
                {self ? <StatusPill>This person</StatusPill> : null}
                {sibling ? <StatusPill tone="accent">Sibling</StatusPill> : null}
                {member.isPrimary ? <StatusPill tone="success">Main contact</StatusPill> : null}
              </div>
              {canManage ? (
                <div className="contacts-row__actions">
                  <Menu
                    label={`Actions for ${nameOf(member.contact)}`}
                    placement="bottom-end"
                    items={[{ key: 'remove', label: 'Remove from household', icon: 'trash', danger: true, onSelect: () => setRemoving(member) }]}
                    trigger={(trigger) => (
                      <Button {...trigger} size="sm" variant="ghost" iconOnly icon="more" aria-label={`Actions for ${nameOf(member.contact)}`} />
                    )}
                  />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {data.hiddenMemberCount > 0 ? (
        <p className="contacts-empty-line">
          {data.hiddenMemberCount === 1 ? 'One more member is' : `${data.hiddenMemberCount} more members are`} known only to other teams or
          companies.
        </p>
      ) : null}

      <AddMemberDialog
        open={adding}
        onClose={() => setAdding(false)}
        householdId={data.id}
        householdName={data.name}
        exclude={data.members.map((member) => member.contact.id)}
      />
      <ConfirmDialog
        open={removing !== null}
        onClose={() => {
          setRemoving(null);
          remove.reset();
        }}
        title={removing ? `Remove ${nameOf(removing.contact)} from ${data.name}?` : 'Remove member?'}
        confirmLabel="Remove"
        danger
        pending={remove.isPending}
        error={remove.error}
        onConfirm={() => {
          if (removing) remove.mutate(removing.contact.id, { onSuccess: () => setRemoving(null) });
        }}
      >
        <p>
          The person keeps their record and history. {data.members.length + data.hiddenMemberCount <= 1 ? 'The household has no other member, so it is archived.' : ''}
        </p>
      </ConfirmDialog>
    </div>
  );
}

// ---------- Add a member ----------

function AddMemberDialog({
  open,
  onClose,
  householdId,
  householdName,
  exclude,
}: {
  open: boolean;
  onClose: () => void;
  householdId: string;
  householdName: string;
  exclude: readonly string[];
}) {
  return (
    <Dialog open={open} onClose={onClose} title={`Add to ${householdName}`} description="Find the parent, guardian, student or sibling.">
      {open ? <AddMemberForm householdId={householdId} exclude={exclude} onClose={onClose} /> : null}
    </Dialog>
  );
}

function AddMemberForm({ householdId, exclude, onClose }: { householdId: string; exclude: readonly string[]; onClose: () => void }) {
  const { scope } = useSession();
  const add = useAddHouseholdMember(householdId);
  const [picked, setPicked] = useState<ContactListItem | null>(null);
  const [role, setRole] = useState<HouseholdRole>('student');
  const [relation, setRelation] = useState('');
  const errors = fieldErrorsOf(add.error);

  function pick(contact: ContactListItem) {
    setPicked(contact);
    setRole(defaultRole(contact.kind));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!picked) return;
    add.mutate({ contactId: picked.id, role, relation: relation.trim() || undefined }, { onSuccess: onClose });
  }

  return (
    <form onSubmit={submit} noValidate>
      <DialogBody>
        <ContactPicker unitId={scope.id} selectedId={picked?.id ?? null} onSelect={pick} exclude={exclude} />
        {picked ? <p className="small">Adding {nameOf(picked)} ({KIND_LABELS[picked.kind].toLowerCase()}).</p> : null}
        <div className="form-grid">
          <RoleField value={role} onChange={setRole} error={errors.role} />
          <Field label="Relation" optional hint="e.g. Mother, Elder brother" error={errors.relation}>
            {(control) => <input {...control} className="input" maxLength={40} value={relation} onChange={(e) => setRelation(e.target.value)} />}
          </Field>
        </div>
        <ErrorAlert error={formErrorOf(add.error, ['role', 'relation'])} />
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" loading={add.isPending} disabled={!picked}>
          Add member
        </Button>
      </DialogFooter>
    </form>
  );
}

function RoleField({ value, onChange, error, label = 'Role in the household' }: { value: HouseholdRole; onChange: (role: HouseholdRole) => void; error?: string; label?: string }) {
  return (
    <Field label={label} error={error}>
      {(control) => (
        <select {...control} className="select" value={value} onChange={(event) => onChange(event.target.value as HouseholdRole)}>
          {HOUSEHOLD_ROLES.map((option) => (
            <option key={option} value={option}>
              {HOUSEHOLD_ROLE_LABELS[option]}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

// ---------- Create a household ----------

function CreateHouseholdDialog({ contact, open, onClose }: { contact: ContactDetail; open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="Create household" description={`Starts with ${nameOf(contact)}; add a parent or student now or later.`}>
      {open ? <CreateHouseholdForm contact={contact} onClose={onClose} /> : null}
    </Dialog>
  );
}

function CreateHouseholdForm({ contact, onClose }: { contact: ContactDetail; onClose: () => void }) {
  const { scope } = useSession();
  const create = useCreateHousehold();
  const [name, setName] = useState(contact.lastName ? `${contact.lastName} family` : `${nameOf(contact)}'s family`);
  const [city, setCity] = useState(contact.city ?? '');
  const [role, setRole] = useState<HouseholdRole>(defaultRole(contact.kind));
  const [other, setOther] = useState<ContactListItem | null>(null);
  const [otherRole, setOtherRole] = useState<HouseholdRole>('student');
  const errors = fieldErrorsOf(create.error);

  function submit(event: FormEvent) {
    event.preventDefault();
    const members = [{ contactId: contact.id, role, isPrimary: role === 'parent' || role === 'guardian' }];
    if (other) members.push({ contactId: other.id, role: otherRole, isPrimary: false });
    create.mutate({ unitId: scope.id, name: name.trim(), city: city.trim() || undefined, members }, { onSuccess: onClose });
  }

  return (
    <form onSubmit={submit} noValidate>
      <DialogBody>
        <div className="form-grid">
          <Field label="Name" error={errors.name}>
            {(control) => <input {...control} className="input" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />}
          </Field>
          <Field label="City" optional error={errors.city}>
            {(control) => <input {...control} className="input" maxLength={80} value={city} onChange={(e) => setCity(e.target.value)} />}
          </Field>
          <RoleField label={`${nameOf(contact)} is the`} value={role} onChange={setRole} error={errors['members.0.role']} />
        </div>
        <fieldset className="field field--group">
          <legend className="field__label">
            Another member <span className="field__optional">(optional)</span>
          </legend>
          <ContactPicker
            unitId={scope.id}
            selectedId={other?.id ?? null}
            onSelect={(picked) => {
              setOther(picked);
              setOtherRole(defaultRole(picked.kind));
            }}
            exclude={[contact.id]}
          />
          {other ? (
            <div className="form-grid">
              <RoleField label={`${nameOf(other)} is the`} value={otherRole} onChange={setOtherRole} error={errors['members.1.role']} />
              <div className="row">
                <Button size="sm" variant="ghost" icon="x" onClick={() => setOther(null)}>
                  Don&apos;t add {nameOf(other)}
                </Button>
              </div>
            </div>
          ) : null}
        </fieldset>
        <ErrorAlert error={formErrorOf(create.error, ['name', 'city', 'members.0.role', 'members.1.role'])} />
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" loading={create.isPending} disabled={!name.trim()}>
          Create household
        </Button>
      </DialogFooter>
    </form>
  );
}
