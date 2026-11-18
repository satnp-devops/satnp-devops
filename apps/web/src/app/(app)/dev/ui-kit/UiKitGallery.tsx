'use client';

import { keepPreviousData, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useReducer, useState, type ReactNode } from 'react';
import {
  AvatarGroup,
  Board,
  BoardCard,
  BoardColumn,
  BulkActionBar,
  ChannelBadge,
  channelIcon,
  DataTable,
  DateTime,
  FilterBar,
  Kbd,
  KeyValue,
  Masked,
  Menu,
  Money,
  Mono,
  NewBadge,
  RelativeTime,
  SavedViewsMenu,
  Section,
  SidePanel,
  SlaBadge,
  StageBubbles,
  StatusPill,
  Tabs,
  UserPicker,
  infiniteRows,
  useModifierKey,
  useRowSelection,
  type ChipOption,
  type Column,
  type PickedUser,
  type SavedView,
  type SortState,
} from '@/components/crm';
import { Icon } from '@/components/icons';
import { Alert, Avatar, Button, EmptyState, Field, PageHeader, cx } from '@/components/ui';
import { CHANNEL_KEYS, channelLabel, formatCount, formatMoney } from '@/lib/crm/format';
import { useSession } from '@/lib/session';
import {
  CHANNEL_COUNTS,
  DEALS,
  INITIAL_VIEWS,
  LEADS,
  OWNERS,
  STAGES,
  fetchLeadPage,
  ownerOf,
  type LeadQuery,
  type SampleDeal,
  type SampleLead,
} from './sampleData';
import './ui-kit.css';

const SECTIONS = [
  { id: 'leads', title: 'Leads list' },
  { id: 'board', title: 'Pipeline board' },
  { id: 'stages', title: 'Stage bubbles' },
  { id: 'formatting', title: 'Money, dates and IDs' },
  { id: 'badges', title: 'Status and channels' },
  { id: 'layout', title: 'Layout pieces' },
];

const MINUTE = 60_000;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function UiKitGallery() {
  const mod = useModifierKey();
  return (
    <>
      <PageHeader
        title="CRM UI kit"
        description="The shared components every CRM screen is built from, with sample data. Development builds only."
        actions={
          <span className="row gap-8 small muted">
            Global search <Kbd keys={[mod, 'K']} />
          </span>
        }
      />
      <div className="content uikit">
        <nav className="uikit-toc" aria-label="On this page">
          {SECTIONS.map((section) => (
            <a key={section.id} href={`#${section.id}`}>
              {section.title}
            </a>
          ))}
        </nav>
        <LeadsDemo />
        <BoardDemo />
        <StagesDemo />
        <FormattingDemo />
        <BadgesDemo />
        <LayoutDemo />
      </div>
    </>
  );
}

function GallerySection({ id, title, description, children }: { id: string; title: string; description: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className="uikit-section" aria-labelledby={`${id}-title`}>
      <header className="uikit-section__header">
        <h2 id={`${id}-title`} className="title-lg">
          {title}
        </h2>
        <p>{description}</p>
      </header>
      {children}
    </section>
  );
}

function Specimen({ title, code, wide = false, children }: { title: string; code?: string; wide?: boolean; children: ReactNode }) {
  return (
    <div className={cx('uikit-specimen', wide && 'uikit-specimen--wide')}>
      <p className="uikit-specimen__title">{title}</p>
      <div className="uikit-specimen__demo">{children}</div>
      {code ? <code className="uikit-specimen__code">{code}</code> : null}
    </div>
  );
}

// ---------- Leads list: FilterBar + SavedViewsMenu + DataTable + BulkActionBar + SidePanel ----------

type Simulate = 'live' | 'loading' | 'empty' | 'error';
const SIMULATIONS: Array<{ value: Simulate; label: string }> = [
  { value: 'live', label: 'Sample API' },
  { value: 'loading', label: 'Loading' },
  { value: 'empty', label: 'Empty' },
  { value: 'error', label: 'Error' },
];

const CHIP_CHANNELS = ['whatsapp', 'website_form', 'lead_ad_instagram', 'lead_ad_facebook', 'voice_call'] as const;
const CHANNEL_CHIPS: ChipOption[] = CHIP_CHANNELS.map((key) => ({
  value: key,
  label: key.startsWith('lead_ad_') ? channelLabel(key).replace(' lead ad', '') : channelLabel(key),
  icon: channelIcon(key),
  count: CHANNEL_COUNTS[key] ?? 0,
}));

