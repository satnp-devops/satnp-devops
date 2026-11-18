'use client';

import { useState } from 'react';
import { Section, StatusPill } from '@/components/crm';
import { Dialog, DialogBody, DialogFooter } from '@/components/dialog';
import { Alert, Button, ErrorAlert, Field, Spinner } from '@/components/ui';
import { fieldErrorsOf, formErrorOf } from '@/lib/api';
import { toMinorUnits } from '@/lib/crm/format';
import { ENROLLMENT_STATUS, SEAT_STATUS, dateRange } from '@/lib/delivery/format';
import { useBatches, useCreateEnrollment, useEnrollments, useProgrammes } from '@/lib/delivery/queries';
import { useSession } from '@/lib/session';
import { Meter } from './Bits';
import { EnrollmentDrawer } from './EnrollmentDrawer';
import './delivery.css';

export interface EnrollmentPanelProps {
  dealId: string;
  /** The deal's unit (enrollments made from a deal belong to it). */
  unitId: string;
  companyId: string;
  /** People on the deal who can be enrolled (role student). */
  students?: ReadonlyArray<{ id: string; displayName: string }>;
  /** The deal's programme, to preselect. */
  productId?: string | null;
}

/**
 * Enrollments of a deal, for the deal profile (/leads/[id]). Payments and the website checkout
 * create enrollments by themselves; people with enrollments.manage can also enroll by hand here.
 *   <EnrollmentPanel dealId={deal.id} unitId={deal.unit.id} companyId={deal.companyId} students={students} productId={deal.product?.id} />
 */
export function EnrollmentPanel({ dealId, unitId, companyId, students = [], productId = null }: EnrollmentPanelProps) {
  const session = useSession();
  const unit = session.unitsById.get(unitId);
  const canView = unit ? session.canAnywhere('enrollments.view', unit) : false;
  const canManage = unit ? session.can('enrollments.manage', unit) : false;
  const list = useEnrollments(unitId, { dealId }, canView);
  const [openId, setOpenId] = useState<string | null>(null);
  const [enrolling, setEnrolling] = useState(false);
  if (!canView) return null;
  const rows = list.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <Section
      title="Enrollment"
      count={rows.length || undefined}
      level={3}
      actions={
        canManage && students.length > 0 ? (
          <Button size="sm" icon="plus" onClick={() => setEnrolling(true)}>
            Enroll
          </Button>
        ) : null
      }
    >
      <div className="delivery-panel">
        {list.isPending ? <Spinner label="Loading enrollments" /> : null}
        {list.isError ? <ErrorAlert error={list.error} /> : null}
        {!list.isPending && !list.isError && rows.length === 0 ? (
          <p className="muted small">Not enrolled yet. The first payment enrolls the student automatically.</p>
        ) : null}
        {rows.map((e) => (
          <button key={e.id} type="button" className="delivery-panel__row" onClick={() => setOpenId(e.id)}>
            <span className="delivery-cell">
              <span className="delivery-cell__main">
                {e.student?.displayName ?? 'Student'} · <span className="crm-mono">{e.ref}</span>
              </span>
              <span className="delivery-cell__sub">
                {e.batch ? `${e.batch.name}, ${dateRange(e.batch.startsOn, e.batch.endsOn)}` : e.waitlist ? `Waitlist #${e.waitlist.position} for ${e.waitlist.batch?.name ?? 'a batch'}` : (e.product?.name ?? '')}
              </span>
            </span>
            <span className="row gap-6">
              <StatusPill tone={ENROLLMENT_STATUS[e.status].tone}>{ENROLLMENT_STATUS[e.status].label}</StatusPill>
              {e.status === 'active' && e.seatStatus !== 'seated' ? <StatusPill tone={SEAT_STATUS[e.seatStatus].tone}>{SEAT_STATUS[e.seatStatus].label}</StatusPill> : null}
              {e.checklist ? <Meter value={e.checklist.itemsDone} max={e.checklist.itemsTotal} label={`Onboarding ${e.checklist.itemsDone}/${e.checklist.itemsTotal}`} tone={e.checklist.status === 'done' ? 'done' : undefined} /> : null}
            </span>
          </button>
        ))}
      </div>
      <EnrollmentDrawer id={openId} onClose={() => setOpenId(null)} />
      {enrolling ? (
        <EnrollDialog
          open
          onClose={() => setEnrolling(false)}
          onCreated={(id) => {
            setEnrolling(false);
            setOpenId(id);
          }}
          dealId={dealId}
          unitId={unitId}
          companyId={companyId}
          students={students}
          productId={productId}
        />
      ) : null}
    </Section>
  );
}

