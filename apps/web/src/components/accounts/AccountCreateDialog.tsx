'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Dialog, DialogBody, DialogFooter } from '@/components/dialog';
import { UnitSelect } from '@/components/UnitSelect';
import { Alert, Button, ErrorAlert, Field } from '@/components/ui';
import { fieldErrorsOf, formErrorOf } from '@/lib/api';
import { ACCOUNT_KINDS, ACCOUNT_STATUSES, ACCOUNT_STATUS_LABELS, accountKindLabel } from '@/lib/accounts/labels';
import { useAccountFields, useCreateAccount } from '@/lib/accounts/queries';
import { companyOfUnit } from '@/lib/accounts/units';
import type { AccountContactInput, AccountCreateInput, AccountKind, CustomValue, CustomValues, LinkStatus } from '@/lib/crm/types';
import { useSession } from '@/lib/session';
import type { OrgUnit } from '@/lib/types';
import { CustomFieldInputs, customValuesForSave } from './CustomFieldInputs';
import './accounts.css';

interface Draft {
  unitId: string;
  kind: AccountKind;
  name: string;
  website: string;
  phone: string;
  email: string;
  city: string;
  state: string;
  studentCount: string;
  branchCount: string;
  currentSoftware: string;
  status: LinkStatus;
  personFirst: string;
  personLast: string;
  personTitle: string;
  personPhone: string;
  personEmail: string;
  custom: CustomValues;
}

const blankDraft = (unitId: string): Draft => ({
  unitId,
  kind: 'coaching_institute',
  name: '',
  website: '',
  phone: '',
  email: '',
  city: '',
  state: '',
  studentCount: '',
  branchCount: '',
  currentSoftware: '',
  status: 'lead',
  personFirst: '',
  personLast: '',
  personTitle: '',
  personPhone: '',
  personEmail: '',
  custom: {},
});

const optional = (value: string): string | undefined => (value.trim() === '' ? undefined : value.trim());
const count = (value: string): number | undefined => (value.trim() === '' ? undefined : Number.parseInt(value, 10));
/** "sunrise.example" → "https://sunrise.example": people rarely type the scheme. */
const withScheme = (value: string): string | undefined => {
  const text = optional(value);
  return text && !/^https?:\/\//i.test(text) ? `https://${text}` : text;
};

/**
 * Add an institute. The server finds it if the group already knows it (same website, email,
 * phone, or name in the same city) and links it to the chosen unit's company instead of
 * creating a duplicate; the profile page then says so.
 */
export function AccountCreateDialog({ open, onClose, units }: { open: boolean; onClose: () => void; units: readonly OrgUnit[] }) {
  return (
    <Dialog open={open} onClose={onClose} title="Add institute" description="If someone in the group already added it, it's linked instead of copied." size="lg">
      {open && units[0] ? <CreateForm units={units} onClose={onClose} /> : null}
    </Dialog>
  );
}

