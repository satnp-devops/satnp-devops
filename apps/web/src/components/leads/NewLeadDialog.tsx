'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import { Dialog, DialogBody, DialogFooter } from '@/components/dialog';
import { Alert, Button, ErrorAlert, Field } from '@/components/ui';
import { fieldErrorsOf, formErrorOf } from '@/lib/api';
import { CHANNEL_KEYS, channelLabel, formatCount } from '@/lib/crm/format';
import type { Channel, DealCreateInput, DealDetail, DealDuplicateCheck, DealKind, DealListItem, Pipeline } from '@/lib/crm/types';
import { useCreateDeal, useDealOwners, useDuplicateCheck, useProductLines, useReopenDeal, type DuplicateCheckInput } from '@/lib/deals/hooks';
import { useDebounced } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { trailOf } from '@/lib/tree';
import type { OrgUnit } from '@/lib/types';

interface Form {
  unitId: string;
  kind: DealKind;
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  city: string;
  studentFirstName: string;
  studentLastName: string;
  grade: string;
  productLineId: string;
  channel: string;
  owner: string;
  campaign: string;
  message: string;
}

/** The company a unit belongs to (nearest ancestor-or-self of type company). */
function companyOf(unit: OrgUnit, byId: ReadonlyMap<string, OrgUnit>): OrgUnit | null {
  const trail = trailOf(unit, byId);
  for (let index = trail.length - 1; index >= 0; index -= 1) {
    const item = trail[index];
    if (item?.type === 'company') return item;
  }
  return null;
}

const digits = (value: string) => value.replace(/\D/g, '');

/** The duplicate check runs once there is a phone, an email or a full name to match on. */
function checkInput(form: Form): DuplicateCheckInput | null {
  const phone = digits(form.phone).length >= 6 ? form.phone.trim() : null;
  const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim()) ? form.email.trim() : null;
  const named = form.firstName.trim().length > 1 && form.lastName.trim().length > 1;
  if (!form.unitId || (!phone && !email && !named)) return null;
  return {
    unitId: form.unitId,
    kind: form.kind,
    phones: phone ? [phone] : undefined,
    emails: email ? [email] : undefined,
    firstName: form.firstName.trim() || undefined,
    lastName: form.lastName.trim() || undefined,
  };
}

function DealLine({ deal, action }: { deal: DealListItem; action: ReactNode }) {
  return (
    <li className="leads-dup__deal">
      <span>
        <strong className="mono">{deal.ref}</strong> {deal.title}
        <span className="muted small">
          {' '}
          · {deal.stage.name} · {deal.owner?.name ?? 'Unassigned'}
        </span>
      </span>
      {action}
    </li>
  );
}

function DuplicateWarning({
  check,
  onOpen,
  onReopen,
  reopening,
}: {
  check: DealDuplicateCheck;
  onOpen: (id: string) => void;
  onReopen: (id: string) => void;
  reopening: string | null;
}) {
  const found = check.contact !== null || check.account !== null;
  if (!found && !check.knownElsewhere && check.openDeals.length === 0 && check.recentlyLost.length === 0 && check.hiddenOpenDealCount === 0)
    return null;
  const who = check.contact?.displayName ?? check.account?.name ?? 'This person';
  return (
    <Alert
      tone={check.openDeals.length > 0 || check.hiddenOpenDealCount > 0 ? 'warning' : 'info'}
      title={found ? `${who} is already in the CRM` : 'Known elsewhere in the group'}
    >
      <div className="stack gap-6">
        {found ? (
          <p>{check.contact?.city ? `${who} (${check.contact.city})` : who} will be linked to this lead, not created again.</p>
        ) : (
          <p>
            Someone with these details exists in another company of the group. Their basic details are reused; that company&apos;s leads stay private.
          </p>
        )}
        {check.openDeals.length > 0 ? (
          <>
            <p className="strong">Open leads</p>
            <ul className="leads-dup__list">
              {check.openDeals.map((deal) => (
                <DealLine
                  key={deal.id}
                  deal={deal}
                  action={
                    <Button size="sm" onClick={() => onOpen(deal.id)}>
                      Open
                    </Button>
                  }
                />
              ))}
            </ul>
          </>
        ) : null}
        {check.recentlyLost.length > 0 ? (
          <>
            <p className="strong">Lost recently: reopen instead of creating a new lead</p>
            <ul className="leads-dup__list">
              {check.recentlyLost.map((deal) => (
                <DealLine
                  key={deal.id}
                  deal={deal}
                  action={
                    <Button size="sm" icon="restore" loading={reopening === deal.id} onClick={() => onReopen(deal.id)}>
                      Reopen
                    </Button>
                  }
                />
              ))}
            </ul>
          </>
        ) : null}
        {check.hiddenOpenDealCount > 0 ? (
          <p>
            {formatCount(check.hiddenOpenDealCount)} more open {check.hiddenOpenDealCount === 1 ? 'lead' : 'leads'} for {who} in this company belong
            to colleagues. Check with your manager before adding another.
          </p>
        ) : null}
      </div>
    </Alert>
  );
}

