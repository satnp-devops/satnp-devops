'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { DataTable, Mono, RelativeTime, StatusPill } from '@/components/crm';
import { Alert, Button, Card, CopyButton, EmptyState, ErrorAlert, Field, PageLoading } from '@/components/ui';
import { Dialog, DialogBody, DialogFooter } from '@/components/dialog';
import { Guard } from '@/components/Guard';
import { api, errorMessage, fieldErrorsOf } from '@/lib/api';
import { useSession } from '@/lib/session';
import { companiesUnder, intakeKeys, useIntakeForms } from '@/lib/intake/api';
import type { Audience, FieldType, FormField, IntakeForm, ThankYou } from '@/lib/intake/types';
import type { OrgUnit } from '@/lib/types';
import '@/components/intake/intake.css';

const TARGETS: Array<{ value: string; label: string }> = [
  { value: 'contact.name', label: 'Name' },
  { value: 'contact.firstName', label: 'First name' },
  { value: 'contact.lastName', label: 'Last name' },
  { value: 'contact.phone', label: 'Phone' },
  { value: 'contact.altPhone', label: 'Other phone' },
  { value: 'contact.email', label: 'Email' },
  { value: 'contact.city', label: 'City' },
  { value: 'contact.state', label: 'State' },
  { value: 'contact.pincode', label: 'PIN code' },
  { value: 'contact.language', label: 'Language' },
  { value: 'contact.relation', label: 'Relation to student' },
  { value: 'student.name', label: 'Student name' },
  { value: 'student.grade', label: 'Grade' },
  { value: 'student.board', label: 'Board' },
  { value: 'student.school', label: 'School' },
  { value: 'student.targetExam', label: 'Target exam' },
  { value: 'parent.name', label: 'Parent name' },
  { value: 'parent.phone', label: 'Parent phone' },
  { value: 'parent.email', label: 'Parent email' },
  { value: 'institute.name', label: 'Institute name' },
  { value: 'institute.type', label: 'Institute type' },
  { value: 'institute.city', label: 'Institute city' },
  { value: 'institute.studentCount', label: 'Number of students' },
  { value: 'institute.website', label: 'Institute website' },
  { value: 'interest.course', label: 'Course' },
  { value: 'interest.product', label: 'Product' },
  { value: 'interest.message', label: 'Message' },
  { value: 'interest.preferredTime', label: 'Preferred time' },
];
const TYPES: Array<{ value: FieldType; label: string }> = [
  { value: 'text', label: 'Text' },
  { value: 'phone', label: 'Phone' },
  { value: 'email', label: 'Email' },
  { value: 'textarea', label: 'Long text' },
  { value: 'select', label: 'List' },
  { value: 'number', label: 'Number' },
  { value: 'checkbox', label: 'Tick box' },
  { value: 'hidden', label: 'Hidden' },
];

export function FormsView() {
  return (
    <Guard anyOf={['intake.view']} anywhere>
      <Forms />
    </Guard>
  );
}

