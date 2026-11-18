'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { UnitSelect } from '@/components/UnitSelect';
import { Dialog, DialogBody, DialogFooter } from '@/components/dialog';
import { Alert, Avatar, Button, ErrorAlert, Field } from '@/components/ui';
import { fieldErrorsOf, formErrorOf } from '@/lib/api';
import { useDebounced } from '@/lib/hooks';
import { CONTACT_KINDS, DUPLICATE_REASON_LABELS, KIND_LABELS, companyOfUnit, nameOf } from '@/lib/contacts/labels';
import { useContactCheck, useCreateContact } from '@/lib/contacts/queries';
import type { ContactCheckBody, ContactCreateBody, ContactCreateResult, ContactKind } from '@/lib/crm/types';
import { useSession } from '@/lib/session';
import { isWithin } from '@/lib/tree';
import type { OrgUnit } from '@/lib/types';
import { PiiText } from './PiiText';
import './contacts.css';

interface Draft {
  unitId: string;
  kind: ContactKind;
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
}

/** Units under the scope where the user may add people: they must belong to a company. */
export function useCreatableUnits(): OrgUnit[] {
  const { workUnits, scope, unitsById, can } = useSession();
  return useMemo(
    () =>
      workUnits.filter(
        (unit) => isWithin(unit.path, scope.path) && companyOfUnit(unit, unitsById) !== null && can('contacts.manage', unit),
      ),
    [workUnits, scope, unitsById, can],
  );
}

/**
 * Add a person. While typing, the API checks the group for the same phone or email (and similar
 * names): an existing person is offered instead ("Asha Verma already exists - use this person"),
 * so the group keeps one record per person.
 */
export function CreateContactDialog({
  open,
  onClose,
  onDone,
  onOpenExisting,
}: {
  open: boolean;
  onClose: () => void;
  /** After saving: the new person, or the existing one they were linked to. */
  onDone: (result: ContactCreateResult) => void;
  /** Open a similar person the viewer can already see, without saving. */
  onOpenExisting: (id: string) => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} size="lg" title="New contact" description="A parent, student or institute staff member.">
      {open ? <CreateContactForm onClose={onClose} onDone={onDone} onOpenExisting={onOpenExisting} /> : null}
    </Dialog>
  );
}

