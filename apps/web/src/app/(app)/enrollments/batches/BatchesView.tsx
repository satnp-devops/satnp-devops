'use client';

import { useMemo, useState } from 'react';
import { DataTable, FilterBar, KeyValue, Mono, RelativeTime, Section, SidePanel, StatusPill, infiniteRows, type Column } from '@/components/crm';
import { Dialog, DialogBody, DialogFooter } from '@/components/dialog';
import { Guard } from '@/components/Guard';
import { Button, EmptyState, ErrorAlert, Field, Spinner } from '@/components/ui';
import { Cell, Meter, moneyText } from '@/components/delivery/Bits';
import { EnrollmentDrawer } from '@/components/delivery/EnrollmentDrawer';
import { fieldErrorsOf, formErrorOf } from '@/lib/api';
import { formatCount, toMajorUnits, toMinorUnits } from '@/lib/crm/format';
import { BATCH_MODES, BATCH_STATUS, ENROLLMENT_STATUS, dateRange, scheduleLabel } from '@/lib/delivery/format';
import { useBatch, useBatches, useEnrollments, useProgrammes, useSaveBatch, useWaitlist } from '@/lib/delivery/queries';
import type { Batch, BatchInput, BatchMode, BatchStatus, RefundUnit, Weekday } from '@/lib/delivery/types';
import { useSession } from '@/lib/session';
import { trailOf } from '@/lib/tree';
import type { OrgUnit } from '@/lib/types';

export function BatchesView() {
  return (
    <Guard anyOf={['enrollments.view']} anywhere>
      <Batches />
    </Guard>
  );
}

const STATUS_CHIPS = (Object.keys(BATCH_STATUS) as BatchStatus[]).map((value) => ({ value, label: BATCH_STATUS[value].label }));

const COLUMNS: Column<Batch>[] = [
  {
    id: 'name',
    header: 'Batch',
    card: 'title',
    cell: (b) => <Cell main={b.name} sub={b.code ? <Mono>{b.code}</Mono> : (b.product?.name ?? null)} />,
  },
  { id: 'programme', header: 'Programme', hideBelow: 'md', cell: (b) => <Cell main={b.product?.name ?? ''} sub={`${BATCH_MODES[b.mode]}${b.location ? ` · ${b.location}` : ''}`} /> },
  { id: 'dates', header: 'Runs', width: 200, cell: (b) => <Cell main={dateRange(b.startsOn, b.endsOn)} sub={scheduleLabel(b.schedule)} /> },
  {
    id: 'seats',
    header: 'Seats',
    width: 150,
    cell: (b) => (
      <Meter
        value={b.seatsTaken}
        max={b.capacity}
        tone={b.seatsLeft === 0 ? 'full' : undefined}
        label={`${b.seatsTaken} of ${b.capacity}${b.waitlistCount ? ` · ${b.waitlistCount} waiting` : ''}`}
      />
    ),
  },
  { id: 'fee', header: 'Fee', width: 120, align: 'end', hideBelow: 'md', cell: (b) => (b.fee ? moneyText(b.fee) : <span className="muted">—</span>) },
  {
    id: 'status',
    header: 'Status',
    width: 160,
    cell: (b) => (
      <div className="row gap-4">
        <StatusPill tone={BATCH_STATUS[b.status].tone}>{BATCH_STATUS[b.status].label}</StatusPill>
        {b.checkoutEnabled ? (
          <StatusPill tone="accent" icon="cart" title="Sold on the website checkout">
            Online sale
          </StatusPill>
        ) : null}
      </div>
    ),
  },
];

/** The company a unit belongs to (itself when it is one). */
export function companyOfUnit(unit: OrgUnit | undefined, byId: ReadonlyMap<string, OrgUnit>): OrgUnit | null {
  if (!unit) return null;
  return trailOf(unit, byId).find((u) => u.type === 'company') ?? null;
}

