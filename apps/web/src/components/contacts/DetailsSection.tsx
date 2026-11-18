'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { DateTime, KeyValue, Section, StatusPill, type KeyValueItem } from '@/components/crm';
import { Dialog, DialogBody, DialogFooter } from '@/components/dialog';
import { Button, ErrorAlert, Field } from '@/components/ui';
import { fieldErrorsOf, formErrorOf } from '@/lib/api';
import { CONTACT_KINDS, KIND_LABELS, LINK_STATUS_LABELS, countryName, languageName } from '@/lib/contacts/labels';
import { useUpdateContact } from '@/lib/contacts/queries';
import type { Address, ContactDetail, ContactKind, ContactPatchBody, StudentProfile } from '@/lib/crm/types';
import './contacts.css';

const PROFILE_LABELS: Array<[keyof StudentProfile, string]> = [
  ['grade', 'Grade'],
  ['school', 'School'],
  ['board', 'Board'],
  ['targetExam', 'Target exam'],
  ['targetDate', 'Target date'],
  ['graduationYear', 'Graduation year'],
  ['stream', 'Stream'],
];

function addressText(address: Address | null): string {
  if (!address) return '';
  return [address.line1, address.line2, address.city, address.state, address.pincode, address.country].filter(Boolean).join(', ');
}

