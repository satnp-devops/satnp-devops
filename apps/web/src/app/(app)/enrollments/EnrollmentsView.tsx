'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { DataTable, FilterBar, Masked, Mono, RelativeTime, StatusPill, infiniteRows, type Column } from '@/components/crm';
import { Guard } from '@/components/Guard';
import { Button, EmptyState } from '@/components/ui';
import { Cell, Meter, Stat, moneyText } from '@/components/delivery/Bits';
import { EnrollmentDrawer } from '@/components/delivery/EnrollmentDrawer';
import { formatCount } from '@/lib/crm/format';
import { ACCESS_STATUS, ENROLLMENT_STATUS, SEAT_STATUS, dateRange } from '@/lib/delivery/format';
import { useEnrollmentCounts, useEnrollments } from '@/lib/delivery/queries';
import type { Enrollment, EnrollmentStatus } from '@/lib/delivery/types';
import { useSession } from '@/lib/session';

export function EnrollmentsView() {
  return (
    <Guard anyOf={['enrollments.view']} anywhere>
      <Enrollments />
    </Guard>
  );
}

const STATUS_CHIPS = (Object.keys(ENROLLMENT_STATUS) as EnrollmentStatus[]).map((value) => ({ value, label: ENROLLMENT_STATUS[value].label }));

const COLUMNS: Column<Enrollment>[] = [
  {
    id: 'student',
    header: 'Student',
    card: 'title',
    cell: (e) => (
      <Cell
        main={e.student?.displayName ?? 'Student'}
        sub={
          e.payer?.primaryPhone || e.student?.primaryPhone ? (
            (e.payer ?? e.student)!.piiMasked ? (
              <Masked value={(e.payer?.primaryPhone ?? e.student?.primaryPhone)!} kind="phone" label="Phone" />
            ) : (
              (e.payer?.primaryPhone ?? e.student?.primaryPhone)
            )
          ) : e.payer ? (
            `Parent: ${e.payer.displayName}`
          ) : null
        }
      />
    ),
  },
  { id: 'ref', header: 'Ref', width: 110, hideBelow: 'md', cell: (e) => <Mono>{e.ref}</Mono> },
  {
    id: 'batch',
    header: 'Programme and batch',
    cell: (e) => (
      <Cell
        main={e.product?.name ?? 'Programme'}
        sub={e.batch ? `${e.batch.name} · ${dateRange(e.batch.startsOn, e.batch.endsOn)}` : e.waitlist ? `Waiting for ${e.waitlist.batch?.name ?? 'a batch'}` : 'No batch yet'}
      />
    ),
  },
  {
    id: 'status',
    header: 'Status',
    width: 190,
    cell: (e) => (
      <div className="row gap-4">
        <StatusPill tone={ENROLLMENT_STATUS[e.status].tone}>{ENROLLMENT_STATUS[e.status].label}</StatusPill>
        {['active', 'paused'].includes(e.status) && e.seatStatus !== 'seated' ? (
          <StatusPill tone={SEAT_STATUS[e.seatStatus].tone}>{e.waitlist ? `Waitlist #${e.waitlist.position}` : SEAT_STATUS[e.seatStatus].label}</StatusPill>
        ) : null}
      </div>
    ),
  },
  {
    id: 'onboarding',
    header: 'Onboarding',
    width: 140,
    hideBelow: 'lg',
    cell: (e) =>
      e.checklist ? <Meter value={e.checklist.itemsDone} max={e.checklist.itemsTotal} label={`${e.checklist.itemsDone} of ${e.checklist.itemsTotal}`} tone={e.checklist.status === 'done' ? 'done' : undefined} /> : <span className="muted">—</span>,
  },
  { id: 'access', header: 'Access', width: 120, hideBelow: 'lg', cell: (e) => <StatusPill tone={ACCESS_STATUS[e.accessStatus].tone}>{ACCESS_STATUS[e.accessStatus].label}</StatusPill> },
  {
    id: 'paid',
    header: 'Paid',
    width: 130,
    align: 'end',
    hideBelow: 'md',
    cell: (e) => <Cell main={moneyText(e.paid)} sub={e.fee ? `of ${moneyText(e.fee)}` : undefined} />,
  },
  { id: 'owner', header: 'Owner', width: 140, hideBelow: 'lg', cell: (e) => e.owner?.name ?? <span className="muted">No owner</span> },
  { id: 'enrolled', header: 'Enrolled', width: 110, hideBelow: 'md', cell: (e) => <RelativeTime value={e.enrolledAt} /> },
];