const DEFAULT_SORT: SortState = { key: 'created_at', direction: 'desc' };

const COLUMNS: Column<SampleLead>[] = [
  {
    id: 'lead',
    header: 'Lead',
    sortKey: 'name',
    card: 'title',
    cell: (lead) => (
      <div className="uikit-lead">
        <span className="uikit-lead__name">
          {lead.name}
          {lead.isNew ? <NewBadge /> : null}
        </span>
        <span className="uikit-lead__meta">
          {lead.student} · {lead.program}
        </span>
      </div>
    ),
  },
  { id: 'channel', header: 'Channel', width: 172, hideBelow: 'md', card: 'plain', cell: (lead) => <ChannelBadge channel={lead.channel} /> },
  {
    id: 'stage',
    header: 'Stage',
    width: 232,
    card: 'plain',
    cell: (lead) => <StageBubbles stages={STAGES} currentId={lead.stageId} reachedId={lead.reachedId} />,
  },
  {
    id: 'owner',
    header: 'Owner',
    width: 140,
    hideBelow: 'lg',
    cell: (lead) => {
      const owner = ownerOf(lead.ownerId);
      return owner ? (
        <span className="row gap-6 nowrap">
          <Avatar name={owner.name} size={22} />
          {owner.name.split(' ')[0]}
        </span>
      ) : (
        <span className="muted">Unassigned</span>
      );
    },
  },
  {
    id: 'value',
    header: 'Value',
    width: 112,
    align: 'end',
    sortKey: 'value',
    firstDirection: 'desc',
    cell: (lead) => <Money minor={lead.valueMinor} currency={lead.currency} />,
  },
  {
    id: 'sla',
    header: 'First reply',
    label: 'First reply',
    width: 160,
    sortKey: 'reply_due_at',
    hideBelow: 'md',
    card: 'plain',
    cell: (lead) => <SlaBadge dueAt={lead.replyDueAt} completedAt={lead.repliedAt} />,
  },
  {
    id: 'created',
    header: 'Created',
    width: 124,
    sortKey: 'created_at',
    firstDirection: 'desc',
    cell: (lead) => <RelativeTime value={lead.createdAt} />,
  },
];

