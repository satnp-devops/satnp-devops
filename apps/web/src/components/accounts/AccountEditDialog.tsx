'use client';

import { useState, type FormEvent } from 'react';
import { Dialog, DialogBody, DialogFooter } from '@/components/dialog';
import { Alert, Button, ErrorAlert, Field } from '@/components/ui';
import { fieldErrorsOf, formErrorOf } from '@/lib/api';
import { ACCOUNT_KINDS, ACCOUNT_STATUSES, ACCOUNT_STATUS_LABELS, accountKindLabel } from '@/lib/accounts/labels';
import { useAccountFields, useUpdateAccount, useUpdateAccountLink } from '@/lib/accounts/queries';
import type {
  AccountDetail,
  AccountKind,
  AccountPatchInput,
  AccountProfile,
  CompanyLink,
  CompanyLinkPatchInput,
  CustomValue,
  CustomValues,
  LinkStatus,
} from '@/lib/crm/types';
import { CustomFieldInputs, customValuesForSave } from './CustomFieldInputs';
import { OwnerSelect } from './OwnerSelect';
import './accounts.css';

// Edit an institute: its shared details (every company sees them) and, for one company, the
// relationship (status, owner, tags, the company's custom institute fields, archiving).

interface DetailsDraft {
  kind: AccountKind;
  name: string;
  legalName: string;
  website: string;
  phone: string;
  email: string;
  city: string;
  state: string;
  countryCode: string;
  line1: string;
  line2: string;
  pincode: string;
  studentCount: string;
  branchCount: string;
  currentSoftware: string;
  gstin: string;
  boards: string;
  exams: string;
  budgetBand: string;
  decisionTimeline: string;
  notes: string;
}

interface LinkDraft {
  status: LinkStatus;
  ownerUserId: string;
  tags: string;
  archived: boolean;
  custom: CustomValues;
}

const text = (value: string | null | undefined): string => value ?? '';
const list = (values: string[] | undefined): string => (values ?? []).join(', ');
const toList = (value: string): string[] =>
  value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
const toCount = (value: string): number | null => (value.trim() === '' ? null : Number.parseInt(value, 10));
const orNull = (value: string): string | null => (value.trim() === '' ? null : value.trim());
const withScheme = (value: string): string | null => {
  const trimmed = orNull(value);
  return trimmed && !/^https?:\/\//i.test(trimmed) ? `https://${trimmed}` : trimmed;
};
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function detailsDraft(account: AccountDetail): DetailsDraft {
  return {
    kind: account.kind,
    name: account.name,
    legalName: text(account.legalName),
    website: text(account.website),
    phone: account.piiMasked ? '' : text(account.primaryPhone),
    email: account.piiMasked ? '' : text(account.primaryEmail),
    city: text(account.city),
    state: text(account.state),
    countryCode: text(account.countryCode),
    line1: text(account.address?.line1),
    line2: text(account.address?.line2),
    pincode: text(account.address?.pincode),
    studentCount: account.studentCount === null ? '' : String(account.studentCount),
    branchCount: account.branchCount === null ? '' : String(account.branchCount),
    currentSoftware: text(account.currentSoftware),
    gstin: text(account.profile.gstin),
    boards: list(account.profile.boards),
    exams: list(account.profile.exams),
    budgetBand: text(account.profile.budgetBand),
    decisionTimeline: text(account.profile.decisionTimeline),
    notes: text(account.profile.notes),
  };
}