function Enrollments() {
  const { scope } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const openId = params.get('enrollment');
  const [q, setQ] = useState('');
  const [statuses, setStatuses] = useState<string[]>(['active', 'paused']);
  const [waitlisted, setWaitlisted] = useState(false);
  const [mine, setMine] = useState(false);
  const filters = { q: q.trim() || undefined, status: statuses.join(',') || undefined, seatStatus: waitlisted ? 'waitlisted' : undefined, owner: mine ? 'me' : undefined };
  const list = useEnrollments(scope.id, filters);
  const counts = useEnrollmentCounts(scope.id);
  const table = infiniteRows(list);
  const filtered = Boolean(filters.q || waitlisted || mine || statuses.join() !== 'active,paused');
  const open = (id: string | null) => router.replace(id ? `${pathname}?enrollment=${id}` : pathname, { scroll: false });
  const clear = () => {
    setQ('');
    setStatuses(['active', 'paused']);
    setWaitlisted(false);
    setMine(false);
  };

  return (
    <>
      {counts.data ? (
        <div className="delivery-stats">
          <Stat label="Active" value={formatCount(counts.data.active)} />
          <Stat label="Waitlisted" value={formatCount(counts.data.waitlisted)} tone={counts.data.waitlisted > 0 ? 'warning' : undefined} />
          <Stat label="Paused" value={formatCount(counts.data.paused)} />
          <Stat label="Withdrawn" value={formatCount(counts.data.withdrawn)} />
          <Stat label="Completed" value={formatCount(counts.data.completed)} />
        </div>
      ) : null}
      <DataTable
        {...table}
        label="Enrollments"
        columns={COLUMNS}
        rowId={(e) => e.id}
        rowLabel={(e) => `${e.student?.displayName ?? 'Student'}, ${e.ref}`}
        onRowActivate={(e) => open(e.id)}
        activeRowId={openId}
        toolbar={
          <FilterBar
            search={{ value: q, onChange: setQ, label: 'Search enrollments', placeholder: 'Student name or ref' }}
            chips={[{ label: 'Status', options: STATUS_CHIPS, selected: statuses, onChange: setStatuses }]}
            extraActiveCount={(waitlisted ? 1 : 0) + (mine ? 1 : 0)}
            onClear={clear}
          >
            <label className="check">
              <input type="checkbox" checked={waitlisted} onChange={(event) => setWaitlisted(event.target.checked)} />
              Waitlisted
            </label>
            <label className="check">
              <input type="checkbox" checked={mine} onChange={(event) => setMine(event.target.checked)} />
              Mine
            </label>
          </FilterBar>
        }
        empty={
          filtered ? (
            <EmptyState icon="search" title="No enrollments match these filters" action={<Button onClick={clear}>Clear filters</Button>}>
              Try another status or search.
            </EmptyState>
          ) : (
            <EmptyState icon="school" title="No enrollments yet">
              Students appear here when a family pays for a programme or buys it on the website checkout.
            </EmptyState>
          )
        }
        footer={table.rows.length > 0 ? `Showing ${formatCount(table.rows.length)} ${table.rows.length === 1 ? 'enrollment' : 'enrollments'}` : undefined}
      />
      <EnrollmentDrawer id={openId} onClose={() => open(null)} />
    </>
  );
}
