'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { DataTable, Mono, StatusPill } from '@/components/crm';
import { Alert, Badge, Button, Card, CopyButton, EmptyState, ErrorAlert, Field, PageLoading } from '@/components/ui';
import { Dialog, DialogBody, DialogFooter } from '@/components/dialog';
import { Guard } from '@/components/Guard';
import { api, errorMessage, fieldErrorsOf } from '@/lib/api';
import { keys, usePeople, useUnitSettings } from '@/lib/queries';
import { useSession } from '@/lib/session';
import { companiesUnder, intakeKeys, useIdentities, useIntakeForms, usePartnerLinks, usePools } from '@/lib/intake/api';
import { CHANNEL_TYPE_LABELS, type AssignmentPool, type ChannelIdentity, type PartnerLink, type PoolMember } from '@/lib/intake/types';
import type { OrgUnit } from '@/lib/types';
import '@/components/intake/intake.css';

const ROUTABLE_TYPES = ['whatsapp', 'phone_call', 'missed_call', 'sms', 'email', 'website_form', 'landing_page', 'chat_widget', 'facebook_lead_ad', 'instagram', 'google_lead_form', 'walk_in', 'event', 'api'];
const MODES: Record<string, string> = { prefer: 'Preferred', require: 'Required', ignore: 'Ignored' };

export function RoutingView() {
  return (
    <Guard anyOf={['intake.view']} anywhere>
      <Routing />
    </Guard>
  );
}

function Routing() {
  const { scope, units, unitsById, can } = useSession();
  const companies = companiesUnder(scope, units, unitsById);
  return (
    <div className="stack gap-16">
      <Alert tone="info">
        <span>
        An enquiry goes to the company that owns the channel it arrived on. On a shared channel (the group&apos;s number or inbox) the classifier picks the
        company; when it is less sure than the threshold, the enquiry waits in the <Link href="/leads/review">review queue</Link>. Other intake rules (reopening lost
        leads, returning families, duplicate scores) are on <Link href="/settings/general">General</Link>.
        </span>
      </Alert>
      {companies.length ? (
        <Card flush title="Routing confidence" description="How sure the classifier must be before an enquiry on a shared channel goes straight to a company.">
          <div className="settings-list">
            {companies.map((c) => (
              <ThresholdRow key={c.id} company={c} canManage={can('intake.manage', c)} />
            ))}
          </div>
        </Card>
      ) : null}
      <Channels companies={companies} />
      <Pools />
      <PartnerLinks companies={companies} />
    </div>
  );
}

function ThresholdRow({ company, canManage }: { company: OrgUnit; canManage: boolean }) {
  const settings = useUnitSettings(company.id);
  const queryClient = useQueryClient();
  const state = settings.data?.values['intake.routingThreshold'];
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? (state ? String(Math.round(Number(state.value) * 100)) : '');
  const save = useMutation({
    mutationFn: () => api.put('/settings/intake.routingThreshold', { unitId: company.id, value: Number(value) / 100 }),
    onSuccess: async () => {
      setDraft(null);
      await queryClient.invalidateQueries({ queryKey: keys.settingsAll });
    },
  });
  const error = fieldErrorsOf(save.error).value;
  return (
    <div className="setting-row">
      <div className="setting-row__text">
        <span className="strong">{company.name}</span>
        <span className="muted">{state ? (state.isDefault ? 'Default' : state.inherited ? 'From the group' : `Set on ${company.name}`) : '…'}</span>
      </div>
      <div className="row gap-8">
        <input
          className="input"
          type="number"
          min={30}
          max={99}
          style={{ width: 90 }}
          aria-label={`Routing confidence for ${company.name}, in percent`}
          aria-invalid={error ? true : undefined}
          value={value}
          disabled={!canManage || !state}
          onChange={(e) => setDraft(e.target.value)}
        />
        <span className="muted">%</span>
        {canManage && draft !== null ? (
          <Button size="sm" variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        ) : null}
      </div>
      {error ? <p className="field__error">{error}</p> : null}
    </div>
  );
}

// ---------- Channels ----------