function CreateContactForm({
  onClose,
  onDone,
  onOpenExisting,
}: {
  onClose: () => void;
  onDone: (result: ContactCreateResult) => void;
  onOpenExisting: (id: string) => void;
}) {
  const { scope } = useSession();
  const units = useCreatableUnits();
  // The scope when people can be added there; otherwise an explicit pick (never a silent first company).
  const [unitId, setUnitId] = useState(() =>
    units.some((unit) => unit.id === scope.id) ? scope.id : units.length === 1 ? (units[0]?.id ?? '') : '',
  );
  const [kind, setKind] = useState<ContactKind>('parent');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [city, setCity] = useState('');
  const create = useCreateContact();
  const errors = fieldErrorsOf(create.error);

  // The live duplicate check runs once typing pauses and there is a number, an email or a full name.
  // (Debounce a string: a fresh object every render would never settle.)
  const draftKey = JSON.stringify({ unitId, kind, firstName: firstName.trim(), lastName: lastName.trim(), phone: phone.trim(), email: email.trim() });
  const settled = useDebounced(draftKey, 450);
  const checkBody = useMemo<ContactCheckBody | null>(() => {
    const draft = JSON.parse(settled) as Draft;
    const phoneOk = draft.phone.replace(/\D/g, '').length >= 7;
    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.email);
    const nameOk = draft.firstName.length >= 2 && draft.lastName.length >= 2;
    if (!draft.unitId || !(phoneOk || emailOk || nameOk)) return null;
    return {
      unitId: draft.unitId,
      kind: draft.kind,
      firstName: draft.firstName || undefined,
      lastName: draft.lastName || undefined,
      phones: phoneOk ? [draft.phone] : undefined,
      emails: emailOk ? [draft.email] : undefined,
    };
  }, [settled]);
  const check = useContactCheck(checkBody);
  const match = checkBody ? check.data?.match ?? null : null;
  const hiddenMatch = checkBody ? check.data?.hiddenMatch === true : false;
  const candidates = checkBody ? (check.data?.candidates ?? []).filter((c) => c.contact.id !== match?.id) : [];

  function save(mode: 'link' | 'create') {
    const body: ContactCreateBody = {
      unitId,
      kind,
      firstName: firstName.trim() || undefined,
      lastName: lastName.trim() || undefined,
      city: city.trim() || undefined,
      phones: phone.trim() ? [phone.trim()] : undefined,
      emails: email.trim() ? [email.trim()] : undefined,
      mode,
    };
    create.mutate(body, { onSuccess: onDone });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    save('link');
  }

  const shown = ['unitId', 'kind', 'firstName', 'lastName', 'city', 'phones.0', 'phones', 'emails.0', 'emails'];
  if (units.length === 0) {
    return (
      <DialogBody>
        <Alert tone="warning" title="You can't add people here">
          Pick a company or team you work in from the switcher at the top, then try again.
        </Alert>
      </DialogBody>
    );
  }

  return (
    <form onSubmit={submit} noValidate>
      <DialogBody>
        <div className="form-grid">
          {units.length > 1 ? (
            <Field label="Company or team" hint="The person is shared across the group; this company keeps the link." error={errors.unitId}>
              {(control) => <UnitSelect units={units} value={unitId} onChange={setUnitId} control={control} placeholder="Pick a company or team" />}
            </Field>
          ) : null}
          <Field label="Role" error={errors.kind}>
            {(control) => (
              <select {...control} className="select" value={kind} onChange={(event) => setKind(event.target.value as ContactKind)}>
                {CONTACT_KINDS.map((value) => (
                  <option key={value} value={value}>
                    {KIND_LABELS[value]}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="First name" error={errors.firstName}>
            {(control) => (
              <input {...control} className="input" autoComplete="off" maxLength={80} value={firstName} onChange={(e) => setFirstName(e.target.value)} autoFocus />
            )}
          </Field>
          <Field label="Last name" optional error={errors.lastName}>
            {(control) => <input {...control} className="input" autoComplete="off" maxLength={80} value={lastName} onChange={(e) => setLastName(e.target.value)} />}
          </Field>
          <Field label="Phone" optional hint="With country code, or a local number" error={errors['phones.0'] ?? errors.phones}>
            {(control) => (
              <input {...control} className="input" type="tel" autoComplete="off" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91 98765 43210" />
            )}
          </Field>
          <Field label="Email" optional error={errors['emails.0'] ?? errors.emails}>
            {(control) => <input {...control} className="input" type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />}
          </Field>
          <Field label="City" optional error={errors.city}>
            {(control) => <input {...control} className="input" maxLength={80} value={city} onChange={(e) => setCity(e.target.value)} />}
          </Field>
        </div>

        <div className="contacts-match" aria-live="polite">
          {match ? (
            <Alert
              tone="warning"
              title={`${nameOf(match)} already exists - use this person`}
              action={
                <Button size="sm" variant="primary" loading={create.isPending && create.variables?.mode === 'link'} onClick={() => save('link')}>
                  Use this person
                </Button>
              }
            >
              <p className="small">
                Same {check.data?.matchedBy === 'email' ? 'email' : 'phone number'}
                {match.city ? ` · ${match.city}` : ''}
                {match.primaryPhone ? ' · ' : ''}
                <PiiText value={match.primaryPhone} kind="phone" masked={match.piiMasked} />
                . Using them keeps one record and all their history.{' '}
                <button type="button" className="link-button" onClick={() => onOpenExisting(match.id)}>
                  Open {nameOf(match)}
                </button>
              </p>
            </Alert>
          ) : hiddenMatch ? (
            <Alert tone="info" title="This person is already known in the group">
              Another company or team has them. Saving links them to yours and you&apos;ll see the shared details, not their deals there.
            </Alert>
          ) : null}
          {candidates.length > 0 ? (
            <div className="stack gap-6">
              <p className="small strong">Similar people</p>
              <ul className="contacts-candidates">
                {candidates.slice(0, 5).map((candidate) => (
                  <li key={candidate.contact.id} className="contacts-candidate">
                    <Avatar name={nameOf(candidate.contact)} size={28} />
                    <span className="contacts-candidate__text">
                      <span className="strong">{nameOf(candidate.contact)}</span>
                      <span className="contacts-sub">
                        {[KIND_LABELS[candidate.contact.kind], candidate.contact.city, ...candidate.reasons.map((r) => DUPLICATE_REASON_LABELS[r])]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </span>
                    <Button size="sm" onClick={() => onOpenExisting(candidate.contact.id)}>
                      Open
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
        <ErrorAlert error={formErrorOf(create.error, shown)} />
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>Cancel</Button>
        {match ? (
          <Button loading={create.isPending && create.variables?.mode === 'create'} onClick={() => save('create')}>
            Create a separate person
          </Button>
        ) : (
          <Button type="submit" variant="primary" loading={create.isPending} disabled={!unitId}>
            {hiddenMatch ? 'Save and link' : 'Create contact'}
          </Button>
        )}
      </DialogFooter>
    </form>
  );
}