/** Only what changed, so a PATCH never rewrites (or needs rights to) fields nobody touched. */
function detailsPatch(account: AccountDetail, draft: DetailsDraft): AccountPatchInput {
  const patch: AccountPatchInput = {};
  if (draft.kind !== account.kind) patch.kind = draft.kind;
  if (draft.name.trim() !== account.name) patch.name = draft.name.trim();
  const plain: Array<[keyof AccountPatchInput, string | null, string | null]> = [
    ['legalName', orNull(draft.legalName), account.legalName],
    ['city', orNull(draft.city), account.city],
    ['state', orNull(draft.state), account.state],
    ['countryCode', orNull(draft.countryCode)?.toUpperCase() ?? null, account.countryCode],
    ['currentSoftware', orNull(draft.currentSoftware), account.currentSoftware],
  ];
  for (const [key, next, current] of plain) if (next !== (current ?? null)) Object.assign(patch, { [key]: next });
  const website = withScheme(draft.website);
  if (website !== (account.website ?? null)) patch.website = website;
  for (const [key, next, current] of [
    ['studentCount', toCount(draft.studentCount), account.studentCount],
    ['branchCount', toCount(draft.branchCount), account.branchCount],
  ] as const) {
    if (next !== current) patch[key] = next;
  }
  if (account.can.viewPii) {
    if (orNull(draft.phone) !== (account.primaryPhone ?? null)) patch.phone = orNull(draft.phone);
    if (orNull(draft.email) !== (account.primaryEmail ?? null)) patch.email = orNull(draft.email);
    const address = { ...(account.address ?? {}), line1: orNull(draft.line1) ?? undefined, line2: orNull(draft.line2) ?? undefined, pincode: orNull(draft.pincode) ?? undefined };
    const cleaned = Object.fromEntries(Object.entries(address).filter(([, value]) => value !== undefined && value !== ''));
    if (!same(cleaned, account.address ?? {})) patch.address = cleaned;
  }
  const profile: AccountProfile = { ...account.profile };
  const setProfile = <K extends keyof AccountProfile>(key: K, value: AccountProfile[K] | null) => {
    if (value === null || (Array.isArray(value) && value.length === 0)) delete profile[key];
    else profile[key] = value;
  };
  setProfile('gstin', orNull(draft.gstin)?.toUpperCase() ?? null);
  setProfile('boards', toList(draft.boards));
  setProfile('exams', toList(draft.exams));
  setProfile('budgetBand', orNull(draft.budgetBand));
  setProfile('decisionTimeline', orNull(draft.decisionTimeline));
  setProfile('notes', orNull(draft.notes));
  if (!same(profile, account.profile)) patch.profile = profile;
  return patch;
}

function linkDraft(link: CompanyLink): LinkDraft {
  return { status: link.status, ownerUserId: link.owner?.id ?? '', tags: link.tags.join(', '), archived: link.archivedAt !== null, custom: { ...link.custom } };
}

export function AccountEditDialog({
  account,
  link,
  canEditLink,
  open,
  onClose,
}: {
  account: AccountDetail;
  /** The company relationship to edit alongside the details, if any. */
  link: CompanyLink | null;
  canEditLink: boolean;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} title={`Edit ${account.name}`} size="lg">
      {open ? <EditForm account={account} link={canEditLink ? link : null} onClose={onClose} /> : null}
    </Dialog>
  );
}

