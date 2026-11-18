'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { DataTable, Mono, RelativeTime, SearchInput, Section, type Column } from '@/components/crm';
import { Guard } from '@/components/Guard';
import { Icon } from '@/components/icons';
import { Badge, Button } from '@/components/ui';
import { useAutomationCatalog, useFlows, useFlowTemplates } from '@/lib/automations/queries';
import type { AutomationFlow, AutomationTemplate, FlowStatus } from '@/lib/automations/types';
import { formatCount } from '@/lib/crm/format';
import { useSession } from '@/lib/session';
import { NewFlowDialog } from './NewFlowDialog';
import { FlowStatusPill, Segmented, companiesInScope, triggerLabel } from './shared';

type StatusFilter = 'all' | FlowStatus;

export function FlowsView() {
  const session = useSession();
  const router = useRouter();
  const approverOnly = !session.canAnywhere('automations.view') && session.canAnywhere('automations.approve');
  useEffect(() => {
    if (approverOnly) router.replace('/automations/approvals');
  }, [approverOnly, router]);
  if (approverOnly) return null;
  return (
    <Guard anyOf={['automations.view']} anywhere>
      <Flows />
    </Guard>
  );
}

function Flows() {
  const session = useSession();
  const router = useRouter();
  const [status, setStatus] = useState<StatusFilter>('all');
  const [nurtureOnly, setNurtureOnly] = useState(false);
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState<{ template: AutomationTemplate | null } | null>(null);
  const catalog = useAutomationCatalog();
  const templates = useFlowTemplates();
  const flows = useFlows(session.scope.id, { status: status === 'all' ? undefined : status, kind: nurtureOnly ? 'nurture' : undefined, q: q || undefined });
  const manageable = companiesInScope(session, 'automations.manage', { manage: true });
  const showCompany = session.scope.type === 'group' || session.scope.parentId === null;

  const columns = useMemo<Column<AutomationFlow>[]>(
    () => [
      {
        id: 'name',
        header: 'Flow',
        card: 'title',
        cell: (flow) => (
          <div className="auto-cell-name">
            <Link href={`/automations/flows/${flow.id}`} className="auto-link">
              {flow.name}
            </Link>
            <span className="small muted">
              {flow.kind === 'nurture' ? <Badge tone="accent">Nurture</Badge> : null} {triggerLabel(catalog.data, flow.triggerType)} · {flow.stepCount} steps
            </span>
          </div>
        ),
      },
      { id: 'status', header: 'Status', cell: (flow) => <FlowStatusPill status={flow.status} />, width: 110 },
      {
        id: 'runs',
        header: 'Runs (7 days)',
        align: 'end',
        hideBelow: 'sm',
        cell: (flow) => (
          <span className="auto-runs">
            <span>{formatCount(flow.stats?.runsLast7Days ?? 0)}</span>
            {flow.stats?.activeRuns ? <span className="small muted">{formatCount(flow.stats.activeRuns)} going</span> : null}
            {flow.stats?.failedLast7Days ? <span className="small auto-danger">{formatCount(flow.stats.failedLast7Days)} failed</span> : null}
          </span>
        ),
      },
      {
        id: 'version',
        header: 'Version',
        hideBelow: 'md',
        cell: (flow) => <Mono>{`v${flow.version}${flow.activeVersion && flow.activeVersion !== flow.version ? ` (on: v${flow.activeVersion})` : ''}`}</Mono>,
      },
      ...(showCompany
        ? [{ id: 'company', header: 'Company', hideBelow: 'md' as const, cell: (flow: AutomationFlow) => session.unitsById.get(flow.companyId)?.name ?? '' }]
        : []),
      { id: 'updated', header: 'Updated', hideBelow: 'md', cell: (flow) => <RelativeTime value={flow.updatedAt} /> },
    ],
    [catalog.data, session.unitsById, showCompany],
  );

  const nurtureTemplates = (templates.data ?? []).filter((t) => t.kind === 'nurture');
  const otherTemplates = (templates.data ?? []).filter((t) => t.kind !== 'nurture');

  return (
    <div className="stack gap-24">
      <DataTable
        label="Flows"
        columns={columns}
        rows={flows.data ?? []}
        rowId={(flow) => flow.id}
        rowLabel={(flow) => flow.name}
        onRowActivate={(flow) => router.push(`/automations/flows/${flow.id}`)}
        loading={flows.isPending}
        refreshing={flows.isFetching && !flows.isPending}
        error={flows.isError ? flows.error : null}
        onRetry={() => void flows.refetch()}
        toolbar={
          <div className="auto-toolbar">
            <Segmented<StatusFilter>
              label="Status"
              value={status}
              onChange={setStatus}
              options={[
                { value: 'all', label: 'All' },
                { value: 'active', label: 'On' },
                { value: 'paused', label: 'Paused' },
                { value: 'draft', label: 'Drafts' },
                { value: 'archived', label: 'Archived' },
              ]}
            />
            <label className="auto-check">
              <input type="checkbox" checked={nurtureOnly} onChange={(e) => setNurtureOnly(e.target.checked)} /> Nurture only
            </label>
            <SearchInput value={q} onChange={setQ} label="Search flows" placeholder="Search flows" className="auto-toolbar__search" />
            {manageable.length > 0 ? (
              <Button variant="primary" icon="plus" onClick={() => setCreating({ template: null })}>
                New flow
              </Button>
            ) : null}
          </div>
        }
        empty={
          <div className="auto-empty">
            <Icon name="bolt" size={28} />
            <p>
              <strong>No flows here yet.</strong>
            </p>
            <p className="muted small">Start from a template below: a WhatsApp welcome for new enquiries, nurture for lost leads, a rebook link after a missed session or a payment chaser.</p>
          </div>
        }
      />

      {templates.data && templates.data.length > 0 ? (
        <Section
          title="Nurture templates for lost leads"
          description="Keep in touch with families who didn't enrol this time. Turn on nurture when you mark a lead lost, and these flows take it from there."
        >
          <TemplateGrid templates={nurtureTemplates} catalogLabel={(key) => triggerLabel(catalog.data, key)} canUse={manageable.length > 0} onUse={(template) => setCreating({ template })} />
        </Section>
      ) : null}
      {otherTemplates.length > 0 ? (
        <Section title="More templates" description="Starting points you can change: every step can be edited before you turn a flow on.">
          <TemplateGrid templates={otherTemplates} catalogLabel={(key) => triggerLabel(catalog.data, key)} canUse={manageable.length > 0} onUse={(template) => setCreating({ template })} />
        </Section>
      ) : null}

      {creating ? (
        <NewFlowDialog
          open
          template={creating.template}
          templates={templates.data ?? []}
          companies={manageable}
          onClose={() => setCreating(null)}
          onCreated={(flow) => router.push(`/automations/flows/${flow.id}`)}
        />
      ) : null}
    </div>
  );
}

function TemplateGrid({
  templates,
  catalogLabel,
  canUse,
  onUse,
}: {
  templates: AutomationTemplate[];
  catalogLabel: (key: string) => string;
  canUse: boolean;
  onUse: (template: AutomationTemplate) => void;
}) {
  return (
    <ul className="auto-templates">
      {templates.map((template) => (
        <li key={template.key} className="auto-template">
          <div className="auto-template__head">
            <Icon name={template.kind === 'nurture' ? 'repeat' : 'bolt'} size={18} />
            <h3>{template.name}</h3>
          </div>
          <p className="small muted">{template.description}</p>
          <p className="small">
            <span className="muted">When:</span> {catalogLabel(template.triggerType)} · {template.stepCount} steps
          </p>
          {canUse ? (
            <Button size="sm" onClick={() => onUse(template)}>
              Use template
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