function LeadsDemo() {
  const queryClient = useQueryClient();
  const [, refresh] = useReducer((count: number) => count + 1, 0);
  const [search, setSearch] = useState('');
  const [channels, setChannels] = useState<string[]>([]);
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [ownerId, setOwnerId] = useState('');
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  const [views, setViews] = useState<SavedView[]>(INITIAL_VIEWS);
  const [viewId, setViewId] = useState<string | null>('all');
  const [modified, setModified] = useState(false);
  const [simulate, setSimulate] = useState<Simulate>('live');
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [lastAction, setLastAction] = useState<string | null>(null);

  const filters: LeadQuery = { q: search, channels, overdueOnly, ownerId: ownerId || null, sort };
  const leads = useInfiniteQuery({
    queryKey: ['dev-ui-kit', 'leads', filters],
    queryFn: ({ pageParam }) => fetchLeadPage(filters, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    enabled: simulate === 'live',
  });
  const table =
    simulate === 'live'
      ? infiniteRows(leads)
      : {
          rows: [],
          loading: simulate === 'loading',
          refreshing: false,
          error: simulate === 'error' ? new Error("Couldn't load leads: the server didn't answer in time.") : null,
          onRetry: () => setSimulate('live'),
          hasMore: false,
          loadingMore: false,
          onLoadMore: () => undefined,
        };
  const selection = useRowSelection({ filters, simulate });
  const filtered = search !== '' || channels.length > 0 || overdueOnly || ownerId !== '';

  const changed = (apply: () => void) => {
    apply();
    setModified(true);
  };
  const clearFilters = () => {
    setSearch('');
    setChannels([]);
    setOverdueOnly(false);
    setOwnerId('');
    setModified(viewId !== 'all');
  };
  const applyView = (view: SavedView) => {
    setViewId(view.id);
    setModified(false);
    setSearch('');
    setOverdueOnly(view.id === 'v-hot');
    setChannels(view.id === 'v-hot' ? ['whatsapp'] : view.id === 'v-web' ? ['website_form'] : view.id === 'v-partner' ? ['partner_referral'] : []);
    setOwnerId(view.id === 'mine' ? 'u-ritika' : '');
    setSort(view.id === 'v-hot' ? { key: 'reply_due_at', direction: 'asc' } : DEFAULT_SORT);
  };

  // The sample "server" keeps its records in memory: change them, then refetch like after a mutation.
  const updateLeads = (ids: Iterable<string>, change: (lead: SampleLead) => void, message: string) => {
    const wanted = new Set(ids);
    for (const lead of LEADS) if (wanted.has(lead.id)) change(lead);
    refresh();
    void queryClient.invalidateQueries({ queryKey: ['dev-ui-kit', 'leads'] });
    setLastAction(message);
  };

  const rows = table.rows;
  const previewIndex = rows.findIndex((lead) => lead.id === previewId);
  const preview = LEADS.find((lead) => lead.id === previewId) ?? null;
  const count = selection.count;
  const noun = count === 1 ? 'lead' : 'leads';

  return (
    <GallerySection
      id="leads"
      title="Leads list"
      description="FilterBar and SavedViewsMenu in a DataTable's toolbar, over a fake cursor-paginated API through useInfiniteQuery. Select rows for the BulkActionBar; click a row or press Enter for the SidePanel preview."
    >
      <div className="uikit-controls" role="radiogroup" aria-label="Table data">
        <span className="small muted">Data:</span>
        {SIMULATIONS.map((option) => (
          <label key={option.value} className="chip-toggle">
            <input type="radio" name="uikit-simulate" checked={simulate === option.value} onChange={() => setSimulate(option.value)} />
            {option.label}
          </label>
        ))}
      </div>

      <DataTable
        {...table}
        label="Leads"
        columns={COLUMNS}
        rowId={(lead) => lead.id}
        rowLabel={(lead) => lead.name}
        sort={sort}
        onSortChange={(next) => changed(() => setSort(next))}
        selection={selection}
        onRowActivate={(lead) => setPreviewId(lead.id)}
        activeRowId={previewId}
        empty={
          filtered ? (
            <EmptyState icon="search" title="No leads match these filters" action={<Button onClick={clearFilters}>Clear filters</Button>}>
              Try another channel or search term.
            </EmptyState>
          ) : (
            <EmptyState icon="inbox" title="No leads yet">
              Enquiries from WhatsApp, forms, calls and ads appear here as they arrive.
            </EmptyState>
          )
        }
        footer={rows.length > 0 ? `Showing ${formatCount(rows.length)} ${rows.length === 1 ? 'lead' : 'leads'}` : undefined}
        toolbar={
          <FilterBar
            search={{
              value: search,
              onChange: (value) => changed(() => setSearch(value)),
              label: 'Search leads',
              placeholder: 'Search leads',
            }}
            chips={[{ label: 'Channel', options: CHANNEL_CHIPS, selected: channels, onChange: (next) => changed(() => setChannels(next)) }]}
            more={{
              activeCount: (overdueOnly ? 1 : 0) + (ownerId ? 1 : 0),
              content: (
                <>
                  <Field label="Owner">
                    {(control) => (
                      <select {...control} className="select" value={ownerId} onChange={(event) => changed(() => setOwnerId(event.target.value))}>
                        <option value="">Anyone</option>
                        {OWNERS.map((owner) => (
                          <option key={owner.id} value={owner.id}>
                            {owner.name}
                          </option>
                        ))}
                      </select>
                    )}
                  </Field>
                  <label className="check">
                    <input type="checkbox" checked={overdueOnly} onChange={(event) => changed(() => setOverdueOnly(event.target.checked))} />
                    <span>Only leads waiting past their first-reply SLA</span>
                  </label>
                </>
              ),
            }}
            onClear={clearFilters}
            end={
              <SavedViewsMenu
                views={views}
                currentId={viewId}
                modified={modified}
                canShare
                onSelect={applyView}
                onSave={async ({ name, shared }) => {
                  await wait(400);
                  const view: SavedView = { id: `v-${Date.now()}`, name, shared, canEdit: true };
                  setViews((list) => [...list, view]);
                  setViewId(view.id);
                  setModified(false);
                }}
                onRename={async (view, name) => {
                  await wait(300);
                  setViews((list) => list.map((item) => (item.id === view.id ? { ...item, name } : item)));
                }}
                onDelete={async (view) => {
                  await wait(300);
                  if (view.name.toLowerCase().includes('error')) throw new Error('Only the person who shared it can delete this view.');
                  setViews((list) => list.filter((item) => item.id !== view.id));
                  if (viewId === view.id) applyView(INITIAL_VIEWS[0] ?? view);
                }}
              />
            }
          />
        }
      />

      <BulkActionBar count={count} noun="lead" onClear={selection.clear}>
        <Menu
          label={`Assign ${count} ${noun} to`}
          heading="Assign to…"
          items={OWNERS.map((owner) => ({
            key: owner.id,
            label: owner.name,
            icon: 'user',
            onSelect: () => {
              updateLeads(selection.selected, (lead) => (lead.ownerId = owner.id), `Assigned ${count} ${noun} to ${owner.name}.`);
              selection.clear();
            },
          }))}
          trigger={(trigger) => (
            <Button {...trigger} size="sm" icon="user">
              Assign
            </Button>
          )}
        />
        <Menu
          label={`Move ${count} ${noun} to`}
          heading="Move to…"
          items={STAGES.filter((stage) => !stage.outcome).map((stage) => ({
            key: stage.id,
            label: stage.name,
            icon: 'arrowRight',
            onSelect: () => {
              updateLeads(selection.selected, (lead) => (lead.stageId = stage.id), `Moved ${count} ${noun} to ${stage.name}.`);
              selection.clear();
            },
          }))}
          trigger={(trigger) => (
            <Button {...trigger} size="sm" icon="move">
              Change stage
            </Button>
          )}
        />
        <Button size="sm" icon="download" onClick={() => setLastAction(`Export of ${count} ${noun} started (a background job in the real app).`)}>
          Export
        </Button>
      </BulkActionBar>

      {lastAction ? (
        <Alert tone="success" action={<Button size="sm" variant="ghost" icon="x" aria-label="Dismiss" onClick={() => setLastAction(null)} />}>
          {lastAction}
        </Alert>
      ) : null}

      <SidePanel
        open={preview !== null}
        onClose={() => setPreviewId(null)}
        title={preview?.name ?? ''}
        subtitle={
          preview ? (
            <span className="row gap-8">
              <ChannelBadge channel={preview.channel} />
              <RelativeTime value={preview.createdAt} />
              <Mono>{preview.ref}</Mono>
            </span>
          ) : null
        }
        actions={
          <>
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              icon="arrowUp"
              aria-label="Previous lead"
              disabled={previewIndex <= 0}
              onClick={() => setPreviewId(rows[previewIndex - 1]?.id ?? previewId)}
            />
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              icon="arrowDown"
              aria-label="Next lead"
              disabled={previewIndex < 0 || previewIndex >= rows.length - 1}
              onClick={() => setPreviewId(rows[previewIndex + 1]?.id ?? previewId)}
            />
          </>
        }
        footer={
          <>
            <Button variant="primary" icon="calendar">
              Send booking link
            </Button>
            <Button icon="phone">Log call</Button>
            <Button icon="plus">Add task</Button>
          </>
        }
      >
        {preview ? (
          <LeadPreview
            lead={preview}
            onStage={(stageId) => {
              const stage = STAGES.find((item) => item.id === stageId);
              updateLeads(
                [preview.id],
                (lead) => {
                  lead.reachedId = stage?.outcome === 'lost' ? lead.stageId : null;
                  lead.stageId = stageId;
                },
                `${preview.name} moved to ${stage?.name ?? 'a new stage'}.`,
              );
            }}
          />
        ) : null}
      </SidePanel>
    </GallerySection>
  );
}

function LeadPreview({ lead, onStage }: { lead: SampleLead; onStage: (stageId: string) => void }) {
  const { scope } = useSession();
  const sampleOwner = ownerOf(lead.ownerId);
  const [owner, setOwner] = useState<PickedUser | null>(sampleOwner);
  return (
    <div className="stack gap-16">
      <StageBubbles size="full" stages={STAGES} currentId={lead.stageId} reachedId={lead.reachedId} onSelect={(stage) => onStage(stage.id)} label="Move this lead" />
      <Section
        level={3}
        title="Original message"
        description={
          <>
            {channelLabel(lead.channel)} · <DateTime value={lead.createdAt} format="short" contactTimeZone={lead.timeZone} />
          </>
        }
      >
        <blockquote className="uikit-quote">{lead.message}</blockquote>
      </Section>
      <Section
        level={3}
        title="Captured by AI"
        actions={
          <StatusPill tone="accent" icon="sparkle">
            High confidence
          </StatusPill>
        }
      >
        <KeyValue
          layout="stacked"
          items={[
            { label: 'Student', value: lead.student },
            { label: 'Grade', value: lead.captured.grade },
            { label: 'Exam', value: lead.captured.exam },
            { label: 'Target date', value: lead.captured.targetDate },
            { label: 'Intent', value: lead.captured.intent },
            { label: 'Language', value: lead.captured.language },
            { label: 'City', value: lead.city },
            { label: 'Budget', value: null },
          ]}
        />
      </Section>
      <Section level={3} title="Contact">
        <KeyValue
          items={[
            { label: 'Phone', value: <Masked value={lead.phone} kind="phone" canReveal /> },
            { label: 'Email', value: <Masked value={lead.email} kind="email" canReveal /> },
            { label: 'Local time', value: <DateTime value={Date.now()} format="time" timeZone={lead.timeZone} /> },
            { label: 'Lead ID', value: <Mono>{lead.ref}</Mono> },
          ]}
        />
        <div className="uikit-owner">
          <Field label="Owner" hint="UserPicker: searches real people in your working scope.">
            {(control) => <UserPicker unitId={scope.id} value={owner} onChange={setOwner} control={control} />}
          </Field>
        </div>
      </Section>
    </div>
  );
}

// ---------- Pipeline board ----------

function BoardDemo() {
  const [deals, setDeals] = useState<SampleDeal[]>(DEALS);
  const [opened, setOpened] = useState<string | null>(null);
  const stages = STAGES.filter((stage) => stage.outcome !== 'lost');
  const now = Date.now();
  return (
    <GallerySection
      id="board"
      title="Pipeline board"
      description="Board, BoardColumn and BoardCard. Drag cards between stages, or use a card's Move menu (keyboard and touch). On phones columns snap into place one at a time."
    >
      <Board
        label="Admissions pipeline (sample)"
        columns={stages.map((stage) => ({ id: stage.id, title: stage.name }))}
        onMove={(cardId, toColumnId) => setDeals((list) => list.map((deal) => (deal.id === cardId ? { ...deal, stageId: toColumnId } : deal)))}
      >
        {stages.map((stage) => {
          const inStage = deals.filter((deal) => deal.stageId === stage.id);
          const total = inStage.reduce((sum, deal) => sum + deal.valueMinor, 0);
          const overdue = inStage.filter((deal) => Date.parse(deal.dueAt) < now).length;
          return (
            <BoardColumn
              key={stage.id}
              id={stage.id}
              title={stage.name}
              count={inStage.length}
              countLabel="deals"
              total={<Money minor={total} currency="INR" compact />}
              flag={
                overdue > 0 ? (
                  <StatusPill tone="danger" icon="clock">
                    {overdue} over SLA
                  </StatusPill>
                ) : null
              }
              emptyText="No deals in this stage"
            >
              {inStage.map((deal) => {
                const owner = ownerOf(deal.ownerId);
                return (
                  <BoardCard key={deal.id} id={deal.id} title={deal.title} onOpen={() => setOpened(deal.title)}>
                    <span>{deal.program}</span>
                    <span className="row gap-8 nowrap">
                      <Money minor={deal.valueMinor} currency="INR" />
                      {owner ? (
                        <span className="row gap-4 nowrap small">
                          <Avatar name={owner.name} size={20} />
                          {owner.name.split(' ')[0]}
                        </span>
                      ) : null}
                    </span>
                    <span className="row gap-6">
                      <ChannelBadge channel={deal.channel} iconOnly />
                      {deal.isNew ? <NewBadge /> : null}
                      <SlaBadge dueAt={deal.dueAt} prefix="Follow-up" />
                    </span>
                  </BoardCard>
                );
              })}
            </BoardColumn>
          );
        })}
      </Board>
      {opened ? (
        <p className="small muted" role="status">
          Opened {opened} (a deal profile in the real app).
        </p>
      ) : null}
    </GallerySection>
  );
}

// ---------- Stage bubbles ----------

function StagesDemo() {
  const [current, setCurrent] = useState('demo_booked');
  return (
    <GallerySection
      id="stages"
      title="Stage bubbles"
      description="Stage progress as filled answer-sheet bubbles: filled for stages passed, ring and fill on the current one, green when won, red when lost. Labels are always there for screen readers (and visible at full size)."
    >
      <div className="uikit-grid">
        <Specimen title="Compact, open deal" code={'<StageBubbles stages={stages} currentId="demo_booked" />'}>
          <StageBubbles stages={STAGES} currentId="demo_booked" />
        </Specimen>
        <Specimen title="Compact, won" code={'currentId="enrolled"'}>
          <StageBubbles stages={STAGES} currentId="enrolled" />
        </Specimen>
        <Specimen title="Compact, lost after the demo" code={'currentId="lost" reachedId="demo_done"'}>
          <StageBubbles stages={STAGES} currentId="lost" reachedId="demo_done" />
        </Specimen>
        <Specimen title="Compact, clickable" code="onSelect={(stage) => move(stage)}">
          <StageBubbles stages={STAGES} currentId={current} onSelect={(stage) => setCurrent(stage.id)} label="Sample stage" />
        </Specimen>
      </div>
      <Specimen wide title="Full size with onSelect: click a stage, or Tab in and use the arrow keys" code={'<StageBubbles size="full" stages={stages} currentId={id} onSelect={move} />'}>
        <StageBubbles size="full" stages={STAGES} currentId={current} onSelect={(stage) => setCurrent(stage.id)} label="Sample stage" />
      </Specimen>
      <Specimen wide title="Full size, lost after the demo">
        <StageBubbles size="full" stages={STAGES} currentId="lost" reachedId="demo_done" />
      </Specimen>
      <div className="uikit-grid">
        <Specimen title="Full size, won">
          <StageBubbles size="full" stages={STAGES} currentId="enrolled" />
        </Specimen>
        <Specimen title="Full size in a narrow space: one summary line">
          <StageBubbles size="full" stages={STAGES} currentId="contacted" />
        </Specimen>
      </div>
    </GallerySection>
  );
}

// ---------- Formatting ----------

function FormattingDemo() {
  const now = Date.now();
  return (
    <GallerySection
      id="formatting"
      title="Money, dates and IDs"
      description="Money is stored in minor units with a currency code; rupees use Indian grouping. Times show in the viewer's time zone, optionally with the contact's, in JetBrains Mono."
    >
      <div className="uikit-grid">
        <Specimen title="Rupees" code={'<Money minor={12500000} currency="INR" />'}>
          <Money minor={12500000} currency="INR" />
          <Money minor={12500050} currency="INR" />
          <Money minor={-500000} currency="INR" />
        </Specimen>
        <Specimen title="Compact (full amount in the tooltip)" code="compact">
          <Money minor={125000000} currency="INR" compact />
          <Money minor={1234567800} currency="INR" compact />
          <Money minor={129900000} currency="USD" compact />
        </Specimen>
        <Specimen title="Other currencies" code={'currency="USD" | "AED" | "JPY"'}>
          <Money minor={129900} currency="USD" />
          <Money minor={450000} currency="AED" />
          <Money minor={98000} currency="JPY" />
        </Specimen>
        <Specimen title="Viewer's time zone" code="<DateTime value={iso} />">
          <DateTime value={now - 3 * 60 * MINUTE} />
          <DateTime value={now} format="day" />
        </Specimen>
        <Specimen title="With the contact's time zone" code={'contactTimeZone="America/New_York"'}>
          <DateTime value={now + 26 * 60 * MINUTE} format="short" contactTimeZone="America/New_York" />
        </Specimen>
        <Specimen title="Relative, updating by itself" code="<RelativeTime value={iso} />">
          <RelativeTime value={now - 5 * MINUTE} />
          <RelativeTime value={now + 3 * 60 * MINUTE} />
          <RelativeTime value={now - 2 * 24 * 60 * MINUTE} />
        </Specimen>
        <Specimen title="IDs and references" code="<Mono>LD-24817</Mono>">
          <Mono>LD-24817</Mono>
          <Mono short>0b6c1000-5d1e-4c3a-9f2b-100000000000</Mono>
          <Mono>INV/2026-27/0042</Mono>
        </Specimen>
        <Specimen title="Masked personal data, with Show" code={'<Masked value={phone} kind="phone" canReveal />'}>
          <Masked value="+91 98765 43210" kind="phone" canReveal />
          <Masked value="ritika.sharma@gmail.com" kind="email" canReveal />
        </Specimen>
        <Specimen title="Masked for roles without access, or fetched on Show" code="onReveal={() => api.get(...)}">
          <Masked value="+91 ••••• •3210" kind="phone" />
          <Masked
            value="+1 201 555 0147"
            kind="phone"
            canReveal
            onReveal={async () => {
              await wait(500);
              return '+1 201 555 0147';
            }}
          />
        </Specimen>
      </div>
    </GallerySection>
  );
}

// ---------- Status and channels ----------

function BadgesDemo() {
  const now = Date.now();
  return (
    <GallerySection
      id="badges"
      title="Status and channels"
      description="Status pills always say their status in words; colour (green, amber, red, neutral) only reinforces it."
    >
      <div className="uikit-grid">
        <Specimen title="StatusPill" code={'<StatusPill tone="success">Enrolled</StatusPill>'}>
          <StatusPill tone="success">Enrolled</StatusPill>
          <StatusPill tone="warning">Payment due</StatusPill>
          <StatusPill tone="danger">Lost</StatusPill>
          <StatusPill>Paused</StatusPill>
          <StatusPill tone="accent" icon="sparkle">
            AI suggested
          </StatusPill>
        </Specimen>
        <Specimen title="NewBadge" code="<NewBadge />">
          <NewBadge />
          <NewBadge>3 new</NewBadge>
        </Specimen>
        <Specimen title="SlaBadge" code={'<SlaBadge dueAt={iso} prefix="Reply" />'}>
          <SlaBadge dueAt={now + 5 * 60 * MINUTE} />
          <SlaBadge dueAt={now + 25 * MINUTE} prefix="Reply" />
          <SlaBadge dueAt={now - 130 * MINUTE} />
          <SlaBadge dueAt={now - 60 * MINUTE} completedAt={now - 90 * MINUTE} />
          <SlaBadge dueAt={now - 60 * MINUTE} completedAt={now - 20 * MINUTE} />
        </Specimen>
      </div>
      <Specimen wide title="ChannelBadge, every channel" code={'<ChannelBadge channel="whatsapp" />  ·  iconOnly'}>
        {CHANNEL_KEYS.map((channel) => (
          <ChannelBadge key={channel} channel={channel} />
        ))}
        <ChannelBadge channel="lead_ad_tiktok" />
      </Specimen>
      <Specimen wide title="Icon only (the name is the tooltip and is read aloud)">
        {CHANNEL_KEYS.map((channel) => (
          <ChannelBadge key={channel} channel={channel} iconOnly />
        ))}
      </Specimen>
    </GallerySection>
  );
}

// ---------- Layout pieces ----------

function LayoutDemo() {
  const { scope } = useSession();
  const mod = useModifierKey();
  const [owner, setOwner] = useState<PickedUser | null>(null);
  const [lastChoice, setLastChoice] = useState('');
  const tabs = [
    { href: '/dev/ui-kit', label: 'UI kit', exact: true },
    { href: '/', label: 'Home', exact: true },
    { href: '/settings/people', label: 'People', count: 8 },
    { href: '/settings/audit', label: 'Audit log' },
  ];
  return (
    <GallerySection id="layout" title="Layout pieces" description="Route tabs, sections, key-value lists, avatars, keys, menus and the people picker.">
      <Specimen wide title="Tabs (route tabs: aria-current follows the URL)" code={'<Tabs label="Lead sections" items={[{ href, label, count }]} />'}>
        <div className="uikit-fill">
          <Tabs label="Sample sections" items={tabs} />
        </div>
      </Specimen>
      <div className="uikit-grid uikit-grid--wide">
        <Section
          title="Fees"
          count={2}
          description="Section: a card with a header, actions and an optional footer"
          actions={
            <>
              <Button size="sm" icon="plus">
                Add fee
              </Button>
              <Menu
                label="More fee actions"
                placement="bottom-end"
                items={[
                  { key: 'plan', label: 'Set up instalments', icon: 'calendar', onSelect: () => setLastChoice('Set up instalments') },
                  { key: 'discount', label: 'Request a discount', icon: 'edit', onSelect: () => setLastChoice('Request a discount') },
                  { key: 'void', label: 'Cancel the proposal', icon: 'trash', danger: true, onSelect: () => setLastChoice('Cancel the proposal') },
                ]}
                trigger={(trigger) => <Button {...trigger} size="sm" variant="ghost" iconOnly icon="more" aria-label="More fee actions" />}
              />
            </>
          }
          footer={<span className="small muted">{lastChoice ? `Chose: ${lastChoice}` : 'Total due in 2 instalments'}</span>}
        >
          <KeyValue
            items={[
              { label: 'Program', value: 'SAT 1:1 mentorship' },
              { label: 'Fee', value: <Money minor={12500000} currency="INR" /> },
              { label: 'GST (18%)', value: <Money minor={2250000} currency="INR" /> },
              { label: 'Due', value: <DateTime value={Date.now() + 3 * 24 * 60 * MINUTE} format="date" /> },
              { label: 'Discount', value: null },
            ]}
          />
        </Section>
        <Section title="Captured by AI" description="KeyValue, stacked layout" level={2}>
          <KeyValue
            layout="stacked"
            items={[
              { label: 'Parent', value: 'Aarav Mehta', meta: <Icon name="sparkle" size={12} /> },
              { label: 'Student', value: 'Riya Mehta', meta: <Icon name="sparkle" size={12} /> },
              { label: 'Grade', value: 'Grade 11' },
              { label: 'Target exam', value: 'Digital SAT, March 2027' },
              { label: 'Time zone', value: <Mono>Asia/Kolkata</Mono> },
              { label: 'Budget', value: '' },
            ]}
          />
        </Section>
      </div>
      <div className="uikit-grid">
        <Specimen title="AvatarGroup" code="<AvatarGroup people={hosts} max={3} />">
          <AvatarGroup people={OWNERS.slice(0, 2)} />
          <AvatarGroup people={OWNERS} max={3} />
          <AvatarGroup people={OWNERS} max={2} size={24} />
        </Specimen>
        <Specimen title="Kbd" code={"<Kbd keys={[mod, 'K']} />"}>
          <Kbd keys={[mod, 'K']} />
          <Kbd>Esc</Kbd>
          <Kbd keys={['↑', '↓']} />
          <Kbd>Enter</Kbd>
          <Kbd keys={['⇧', 'Space']} />
        </Specimen>
        <Specimen title="Menu" code="<Menu label items trigger />">
          <Menu
            label="Lead actions"
            items={[
              { key: 'call', label: 'Log a call', icon: 'phone', onSelect: () => setLastChoice('Log a call') },
              { key: 'mail', label: 'Send an email', icon: 'mail', onSelect: () => setLastChoice('Send an email') },
              { key: 'merge', label: 'Merge duplicate', icon: 'layers', onSelect: () => setLastChoice('Merge duplicate'), disabled: true },
            ]}
            trigger={(trigger) => (
              <Button {...trigger} icon="chevronDown">
                Actions
              </Button>
            )}
          />
          {lastChoice ? <span className="small muted">Chose: {lastChoice}</span> : null}
        </Specimen>
      </div>
      <Specimen wide title={`UserPicker (live: GET /users?unitId=${scope.name}&q=…)`} code="<UserPicker unitId={scope.id} value={owner} onChange={setOwner} control={control} />">
        <div className="uikit-picker">
          <Field label="Owner" hint={`People with a role in ${scope.name} or anywhere inside it. Needs users.view there.`}>
            {(control) => <UserPicker unitId={scope.id} value={owner} onChange={setOwner} control={control} />}
          </Field>
          <p className="small muted">{owner ? `Picked ${owner.name}${owner.email ? ` (${owner.email})` : ''}` : 'Nobody picked yet.'}</p>
        </div>
      </Specimen>
      <p className="small muted">
        {formatCount(LEADS.length)} sample leads · pipeline value {formatMoney(DEALS.reduce((sum, deal) => sum + deal.valueMinor, 0), 'INR')}
      </p>
    </GallerySection>
  );
}