export function EnrollDialog({
  open,
  onClose,
  onCreated,
  dealId,
  unitId,
  companyId,
  students,
  productId,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
  dealId?: string;
  unitId: string;
  companyId: string;
  students: ReadonlyArray<{ id: string; displayName: string }>;
  productId?: string | null;
}) {
  const programmes = useProgrammes(unitId, open);
  const create = useCreateEnrollment();
  const [studentId, setStudentId] = useState(students[0]?.id ?? '');
  const [product, setProduct] = useState(productId ?? '');
  const [batchId, setBatchId] = useState('');
  const [fee, setFee] = useState('');
  const batches = useBatches(unitId, { productId: product, joinable: true }, open && Boolean(product));
  const batchRows = batches.data?.pages.flatMap((p) => p.data) ?? [];
  const chosen = batchRows.find((b) => b.id === batchId);
  const options = (programmes.data ?? []).filter((p) => p.companyId === companyId);
  const errors = fieldErrorsOf(create.error);
  const currency = chosen?.fee?.currency ?? 'INR';

  return (
    <Dialog open={open} onClose={onClose} title="Enroll a student" description="Takes a seat in the batch (or a place on its waitlist) and starts the onboarding checklist.">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const feeMinor = fee.trim() === '' ? null : toMinorUnits(Number(fee), currency);
          create.mutate(
            {
              unitId,
              dealId: dealId ?? null,
              studentContactId: studentId,
              productId: product,
              batchId: batchId || null,
              joinWaitlist: true,
              ...(feeMinor !== null && Number.isFinite(feeMinor) ? { fee: { valueMinor: feeMinor, currency } } : {}),
            },
            { onSuccess: (enrollment) => onCreated(enrollment.id) },
          );
        }}
      >
        <DialogBody>
          <div className="stack gap-12">
            {formErrorOf(create.error, ['studentContactId', 'productId', 'batchId', 'fee.valueMinor']) ? <ErrorAlert error={create.error} /> : null}
            <Field label="Student" error={errors.studentContactId}>
              {(control) => (
                <select {...control} className="select" required value={studentId} onChange={(event) => setStudentId(event.target.value)}>
                  {students.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.displayName}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="Programme" error={errors.productId}>
              {(control) => (
                <select
                  {...control}
                  className="select"
                  required
                  value={product}
                  onChange={(event) => {
                    setProduct(event.target.value);
                    setBatchId('');
                  }}
                >
                  <option value="">{programmes.isPending ? 'Loading…' : 'Pick a programme'}</option>
                  {options.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="Batch" optional hint="Leave empty to pick one later." error={errors.batchId}>
              {(control) => (
                <select {...control} className="select" value={batchId} disabled={!product} onChange={(event) => setBatchId(event.target.value)}>
                  <option value="">No batch yet</option>
                  {batchRows.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name} · {dateRange(b.startsOn, b.endsOn)} · {b.seatsLeft > 0 ? `${b.seatsLeft} seats left` : `full, ${b.waitlistCount} waiting`}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            {chosen && chosen.seatsLeft === 0 ? <Alert tone="warning">This batch is full: the student joins its waitlist and gets the next free seat.</Alert> : null}
            <Field label={`Fee (${currency})`} optional hint={chosen?.fee ? 'Defaults to the batch fee.' : 'The agreed fee, for refunds.'} error={errors['fee.valueMinor']}>
              {(control) => <input {...control} className="input" inputMode="decimal" value={fee} onChange={(event) => setFee(event.target.value.replace(/[^\d.]/g, ''))} />}
            </Field>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={create.isPending} disabled={!studentId || !product}>
            Enroll
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