/**
 * Manual entry of a lead: the person (found or created by the server's de-duplication), a student
 * for families, product line, channel, owner and the enquiry text. A live warning shows when the
 * person already exists, with their open leads (open one instead) and recently lost ones (reopen).
 */
export function NewLeadDialog({
  open,
  onClose,
  onCreated,
  onOpenExisting,
  pipelines,
  channels,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (deal: DealDetail) => void;
  onOpenExisting: (id: string) => void;
  pipelines: readonly Pipeline[];
  channels: readonly Channel[] | undefined;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New lead"
      description="Add an enquiry by hand. People already in the CRM are matched, not duplicated."
      size="lg"
    >
      <NewLeadForm onClose={onClose} onCreated={onCreated} onOpenExisting={onOpenExisting} pipelines={pipelines} channels={channels} />
    </Dialog>
  );
}

function NewLeadForm({
  onClose,
  onCreated,
  onOpenExisting,
  pipelines,
  channels,
}: {
  onClose: () => void;
  onCreated: (deal: DealDetail) => void;
  onOpenExisting: (id: string) => void;
  pipelines: readonly Pipeline[];
  channels: readonly Channel[] | undefined;
}) {
  const session = useSession();
  const units = session.workUnits.filter(
    (unit) => unit.type !== 'group' && session.can('deals.manage', unit) && companyOf(unit, session.unitsById) !== null,
  );
  const initialUnit = units.find((unit) => unit.id === session.scope.id) ?? units[0];
  const [form, setForm] = useState<Form>({
    unitId: initialUnit?.id ?? '',
    kind: 'b2c',
    firstName: '',
    lastName: '',
    phone: '',
    email: '',
    city: '',
    studentFirstName: '',
    studentLastName: '',
    grade: '',
    productLineId: '',
    channel: 'manual',
    owner: 'me',
    campaign: '',
    message: '',
  });
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((current) => ({ ...current, [key]: value }));

  const unit = session.unitsById.get(form.unitId) ?? null;
  const company = unit ? companyOf(unit, session.unitsById) : null;
  const kinds = new Set(
    pipelines.filter((pipeline) => pipeline.companyId === company?.id && pipeline.archivedAt === null).map((pipeline) => pipeline.kind),
  );
  const lines = useProductLines({ companyId: company?.id ?? '' }, company !== null);
  const canAssign = unit ? session.can('deals.assign', unit) : false;
  const owners = useDealOwners(unit?.id ?? null, canAssign);
  const create = useCreateDeal();
  const reopen = useReopenDeal();
  // Debounce the request as text: a new object every render would restart the timer for ever.
  const checkKey = useDebounced(JSON.stringify(checkInput(form)), 500);
  const check = useDuplicateCheck(JSON.parse(checkKey) as DuplicateCheckInput | null);
  const errors = fieldErrorsOf(create.error);

  const channelOptions =
    channels?.map((channel) => ({ key: channel.key, label: channel.label })) ?? CHANNEL_KEYS.map((key) => ({ key, label: channelLabel(key) }));

  function submit(event: FormEvent) {
    event.preventDefault();
    const phones = form.phone.trim() ? [form.phone.trim()] : undefined;
    const emails = form.email.trim() ? [form.email.trim()] : undefined;
    const body: DealCreateInput = {
      unitId: form.unitId,
      kind: form.kind,
      contact: {
        kind: form.kind === 'b2c' ? 'parent' : 'staff',
        firstName: form.firstName.trim() || undefined,
        lastName: form.lastName.trim() || undefined,
        phones,
        emails,
        city: form.city.trim() || undefined,
      },
      channel: form.channel,
      productLineId: form.productLineId || undefined,
    };
    if (form.kind === 'b2c' && form.studentFirstName.trim()) {
      body.students = [
        {
          contact: {
            kind: 'student',
            firstName: form.studentFirstName.trim(),
            lastName: form.studentLastName.trim() || form.lastName.trim() || undefined,
            studentProfile: form.grade.trim() ? { grade: form.grade.trim() } : undefined,
          },
        },
      ];
    }
    if (canAssign) body.ownerUserId = form.owner === 'me' ? session.user.id : form.owner === 'none' ? null : form.owner;
    if (form.campaign.trim()) body.firstTouch = { channel: form.channel, campaign: form.campaign.trim() };
    if (form.message.trim()) body.originalMessage = { channel: form.channel, text: form.message.trim(), receivedAt: new Date().toISOString() };
    create.mutate(body, { onSuccess: onCreated });
  }

  const error = (...keys: string[]) => keys.map((key) => errors[key]).find(Boolean);
  const shown = [
    'unitId',
    'kind',
    'contact',
    'contact.firstName',
    'contact.lastName',
    'contact.phones.0',
    'contact.emails.0',
    'contact.city',
    'students.0.contact.firstName',
    'productLineId',
    'ownerUserId',
    'channel',
  ];

  if (units.length === 0) {
    return (
      <DialogBody>
        <Alert tone="info">You can&apos;t add leads in the teams you work in. Ask an admin for the permission to work on leads.</Alert>
        <DialogFooter>
          <Button onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogBody>
    );
  }

  return (
    <form onSubmit={submit} noValidate>
      <DialogBody>
        <div className="form-grid">
          {units.length > 1 ? (
            <Field label="Team" error={error('unitId')}>
              {(control) => (
                <select
                  {...control}
                  className="select"
                  value={form.unitId}
                  onChange={(event) => setForm((current) => ({ ...current, unitId: event.target.value, productLineId: '', owner: 'me' }))}
                >
                  {units.map((item) => (
                    <option key={item.id} value={item.id}>
                      {trailOf(item, session.unitsById)
                        .filter((part) => part.type !== 'group')
                        .map((part) => part.name)
                        .join(' › ')}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          ) : null}
          {kinds.size > 1 ? (
            <Field label="Lead for" error={error('kind')}>
              {(control) => (
                <select
                  {...control}
                  className="select"
                  value={form.kind}
                  onChange={(event) => setForm((current) => ({ ...current, kind: event.target.value as DealKind, productLineId: '' }))}
                >
                  <option value="b2c">A family (course or program)</option>
                  <option value="b2b">An institute (software)</option>
                </select>
              )}
            </Field>
          ) : null}
        </div>

        <fieldset className="leads-form__group">
          <legend className="section-title">{form.kind === 'b2c' ? 'Parent or enquirer' : 'Contact person'}</legend>
          <div className="form-grid">
            <Field label="First name" error={error('contact.firstName', 'contact')}>
              {(control) => (
                <input
                  {...control}
                  className="input"
                  autoComplete="off"
                  maxLength={80}
                  value={form.firstName}
                  onChange={(event) => set('firstName', event.target.value)}
                />
              )}
            </Field>
            <Field label="Last name" optional error={error('contact.lastName')}>
              {(control) => (
                <input
                  {...control}
                  className="input"
                  autoComplete="off"
                  maxLength={80}
                  value={form.lastName}
                  onChange={(event) => set('lastName', event.target.value)}
                />
              )}
            </Field>
            <Field label="Phone or WhatsApp" optional error={error('contact.phones.0', 'contact.phones')}>
              {(control) => (
                <input
                  {...control}
                  className="input"
                  type="tel"
                  autoComplete="off"
                  maxLength={40}
                  value={form.phone}
                  onChange={(event) => set('phone', event.target.value)}
                  placeholder="+91 98765 43210"
                />
              )}
            </Field>
            <Field label="Email" optional error={error('contact.emails.0', 'contact.emails')}>
              {(control) => (
                <input
                  {...control}
                  className="input"
                  type="email"
                  autoComplete="off"
                  maxLength={254}
                  value={form.email}
                  onChange={(event) => set('email', event.target.value)}
                />
              )}
            </Field>
            <Field label="City" optional error={error('contact.city')}>
              {(control) => (
                <input {...control} className="input" maxLength={80} value={form.city} onChange={(event) => set('city', event.target.value)} />
              )}
            </Field>
          </div>
        </fieldset>

        <div aria-live="polite">
          {check.data ? (
            <DuplicateWarning
              check={check.data}
              reopening={reopen.isPending ? (reopen.variables ?? null) : null}
              onOpen={onOpenExisting}
              onReopen={(id) => reopen.mutate(id, { onSuccess: (deal) => onOpenExisting(deal.id) })}
            />
          ) : null}
          {reopen.isError ? <ErrorAlert error={reopen.error} title="Couldn't reopen that lead" /> : null}
        </div>

        {form.kind === 'b2c' ? (
          <fieldset className="leads-form__group">
            <legend className="section-title">Student</legend>
            <div className="form-grid">
              <Field label="Student's first name" optional error={error('students.0.contact.firstName', 'students.0.contact')}>
                {(control) => (
                  <input
                    {...control}
                    className="input"
                    autoComplete="off"
                    maxLength={80}
                    value={form.studentFirstName}
                    onChange={(event) => set('studentFirstName', event.target.value)}
                  />
                )}
              </Field>
              <Field label="Student's last name" optional hint="Defaults to the parent's">
                {(control) => (
                  <input
                    {...control}
                    className="input"
                    autoComplete="off"
                    maxLength={80}
                    value={form.studentLastName}
                    onChange={(event) => set('studentLastName', event.target.value)}
                  />
                )}
              </Field>
              <Field label="Grade" optional>
                {(control) => (
                  <input
                    {...control}
                    className="input"
                    maxLength={20}
                    value={form.grade}
                    onChange={(event) => set('grade', event.target.value)}
                    placeholder="11"
                  />
                )}
              </Field>
            </div>
          </fieldset>
        ) : null}

        <fieldset className="leads-form__group">
          <legend className="section-title">Enquiry</legend>
          <div className="form-grid">
            <Field label="Product line" optional error={error('productLineId')}>
              {(control) => (
                <select {...control} className="select" value={form.productLineId} onChange={(event) => set('productLineId', event.target.value)}>
                  <option value="">Not decided yet</option>
                  {(lines.data ?? [])
                    .filter((line) => line.active && line.audience === form.kind)
                    .map((line) => (
                      <option key={line.id} value={line.id}>
                        {line.name}
                      </option>
                    ))}
                </select>
              )}
            </Field>
            <Field label="Came in through" error={error('channel')}>
              {(control) => (
                <select {...control} className="select" value={form.channel} onChange={(event) => set('channel', event.target.value)}>
                  {channelOptions.map((channel) => (
                    <option key={channel.key} value={channel.key}>
                      {channel.label}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            {canAssign ? (
              <Field label="Owner" error={error('ownerUserId')}>
                {(control) => (
                  <select {...control} className="select" value={form.owner} onChange={(event) => set('owner', event.target.value)}>
                    <option value="me">Me</option>
                    <option value="none">Unassigned</option>
                    {(owners.data ?? [])
                      .filter((person) => person.id !== session.user.id)
                      .map((person) => (
                        <option key={person.id} value={person.id}>
                          {person.name}
                        </option>
                      ))}
                  </select>
                )}
              </Field>
            ) : null}
            <Field label="Campaign" optional>
              {(control) => (
                <input
                  {...control}
                  className="input"
                  maxLength={200}
                  value={form.campaign}
                  onChange={(event) => set('campaign', event.target.value)}
                />
              )}
            </Field>
          </div>
          <Field label="What did they ask?" optional hint="Saved as the lead's original message">
            {(control) => (
              <textarea
                {...control}
                className="textarea"
                rows={3}
                maxLength={5000}
                value={form.message}
                onChange={(event) => set('message', event.target.value)}
              />
            )}
          </Field>
        </fieldset>
        <ErrorAlert error={formErrorOf(create.error, shown)} />
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" loading={create.isPending}>
          Add lead
        </Button>
      </DialogFooter>
    </form>
  );
}
