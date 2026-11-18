'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { DateTime, StatusPill } from '@/components/crm';
import { ConfirmDialog } from '@/components/dialog';
import { Icon } from '@/components/icons';
import { TemplatePreview, VariablesForm } from '@/components/messaging';
import { Alert, Button, Card, EmptyState, ErrorAlert, Field, PageLoading } from '@/components/ui';
import { api, fieldErrorsOf, formErrorOf, isApiError } from '@/lib/api';
import { companyOfScope, groupCompanies } from '@/lib/integrations/display';
import { CATEGORY_HINTS, CATEGORY_NAMES, CHANNEL_ICONS, CHANNEL_NAMES, LANGUAGE_NAMES, MESSAGE_CHANNELS, TEMPLATE_STATUS } from '@/lib/messaging/display';
import { messagingKeys, useTemplate } from '@/lib/messaging/queries';
import { STANDARD_VARIABLES, TEMPLATE_LANGUAGE, TEMPLATE_NAME, templateVariables, toProviderText } from '@/lib/messaging/render';
import type {
  MessageChannel,
  MessageTemplate,
  MessageTemplateDetail,
  TemplateButton,
  TemplateCategory,
  TemplateContent,
  TemplateCreateBody,
  TemplateUpdateBody,
} from '@/lib/messaging/types';
import { useSession } from '@/lib/session';
import './templates.css';

const CATEGORIES: TemplateCategory[] = ['utility', 'marketing', 'authentication'];
const BUTTON_TYPES: Array<{ value: TemplateButton['type']; label: string }> = [
  { value: 'quick_reply', label: 'Quick reply' },
  { value: 'url', label: 'Link' },
  { value: 'phone', label: 'Call' },
];

interface Draft {
  companyId: string;
  channel: MessageChannel;
  name: string;
  language: string;
  category: TemplateCategory;
  description: string;
  headerOn: boolean;
  headerText: string;
  subject: string;
  body: string;
  footer: string;
  buttons: TemplateButton[];
  samples: Record<string, string>;
  providerTemplateName: string;
  providerTemplateId: string;
}

function draftOf(template: MessageTemplate): Draft {
  const latest = template.latest;
  return {
    companyId: template.companyId,
    channel: template.channel,
    name: template.name,
    language: template.language,
    category: template.category,
    description: template.description ?? '',
    headerOn: Boolean(latest?.header),
    headerText: latest?.header?.text ?? '',
    subject: latest?.subject ?? '',
    body: latest?.body ?? '',
    footer: latest?.footer ?? '',
    buttons: latest?.buttons ?? [],
    samples: latest?.samples ?? {},
    providerTemplateName: latest?.providerTemplateName ?? '',
    providerTemplateId: latest?.providerTemplateId ?? '',
  };
}

const emptyDraft = (companyId: string, channel: MessageChannel): Draft => ({
  companyId,
  channel,
  name: '',
  language: 'en',
  category: 'utility',
  description: '',
  headerOn: false,
  headerText: '',
  subject: '',
  body: '',
  footer: '',
  buttons: [],
  samples: {},
  providerTemplateName: '',
  providerTemplateId: '',
});

const orNull = (value: string) => (value.trim() ? value.trim() : null);