/** Who the person is: names, place, student facts, and the companies that know them. */
export function DetailsSection({ contact }: { contact: ContactDetail }) {
  const [editing, setEditing] = useState(false);
  const profile = contact.studentProfile;
  const showProfile = contact.kind === 'student' || PROFILE_LABELS.some(([key]) => profile[key] !== undefined);

  const items: KeyValueItem[] = [
    { label: 'Role', value: KIND_LABELS[contact.kind] },
    { label: 'City', value: contact.city },
    { label: 'Country', value: countryName(contact.countryCode) },
    { label: 'Time zone', value: contact.timeZone },
    { label: 'Language', value: languageName(contact.language) },
  ];
  if (contact.can.viewPii) {
    items.push(
      { label: 'Date of birth', value: contact.dateOfBirth ? <DateTime value={`${contact.dateOfBirth}T00:00:00Z`} format="date" timeZone="UTC" sans /> : null },
      { label: 'Address', value: addressText(contact.address) },
    );
  }
  if (showProfile) {
    for (const [key, label] of PROFILE_LABELS) {
      const value = profile[key];
      if (value === undefined) items.push({ key, label, value: null });
      else if (key === 'targetDate') items.push({ key, label, value: <DateTime value={`${value}T00:00:00Z`} format="date" timeZone="UTC" sans /> });
      else items.push({ key, label, value: String(value) });
    }
  }

  return (
    <>
      <Section
        title="Details"
        level={3}
        actions={
          contact.can.manage ? (
            <Button size="sm" icon="edit" onClick={() => setEditing(true)}>
              Edit
            </Button>
          ) : null
        }
      >
        <KeyValue items={items} />
      </Section>

      <Section title="Companies" level={3} count={contact.links.length} flush>
        {contact.links.length === 0 ? (
          <p className="contacts-empty-line">No company you can see knows this person.</p>
        ) : (
          <ul className="contacts-rows">
            {contact.links.map((link) => (
              <li key={link.id} className="contacts-row">
                <div className="contacts-row__text">
                  <span className="contacts-row__title">{link.company.name}</span>
                  <span className="contacts-sub">
                    {link.unit.name}
                    {link.owner ? ` · Owner ${link.owner.name}` : ' · No owner'}
                    {' · Since '}
                    <DateTime value={link.firstSeenAt} format="date" sans />
                  </span>
                  {link.tags.length > 0 ? <span className="contacts-sub">Tags: {link.tags.join(', ')}</span> : null}
                </div>
                <div className="contacts-badges">
                  <StatusPill tone={link.status === 'customer' ? 'success' : link.status === 'lead' ? 'accent' : 'neutral'}>
                    {LINK_STATUS_LABELS[link.status]}
                  </StatusPill>
                  {link.archivedAt ? <StatusPill>Archived</StatusPill> : null}
                </div>
              </li>
            ))}
          </ul>
        )}
        {contact.accounts.length > 0 ? (
          <ul className="contacts-rows" aria-label="Institutes">
            {contact.accounts.map((ref) => (
              <li key={ref.account.id} className="contacts-row">
                <div className="contacts-row__text">
                  <Link className="contacts-row__link" href={`/accounts/${ref.account.id}`}>
                    {ref.account.name}
                  </Link>
                  <span className="contacts-sub">
                    {[ref.title, ref.role.replace(/_/g, ' '), ref.isPrimary ? 'main contact' : null].filter(Boolean).join(' · ')}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </Section>

      <EditContactDialog contact={contact} open={editing} onClose={() => setEditing(false)} />
    </>
  );
}

// ---------- Edit ----------

function EditContactDialog({ contact, open, onClose }: { contact: ContactDetail; open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} size="lg" title={`Edit ${contact.displayName}`}>
      {open ? <EditContactForm contact={contact} onClose={onClose} /> : null}
    </Dialog>
  );
}

type ProfileDraft = Record<keyof StudentProfile, string>;

function profileDraft(profile: StudentProfile): ProfileDraft {
  return {
    grade: profile.grade ?? '',
    school: profile.school ?? '',
    board: profile.board ?? '',
    targetExam: profile.targetExam ?? '',
    targetDate: profile.targetDate ?? '',
    graduationYear: profile.graduationYear === undefined ? '' : String(profile.graduationYear),
    stream: profile.stream ?? '',
  };
}

function EditContactForm({ contact, onClose }: { contact: ContactDetail; onClose: () => void }) {
  const update = useUpdateContact(contact.id);
  const [kind, setKind] = useState<ContactKind>(contact.kind);
  const [firstName, setFirstName] = useState(contact.firstName ?? '');
  const [lastName, setLastName] = useState(contact.lastName ?? '');
  const [city, setCity] = useState(contact.city ?? '');
  const [countryCode, setCountryCode] = useState(contact.countryCode ?? '');
  const [timeZone, setTimeZone] = useState(contact.timeZone ?? '');
  const [language, setLanguage] = useState(contact.language ?? '');
  const [dateOfBirth, setDateOfBirth] = useState(contact.dateOfBirth ?? '');
  const [line1, setLine1] = useState(contact.address?.line1 ?? '');
  const [pincode, setPincode] = useState(contact.address?.pincode ?? '');
  const [profile, setProfile] = useState<ProfileDraft>(() => profileDraft(contact.studentProfile));
  const errors = fieldErrorsOf(update.error);

  const text = (value: string) => value.trim() || null;

  function submit(event: FormEvent) {
    event.preventDefault();
    const studentProfile: NonNullable<ContactPatchBody['studentProfile']> = {};
    const original = profileDraft(contact.studentProfile);
    for (const key of Object.keys(profile) as Array<keyof StudentProfile>) {
      if (profile[key] === original[key]) continue;
      const value = profile[key].trim();
      if (key === 'graduationYear') studentProfile.graduationYear = value ? Number(value) : null;
      else studentProfile[key] = value || null;
    }
    const body: ContactPatchBody = {
      kind,
      firstName: text(firstName),
      lastName: text(lastName),
      city: text(city),
      countryCode: countryCode.trim() ? countryCode.trim().toUpperCase() : null,
      timeZone: text(timeZone),
      language: text(language),
    };
    if (Object.keys(studentProfile).length > 0) body.studentProfile = studentProfile;
    if (contact.can.viewPii) {
      if ((contact.dateOfBirth ?? '') !== dateOfBirth) body.dateOfBirth = dateOfBirth || null;
      if ((contact.address?.line1 ?? '') !== line1 || (contact.address?.pincode ?? '') !== pincode) {
        const address: Address = { ...(contact.address ?? {}) };
        if (line1.trim()) address.line1 = line1.trim();
        else delete address.line1;
        if (pincode.trim()) address.pincode = pincode.trim();
        else delete address.pincode;
        body.address = Object.keys(address).length > 0 ? address : null;
      }
    }
    update.mutate(body, { onSuccess: onClose });
  }

  const shown = ['kind', 'firstName', 'lastName', 'city', 'countryCode', 'timeZone', 'language', 'dateOfBirth'];
  return (
    <form onSubmit={submit} noValidate>
      <DialogBody>
        <div className="form-grid">
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
            {(control) => <input {...control} className="input" value={firstName} onChange={(e) => setFirstName(e.target.value)} />}
          </Field>
          <Field label="Last name" optional error={errors.lastName}>
            {(control) => <input {...control} className="input" value={lastName} onChange={(e) => setLastName(e.target.value)} />}
          </Field>
          <Field label="City" optional error={errors.city}>
            {(control) => <input {...control} className="input" value={city} onChange={(e) => setCity(e.target.value)} />}
          </Field>
          <Field label="Country code" optional hint="Two letters, e.g. IN" error={errors.countryCode}>
            {(control) => (
              <input {...control} className="input" maxLength={2} value={countryCode} onChange={(e) => setCountryCode(e.target.value)} />
            )}
          </Field>
          <Field label="Time zone" optional hint="e.g. Asia/Kolkata" error={errors.timeZone}>
            {(control) => <input {...control} className="input" value={timeZone} onChange={(e) => setTimeZone(e.target.value)} />}
          </Field>
          <Field label="Language" optional hint="e.g. en, hi" error={errors.language}>
            {(control) => <input {...control} className="input" value={language} onChange={(e) => setLanguage(e.target.value)} />}
          </Field>
          {contact.can.viewPii ? (
            <>
              <Field label="Date of birth" optional error={errors.dateOfBirth}>
                {(control) => (
                  <input {...control} type="date" className="input" value={dateOfBirth} onChange={(e) => setDateOfBirth(e.target.value)} />
                )}
              </Field>
              <Field label="Address" optional error={errors['address.line1']}>
                {(control) => <input {...control} className="input" value={line1} onChange={(e) => setLine1(e.target.value)} />}
              </Field>
              <Field label="PIN code" optional error={errors['address.pincode']}>
                {(control) => <input {...control} className="input" value={pincode} onChange={(e) => setPincode(e.target.value)} />}
              </Field>
            </>
          ) : null}
        </div>
        {kind === 'student' ? (
          <fieldset className="field field--group">
            <legend className="field__label">Student</legend>
            <div className="form-grid">
              {PROFILE_LABELS.map(([key, label]) => (
                <Field key={key} label={label} optional error={errors[`studentProfile.${key}`]}>
                  {(control) => (
                    <input
                      {...control}
                      className="input"
                      type={key === 'targetDate' ? 'date' : key === 'graduationYear' ? 'number' : 'text'}
                      value={profile[key]}
                      onChange={(event) => setProfile((current) => ({ ...current, [key]: event.target.value }))}
                    />
                  )}
                </Field>
              ))}
            </div>
          </fieldset>
        ) : null}
        <ErrorAlert error={formErrorOf(update.error, shown)} />
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
