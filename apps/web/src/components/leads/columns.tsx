'use client';

import { ChannelBadge, Money, NewBadge, RelativeTime, SlaBadge, StageBubbles, StatusPill, type Column, type StageBubble } from '@/components/crm';
import { Avatar } from '@/components/ui';
import type { BuiltInDealColumn, DealListItem, Pipeline } from '@/lib/crm/types';

/** The display name of a lead: its main contact, else its institute, else its title. */
export function leadName(deal: Pick<DealListItem, 'primaryContact' | 'account' | 'title'>): string {
  return deal.primaryContact?.displayName ?? deal.account?.name ?? deal.title;
}

/** Active stages of a pipeline in order, as StageBubbles wants them. */
export function stageBubbles(pipeline: Pipeline | undefined): StageBubble[] {
  if (!pipeline) return [];
  return pipeline.stages
    .filter((stage) => stage.archivedAt === null)
    .sort((a, b) => a.position - b.position)
    .map((stage) => ({ id: stage.id, name: stage.name, outcome: stage.category === 'open' ? null : stage.category }));
}

/** The deadline that matters most right now: a first reply still owed, else the stage SLA. */
export function LeadSla({ deal }: { deal: DealListItem }) {
  if (deal.status !== 'open') {
    return <StatusPill tone={deal.status === 'won' ? 'success' : 'danger'}>{deal.status === 'won' ? 'Won' : 'Lost'}</StatusPill>;
  }
  if (deal.firstReplyDueAt && !deal.firstRepliedAt) return <SlaBadge dueAt={deal.firstReplyDueAt} prefix="Reply" />;
  if (deal.slaDueAt) return <SlaBadge dueAt={deal.slaDueAt} warnWithinMinutes={120} />;
  return <span className="muted small">No target</span>;
}

function LeadCell({ deal }: { deal: DealListItem }) {
  const meta = [deal.ref, deal.studentNames.length > 0 ? deal.studentNames.join(', ') : null, deal.productLine?.name ?? null].filter(
    (part): part is string => Boolean(part),
  );
  return (
    <div className="leads-cell">
      <span className="leads-cell__name">
        <span className="leads-cell__text">{leadName(deal)}</span>
        {deal.isNew ? <NewBadge title="New: its owner hasn't opened it yet" /> : null}
      </span>
      <span className="leads-cell__meta">{meta.join(' · ')}</span>
      {deal.messagePreview ? <span className="leads-cell__message">{deal.messagePreview}</span> : null}
    </div>
  );
}

function OwnerCell({ deal }: { deal: DealListItem }) {
  if (!deal.owner) return <span className="muted">Unassigned</span>;
  return (
    <span className="row gap-6 nowrap">
      <Avatar name={deal.owner.name} size={22} />
      <span>{deal.owner.name}</span>
    </span>
  );
}

function StageCell({ deal, pipelines }: { deal: DealListItem; pipelines: ReadonlyMap<string, Pipeline> }) {
  const stages = stageBubbles(pipelines.get(deal.pipelineId));
  if (stages.length === 0 || !stages.some((stage) => stage.id === deal.stage.id)) return <span>{deal.stage.name}</span>;
  return <StageBubbles stages={stages} currentId={deal.stage.id} label={`Stage of ${leadName(deal)}`} />;
}

/**
 * The Leads table's columns: the lead (always) and the optional ones that are switched on.
 * Sort keys are GET /deals sorts (the header click picks the direction).
 */
export function leadColumns(visible: readonly BuiltInDealColumn[], pipelines: ReadonlyMap<string, Pipeline>): Column<DealListItem>[] {
  const all: Partial<Record<BuiltInDealColumn, Column<DealListItem>>> = {
    channel: {
      id: 'channel',
      header: 'Channel',
      width: 150,
      hideBelow: 'md',
      card: 'plain',
      cell: (deal) => <ChannelBadge channel={deal.channel} />,
    },
    stage: { id: 'stage', header: 'Stage', width: 220, card: 'plain', cell: (deal) => <StageCell deal={deal} pipelines={pipelines} /> },
    owner: { id: 'owner', header: 'Owner', width: 160, hideBelow: 'lg', cell: (deal) => <OwnerCell deal={deal} /> },
    productLine: {
      id: 'productLine',
      header: 'Product line',
      width: 160,
      hideBelow: 'lg',
      cell: (deal) => deal.productLine?.name ?? <span className="muted">None</span>,
    },
    value: {
      id: 'value',
      header: 'Value',
      width: 116,
      align: 'end',
      sortKey: 'value',
      firstDirection: 'desc',
      cell: (deal) =>
        deal.value.valueMinor > 0 ? <Money minor={deal.value.valueMinor} currency={deal.value.currency} /> : <span className="muted">—</span>,
    },
    slaDueAt: {
      id: 'slaDueAt',
      header: 'SLA',
      label: 'SLA',
      width: 200,
      sortKey: 'slaDueAt',
      card: 'plain',
      cell: (deal) => <LeadSla deal={deal} />,
    },
    tags: {
      id: 'tags',
      header: 'Tags',
      width: 160,
      hideBelow: 'lg',
      cell: (deal) =>
        deal.tags.length > 0 ? (
          <span className="leads-tags">
            {deal.tags.map((tag) => (
              <span key={tag} className="badge">
                {tag}
              </span>
            ))}
          </span>
        ) : (
          <span className="muted">—</span>
        ),
    },
    unit: { id: 'unit', header: 'Team', width: 150, hideBelow: 'lg', cell: (deal) => deal.unit.name },
    lastActivityAt: {
      id: 'lastActivityAt',
      header: 'Last activity',
      width: 124,
      sortKey: 'lastActivityAt',
      firstDirection: 'desc',
      hideBelow: 'md',
      cell: (deal) => <RelativeTime value={deal.lastActivityAt} />,
    },
    createdAt: {
      id: 'createdAt',
      header: 'Created',
      width: 116,
      sortKey: 'createdAt',
      firstDirection: 'desc',
      cell: (deal) => <RelativeTime value={deal.createdAt} />,
    },
    updatedAt: {
      id: 'updatedAt',
      header: 'Updated',
      width: 116,
      sortKey: 'updatedAt',
      firstDirection: 'desc',
      hideBelow: 'md',
      cell: (deal) => <RelativeTime value={deal.updatedAt} />,
    },
  };
  const lead: Column<DealListItem> = {
    id: 'lead',
    header: 'Lead',
    label: 'Name',
    sortKey: 'title',
    card: 'title',
    cell: (deal) => <LeadCell deal={deal} />,
  };
  return [lead, ...visible.flatMap((id) => all[id] ?? [])];
}