/** The content fields of a draft as the API takes them (only what the channel uses). */
function contentOf(draft: Draft): TemplateContent {
  const whatsapp = draft.channel === 'whatsapp';
  return {
    header: whatsapp && draft.headerOn ? { type: 'text', text: draft.headerText.trim() } : null,
    subject: draft.channel === 'email' ? orNull(draft.subject) : null,
    body: draft.body,
    footer: whatsapp ? orNull(draft.footer) : null,
    buttons: whatsapp ? draft.buttons : [],
    samples: Object.fromEntries(Object.entries(draft.samples).filter(([, v]) => v.trim())),
    providerTemplateName: draft.channel === 'email' ? null : orNull(draft.providerTemplateName),
    providerTemplateId: draft.channel === 'email' ? null : orNull(draft.providerTemplateId),
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Only the fields that changed: editing an approved template starts a new version, so unchanged content must stay out. */
function changesOf(template: MessageTemplate, draft: Draft): TemplateUpdateBody {
  const before = contentOf(draftOf(template));
  const after = contentOf(draft);
  const out: TemplateUpdateBody = {};
  if (draft.category !== template.category) out.category = draft.category;
  if (draft.description.trim() !== (template.description ?? '')) out.description = orNull(draft.description);
  if (!same(before.header, after.header)) out.header = after.header;
  if (!same(before.subject, after.subject)) out.subject = after.subject;
  if (before.body !== after.body) out.body = after.body;
  if (!same(before.footer, after.footer)) out.footer = after.footer;
  if (!same(before.buttons, after.buttons)) out.buttons = after.buttons;
  if (!same(before.samples, after.samples)) out.samples = after.samples;
  if (!same(before.providerTemplateName, after.providerTemplateName)) out.providerTemplateName = after.providerTemplateName;
  if (!same(before.providerTemplateId, after.providerTemplateId)) out.providerTemplateId = after.providerTemplateId;
  return out;
}

export function TemplateEditor({ id, initialCompanyId, initialChannel }: { id: string | null; initialCompanyId?: string; initialChannel?: MessageChannel }) {
  const template = useTemplate(id);
  // Kept here so a notice survives the form remounting after a save.
  const [notice, setNotice] = useState<string | null>(null);
  if (id === null) return <EditorForm template={null} initialCompanyId={initialCompanyId} initialChannel={initialChannel} notice={notice} setNotice={setNotice} />;
  if (template.isPending) return <PageLoading />;
  if (template.isError) {
    return (
      <Card>
        {isApiError(template.error) && template.error.status === 404 ? (
          <EmptyState icon="message" title="Template not found" action={<Link href="/settings/templates">Back to templates</Link>}>
            It may belong to a company you don&apos;t work in.
          </EmptyState>
        ) : (
          <ErrorAlert error={template.error} title="The template could not be loaded" />
        )}
      </Card>
    );
  }
  // Remount when a save changes the version, so the form starts from what the server has.
  return <EditorForm key={`${template.data.id}:${template.data.latestVersion}:${template.data.updatedAt}`} template={template.data} notice={notice} setNotice={setNotice} />;
}

function EditorForm({
  template,
  initialCompanyId,
  initialChannel,
  notice,
  setNotice,
}: {
  template: MessageTemplateDetail | null;
  initialCompanyId?: string;
  initialChannel?: MessageChannel;
  notice: string | null;
  setNotice: (notice: string | null) => void;
}) {
  const session = useSession();
  const router = useRouter();
  const queryClient = useQueryClient();
  const scopeCompany = companyOfScope(session);
  const companies = (scopeCompany ? [scopeCompany] : groupCompanies(session)).filter((c) => session.can('messaging.templates_manage', c));
  const defaultCompany = companies.find((c) => c.id === initialCompanyId)?.id ?? companies[0]?.id ?? '';
  const [draft, setDraft] = useState<Draft>(() => (template ? draftOf(template) : emptyDraft(defaultCompany, initialChannel ?? 'whatsapp')));
  const [archiving, setArchiving] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);

  const creating = template === null;
  const canEdit = creating ? companies.length > 0 : template.can.manage;
  const locked = !canEdit || template?.status === 'submitted';
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const content = contentOf(draft);
  const variables = templateVariables({ channel: draft.channel, ...content });
  const changes = template ? changesOf(template, draft) : null;
  const dirty = creating || Object.keys(changes ?? {}).length > 0;

  const refresh = async (templateId?: string) => {
    await queryClient.invalidateQueries({ queryKey: messagingKeys.templatesAll });
    if (templateId) await queryClient.invalidateQueries({ queryKey: messagingKeys.template(templateId) });
    await queryClient.invalidateQueries({ queryKey: ['messaging', 'context'] });
  };

  const save = useMutation({
    mutationFn: async (): Promise<MessageTemplate> => {
      if (creating) {
        const body: TemplateCreateBody = {
          companyId: draft.companyId,
          channel: draft.channel,
          name: draft.name.trim(),
          language: draft.language,
          category: draft.category,
          description: orNull(draft.description),
          ...content,
        };
        return api.post<MessageTemplate>('/messaging/templates', body);
      }
      return api.patch<MessageTemplate>(`/messaging/templates/${template.id}`, changes);
    },
    onSuccess: async (saved) => {
      setNotice(saved.latestVersion > (template?.latestVersion ?? 0) && template ? `Saved as version ${saved.latestVersion} (draft). Version ${saved.approvedVersion ?? '–'} keeps sending until this one is approved.` : 'Saved');
      await refresh(saved.id);
      if (creating) router.replace(`/settings/templates/${saved.id}`);
    },
  });

  const submit = useMutation({
    mutationFn: async () => {
      let templateId = template?.id;
      if (dirty) templateId = (await save.mutateAsync()).id;
      if (!templateId) throw new Error('Save the template first');
      return api.post<MessageTemplate>(`/messaging/templates/${templateId}/submit`);
    },
    onSuccess: async (submitted) => {
      setNotice(submitted.status === 'approved' ? 'Approved: teams can send it now.' : 'Submitted: it can be sent once the provider approves it.');
      await refresh(submitted.id);
      if (creating) router.replace(`/settings/templates/${submitted.id}`);
    },
  });

  const archive = useMutation({
    mutationFn: () => api.delete(`/messaging/templates/${template?.id ?? ''}`),
    onSuccess: async () => {
      await refresh(template?.id);
      router.push('/settings/templates');
    },
  });

  const error = submit.error ?? save.error;
  const fields = fieldErrorsOf(error);
  const shown = ['companyId', 'name', 'language', 'category', 'description', 'header.text', 'subject', 'body', 'footer', ...variables.map((v) => `samples.${v}`), ...draft.buttons.flatMap((_, i) => [`buttons.${i}.text`, `buttons.${i}.url`, `buttons.${i}.phone`])];
  const sampleErrors = Object.fromEntries(variables.map((v) => [v, fields[`samples.${v}`]]).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  const nameError = fields.name ?? (creating && draft.name && !TEMPLATE_NAME.test(draft.name) ? 'Use lower-case letters, digits and underscores, like booking_link' : undefined);
  const languageError = fields.language ?? (!TEMPLATE_LANGUAGE.test(draft.language) ? 'Use a code like en or hi' : undefined);

  function insertVariable(name: string) {
    const token = `{{${name}}}`;
    const el = bodyRef.current;
    const start = el?.selectionStart ?? draft.body.length;
    const end = el?.selectionEnd ?? draft.body.length;
    const next = `${draft.body.slice(0, start)}${token}${draft.body.slice(end)}`;
    set('body', next);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  }

  function setButton(index: number, button: TemplateButton) {
    set(
      'buttons',
      draft.buttons.map((b, i) => (i === index ? button : b)),
    );
  }

  function changeButtonType(index: number, type: TemplateButton['type']) {
    const text = draft.buttons[index]?.text ?? '';
    setButton(index, type === 'url' ? { type, text, url: 'https://' } : type === 'phone' ? { type, text, phone: '+91' } : { type, text });
  }

  if (creating && companies.length === 0) {
    return (
      <Card>
        <EmptyState icon="lock" title="You can't create templates here">
          Creating templates needs the &ldquo;Manage message templates&rdquo; permission at a company.
        </EmptyState>
      </Card>
    );
  }

  const status = template ? TEMPLATE_STATUS[template.status] : null;
  const whatsapp = draft.channel === 'whatsapp';
  const providerText = whatsapp && variables.length ? toProviderText(draft.body) : null;

  return (
    <div className="stack gap-16">
      <div className="msgt-head">
        <div className="msgt-head__title">
          <Link href="/settings/templates" className="link-button">
            <Icon name="chevronRight" size={14} style={{ transform: 'rotate(180deg)' }} />
            Templates
          </Link>
          <h2>{creating ? 'New template' : template.name}</h2>
          {status ? <StatusPill tone={status.tone}>{status.label}</StatusPill> : null}
          {template && template.approvedVersion && template.approvedVersion !== template.latestVersion ? (
            <span className="small muted">Version {template.approvedVersion} is live</span>
          ) : null}
        </div>
        {canEdit && template?.status !== 'submitted' ? (
          <div className="msgt-actions">
            {!creating ? (
              <Button variant="ghost" icon="archive" onClick={() => setArchiving(true)}>
                Archive
              </Button>
            ) : null}
            <Button onClick={() => save.mutate()} loading={save.isPending && !submit.isPending} disabled={!dirty || submit.isPending}>
              {creating ? 'Save draft' : 'Save'}
            </Button>
            <Button
              variant="primary"
              icon="check"
              onClick={() => submit.mutate()}
              loading={submit.isPending}
              disabled={save.isPending || (!dirty && template?.status !== 'draft')}
            >
              Submit for approval
            </Button>
          </div>
        ) : null}
      </div>

      {template?.status === 'submitted' ? (
        <Alert tone="info" title="Waiting for the provider">
          This version was submitted for approval. You can edit it again once the provider approves or rejects it.
        </Alert>
      ) : null}
      {template?.status === 'rejected' && template.latest?.rejectionReason ? (
        <Alert tone="error" title="Rejected">
          {template.latest.rejectionReason}. Edit it and submit it again.
        </Alert>
      ) : null}
      {!canEdit ? <Alert tone="info">You can see this template but not change it.</Alert> : null}
      {notice && !error ? <Alert tone="success">{notice}</Alert> : null}
      <ErrorAlert error={formErrorOf(error, shown)} />

      <div className="msgt-editor">
        <div className="stack gap-16">
          <Card title="About">
            <div className="form-grid">
              {creating && companies.length > 1 ? (
                <Field label="Company" error={fields.companyId}>
                  {(control) => (
                    <select {...control} className="select" value={draft.companyId} onChange={(e) => set('companyId', e.target.value)}>
                      {companies.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
              ) : null}
              {creating ? (
                <fieldset className="field field--group">
                  <legend className="field__label">Channel</legend>
                  <div className="msg-segment" role="radiogroup" aria-label="Channel">
                    {MESSAGE_CHANNELS.map((c) => (
                      <label key={c}>
                        <input type="radio" name="msgt-channel" checked={draft.channel === c} onChange={() => set('channel', c)} />
                        <Icon name={CHANNEL_ICONS[c]} size={15} />
                        {CHANNEL_NAMES[c]}
                      </label>
                    ))}
                  </div>
                </fieldset>
              ) : null}
              <Field label="Name" hint={creating ? 'The provider sees this name: lower-case letters, digits and underscores.' : "Names can't change once created."} error={nameError}>
                {(control) => (
                  <input {...control} className="input mono" value={draft.name} maxLength={100} disabled={!creating} placeholder="booking_link" onChange={(e) => set('name', e.target.value)} />
                )}
              </Field>
              <Field label="Language" error={languageError}>
                {(control) => (
                  <select {...control} className="select" value={draft.language} disabled={!creating} onChange={(e) => set('language', e.target.value)}>
                    {Object.entries(LANGUAGE_NAMES).map(([code, label]) => (
                      <option key={code} value={code}>
                        {label} ({code})
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field
                label="Category"
                hint={template?.approvedVersion ? 'An approved template keeps its category.' : CATEGORY_HINTS[draft.category]}
                error={fields.category}
              >
                {(control) => (
                  <select
                    {...control}
                    className="select"
                    value={draft.category}
                    disabled={locked || Boolean(template?.approvedVersion)}
                    onChange={(e) => set('category', e.target.value as TemplateCategory)}
                  >
                    {CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {CATEGORY_NAMES[c]}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field label="Description" optional error={fields.description}>
                {(control) => (
                  <input {...control} className="input" value={draft.description} maxLength={300} disabled={locked} placeholder="When teams use it" onChange={(e) => set('description', e.target.value)} />
                )}
              </Field>
            </div>
          </Card>

          <Card title="Message">
            <div className="stack gap-12">
              {whatsapp ? (
                <>
                  <label className="check">
                    <input type="checkbox" checked={draft.headerOn} disabled={locked} onChange={(e) => set('headerOn', e.target.checked)} />
                    Add a header
                  </label>
                  {draft.headerOn ? (
                    <Field label="Header" hint="Up to 60 characters and one variable." error={fields['header.text']}>
                      {(control) => <input {...control} className="input" value={draft.headerText} maxLength={60} disabled={locked} onChange={(e) => set('headerText', e.target.value)} />}
                    </Field>
                  ) : null}
                </>
              ) : null}
              {draft.channel === 'email' ? (
                <Field label="Subject" error={fields.subject}>
                  {(control) => <input {...control} className="input" value={draft.subject} maxLength={200} disabled={locked} onChange={(e) => set('subject', e.target.value)} />}
                </Field>
              ) : null}
              <Field
                label="Body"
                hint={whatsapp ? "Write variables like {{student_name}}. WhatsApp doesn't accept a message that starts or ends with a variable." : 'Write variables like {{student_name}}.'}
                error={fields.body}
              >
                {(control) => (
                  <textarea
                    {...control}
                    ref={bodyRef}
                    className="textarea"
                    rows={draft.channel === 'email' ? 10 : 6}
                    value={draft.body}
                    disabled={locked}
                    onChange={(e) => set('body', e.target.value)}
                  />
                )}
              </Field>
              {!locked ? (
                <div className="msgt-insert">
                  <span>Insert:</span>
                  {STANDARD_VARIABLES.map((v) => (
                    <button key={v.name} type="button" title={v.label} onClick={() => insertVariable(v.name)}>
                      {`{{${v.name}}}`}
                    </button>
                  ))}
                </div>
              ) : null}
              {whatsapp ? (
                <Field label="Footer" optional hint="Up to 60 characters, no variables." error={fields.footer}>
                  {(control) => <input {...control} className="input" value={draft.footer} maxLength={60} disabled={locked} onChange={(e) => set('footer', e.target.value)} />}
                </Field>
              ) : null}
            </div>
          </Card>

          {whatsapp ? (
            <Card title="Buttons" description="Quick replies, a link (it may end with one variable) or a phone number. Up to 10.">
              <div className="msgt-buttons">
                {draft.buttons.map((button, i) => (
                  <div key={i} className="msgt-button-row">
                    <Field label="Type">
                      {(control) => (
                        <select {...control} className="select" value={button.type} disabled={locked} onChange={(e) => changeButtonType(i, e.target.value as TemplateButton['type'])}>
                          {BUTTON_TYPES.map((t) => (
                            <option key={t.value} value={t.value}>
                              {t.label}
                            </option>
                          ))}
                        </select>
                      )}
                    </Field>
                    <Field label="Text" error={fields[`buttons.${i}.text`]}>
                      {(control) => <input {...control} className="input" value={button.text} maxLength={25} disabled={locked} onChange={(e) => setButton(i, { ...button, text: e.target.value })} />}
                    </Field>
                    {button.type === 'url' ? (
                      <Field label="Link" error={fields[`buttons.${i}.url`]}>
                        {(control) => <input {...control} className="input" value={button.url} disabled={locked} onChange={(e) => setButton(i, { ...button, url: e.target.value })} />}
                      </Field>
                    ) : button.type === 'phone' ? (
                      <Field label="Phone" error={fields[`buttons.${i}.phone`]}>
                        {(control) => <input {...control} className="input" value={button.phone} disabled={locked} onChange={(e) => setButton(i, { ...button, phone: e.target.value })} />}
                      </Field>
                    ) : (
                      <span />
                    )}
                    {!locked ? (
                      <Button iconOnly variant="ghost" icon="trash" aria-label={`Remove button ${i + 1}`} onClick={() => set('buttons', draft.buttons.filter((_, j) => j !== i))} />
                    ) : null}
                  </div>
                ))}
                {!locked && draft.buttons.length < 10 ? (
                  <div>
                    <Button size="sm" icon="plus" onClick={() => set('buttons', [...draft.buttons, { type: 'quick_reply', text: '' }])}>
                      Add a button
                    </Button>
                  </div>
                ) : null}
              </div>
            </Card>
          ) : null}

          {draft.channel !== 'email' ? (
            <Card>
              <details className="msgt-details">
                <summary>Provider details</summary>
                <div className="form-grid">
                  <Field label="Name at the provider" optional hint="When the provider knows this template by another name." error={fields.providerTemplateName}>
                    {(control) => (
                      <input {...control} className="input mono" value={draft.providerTemplateName} disabled={locked} onChange={(e) => set('providerTemplateName', e.target.value)} />
                    )}
                  </Field>
                  <Field label={draft.channel === 'sms' ? 'DLT template id' : 'Provider template id'} optional error={fields.providerTemplateId}>
                    {(control) => (
                      <input {...control} className="input mono" value={draft.providerTemplateId} disabled={locked} onChange={(e) => set('providerTemplateId', e.target.value)} />
                    )}
                  </Field>
                </div>
              </details>
            </Card>
          ) : null}
        </div>

        <div className="msgt-editor__side">
          <Card title="Preview" description="With the sample values below.">
            <TemplatePreview template={{ channel: draft.channel, ...content }} variables={draft.samples} />
          </Card>
          <Card title="Sample values" description="The provider reviews the template with these. Every variable needs one before you submit.">
            <VariablesForm
              idPrefix="msgt-sample"
              variables={variables}
              values={draft.samples}
              errors={sampleErrors}
              disabled={locked}
              onChange={(name, value) => set('samples', { ...draft.samples, [name]: value })}
            />
          </Card>
          {providerText ? (
            <Card title="As the provider sees it" description="WhatsApp numbers the variables in order.">
              <pre className="msgt-provider">{providerText}</pre>
            </Card>
          ) : null}
          {template && template.versions.length > 0 ? (
            <Card title="Versions">
              <ol className="msgt-versions">
                {template.versions.map((v) => (
                  <li key={v.version}>
                    <span className="mono strong">v{v.version}</span>
                    <StatusPill tone={TEMPLATE_STATUS[v.status].tone}>{TEMPLATE_STATUS[v.status].label}</StatusPill>
                    {v.version === template.approvedVersion ? <span className="small">Live</span> : null}
                    <span className="small muted">
                      <DateTime value={v.decidedAt ?? v.submittedAt ?? v.createdAt} format="short" />
                    </span>
                    {v.rejectionReason ? <span className="msgt-versions__reason">{v.rejectionReason}</span> : null}
                  </li>
                ))}
              </ol>
            </Card>
          ) : null}
        </div>
      </div>

      <ConfirmDialog
        open={archiving}
        onClose={() => setArchiving(false)}
        title={`Archive ${template?.name ?? 'this template'}?`}
        confirmLabel="Archive"
        danger
        pending={archive.isPending}
        error={archive.error}
        onConfirm={() => archive.mutate()}
      >
        <p>Teams and automations can no longer send it. Messages already sent keep their history.</p>
      </ConfirmDialog>
    </div>
  );
}
