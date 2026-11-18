'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { DataTable, FilterBar, StatusPill, infiniteRows, type Column } from '@/components/crm';
import { Guard } from '@/components/Guard';
import { Button, EmptyState } from '@/components/ui';
import { Cell, Meter } from '@/components/delivery/Bits';
import { formatCount } from '@/lib/crm/format';
import { PROJECT_STATUS, dateLabel, daysUntil } from '@/lib/delivery/format';
import { useProjects } from '@/lib/delivery/queries';
import type { ProjectStatus, ProjectSummary } from '@/lib/delivery/types';
import { useSession } from '@/lib/session';

export function ProjectsView() {
  return (
    <Guard anyOf={['onboarding.view']} anywhere>
      <Projects />
    </Guard>
  );
}

const STATUS_CHIPS = (Object.keys(PROJECT_STATUS) as ProjectStatus[]).map((value) => ({ value, label: PROJECT_STATUS[value].label }));

function goLive(p: ProjectSummary) {
  if (p.status === 'live') return <StatusPill tone="success">Live{p.wentLiveAt ? ` since ${dateLabel(p.wentLiveAt.slice(0, 10))}` : ''}</StatusPill>;
  if (!p.targetGoLiveOn) return <span className="muted">No date</span>;
  const days = daysUntil(p.targetGoLiveOn);
  return <Cell main={dateLabel(p.targetGoLiveOn)} sub={days < 0 ? <span className="delivery-overdue">{-days} days late</span> : `in ${days} days`} />;
}

const COLUMNS: Column<ProjectSummary>[] = [
  { id: 'account', header: 'Institute', card: 'title', cell: (p) => <Cell main={p.account?.name ?? p.name} sub={p.product?.name ?? p.productLine?.name ?? null} /> },
  { id: 'status', header: 'Status', width: 130, cell: (p) => <StatusPill tone={PROJECT_STATUS[p.status].tone}>{PROJECT_STATUS[p.status].label}</StatusPill> },
  { id: 'phase', header: 'Now', width: 170, hideBelow: 'md', cell: (p) => (p.currentPhase ? <Cell main={p.currentPhase.name} sub={p.currentPhase.dueOn ? `Due ${dateLabel(p.currentPhase.dueOn)}` : undefined} /> : <span className="muted">All phases done</span>) },
  { id: 'progress', header: 'Tasks', width: 150, cell: (p) => <Meter value={p.tasksDone} max={p.tasksTotal} label={`${p.tasksDone} of ${p.tasksTotal}`} tone={p.tasksTotal > 0 && p.tasksDone === p.tasksTotal ? 'done' : undefined} /> },
  { id: 'golive', header: 'Go-live', width: 150, cell: goLive },
  { id: 'owner', header: 'Owner', width: 140, hideBelow: 'lg', cell: (p) => p.owner?.name ?? <span className="muted">No owner</span> },
];

function Projects() {
  const { scope } = useSession();
  const router = useRouter();
  const [statuses, setStatuses] = useState<string[]>(['planned', 'in_progress', 'on_hold']);
  const [mine, setMine] = useState(false);
  const list = useProjects(scope.id, { status: statuses.join(',') || undefined, owner: mine ? 'me' : undefined });
  const table = infiniteRows(list);
  const clear = () => {
    setStatuses(['planned', 'in_progress', 'on_hold']);
    setMine(false);
  };
  return (
    <DataTable
      {...table}
      label="Implementation projects"
      columns={COLUMNS}
      rowId={(p) => p.id}
      rowLabel={(p) => p.account?.name ?? p.name}
      onRowActivate={(p) => router.push(`/onboarding/projects/${p.id}`)}
      toolbar={
        <FilterBar chips={[{ label: 'Status', options: STATUS_CHIPS, selected: statuses, onChange: setStatuses }]} extraActiveCount={mine ? 1 : 0} onClear={clear}>
          <label className="check">
            <input type="checkbox" checked={mine} onChange={(event) => setMine(event.target.checked)} />
            Mine
          </label>
        </FilterBar>
      }
      empty={
        <EmptyState icon="flag" title="No implementation projects here" action={mine ? <Button onClick={clear}>Clear filters</Button> : undefined}>
          A project starts by itself when an institute signs, with kickoff, data import, training and go-live.
        </EmptyState>
      }
      footer={table.rows.length > 0 ? `Showing ${formatCount(table.rows.length)} ${table.rows.length === 1 ? 'project' : 'projects'}` : undefined}
    />
  );
}