function Forms() {
  const { scope, units, unitsById, can } = useSession();
  const forms = useIntakeForms(scope.id);
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const companies = companiesUnder(scope, units, unitsById);
  const manageable = companies.filter((c) => can('intake.manage', c));

  if (forms.isPending) return <PageLoading />;
  if (forms.isError) return <ErrorAlert error={forms.error} />;
  const current = forms.data.find((f) => f.id === editing);
  if (current) return <FormEditor form={current} onClose={() => setEditing(null)} canManage={can('intake.manage', unitsById.get(current.companyId) ?? scope)} />;

  return (
    <div className="stack gap-16">
      <Card
        flush
        title="Website forms"
        description="Enquiry forms for each company's website, and checkout hand-offs from the site's own checkout. Every submission goes through routing, de-duplication and assignment."
        actions={
          manageable.length ? (
            <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
              New form
            </Button>
          ) : null
        }
      >
        {forms.data.length === 0 ? (
          <EmptyState icon="form" title="No forms yet">
            {manageable.length ? 'Create a form, then paste its embed snippet into the website.' : 'A company admin can create forms here.'}
          </EmptyState>
        ) : (
          <DataTable<IntakeForm>
            label="Website forms"
            framed={false}
            rows={forms.data}
            rowId={(f) => f.id}
            onRowActivate={(f) => setEditing(f.id)}
            columns={[
              { id: 'name', header: 'Form', card: 'title', cell: (f) => <span className="strong">{f.name}</span> },
              { id: 'company', header: 'Company', hideBelow: 'md', cell: (f) => unitsById.get(f.companyId)?.name ?? '—' },
              { id: 'kind', header: 'Kind', cell: (f) => (f.kind === 'checkout' ? 'Checkout hand-off' : f.audience === 'b2b' ? 'Institutes' : 'Families') },
              { id: 'status', header: 'Status', cell: (f) => <StatusPill tone={f.active ? 'success' : 'neutral'}>{f.active ? 'Live' : 'Off'}</StatusPill> },
              { id: 'subs', header: 'Submissions', align: 'end', cell: (f) => f.submissionCount },
              { id: 'spam', header: 'Spam stopped', align: 'end', hideBelow: 'lg', cell: (f) => f.spamCount },
              { id: 'last', header: 'Last', hideBelow: 'md', cell: (f) => (f.lastSubmissionAt ? <RelativeTime value={f.lastSubmissionAt} /> : '—') },
            ]}
          />
        )}
      </Card>
      {creating ? <CreateFormDialog companies={manageable} onClose={() => setCreating(false)} onCreated={(id) => setEditing(id)} /> : null}
    </div>
  );
}

function CreateFormDialog({ companies, onClose, onCreated }: { companies: OrgUnit[]; onClose: () => void; onCreated: (id: string) => void }) {
  const { scope } = useSession();
  const queryClient = useQueryClient();
  const [companyId, setCompanyId] = useState(companies[0]?.id ?? '');
  const [name, setName] = useState('');
  const [audience, setAudience] = useState<Audience>('b2c');
  const [kind, setKind] = useState<'enquiry' | 'checkout'>('enquiry');
  const [secret, setSecret] = useState<string | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => api.post<IntakeForm>('/intake/forms', { companyId, name, audience, kind, ...(kind === 'checkout' ? { fields: [] } : {}), ...(scope.type !== 'company' && scope.type !== 'group' ? { unitId: scope.id } : {}) }),
    onSuccess: async (form) => {
      await queryClient.invalidateQueries({ queryKey: intakeKeys.forms(scope.id) });
      if (form.signingSecret) {
        setSecret(form.signingSecret);
        setCreatedId(form.id);
      } else {
        onClose();
        onCreated(form.id);
      }
    },
  });
  const errors = fieldErrorsOf(create.error);
  return (
    <Dialog open onClose={onClose} title={secret ? 'Signing secret' : 'New form'}>
      <DialogBody>
        {secret ? (
          <>
            <Alert tone="warning" title="Copy it now">
              This secret is shown once. The website&apos;s server signs each checkout hand-off with it.
            </Alert>
            <pre className="intake-code">{secret}</pre>
            <CopyButton text={secret} label="Copy secret" />
          </>
        ) : (
          <>
            {companies.length > 1 ? (
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
            ) : null}
            <Field label="Name" error={errors.name} hint="For your team, e.g. “SAT enquiry (website)”">
              {(control) => <input {...control} className="input" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />}
            </Field>
            <Field label="Kind">
              {(control) => (
                <select {...control} className="select" value={kind} onChange={(e) => setKind(e.target.value as 'enquiry' | 'checkout')}>
                  <option value="enquiry">Enquiry form on the website</option>
                  <option value="checkout">Checkout hand-off (server to server)</option>
                </select>
              )}
            </Field>
            <Field label="For">
              {(control) => (
                <select {...control} className="select" value={audience} onChange={(e) => setAudience(e.target.value as Audience)}>
                  <option value="b2c">Families and students</option>
                  <option value="b2b">Institutes</option>
                </select>
              )}
            </Field>
            {create.isError && !Object.keys(errors).length ? <Alert tone="error">{errorMessage(create.error)}</Alert> : null}
          </>
        )}
      </DialogBody>
      <DialogFooter>
        {secret ? (
          <Button
            variant="primary"
            onClick={() => {
              onClose();
              if (createdId) onCreated(createdId);
            }}
          >
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" loading={create.isPending} disabled={!name.trim() || !companyId} onClick={() => create.mutate()}>
              Create
            </Button>
          </>
        )}
      </DialogFooter>
    </Dialog>
  );
}

