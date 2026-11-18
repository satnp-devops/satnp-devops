'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ChipGroup, RelativeTime, StatusPill } from '@/components/crm';
import { Icon } from '@/components/icons';
import { ButtonLink, Card, EmptyState, ErrorAlert, PageLoading } from '@/components/ui';
import { companyOfScope, groupCompanies } from '@/lib/integrations/display';
import { CATEGORY_NAMES, CHANNEL_ICONS, CHANNEL_NAMES, MESSAGE_CHANNELS, TEMPLATE_STATUS, languageName } from '@/lib/messaging/display';
import { useTemplates } from '@/lib/messaging/queries';
import type { MessageChannel, MessageTemplate, TemplateStatus } from '@/lib/messaging/types';
import { useSession } from '@/lib/session';
import './templates.css';

const STATUSES: TemplateStatus[] = ['approved', 'submitted', 'draft', 'rejected'];

export function TemplatesView() {
  const session = useSession();
  if (!session.canAnywhere('messaging.templates_view')) {
    return (
      <Card>
        <EmptyState icon="message" title="Templates are managed by your admins">
          Seeing message templates needs the &ldquo;See message templates&rdquo; permission.
        </EmptyState>
      </Card>
    );
  }
  return <Templates />;
}

function Templates() {
  const session = useSession();
  const company = companyOfScope(session);
  const companies = company ? [company] : groupCompanies(session);
  const [companyId, setCompanyId] = useState('');
  const [channels, setChannels] = useState<MessageChannel[]>([]);
  const [status, setStatus] = useState<TemplateStatus | ''>('');
  const scope = company ? { companyId: company.id } : companyId ? { companyId } : { unitId: session.scope.id };
  const templates = useTemplates(scope, { channel: channels.length === 1 ? channels[0] : '', status });

  const manageable = companies.filter((c) => session.can('messaging.templates_manage', c));
  const newHref = `/settings/templates/new${manageable.length === 1 && manageable[0] ? `?companyId=${manageable[0].id}` : ''}`;
  const companyName = (id: string) => companies.find((c) => c.id === id)?.name ?? '';

  const rows = (templates.data ?? []).filter((t) => channels.length === 0 || channels.includes(t.channel));

  return (
    <Card
      flush
      title="Message templates"
      description="WhatsApp, email and SMS templates your teams send from the reply box and automations. WhatsApp and SMS templates need the provider's approval before they can be sent."
      actions={manageable.length > 0 ? <ButtonLink href={newHref} variant="primary" size="sm" icon="plus">New template</ButtonLink> : null}
    >
      <div className="msgt-toolbar">
        {!company && companies.length > 1 ? (
          <>
            <label className="visually-hidden" htmlFor="msgt-company">
              Company
            </label>
            <select id="msgt-company" className="select" value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
              <option value="">All companies</option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </>
        ) : null}
        <ChipGroup
          label="Channel"
          options={MESSAGE_CHANNELS.map((c) => ({ value: c, label: CHANNEL_NAMES[c], icon: CHANNEL_ICONS[c] }))}
          selected={channels}
          onChange={(next) => setChannels(next.filter((v): v is MessageChannel => (MESSAGE_CHANNELS as string[]).includes(v)))}
        />
        <label className="visually-hidden" htmlFor="msgt-status">
          Status
        </label>
        <select id="msgt-status" className="select" value={status} onChange={(e) => setStatus(e.target.value as TemplateStatus | '')}>
          <option value="">Any status</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {TEMPLATE_STATUS[s].label}
            </option>
          ))}
        </select>
      </div>
      {templates.isPending ? (
        <PageLoading />
      ) : templates.isError ? (
        <div className="card__body">
          <ErrorAlert error={templates.error} title="Templates could not be loaded" />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState icon="message" title={channels.length || status ? 'No templates match' : 'No templates yet'}>
          {manageable.length > 0 ? 'Create one: a booking link, a demo reminder or a welcome message.' : 'Your admins add the templates teams can send.'}
        </EmptyState>
      ) : (
        <ul className="msgt-list" aria-label="Templates">
          {rows.map((template) => (
            <TemplateRow key={template.id} template={template} companyName={company ? null : companyName(template.companyId)} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function TemplateRow({ template, companyName }: { template: MessageTemplate; companyName: string | null }) {
  const status = TEMPLATE_STATUS[template.status];
  const liveElsewhere = template.approvedVersion !== null && template.approvedVersion !== template.latestVersion;
  return (
    <li className="msgt-row">
      <Link href={`/settings/templates/${template.id}`} className="msgt-row__link">
        <span className="msgt-row__icon" aria-hidden="true">
          <Icon name={CHANNEL_ICONS[template.channel]} size={16} />
        </span>
        <span className="msgt-row__main">
          <span className="msgt-row__name">{template.name}</span>
          <span className="msgt-row__meta">
            <span>{CHANNEL_NAMES[template.channel]}</span>
            <span>{languageName(template.language)}</span>
            <span>{CATEGORY_NAMES[template.category]}</span>
            {companyName ? <span>{companyName}</span> : null}
          </span>
          {template.latest ? <span className="msgt-row__body">{template.latest.subject ?? template.latest.body}</span> : null}
        </span>
        <span className="msgt-row__status">
          <StatusPill tone={status.tone}>{status.label}</StatusPill>
          {liveElsewhere ? <span>v{template.approvedVersion} is live</span> : <span>v{template.latestVersion}</span>}
          <RelativeTime value={template.updatedAt} />
        </span>
      </Link>
    </li>
  );
}