function CreateForm({ units, onClose }: { units: readonly OrgUnit[]; onClose: () => void }) {
  const router = useRouter();
  const { unitsById } = useSession();
  const [draft, setDraft] = useState<Draft>(() => blankDraft(units[0]?.id ?? ''));
  const create = useCreateAccount();
  const company = companyOfUnit(unitsById.get(draft.unitId), unitsById);
  const fields = useAccountFields(company?.id ?? null);
  const definitions = fields.data ?? [];
  const errors = fieldErrorsOf(create.error);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const setCustom = (key: string, value: CustomValue) => setDraft((current) => ({ ...current, custom: { ...current.custom, [key]: value } }));

  const hasPerson = [draft.personFirst, draft.personLast, draft.personPhone, draft.personEmail].some((value) => value.trim() !== '');
  const shown = [
    'unitId',
    'kind',
    'name',
    'website',
    'phone',
    'email',
    'city',
    'state',
    'studentCount',
    'branchCount',
    'currentSoftware',
    'status',
    'contacts.0.contact',
    'contacts.0.contact.phones.0',
    'contacts.0.contact.emails.0',
    ...definitions.map((definition) => `custom.${definition.key}`),
  ];

  function submit(event: FormEvent) {
    event.preventDefault();
    const contacts: AccountContactInput[] = hasPerson
      ? [
          {
            contact: {
              kind: 'staff',
              firstName: optional(draft.personFirst),
              lastName: optional(draft.personLast),
              phones: optional(draft.personPhone) ? [draft.personPhone.trim()] : undefined,
              emails: optional(draft.personEmail) ? [draft.personEmail.trim()] : undefined,
            },
            title: optional(draft.personTitle),
            role: 'decision_maker',
            isPrimary: true,
          },
        ]
      : [];
    const input: AccountCreateInput = {
      unitId: draft.unitId,
      kind: draft.kind,
      name: draft.name.trim(),
      website: withScheme(draft.website),
      phone: optional(draft.phone),
      email: optional(draft.email),
      city: optional(draft.city),
      state: optional(draft.state),
      studentCount: count(draft.studentCount),
      branchCount: count(draft.branchCount),
      currentSoftware: optional(draft.currentSoftware),
      status: draft.status,
      custom: customValuesForSave(definitions, draft.custom),
      source: { channel: 'manual' },
      contacts,
    };
    create.mutate(input, {
      onSuccess: (result) => {
        onClose();
        const query = result.created ? '' : `?matched=${result.matchedBy ?? 'name'}${result.linkCreated ? '&linked=1' : ''}`;
        router.push(`/accounts/${result.account.id}${query}`);
      },
    });
  }

  return (
    <form onSubmit={submit} noValidate>
      <DialogBody>
        <ErrorAlert error={formErrorOf(create.error, shown)} />
        {units.length > 1 ? (
          <Field label="Add to" hint="The team or branch that will work this institute" error={errors.unitId}>
            {(control) => <UnitSelect units={units} value={draft.unitId} onChange={(value) => set('unitId', value)} control={control} />}
          </Field>
        ) : null}

        <div className="accounts-form-grid">
          <Field label="Name" error={errors.name}>
            {(control) => (
              <input {...control} className="input" value={draft.name} autoFocus required maxLength={200} onChange={(event) => set('name', event.target.value)} />
            )}
          </Field>
          <Field label="Kind" error={errors.kind}>
            {(control) => (
              <select {...control} className="select" value={draft.kind} onChange={(event) => set('kind', event.target.value as AccountKind)}>
                {ACCOUNT_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {accountKindLabel(kind)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Website" optional error={errors.website}>
            {(control) => (
              <input {...control} className="input" inputMode="url" placeholder="sunrise.example" value={draft.website} onChange={(event) => set('website', event.target.value)} />
            )}
          </Field>
          <Field label="Status" error={errors.status}>
            {(control) => (
              <select {...control} className="select" value={draft.status} onChange={(event) => set('status', event.target.value as LinkStatus)}>
                {ACCOUNT_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {ACCOUNT_STATUS_LABELS[status]}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Office phone" optional error={errors.phone}>
            {(control) => <input {...control} className="input" type="tel" value={draft.phone} onChange={(event) => set('phone', event.target.value)} />}
          </Field>
          <Field label="Office email" optional error={errors.email}>
            {(control) => <input {...control} className="input" type="email" value={draft.email} onChange={(event) => set('email', event.target.value)} />}
          </Field>
          <Field label="City" optional error={errors.city}>
            {(control) => <input {...control} className="input" value={draft.city} onChange={(event) => set('city', event.target.value)} />}
          </Field>
          <Field label="State" optional error={errors.state}>
            {(control) => <input {...control} className="input" value={draft.state} onChange={(event) => set('state', event.target.value)} />}
          </Field>
          <Field label="Students" optional error={errors.studentCount}>
            {(control) => (
              <input {...control} className="input" inputMode="numeric" value={draft.studentCount} onChange={(event) => set('studentCount', event.target.value.replace(/\D/g, ''))} />
            )}
          </Field>
          <Field label="Branches" optional error={errors.branchCount}>
            {(control) => (
              <input {...control} className="input" inputMode="numeric" value={draft.branchCount} onChange={(event) => set('branchCount', event.target.value.replace(/\D/g, ''))} />
            )}
          </Field>
          <Field label="Current software" optional hint="What they use today for tests, fees or attendance" error={errors.currentSoftware}>
            {(control) => <input {...control} className="input" value={draft.currentSoftware} onChange={(event) => set('currentSoftware', event.target.value)} />}
          </Field>
        </div>

        {definitions.length > 0 ? (
          <fieldset className="accounts-fieldset">
            <legend>{company ? `${company.name} fields` : 'More fields'}</legend>
            <div className="accounts-form-grid">
              <CustomFieldInputs definitions={definitions} values={draft.custom} onChange={setCustom} errors={errors} />
            </div>
          </fieldset>
        ) : null}

        <fieldset className="accounts-fieldset">
          <legend>Decision maker</legend>
          <p className="small muted">Optional. Someone already in the group with this phone or email is reused.</p>
          <div className="accounts-form-grid">
            <Field label="First name" optional error={errors['contacts.0.contact']}>
              {(control) => <input {...control} className="input" value={draft.personFirst} onChange={(event) => set('personFirst', event.target.value)} />}
            </Field>
            <Field label="Last name" optional>
              {(control) => <input {...control} className="input" value={draft.personLast} onChange={(event) => set('personLast', event.target.value)} />}
            </Field>
            <Field label="Title" optional>
              {(control) => (
                <input {...control} className="input" placeholder="Director, Principal…" value={draft.personTitle} onChange={(event) => set('personTitle', event.target.value)} />
              )}
            </Field>
            <Field label="Phone" optional error={errors['contacts.0.contact.phones.0']}>
              {(control) => <input {...control} className="input" type="tel" value={draft.personPhone} onChange={(event) => set('personPhone', event.target.value)} />}
            </Field>
            <Field label="Email" optional error={errors['contacts.0.contact.emails.0']}>
              {(control) => <input {...control} className="input" type="email" value={draft.personEmail} onChange={(event) => set('personEmail', event.target.value)} />}
            </Field>
          </div>
        </fieldset>
        {fields.isError ? (
          <Alert tone="warning">Couldn&apos;t load this company&apos;s custom fields. You can add them later from the institute page.</Alert>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" loading={create.isPending} disabled={draft.name.trim() === ''}>
          Add institute
        </Button>
      </DialogFooter>
    </form>
  );
}