function FormEditor({ form, onClose, canManage }: { form: IntakeForm; onClose: () => void; canManage: boolean }) {
  const { scope, units } = useSession();
  const queryClient = useQueryClient();
  const [name, setName] = useState(form.name);
  const [active, setActive] = useState(form.active);
  const [unitId, setUnitId] = useState(form.unitId);
  const [fields, setFields] = useState<FormField[]>(form.fields);
  const [consentText, setConsentText] = useState(form.consent.text ?? '');
  const [consentRequired, setConsentRequired] = useState(form.consent.required);
  const [spam, setSpam] = useState(form.spam);
  const [origins, setOrigins] = useState(form.spam.allowedOrigins.join('\n'));
  const [thankYou, setThankYou] = useState<ThankYou>(form.thankYou);
  const [secret, setSecret] = useState<string | null>(null);
  const company = units.find((u) => u.id === form.companyId);
  const landingUnits = units.filter((u) => company && u.path.startsWith(company.path) && u.status === 'active');

  const save = useMutation({
    mutationFn: () =>
      api.patch<IntakeForm>(`/intake/forms/${form.id}`, {
        name,
        active,
        unitId,
        ...(form.kind === 'enquiry' ? { fields } : {}),
        consent: { ...(consentText.trim() ? { text: consentText.trim() } : {}), required: consentRequired, channels: form.consent.channels.length ? form.consent.channels : ['whatsapp', 'calls'] },
        spam: { ...spam, allowedOrigins: origins.split(/\s+/).map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean) },
        thankYou,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: intakeKeys.forms(scope.id) }),
  });
  const rotate = useMutation({
    mutationFn: () => api.post<IntakeForm>(`/intake/forms/${form.id}/secret`),
    onSuccess: (r) => setSecret(r.signingSecret ?? null),
  });
  const errors = fieldErrorsOf(save.error);
  const update = (i: number, patch: Partial<FormField>) => setFields(fields.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const move = (i: number, by: number) => {
    const next = [...fields];
    const [item] = next.splice(i, 1);
    if (item) next.splice(i + by, 0, item);
    setFields(next);
  };

  return (
    <div className="stack gap-16">
      <div className="intake-toolbar">
        <div className="stack gap-4">
          <span className="strong">{form.name}</span>
          <span className="muted">
            {company?.name} · {form.kind === 'checkout' ? 'Checkout hand-off' : form.audience === 'b2b' ? 'Institutes' : 'Families'} · key <Mono>{form.key}</Mono>
          </span>
        </div>
        <div className="row gap-8">
          {form.url && form.kind === 'enquiry' ? (
            <a className="btn" href={form.url} target="_blank" rel="noreferrer">
              Open the form
            </a>
          ) : null}
          <Button variant="ghost" onClick={onClose}>
            Back to forms
          </Button>
        </div>
      </div>
      {!canManage ? <Alert tone="info">You can see this form but not change it.</Alert> : null}

      <Card title="Basics">
        <div className="intake-grid-2">
          <Field label="Name" error={errors.name}>
            {(control) => <input {...control} className="input" value={name} disabled={!canManage} onChange={(e) => setName(e.target.value)} />}
          </Field>
          <Field label="Leads land in" error={errors.unitId} hint="An assignment pool for this team picks the owner">
            {(control) => (
              <select {...control} className="select" value={unitId} disabled={!canManage} onChange={(e) => setUnitId(e.target.value)}>
                {landingUnits.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <label className="intake-check">
            <input type="checkbox" checked={active} disabled={!canManage} onChange={(e) => setActive(e.target.checked)} /> Live (accepting submissions)
          </label>
        </div>
      </Card>

      {form.kind === 'enquiry' ? (
        <Card title="Fields" description="What visitors fill in, and where each answer goes. Fields that go nowhere are added to the message.">
          <div className="intake-fields">
            {fields.map((f, i) => (
              <div key={i} className="intake-field-row">
                <input className="input" aria-label={`Label of field ${i + 1}`} value={f.label} disabled={!canManage} onChange={(e) => update(i, { label: e.target.value })} aria-invalid={errors[`fields.${i}.label`] ? true : undefined} />
                <select className="select" aria-label={`Type of ${f.label}`} value={f.type} disabled={!canManage} onChange={(e) => update(i, { type: e.target.value as FieldType, ...(e.target.value === 'select' && !f.options.length ? { options: [{ value: 'option_1', label: 'Option 1' }] } : {}) })}>
                  {TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
                <select className="select" aria-label={`Where ${f.label} goes`} value={f.maps ?? ''} disabled={!canManage || f.type === 'checkbox'} onChange={(e) => update(i, { maps: e.target.value || null })} aria-invalid={errors[`fields.${i}.maps`] ? true : undefined}>
                  <option value="">Into the message</option>
                  {TARGETS.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
                <label className="intake-check">
                  <input type="checkbox" checked={f.required} disabled={!canManage} onChange={(e) => update(i, { required: e.target.checked })} /> Required
                </label>
                <div className="intake-field-row__tools">
                  <Button size="sm" variant="ghost" iconOnly icon="arrowUp" aria-label={`Move ${f.label} up`} disabled={!canManage || i === 0} onClick={() => move(i, -1)} />
                  <Button size="sm" variant="ghost" iconOnly icon="arrowDown" aria-label={`Move ${f.label} down`} disabled={!canManage || i === fields.length - 1} onClick={() => move(i, 1)} />
                  <Button size="sm" variant="ghost" iconOnly icon="trash" aria-label={`Remove ${f.label}`} disabled={!canManage} onClick={() => setFields(fields.filter((_, j) => j !== i))} />
                </div>
                {f.type === 'select' ? (
                  <input
                    className="input"
                    style={{ gridColumn: '1 / -1' }}
                    aria-label={`Options of ${f.label}, separated by commas`}
                    value={f.options.map((o) => o.label).join(', ')}
                    disabled={!canManage}
                    onChange={(e) => update(i, { options: e.target.value.split(',').map((l) => l.trim()).filter(Boolean).map((l) => ({ value: l.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 80) || 'option', label: l })) })}
                  />
                ) : null}
              </div>
            ))}
          </div>
          {errors.fields ? <p className="field__error">{errors.fields}</p> : null}
          {canManage ? (
            <div className="row">
              <Button
                icon="plus"
                onClick={() => {
                  const n = fields.length + 1;
                  setFields([...fields, { key: `field_${n}_${Date.now().toString(36).slice(-3)}`, label: `Question ${n}`, type: 'text', required: false, maps: null, options: [] }]);
                }}
              >
                Add a field
              </Button>
            </div>
          ) : null}
        </Card>
      ) : null}

      <Card title="Consent" description="Recorded with the wording and page, per the DPDP Act.">
        <div className="stack gap-12">
          <Field label="Consent text" optional>
            {(control) => <textarea {...control} className="textarea" rows={2} value={consentText} disabled={!canManage} maxLength={2000} onChange={(e) => setConsentText(e.target.value)} />}
          </Field>
          <label className="intake-check">
            <input type="checkbox" checked={consentRequired} disabled={!canManage} onChange={(e) => setConsentRequired(e.target.checked)} /> Visitors must tick it to send
          </label>
        </div>
      </Card>

      <Card title="Spam protection">
        <div className="intake-grid-2">
          <label className="intake-check">
            <input type="checkbox" checked={spam.honeypot} disabled={!canManage} onChange={(e) => setSpam({ ...spam, honeypot: e.target.checked })} /> Hidden trap field for bots
          </label>
          <Field label="Minimum seconds to fill in" hint="Faster submissions are treated as bots">
            {(control) => <input {...control} type="number" min={0} max={120} className="input" value={spam.minSeconds} disabled={!canManage} onChange={(e) => setSpam({ ...spam, minSeconds: Number(e.target.value) || 0 })} />}
          </Field>
          <Field label="Captcha">
            {(control) => (
              <select {...control} className="select" value={spam.captcha} disabled={!canManage} onChange={(e) => setSpam({ ...spam, captcha: e.target.value as typeof spam.captcha })}>
                <option value="none">None</option>
                <option value="turnstile">Cloudflare Turnstile</option>
                <option value="recaptcha">Google reCAPTCHA</option>
                <option value="hcaptcha">hCaptcha</option>
              </select>
            )}
          </Field>
          <Field label="Submissions per visitor per hour">
            {(control) => <input {...control} type="number" min={1} max={1000} className="input" value={spam.perIpPerHour} disabled={!canManage} onChange={(e) => setSpam({ ...spam, perIpPerHour: Number(e.target.value) || 1 })} />}
          </Field>
          <Field label="Allowed websites" optional hint="One origin per line, like https://satnpaper.com. Empty allows any." error={errors['spam.allowedOrigins']}>
            {(control) => <textarea {...control} className="textarea" rows={2} value={origins} disabled={!canManage} onChange={(e) => setOrigins(e.target.value)} />}
          </Field>
        </div>
      </Card>

      <Card title="After sending">
        <div className="intake-grid-2">
          <Field label="Show">
            {(control) => (
              <select {...control} className="select" value={thankYou.mode} disabled={!canManage} onChange={(e) => setThankYou(e.target.value === 'redirect' ? { mode: 'redirect', redirectUrl: 'https://' } : { mode: 'message', message: 'Thank you. We will be in touch shortly.' })}>
                <option value="message">A thank-you message</option>
                <option value="redirect">Another page</option>
              </select>
            )}
          </Field>
          {thankYou.mode === 'message' ? (
            <Field label="Message" error={errors['thankYou.message']}>
              {(control) => <textarea {...control} className="textarea" rows={2} value={thankYou.message} disabled={!canManage} onChange={(e) => setThankYou({ mode: 'message', message: e.target.value })} />}
            </Field>
          ) : (
            <Field label="Page address" error={errors['thankYou.redirectUrl']}>
              {(control) => <input {...control} className="input" value={thankYou.redirectUrl} disabled={!canManage} onChange={(e) => setThankYou({ mode: 'redirect', redirectUrl: e.target.value })} />}
            </Field>
          )}
        </div>
      </Card>

      {save.isError && !Object.keys(errors).length ? <Alert tone="error">{errorMessage(save.error)}</Alert> : null}
      {save.isSuccess ? <Alert tone="success">Saved.</Alert> : null}
      {canManage ? (
        <div className="row">
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            Save form
          </Button>
        </div>
      ) : null}

      {form.kind === 'enquiry' && form.embed ? (
        <Card title="Put it on the website" description="Paste this where the form should appear. It loads the hosted form and resizes to fit.">
          <pre className="intake-code">{form.embed.iframe}</pre>
          <div className="row gap-8">
            <CopyButton text={form.embed.iframe} label="Copy embed code" />
            <CopyButton text={form.embed.url} label="Copy link" />
          </div>
        </Card>
      ) : (
        <Card title="Checkout hand-off" description="The website's server posts each checkout (started, paid or abandoned) here, signed with the form's secret.">
          <pre className="intake-code">{`POST ${typeof window === 'undefined' ? '' : window.location.origin}/api/v1/public/checkout/${form.key}
X-Phoenix-Client: checkout
Content-Type: application/json

{ "payload": "<JSON text of { orderId, status, product, amount, currency, customer: { name, phone, email } }>",
  "timestamp": <unix seconds>,
  "signature": "<hex HMAC-SHA256 of \\"<timestamp>.<payload>\\" with the secret>" }`}</pre>
          {secret ? (
            <>
              <Alert tone="warning" title="New secret: copy it now">
                It is shown once. The old secret stops working.
              </Alert>
              <pre className="intake-code">{secret}</pre>
              <CopyButton text={secret} label="Copy secret" />
            </>
          ) : canManage ? (
            <div className="row">
              <Button loading={rotate.isPending} onClick={() => rotate.mutate()}>
                {form.hasSigningSecret ? 'Replace the signing secret' : 'Create a signing secret'}
              </Button>
            </div>
          ) : null}
          {rotate.isError ? <Alert tone="error">{errorMessage(rotate.error)}</Alert> : null}
        </Card>
      )}
    </div>
  );
}