function EditForm({ account, link, onClose }: { account: AccountDetail; link: CompanyLink | null; onClose: () => void }) {
  const [details, setDetails] = useState(() => detailsDraft(account));
  const [relationship, setRelationship] = useState<LinkDraft | null>(() => (link ? linkDraft(link) : null));
  const updateDetails = useUpdateAccount(account.id);
  const updateLink = useUpdateAccountLink(account.id);
  const fields = useAccountFields(link?.company.id ?? null);
  const definitions = fields.data ?? [];
  const error = updateDetails.error ?? updateLink.error;
  const errors = fieldErrorsOf(error);
  const pending = updateDetails.isPending || updateLink.isPending;
  const canEditDetails = account.can.manage;

  const set = <K extends keyof DetailsDraft>(key: K, value: DetailsDraft[K]) => setDetails((current) => ({ ...current, [key]: value }));
  const setLink = <K extends keyof LinkDraft>(key: K, value: LinkDraft[K]) =>
    setRelationship((current) => (current ? { ...current, [key]: value } : current));
  const setCustom = (key: string, value: CustomValue) =>
    setRelationship((current) => (current ? { ...current, custom: { ...current.custom, [key]: value } } : current));

  function linkPatch(): CompanyLinkPatchInput {
    if (!link || !relationship) return {};
    const patch: CompanyLinkPatchInput = {};
    if (relationship.status !== link.status) patch.status = relationship.status;
    if ((relationship.ownerUserId || null) !== (link.owner?.id ?? null)) patch.ownerUserId = relationship.ownerUserId || null;
    const tags = toList(relationship.tags).map((tag) => tag.toLowerCase());
    if (!same([...tags].sort(), [...link.tags].sort())) patch.tags = tags;
    if (relationship.archived !== (link.archivedAt !== null)) patch.archived = relationship.archived;
    const custom = customValuesForSave(definitions, relationship.custom);
    const changed = Object.fromEntries(Object.entries(custom).filter(([key, value]) => !same(value, link.custom[key])));
    if (Object.keys(changed).length > 0) patch.custom = changed;
    return patch;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    updateDetails.reset();
    updateLink.reset();
    try {
      const forDetails = canEditDetails ? detailsPatch(account, details) : {};
      if (Object.keys(forDetails).length > 0) await updateDetails.mutateAsync(forDetails);
      const forLink = linkPatch();
      if (link && Object.keys(forLink).length > 0) await updateLink.mutateAsync({ companyId: link.company.id, input: forLink });
      onClose();
    } catch {
      // Shown next to the fields or above the form.
    }
  }

  const shown = [
    'kind',
    'name',
    'legalName',
    'website',
    'phone',
    'email',
    'city',
    'state',
    'countryCode',
    'address.line1',
    'address.line2',
    'address.pincode',
    'studentCount',
    'branchCount',
    'currentSoftware',
    'profile.gstin',
    'profile.budgetBand',
    'profile.decisionTimeline',
    'profile.notes',
    'status',
    'ownerUserId',
    'tags',
    ...definitions.map((definition) => `custom.${definition.key}`),
  ];

  return (
    <form onSubmit={(event) => void submit(event)} noValidate>
      <DialogBody>
        <ErrorAlert error={formErrorOf(error, shown)} />
        {canEditDetails ? (
          <fieldset className="accounts-fieldset">
            <legend>Institute details</legend>
            <p className="small muted">Shared by every company in the group that works with this institute.</p>
            <div className="accounts-form-grid">
              <Field label="Name" error={errors.name}>
                {(control) => <input {...control} className="input" value={details.name} required maxLength={200} onChange={(event) => set('name', event.target.value)} />}
              </Field>
              <Field label="Kind" error={errors.kind}>
                {(control) => (
                  <select {...control} className="select" value={details.kind} onChange={(event) => set('kind', event.target.value as AccountKind)}>
                    {ACCOUNT_KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {accountKindLabel(kind)}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field label="Legal name" optional error={errors.legalName}>
                {(control) => <input {...control} className="input" value={details.legalName} onChange={(event) => set('legalName', event.target.value)} />}
              </Field>
              <Field label="GSTIN" optional error={errors['profile.gstin']}>
                {(control) => (
                  <input {...control} className="input mono" maxLength={15} placeholder="27AAPFU0939F1ZV" value={details.gstin} onChange={(event) => set('gstin', event.target.value.toUpperCase())} />
                )}
              </Field>
              <Field label="Website" optional error={errors.website}>
                {(control) => <input {...control} className="input" inputMode="url" value={details.website} onChange={(event) => set('website', event.target.value)} />}
              </Field>
              <Field label="Current software" optional error={errors.currentSoftware}>
                {(control) => <input {...control} className="input" value={details.currentSoftware} onChange={(event) => set('currentSoftware', event.target.value)} />}
              </Field>
              <Field label="Students" optional error={errors.studentCount}>
                {(control) => (
                  <input {...control} className="input" inputMode="numeric" value={details.studentCount} onChange={(event) => set('studentCount', event.target.value.replace(/\D/g, ''))} />
                )}
              </Field>
              <Field label="Branches" optional error={errors.branchCount}>
                {(control) => (
                  <input {...control} className="input" inputMode="numeric" value={details.branchCount} onChange={(event) => set('branchCount', event.target.value.replace(/\D/g, ''))} />
                )}
              </Field>
              <Field label="City" optional error={errors.city}>
                {(control) => <input {...control} className="input" value={details.city} onChange={(event) => set('city', event.target.value)} />}
              </Field>
              <Field label="State" optional error={errors.state}>
                {(control) => <input {...control} className="input" value={details.state} onChange={(event) => set('state', event.target.value)} />}
              </Field>
              <Field label="Country code" optional hint="Two letters, like IN" error={errors.countryCode}>
                {(control) => (
                  <input {...control} className="input" maxLength={2} value={details.countryCode} onChange={(event) => set('countryCode', event.target.value.toUpperCase())} />
                )}
              </Field>
              <Field label="Boards" optional hint="Separate with commas" error={errors['profile.boards']}>
                {(control) => <input {...control} className="input" value={details.boards} onChange={(event) => set('boards', event.target.value)} />}
              </Field>
              <Field label="Exams" optional hint="Separate with commas" error={errors['profile.exams']}>
                {(control) => <input {...control} className="input" value={details.exams} onChange={(event) => set('exams', event.target.value)} />}
              </Field>
              <Field label="Budget" optional error={errors['profile.budgetBand']}>
                {(control) => <input {...control} className="input" value={details.budgetBand} onChange={(event) => set('budgetBand', event.target.value)} />}
              </Field>
              <Field label="Decision timeline" optional error={errors['profile.decisionTimeline']}>
                {(control) => <input {...control} className="input" value={details.decisionTimeline} onChange={(event) => set('decisionTimeline', event.target.value)} />}
              </Field>
            </div>
            {account.can.viewPii ? (
              <div className="accounts-form-grid">
                <Field label="Office phone" optional error={errors.phone}>
                  {(control) => <input {...control} className="input" type="tel" value={details.phone} onChange={(event) => set('phone', event.target.value)} />}
                </Field>
                <Field label="Office email" optional error={errors.email}>
                  {(control) => <input {...control} className="input" type="email" value={details.email} onChange={(event) => set('email', event.target.value)} />}
                </Field>
                <Field label="Address" optional error={errors['address.line1']}>
                  {(control) => <input {...control} className="input" value={details.line1} onChange={(event) => set('line1', event.target.value)} />}
                </Field>
                <Field label="Address line 2" optional error={errors['address.line2']}>
                  {(control) => <input {...control} className="input" value={details.line2} onChange={(event) => set('line2', event.target.value)} />}
                </Field>
                <Field label="PIN code" optional error={errors['address.pincode']}>
                  {(control) => <input {...control} className="input" inputMode="numeric" value={details.pincode} onChange={(event) => set('pincode', event.target.value)} />}
                </Field>
              </div>
            ) : (
              <Alert tone="info">Phone, email and address are personal details your role doesn&apos;t include here, so they can&apos;t be changed.</Alert>
            )}
            <Field label="Notes" optional error={errors['profile.notes']}>
              {(control) => <textarea {...control} className="textarea" rows={3} maxLength={2000} value={details.notes} onChange={(event) => set('notes', event.target.value)} />}
            </Field>
          </fieldset>
        ) : null}

        {link && relationship ? (
          <fieldset className="accounts-fieldset">
            <legend>{link.company.name}</legend>
            <p className="small muted">Only {link.company.name} sees these.</p>
            <div className="accounts-form-grid">
              <Field label="Status" error={errors.status}>
                {(control) => (
                  <select {...control} className="select" value={relationship.status} onChange={(event) => setLink('status', event.target.value as LinkStatus)}>
                    {ACCOUNT_STATUSES.map((status) => (
                      <option key={status} value={status}>
                        {ACCOUNT_STATUS_LABELS[status]}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field label="Owner" error={errors.ownerUserId}>
                {(control) => (
                  <OwnerSelect unitId={link.unit.id} value={relationship.ownerUserId} current={link.owner} onChange={(value) => setLink('ownerUserId', value)} control={control} />
                )}
              </Field>
              <Field label="Tags" optional hint="Separate with commas" error={errors.tags ?? errors['tags.0']}>
                {(control) => <input {...control} className="input" value={relationship.tags} onChange={(event) => setLink('tags', event.target.value)} />}
              </Field>
              <CustomFieldInputs definitions={definitions} values={relationship.custom} onChange={setCustom} errors={errors} />
            </div>
            {fields.isError ? <Alert tone="warning">Couldn&apos;t load {link.company.name}&apos;s custom fields, so they can&apos;t be edited right now.</Alert> : null}
            <label className="check">
              <input type="checkbox" checked={relationship.archived} onChange={(event) => setLink('archived', event.target.checked)} />
              <span>Archived: hide from {link.company.name}&apos;s institute lists</span>
            </label>
          </fieldset>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" loading={pending} disabled={canEditDetails && details.name.trim() === ''}>
          Save changes
        </Button>
      </DialogFooter>
    </form>
  );
}
