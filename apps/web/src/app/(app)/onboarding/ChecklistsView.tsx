'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { DataTable, FilterBar, Mono, SidePanel, StatusPill, infiniteRows, type Column } from '@/components/crm';
import { Guard } from '@/components/Guard';
import { Button, EmptyState, ErrorAlert, PageLoading, Spinner } from '@/components/ui';
import { Cell, Meter } from '@/components/delivery/Bits';
import { ChecklistItems, EnrollmentDrawer } from '@/components/delivery/EnrollmentDrawer';
import { formatCount } from '@/lib/crm/format';
import { ENROLLMENT_STATUS, dateLabel, todayInIndia } from '@/lib/delivery/format';
import { useChecklist, useChecklists } from '@/lib/delivery/queries';
import type { ChecklistSummary } from '@/lib/delivery/types';
import { useSession } from '@/lib/session';

export function ChecklistsView() {
  const session = useSession();
  const router = useRouter();
  // People who only see renewals (finance) land on that tab.
  const renewalsOnly = !session.canAnywhere('onboarding.view') && session.canAnywhere('onboarding.view_renewals');
  useEffect(() => {
    if (renewalsOnly) router.replace('/onboarding/renewals');
  }, [renewalsOnly, router]);
  if (renewalsOnly) return <PageLoading />;
  return (
    <Guard anyOf={['onboarding.view']} anywhere>
      <Checklists />
    </Guard>
  );
}

const STATUS_CHIPS = [
  { value: 'open', label: 'In progress' },
  { value: 'done', label: 'Done' },
];

const COLUMNS: Column<ChecklistSummary>[] = [
  {
    id: 'student',
    header: 'Student',
    card: 'title',
    cell: (c) => <Cell main={c.enrollment?.student?.displayName ?? 'Student'} sub={c.enrollment ? <Mono>{c.enrollment.ref}</Mono> : null} />,
  },
  { id: 'programme', header: 'Programme', hideBelow: 'md', cell: (c) => <Cell main={c.enrollment?.product?.name ?? ''} sub={c.enrollment?.batch?.name ?? 'No batch yet'} /> },
  {
    id: 'progress',
    header: 'Progress',
    width: 160,
    cell: (c) => <Meter value={c.itemsDone} max={c.itemsTotal} label={`${c.itemsDone} of ${c.itemsTotal} done`} tone={c.status === 'done' ? 'done' : undefined} />,
  },
  {
    id: 'next',
    header: 'Next due',
    width: 150,
    cell: (c) =>
      c.status === 'done' ? (
        <StatusPill tone="success">Complete</StatusPill>
      ) : c.overdueCount > 0 ? (
        <span className="delivery-overdue">{c.overdueCount} overdue</span>
      ) : c.nextDueOn ? (
        dateLabel(c.nextDueOn)
      ) : (
        <span className="muted">—</span>
      ),
  },
  {
    id: 'enrollment',
    header: 'Enrollment',
    width: 120,
    hideBelow: 'lg',
    cell: (c) => (c.enrollment ? <StatusPill tone={ENROLLMENT_STATUS[c.enrollment.status].tone}>{ENROLLMENT_STATUS[c.enrollment.status].label}</StatusPill> : null),
  },
  { id: 'owner', header: 'Owner', width: 140, hideBelow: 'md', cell: (c) => c.owner?.name ?? <span className="muted">No owner</span> },
];

function Checklists() {
  const { scope } = useSession();
  const [statuses, setStatuses] = useState<string[]>(['open']);
  const [overdue, setOverdue] = useState(false);
  const [mine, setMine] = useState(false);
  const status = statuses.length === 1 ? statuses[0] : undefined;
  const list = useChecklists(scope.id, { status, overdue: overdue || undefined, owner: mine ? 'me' : undefined });
  const table = infiniteRows(list);
  const [openId, setOpenId] = useState<string | null>(null);
  const clear = () => {
    setStatuses(['open']);
    setOverdue(false);
    setMine(false);
  };
  return (
    <>
      <DataTable
        {...table}
        label="Onboarding checklists"
        columns={COLUMNS}
        rowId={(c) => c.id}
        rowLabel={(c) => c.enrollment?.student?.displayName ?? c.name}
        onRowActivate={(c) => setOpenId(c.id)}
        activeRowId={openId}
        toolbar={
          <FilterBar chips={[{ label: 'Status', options: STATUS_CHIPS, selected: statuses, onChange: setStatuses }]} extraActiveCount={(overdue ? 1 : 0) + (mine ? 1 : 0)} onClear={clear}>
            <label className="check">
              <input type="checkbox" checked={overdue} onChange={(event) => setOverdue(event.target.checked)} />
              Overdue items
            </label>
            <label className="check">
              <input type="checkbox" checked={mine} onChange={(event) => setMine(event.target.checked)} />
              Mine
            </label>
          </FilterBar>
        }
        empty={
          <EmptyState icon="flag" title={overdue ? 'Nothing overdue' : 'No checklists here'} action={overdue || mine ? <Button onClick={clear}>Clear filters</Button> : undefined}>
            Every new enrollment starts the company&apos;s onboarding checklist: welcome call, timetable, platform login and the first check-in.
          </EmptyState>
        }
        footer={table.rows.length > 0 ? `Showing ${formatCount(table.rows.length)} ${table.rows.length === 1 ? 'checklist' : 'checklists'}` : undefined}
      />
      <ChecklistDrawer id={openId} onClose={() => setOpenId(null)} />
    </>
  );
}

function ChecklistDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const query = useChecklist(id);
  const c = query.data;
  const [enrollmentId, setEnrollmentId] = useState<string | null>(null);
  const today = todayInIndia();
  return (
    <SidePanel
      open={id !== null}
      onClose={onClose}
      title={c?.enrollment?.student?.displayName ?? 'Checklist'}
      subtitle={c ? `${c.name} · ${c.enrollment?.product?.name ?? ''}` : undefined}
      actions={
        c?.enrollment ? (
          <Button size="sm" icon="school" onClick={() => setEnrollmentId(c.enrollment!.id)}>
            Enrollment
          </Button>
        ) : null
      }
    >
      {query.isPending && id ? <Spinner label="Loading the checklist" /> : null}
      {query.isError ? <ErrorAlert error={query.error} /> : null}
      {c ? (
        <div className="stack gap-16">
          <Meter value={c.itemsDone} max={c.itemsTotal} label={`${c.itemsDone} of ${c.itemsTotal} done${c.items.some((i) => i.status === 'pending' && i.dueOn && i.dueOn < today) ? ' · some overdue' : ''}`} tone={c.status === 'done' ? 'done' : undefined} />
          <ChecklistItems checklistId={c.id} items={c.items} canManage={c.can.manage} />
        </div>
      ) : null}
      <EnrollmentDrawer id={enrollmentId} onClose={() => setEnrollmentId(null)} />
    </SidePanel>
  );
}