function Batches() {
  const session = useSession();
  const [q, setQ] = useState('');
  const [statuses, setStatuses] = useState<string[]>(['planned', 'open']);
  const [productId, setProductId] = useState('');
  const programmes = useProgrammes(session.scope.id);
  const filters = { q: q.trim() || undefined, status: statuses.join(',') || undefined, productId: productId || undefined };
  const list = useBatches(session.scope.id, filters);
  const table = infiniteRows(list);
  const [openId, setOpenId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Batch | 'new' | null>(null);
  const canCreate = session.workUnits.some((u) => session.can('enrollments.manage_batches', u) && companyOfUnit(u, session.unitsById));
  const clear = () => {
    setQ('');
    setStatuses(['planned', 'open']);
    setProductId('');
  };

  return (
    <>
      <DataTable
        {...table}
        label="Batches"
        columns={COLUMNS}
        rowId={(b) => b.id}
        rowLabel={(b) => b.name}
        onRowActivate={(b) => setOpenId(b.id)}
        activeRowId={openId}
        toolbar={
          <FilterBar
            search={{ value: q, onChange: setQ, label: 'Search batches', placeholder: 'Batch name or code' }}
            chips={[{ label: 'Status', options: STATUS_CHIPS, selected: statuses, onChange: setStatuses }]}
            extraActiveCount={productId ? 1 : 0}
            onClear={clear}
            end={
              canCreate ? (
                <Button size="sm" variant="primary" icon="plus" onClick={() => setEditing('new')}>
                  New batch
                </Button>
              ) : null
            }
          >
            <select className="select delivery-filter-select" aria-label="Programme" value={productId} onChange={(event) => setProductId(event.target.value)}>
              <option value="">All programmes</option>
              {(programmes.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </FilterBar>
        }
        empty={
          <EmptyState icon="calendar" title="No batches here" action={canCreate ? <Button onClick={() => setEditing('new')}>Create a batch</Button> : undefined}>
            Batches give programmes their dates, timetable, seats and waitlist.
          </EmptyState>
        }
        footer={table.rows.length > 0 ? `Showing ${formatCount(table.rows.length)} ${table.rows.length === 1 ? 'batch' : 'batches'}` : undefined}
      />
      <BatchDrawer id={openId} onClose={() => setOpenId(null)} onEdit={(b) => setEditing(b)} />
      {editing ? <BatchDialog batch={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={(b) => setOpenId(b.id)} /> : null}
    </>
  );
}

function BatchDrawer({ id, onClose, onEdit }: { id: string | null; onClose: () => void; onEdit: (b: Batch) => void }) {
  const batch = useBatch(id);
  const b = batch.data;
  const roster = useEnrollments(b?.unit?.id ?? '', { batchId: id ?? undefined, status: 'active,paused' }, Boolean(b?.unit));
  const waitlist = useWaitlist(b && b.waitlistCount > 0 ? b.id : null);
  const [enrollmentId, setEnrollmentId] = useState<string | null>(null);
  const seated = (roster.data?.pages.flatMap((p) => p.data) ?? []).filter((e) => e.batch?.id === id);
  return (
    <SidePanel
      open={id !== null}
      onClose={onClose}
      size="lg"
      title={b?.name ?? 'Batch'}
      subtitle={b ? `${b.product?.name ?? ''} · ${dateRange(b.startsOn, b.endsOn)}` : undefined}
      actions={
        b?.can.manage ? (
          <Button size="sm" icon="edit" onClick={() => onEdit(b)}>
            Edit
          </Button>
        ) : null
      }
    >
      {batch.isPending && id ? <Spinner label="Loading the batch" /> : null}
      {batch.isError ? <ErrorAlert error={batch.error} /> : null}
      {b ? (
        <div className="stack gap-20">
          <Meter value={b.seatsTaken} max={b.capacity} tone={b.seatsLeft === 0 ? 'full' : undefined} label={`${b.seatsTaken} of ${b.capacity} seats taken · ${b.seatsLeft} left`} />
          <KeyValue
            items={[
              { label: 'Status', value: <StatusPill tone={BATCH_STATUS[b.status].tone}>{BATCH_STATUS[b.status].label}</StatusPill> },
              { label: 'Timetable', value: scheduleLabel(b.schedule) || null },
              { label: 'Mode', value: `${BATCH_MODES[b.mode]}${b.location ? ` · ${b.location}` : ''}` },
              { label: 'Teacher', value: b.teacher?.name ?? b.teacherName },
              { label: 'Fee', value: b.fee ? moneyText(b.fee) : null },
              { label: 'Website checkout', value: b.checkoutEnabled ? 'On sale' : 'Not sold online' },
              { label: 'Waitlist', value: b.waitlistEnabled ? `${b.waitlistCount} waiting${b.waitlistLimit ? ` (up to ${b.waitlistLimit})` : ''}` : 'Off' },
              { label: 'Refunds by', value: b.refundUnit === 'classes' ? `Classes (${b.totalClasses ?? '?'} in all)` : 'Days of the course' },
              { label: 'Code', value: b.code ? <Mono>{b.code}</Mono> : null },
              { label: 'Unit', value: b.unit?.name ?? null },
            ]}
          />
          <Section title="Students" count={seated.length} level={3}>
            {roster.isPending ? <Spinner /> : null}
            {seated.length === 0 && !roster.isPending ? <p className="muted small">No students in this batch yet.</p> : null}
            <div className="delivery-panel">
              {seated.map((e) => (
                <button key={e.id} type="button" className="delivery-panel__row" onClick={() => setEnrollmentId(e.id)}>
                  <Cell main={e.student?.displayName ?? 'Student'} sub={<Mono>{e.ref}</Mono>} />
                  <StatusPill tone={ENROLLMENT_STATUS[e.status].tone}>{ENROLLMENT_STATUS[e.status].label}</StatusPill>
                </button>
              ))}
            </div>
          </Section>
          {b.waitlistCount > 0 ? (
            <Section title="Waitlist" count={b.waitlistCount} level={3} description="First come, first served: the next free seat goes to #1.">
              {waitlist.isPending ? <Spinner /> : null}
              {waitlist.isError ? <ErrorAlert error={waitlist.error} /> : null}
              <div className="delivery-panel">
                {(waitlist.data ?? []).map((w) => (
                  <button key={w.id} type="button" className="delivery-panel__row" onClick={() => setEnrollmentId(w.enrollment.id)}>
                    <Cell main={`#${w.position} ${w.enrollment.student?.displayName ?? 'Student'}`} sub={<RelativeTime value={w.queuedAt} sans />} />
                    <Mono>{w.enrollment.ref}</Mono>
                  </button>
                ))}
                {waitlist.data && waitlist.data.length < b.waitlistCount ? (
                  <p className="muted small">{b.waitlistCount - waitlist.data.length} more waiting in teams you don&apos;t see.</p>
                ) : null}
              </div>
            </Section>
          ) : null}
        </div>
      ) : null}
      <EnrollmentDrawer id={enrollmentId} onClose={() => setEnrollmentId(null)} />
    </SidePanel>
  );
}

const WEEKDAYS: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_LABEL: Record<Weekday, string> = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };

function BatchDialog({ batch, onClose, onSaved }: { batch: Batch | null; onClose: () => void; onSaved: (b: Batch) => void }) {
  const session = useSession();
  const save = useSaveBatch();
  const units = useMemo(
    () => session.workUnits.filter((u) => u.status === 'active' && session.can('enrollments.manage_batches', u) && companyOfUnit(u, session.unitsById)),
    [session],
  );
  const programmes = useProgrammes(session.scope.id);
  const [unitId, setUnitId] = useState(batch?.unit?.id ?? units[0]?.id ?? '');
  const company = companyOfUnit(session.unitsById.get(unitId), session.unitsById);
  const [productId, setProductId] = useState(batch?.product?.id ?? '');
  const [name, setName] = useState(batch?.name ?? '');
  const [code, setCode] = useState(batch?.code ?? '');
  const [mode, setMode] = useState<BatchMode>(batch?.mode ?? 'online');
  const [startsOn, setStartsOn] = useState(batch?.startsOn ?? '');
  const [endsOn, setEndsOn] = useState(batch?.endsOn ?? '');
  const [days, setDays] = useState<Weekday[]>(batch?.schedule.days ?? []);
  const [startTime, setStartTime] = useState(batch?.schedule.startTime ?? '');
  const [endTime, setEndTime] = useState(batch?.schedule.endTime ?? '');
  const [capacity, setCapacity] = useState(String(batch?.capacity ?? 25));
  const [waitlistEnabled, setWaitlistEnabled] = useState(batch?.waitlistEnabled ?? true);
  const [waitlistLimit, setWaitlistLimit] = useState(batch?.waitlistLimit ? String(batch.waitlistLimit) : '');
  const currency = batch?.fee?.currency ?? 'INR';
  const [fee, setFee] = useState(batch?.fee ? String(toMajorUnits(batch.fee.valueMinor, batch.fee.currency)) : '');
  const [checkoutEnabled, setCheckoutEnabled] = useState(batch?.checkoutEnabled ?? false);
  const [location, setLocation] = useState(batch?.location ?? '');
  const [teacherName, setTeacherName] = useState(batch?.teacherName ?? '');
  const [status, setStatus] = useState<BatchStatus>(batch?.status ?? 'open');
  const [refundUnit, setRefundUnit] = useState<RefundUnit>(batch?.refundUnit ?? 'days');
  const [totalClasses, setTotalClasses] = useState(batch?.totalClasses ? String(batch.totalClasses) : '');
  const errors = fieldErrorsOf(save.error);
  const shown = ['unitId', 'productId', 'name', 'code', 'mode', 'startsOn', 'endsOn', 'capacity', 'waitlistLimit', 'fee', 'fee.valueMinor', 'location', 'status', 'refundUnit', 'totalClasses', 'schedule.endTime'];
  const options = (programmes.data ?? []).filter((p) => !company || p.companyId === company.id);

  const submit = () => {
    const input: BatchInput = {
      name: name.trim(),
      code: code.trim() || null,
      mode,
      startsOn,
      endsOn,
      schedule: { ...(days.length ? { days } : {}), ...(startTime ? { startTime } : {}), ...(endTime ? { endTime } : {}), timeZone: 'Asia/Kolkata' },
      capacity: Number(capacity),
      waitlistEnabled,
      waitlistLimit: waitlistLimit ? Number(waitlistLimit) : null,
      fee: fee.trim() ? { valueMinor: toMinorUnits(Number(fee), currency), currency } : null,
      checkoutEnabled,
      location: location.trim() || null,
      teacherName: teacherName.trim() || null,
      status,
      refundUnit,
      totalClasses: totalClasses ? Number(totalClasses) : null,
    };
    if (!batch) Object.assign(input, { unitId, productId });
    save.mutate({ id: batch?.id ?? null, input }, { onSuccess: (saved) => (onSaved(saved), onClose()) });
  };

  return (
    <Dialog open onClose={onClose} size="lg" title={batch ? `Edit ${batch.name}` : 'New batch'}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <DialogBody>
          <div className="stack gap-12">
            {formErrorOf(save.error, shown) ? <ErrorAlert error={save.error} /> : null}
            <div className="form-grid">
              {!batch ? (
                <>
                  <Field label="Belongs to" error={errors.unitId}>
                    {(control) => (
                      <select {...control} className="select" required value={unitId} onChange={(event) => setUnitId(event.target.value)}>
                        {units.map((u) => (
                          <option key={u.id} value={u.id}>
                            {trailOf(u, session.unitsById).map((x) => x.name).slice(1).join(' › ') || u.name}
                          </option>
                        ))}
                      </select>
                    )}
                  </Field>
                  <Field label="Programme" error={errors.productId}>
                    {(control) => (
                      <select {...control} className="select" required value={productId} onChange={(event) => setProductId(event.target.value)}>
                        <option value="">Pick a programme</option>
                        {options.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    )}
                  </Field>
                </>
              ) : null}
              <Field label="Name" error={errors.name}>
                {(control) => <input {...control} className="input" required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} placeholder="SAT Weekend, Jan 2027" />}
              </Field>
              <Field label="Code" optional error={errors.code}>
                {(control) => <input {...control} className="input input--code" maxLength={40} value={code} onChange={(event) => setCode(event.target.value)} placeholder="SAT-JAN27-WE" />}
              </Field>
              <Field label="Starts on" error={errors.startsOn}>
                {(control) => <input {...control} className="input" type="date" required value={startsOn} onChange={(event) => setStartsOn(event.target.value)} />}
              </Field>
              <Field label="Ends on" error={errors.endsOn}>
                {(control) => <input {...control} className="input" type="date" required min={startsOn || undefined} value={endsOn} onChange={(event) => setEndsOn(event.target.value)} />}
              </Field>
              <Field label="Mode" error={errors.mode}>
                {(control) => (
                  <select {...control} className="select" value={mode} onChange={(event) => setMode(event.target.value as BatchMode)}>
                    {(Object.keys(BATCH_MODES) as BatchMode[]).map((m) => (
                      <option key={m} value={m}>
                        {BATCH_MODES[m]}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field label="Where" optional error={errors.location}>
                {(control) => <input {...control} className="input" maxLength={200} value={location} onChange={(event) => setLocation(event.target.value)} placeholder="Zoom, Pune centre room 2" />}
              </Field>
            </div>
            <fieldset className="stack gap-8" style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="small muted">Timetable</legend>
              <div className="row gap-6">
                {WEEKDAYS.map((d) => (
                  <label key={d} className="chip-toggle">
                    <input type="checkbox" checked={days.includes(d)} onChange={(event) => setDays(event.target.checked ? WEEKDAYS.filter((x) => x === d || days.includes(x)) : days.filter((x) => x !== d))} />
                    {DAY_LABEL[d]}
                  </label>
                ))}
              </div>
              <div className="form-grid">
                <Field label="From" optional>
                  {(control) => <input {...control} className="input" type="time" value={startTime} onChange={(event) => setStartTime(event.target.value)} />}
                </Field>
                <Field label="To" optional error={errors['schedule.endTime']}>
                  {(control) => <input {...control} className="input" type="time" value={endTime} onChange={(event) => setEndTime(event.target.value)} />}
                </Field>
              </div>
            </fieldset>
            <div className="form-grid">
              <Field label="Seats" error={errors.capacity} hint={batch ? `${batch.seatsTaken} taken` : undefined}>
                {(control) => <input {...control} className="input" type="number" required min={Math.max(1, batch?.seatsTaken ?? 1)} max={100000} value={capacity} onChange={(event) => setCapacity(event.target.value)} />}
              </Field>
              <Field label={`Fee (${currency})`} optional error={errors['fee.valueMinor'] ?? errors.fee}>
                {(control) => <input {...control} className="input" inputMode="decimal" value={fee} onChange={(event) => setFee(event.target.value.replace(/[^\d.]/g, ''))} placeholder="45000" />}
              </Field>
              <Field label="Status" error={errors.status}>
                {(control) => (
                  <select {...control} className="select" value={status} onChange={(event) => setStatus(event.target.value as BatchStatus)}>
                    {(Object.keys(BATCH_STATUS) as BatchStatus[]).map((s) => (
                      <option key={s} value={s}>
                        {BATCH_STATUS[s].label}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field label="Teacher" optional>
                {(control) => <input {...control} className="input" maxLength={120} value={teacherName} onChange={(event) => setTeacherName(event.target.value)} />}
              </Field>
            </div>
            <div className="row gap-16">
              <label className="check">
                <input type="checkbox" checked={waitlistEnabled} onChange={(event) => setWaitlistEnabled(event.target.checked)} />
                Keep a waitlist when full
              </label>
              <label className="check">
                <input type="checkbox" checked={checkoutEnabled} onChange={(event) => setCheckoutEnabled(event.target.checked)} />
                Sell on the website checkout
              </label>
            </div>
            <div className="form-grid">
              {waitlistEnabled ? (
                <Field label="Waitlist limit" optional error={errors.waitlistLimit}>
                  {(control) => <input {...control} className="input" type="number" min={1} value={waitlistLimit} onChange={(event) => setWaitlistLimit(event.target.value)} />}
                </Field>
              ) : null}
              <Field label="Refund a leaver by" error={errors.refundUnit} hint="Pro rata, for the part of the course not used.">
                {(control) => (
                  <select {...control} className="select" value={refundUnit} onChange={(event) => setRefundUnit(event.target.value as RefundUnit)}>
                    <option value="days">Days of the course</option>
                    <option value="classes">Classes attended</option>
                  </select>
                )}
              </Field>
              {refundUnit === 'classes' ? (
                <Field label="Classes in all" error={errors.totalClasses}>
                  {(control) => <input {...control} className="input" type="number" min={1} required value={totalClasses} onChange={(event) => setTotalClasses(event.target.value)} />}
                </Field>
              ) : null}
            </div>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>
            {batch ? 'Save' : 'Create batch'}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