function Channels({ companies }: { companies: OrgUnit[] }) {
  const { scope, unitsById, can } = useSession();
  const identities = useIdentities(scope.id);
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const manageable = companies.filter((c) => can('intake.manage', c));
  const toggle = useMutation({
    mutationFn: (i: ChannelIdentity) => api.patch(`/intake/identities/${i.id}`, { active: !i.active }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: intakeKeys.identities(scope.id) }),
  });
  const remove = useMutation({
    mutationFn: (i: ChannelIdentity) => api.delete(`/intake/identities/${i.id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: intakeKeys.identities(scope.id) }),
  });
  const canEdit = (i: ChannelIdentity) => (i.shared ? i.companyIds : [i.companyId ?? '']).every((id) => {
    const unit = unitsById.get(id);
    return unit ? can('intake.manage', unit) : false;
  });

  return (
    <Card
      flush
      title="Channels"
      description="Numbers, inboxes, lead forms and sites, and the company each belongs to."
      actions={manageable.length ? <Button icon="plus" onClick={() => setAdding(true)}>Add a channel</Button> : null}
    >
      {identities.isPending ? (
        <PageLoading />
      ) : identities.isError ? (
        <ErrorAlert error={identities.error} />
      ) : identities.data.length === 0 ? (
        <EmptyState icon="plug" title="No channels registered">
          Enquiries on unregistered channels wait in the review queue.
        </EmptyState>
      ) : (
        <DataTable<ChannelIdentity>
          label="Channels"
          framed={false}
          rows={identities.data}
          rowId={(i) => i.id}
          columns={[
            { id: 'identity', header: 'Channel', card: 'title', cell: (i) => <span className="stack gap-2"><Mono>{i.identity}</Mono>{i.label ? <span className="muted">{i.label}</span> : null}</span> },
            { id: 'type', header: 'Kind', cell: (i) => CHANNEL_TYPE_LABELS[i.type] ?? i.type },
            {
              id: 'company',
              header: 'Goes to',
              cell: (i) =>
                i.shared ? (
                  <span className="intake-chips">
                    <Badge tone="accent">Shared</Badge>
                    {i.companyIds.map((id) => (
                      <Badge key={id}>{unitsById.get(id)?.name ?? 'Another company'}</Badge>
                    ))}
                  </span>
                ) : (
                  <span>
                    {unitsById.get(i.companyId ?? '')?.name ?? '—'}
                    {i.unitId ? ` › ${unitsById.get(i.unitId)?.name ?? ''}` : ''}
                  </span>
                ),
            },
            { id: 'status', header: 'Status', cell: (i) => <StatusPill tone={i.active ? 'success' : 'neutral'}>{i.active ? 'On' : 'Off'}</StatusPill> },
            {
              id: 'actions',
              header: <span className="visually-hidden">Actions</span>,
              label: 'Actions',
              align: 'end',
              cell: (i) =>
                canEdit(i) ? (
                  <span className="row gap-4 nowrap">
                    <Button size="sm" variant="ghost" onClick={() => toggle.mutate(i)}>
                      {i.active ? 'Turn off' : 'Turn on'}
                    </Button>
                    <Button size="sm" variant="ghost" iconOnly icon="trash" aria-label={`Remove ${i.identity}`} onClick={() => remove.mutate(i)} />
                  </span>
                ) : null,
            },
          ]}
        />
      )}
      {toggle.isError || remove.isError ? <Alert tone="error">{errorMessage(toggle.error ?? remove.error)}</Alert> : null}
      {adding ? <AddChannelDialog companies={manageable} onClose={() => setAdding(false)} /> : null}
    </Card>
  );
}

function AddChannelDialog({ companies, onClose }: { companies: OrgUnit[]; onClose: () => void }) {
  const { scope } = useSession();
  const queryClient = useQueryClient();
  const [type, setType] = useState('whatsapp');
  const [identity, setIdentity] = useState('');
  const [label, setLabel] = useState('');
  const [shared, setShared] = useState(false);
  const [companyId, setCompanyId] = useState(companies[0]?.id ?? '');
  const [companyIds, setCompanyIds] = useState<string[]>([]);
  const add = useMutation({
    mutationFn: () => api.post('/intake/identities', { type, identity, ...(label.trim() ? { label: label.trim() } : {}), shared, ...(shared ? { companyIds } : { companyId }) }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: intakeKeys.identities(scope.id) });
      onClose();
    },
  });
  const errors = fieldErrorsOf(add.error);
  return (
    <Dialog open onClose={onClose} title="Add a channel">
      <DialogBody>
        <Field label="Kind">
          {(control) => (
            <select {...control} className="select" value={type} onChange={(e) => setType(e.target.value)}>
              {ROUTABLE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {CHANNEL_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Number, inbox, form id or site" error={errors.identity} hint="As people reach you: +91 98765 43210, admissions@satnpaper.com, satnpaper.com/sat">
          {(control) => <input {...control} className="input" value={identity} onChange={(e) => setIdentity(e.target.value)} />}
        </Field>
        <Field label="Name" optional>
          {(control) => <input {...control} className="input" value={label} maxLength={120} onChange={(e) => setLabel(e.target.value)} />}
        </Field>
        {companies.length > 1 ? (
          <label className="intake-check">
            <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} /> Shared by several companies (the classifier decides)
          </label>
        ) : null}
        {shared ? (
          <fieldset className="field field--group">
            <legend className="field__label">Companies it serves</legend>
            {companies.map((c) => (
              <label key={c.id} className="intake-check">
                <input type="checkbox" checked={companyIds.includes(c.id)} onChange={(e) => setCompanyIds(e.target.checked ? [...companyIds, c.id] : companyIds.filter((id) => id !== c.id))} /> {c.name}
              </label>
            ))}
            {errors.companyId || errors.companyIds ? <p className="field__error">{errors.companyId ?? errors.companyIds}</p> : null}
          </fieldset>
        ) : (
          <Field label="Company" error={errors.companyId}>
            {(control) => (
              <select {...control} className="select" value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
        {add.isError && !Object.keys(errors).length ? <Alert tone="error">{errorMessage(add.error)}</Alert> : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" loading={add.isPending} disabled={!identity.trim()} onClick={() => add.mutate()}>
          Add
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

// ---------- Assignment pools ----------

function Pools() {
  const { scope, unitsById, can } = useSession();
  const pools = usePools(scope.id);
  const [editing, setEditing] = useState<AssignmentPool | null>(null);
  return (
    <Card flush title="Assignment" description="New leads go round-robin to the people in a pool, skipping anyone at their open-lead cap or on leave, preferring someone who speaks the family's language and is at work. Partner leads stay with the partner's counsellor; returning families keep theirs.">
      {pools.isPending ? (
        <PageLoading />
      ) : pools.isError ? (
        <ErrorAlert error={pools.error} />
      ) : pools.data.length === 0 ? (
        <EmptyState icon="users" title="No assignment pools">
          Without a pool, new leads stay unassigned in the company.
        </EmptyState>
      ) : (
        <div className="stack gap-12" style={{ padding: 16 }}>
          {pools.data.map((p) => {
            const unit = unitsById.get(p.unitId);
            const company = unitsById.get(p.companyId);
            const manage = company ? can('intake.manage', company) : false;
            return (
              <section key={p.id} className="intake-item" aria-labelledby={`pool-${p.id}`}>
                <div className="intake-item__head">
                  <h3 className="intake-item__title" id={`pool-${p.id}`}>
                    {p.name}
                  </h3>
                  <div className="row gap-8">
                    {p.isDefault ? <Badge tone="accent">Default</Badge> : null}
                    <StatusPill tone={p.active ? 'success' : 'neutral'}>{p.active ? 'On' : 'Off'}</StatusPill>
                    {manage ? (
                      <Button size="sm" onClick={() => setEditing(p)}>
                        Edit people
                      </Button>
                    ) : null}
                  </div>
                </div>
                <div className="intake-item__meta">
                  <span>{company?.name}{unit && unit.id !== company?.id ? ` › ${unit.name}` : ''}</span>
                  <span>{p.kind === 'b2b' ? 'Institutes' : p.kind === 'b2c' ? 'Families' : 'All leads'}</span>
                  <span>Language: {MODES[p.languageMatch]}</span>
                  <span>Working hours: {MODES[p.workingHours]}</span>
                  <span>Time zone: {MODES[p.timeZoneMatch]}</span>
                </div>
                {p.members.length ? (
                  <table className="intake-members">
                    <thead>
                      <tr>
                        <th scope="col">Person</th>
                        <th scope="col">Open leads</th>
                        <th scope="col">Cap</th>
                        <th scope="col">Languages</th>
                        <th scope="col">Assigned by intake</th>
                      </tr>
                    </thead>
                    <tbody>
                      {p.members.map((m) => (
                        <tr key={m.userId}>
                          <td className="strong">
                            {m.name ?? 'Someone'} {!m.active ? <Badge>Paused</Badge> : null} {m.awayUntil && new Date(m.awayUntil) > new Date() ? <Badge tone="warning">On leave</Badge> : null}
                          </td>
                          <td data-label="Open leads">{m.openLeads}</td>
                          <td data-label="Cap">{m.capacity ?? 'No cap'}</td>
                          <td data-label="Languages">{m.languages.join(', ') || '—'}</td>
                          <td data-label="Assigned by intake">{m.assigned}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="muted">Nobody in this pool yet.</p>
                )}
              </section>
            );
          })}
        </div>
      )}
      {editing ? <PoolMembersDialog pool={editing} onClose={() => setEditing(null)} /> : null}
    </Card>
  );
}

function PoolMembersDialog({ pool, onClose }: { pool: AssignmentPool; onClose: () => void }) {
  const { scope } = useSession();
  const queryClient = useQueryClient();
  const people = usePeople(pool.unitId, { q: '', status: 'active' });
  const [members, setMembers] = useState<PoolMember[]>(pool.members);
  const [adding, setAdding] = useState('');
  const save = useMutation({
    mutationFn: () =>
      api.put(`/intake/pools/${pool.id}/members`, {
        members: members.map((m) => ({ userId: m.userId, capacity: m.capacity, languages: m.languages, timeZone: m.timeZone, active: m.active, awayUntil: m.awayUntil })),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: intakeKeys.pools(scope.id) });
      onClose();
    },
  });
  const errors = fieldErrorsOf(save.error);
  const candidates = (people.data?.pages.flatMap((p) => p.data) ?? []).filter((p) => !members.some((m) => m.userId === p.id));
  const update = (i: number, patch: Partial<PoolMember>) => setMembers(members.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  return (
    <Dialog open onClose={onClose} title={`People in ${pool.name}`} size="lg">
      <DialogBody>
        <table className="intake-members">
          <thead>
            <tr>
              <th scope="col">Person</th>
              <th scope="col">Open-lead cap</th>
              <th scope="col">Languages</th>
              <th scope="col">Taking leads</th>
              <th scope="col">
                <span className="visually-hidden">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {members.map((m, i) => (
              <tr key={m.userId}>
                <td className="strong">
                  {m.name ?? candidates.find((c) => c.id === m.userId)?.name ?? 'Someone'}
                  {errors[`members.${i}.userId`] ? <p className="field__error">{errors[`members.${i}.userId`]}</p> : null}
                </td>
                <td>
                  <input className="input" type="number" min={0} aria-label="Open-lead cap (empty for none)" value={m.capacity ?? ''} onChange={(e) => update(i, { capacity: e.target.value === '' ? null : Number(e.target.value) })} />
                </td>
                <td>
                  <input className="input" aria-label="Languages, like en, hi" value={m.languages.join(', ')} onChange={(e) => update(i, { languages: e.target.value.split(',').map((l) => l.trim().toLowerCase()).filter(Boolean) })} />
                </td>
                <td>
                  <input type="checkbox" aria-label="Taking leads" checked={m.active} onChange={(e) => update(i, { active: e.target.checked })} />
                </td>
                <td>
                  <Button size="sm" variant="ghost" iconOnly icon="trash" aria-label="Remove from the pool" onClick={() => setMembers(members.filter((_, j) => j !== i))} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="row gap-8" style={{ alignItems: 'flex-end' }}>
          <Field label="Add someone">
            {(control) => (
              <select {...control} className="select" value={adding} onChange={(e) => setAdding(e.target.value)}>
                <option value="">Pick a person</option>
                {candidates.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Button
            disabled={!adding}
            onClick={() => {
              const person = candidates.find((c) => c.id === adding);
              setMembers([...members, { userId: adding, name: person?.name ?? null, capacity: null, languages: ['en'], timeZone: null, active: true, awayUntil: null, openLeads: 0, assigned: 0 }]);
              setAdding('');
            }}
          >
            Add
          </Button>
        </div>
        {save.isError && !Object.keys(errors).length ? <Alert tone="error">{errorMessage(save.error)}</Alert> : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
          Save
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

// ---------- Partner referral links ----------

function PartnerLinks({ companies }: { companies: OrgUnit[] }) {
  const { scope, unitsById, can } = useSession();
  const links = usePartnerLinks(scope.id);
  const [adding, setAdding] = useState(false);
  const manageable = companies.filter((c) => can('intake.manage', c));
  return (
    <Card flush title="Partner referral links" description="A link per partner. Enquiries through it are credited to the partner and stay with the partner's counsellor." actions={manageable.length ? <Button icon="plus" onClick={() => setAdding(true)}>New link</Button> : null}>
      {links.isPending ? (
        <PageLoading />
      ) : links.isError ? (
        <ErrorAlert error={links.error} />
      ) : links.data.length === 0 ? (
        <EmptyState icon="link" title="No referral links" />
      ) : (
        <DataTable<PartnerLink>
          label="Partner referral links"
          framed={false}
          rows={links.data}
          rowId={(l) => l.id}
          columns={[
            { id: 'partner', header: 'Partner', card: 'title', cell: (l) => <span className="strong">{l.partnerName}</span> },
            { id: 'code', header: 'Code', cell: (l) => <Mono>{l.code}</Mono> },
            { id: 'company', header: 'Company', hideBelow: 'md', cell: (l) => unitsById.get(l.companyId)?.name ?? '—' },
            { id: 'clicks', header: 'Visits', align: 'end', cell: (l) => l.clickCount },
            { id: 'link', header: 'Link', cell: (l) => (l.url ? <CopyButton text={l.url} label="Copy link" /> : <span className="muted">Needs an enquiry form</span>) },
          ]}
        />
      )}
      {adding ? <PartnerLinkDialog companies={manageable} onClose={() => setAdding(false)} /> : null}
    </Card>
  );
}

function PartnerLinkDialog({ companies, onClose }: { companies: OrgUnit[]; onClose: () => void }) {
  const { scope } = useSession();
  const queryClient = useQueryClient();
  const [companyId, setCompanyId] = useState(companies[0]?.id ?? '');
  const [partnerName, setPartnerName] = useState('');
  const [code, setCode] = useState('');
  const [ownerUserId, setOwnerUserId] = useState('');
  const [formId, setFormId] = useState('');
  const forms = useIntakeForms(scope.id);
  const people = usePeople(companyId, { q: '', status: 'active' }, Boolean(companyId));
  const create = useMutation({
    // Partners arrive with the partners module (phase 10); until then each link names a new partner.
    mutationFn: () => api.post('/intake/partner-links', { companyId, code, partnerId: crypto.randomUUID(), partnerName, ownerUserId: ownerUserId || null, formId: formId || null }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: intakeKeys.partnerLinks(scope.id) });
      onClose();
    },
  });
  const errors = fieldErrorsOf(create.error);
  return (
    <Dialog open onClose={onClose} title="New referral link">
      <DialogBody>
        {companies.length > 1 ? (
          <Field label="Company">
            {(control) => (
              <select {...control} className="select" value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        ) : null}
        <Field label="Partner" error={errors.partnerName}>
          {(control) => <input {...control} className="input" value={partnerName} maxLength={120} onChange={(e) => setPartnerName(e.target.value)} />}
        </Field>
        <Field label="Code" error={errors.code} hint="Goes in the link: ?ref=CODE. Letters, digits, - and _">
          {(control) => <input {...control} className="input" value={code} maxLength={40} onChange={(e) => setCode(e.target.value)} />}
        </Field>
        <Field label="Their counsellor" optional error={errors.ownerUserId} hint="Leads through this link stay with them">
          {(control) => (
            <select {...control} className="select" value={ownerUserId} onChange={(e) => setOwnerUserId(e.target.value)}>
              <option value="">Round-robin</option>
              {(people.data?.pages.flatMap((p) => p.data) ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Form the link opens" optional error={errors.formId}>
          {(control) => (
            <select {...control} className="select" value={formId} onChange={(e) => setFormId(e.target.value)}>
              <option value="">The company&apos;s first enquiry form</option>
              {(forms.data ?? [])
                .filter((f) => f.companyId === companyId && f.kind === 'enquiry')
                .map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
            </select>
          )}
        </Field>
        {create.isError && !Object.keys(errors).length ? <Alert tone="error">{errorMessage(create.error)}</Alert> : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" loading={create.isPending} disabled={!partnerName.trim() || code.trim().length < 3} onClick={() => create.mutate()}>
          Create
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
