'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { KeyValue, Masked, Mono, RelativeTime, Section, SidePanel, StatusPill } from '@/components/crm';
import { ConfirmDialog, Dialog, DialogBody, DialogFooter } from '@/components/dialog';
import { Alert, Button, ErrorAlert, Field, Spinner } from '@/components/ui';
import { fieldErrorsOf, formErrorOf } from '@/lib/api';
import { formatMoney } from '@/lib/crm/format';
import { ACCESS_STATUS, ENROLLMENT_STATUS, REFUND_STATUS, SEAT_STATUS, WITHDRAWAL_CHANNELS, dateLabel, dateRange, daysUntil, todayInIndia } from '@/lib/delivery/format';
import { useBatches, useEnrollment, useEnrollmentAction, useRefundPreview, useUpdateChecklistItem } from '@/lib/delivery/queries';
import type { AccessStatus, ChecklistItem, EnrollmentDetail, WithdrawalChannel } from '@/lib/delivery/types';
import { cx } from '@/components/ui';
import { Meter, moneyText } from './Bits';
import './delivery.css';

/** The enrollment side panel: details, refund, checklist and every action the user may take. */
export function EnrollmentDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const query = useEnrollment(id);
  const enrollment = query.data;
  const [dialog, setDialog] = useState<'batch' | 'pause' | 'withdraw' | 'complete' | null>(null);

  return (
    <SidePanel
      open={id !== null}
      onClose={onClose}
      size="lg"
      title={enrollment?.student?.displayName ?? 'Enrollment'}
      subtitle={enrollment ? `${enrollment.ref} · ${enrollment.product?.name ?? 'Programme'}` : undefined}
      footer={enrollment ? <Actions enrollment={enrollment} onOpen={setDialog} /> : null}
    >
      {query.isPending && id ? <Spinner label="Loading the enrollment" /> : null}
      {query.isError ? <ErrorAlert error={query.error} /> : null}
      {enrollment ? (
        <div className="stack gap-20">
          <div className="row gap-6">
            <StatusPill tone={ENROLLMENT_STATUS[enrollment.status].tone}>{ENROLLMENT_STATUS[enrollment.status].label}</StatusPill>
            <StatusPill tone={SEAT_STATUS[enrollment.seatStatus].tone}>
              {enrollment.waitlist ? `Waitlist #${enrollment.waitlist.position}` : SEAT_STATUS[enrollment.seatStatus].label}
            </StatusPill>
            <StatusPill tone={ACCESS_STATUS[enrollment.accessStatus].tone} title="Learning platform access">
              {ACCESS_STATUS[enrollment.accessStatus].label}
            </StatusPill>
          </div>
          <Details enrollment={enrollment} />
          {enrollment.withdrawal ? <WithdrawalSection enrollment={enrollment} /> : null}
          {enrollment.checklist ? <ChecklistSection enrollment={enrollment} /> : null}
          {enrollment.payments.length > 0 ? (
            <Section title="Payments" count={enrollment.payments.length} level={3}>
              <ul className="delivery-checklist">
                {enrollment.payments.map((p) => (
                  <li key={p.id} className="delivery-checklist__item" style={{ gridTemplateColumns: '1fr auto' }}>
                    <span className="delivery-checklist__title">{formatMoney(p.amount.valueMinor, p.amount.currency)}</span>
                    <RelativeTime value={p.paidAt} />
                    <span className="delivery-checklist__meta">
                      <Mono short>{p.paymentId}</Mono>
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}
          <MoveBatchDialog enrollment={enrollment} open={dialog === 'batch'} onClose={() => setDialog(null)} />
          <PauseDialog enrollment={enrollment} open={dialog === 'pause'} onClose={() => setDialog(null)} />
          <WithdrawDialog enrollment={enrollment} open={dialog === 'withdraw'} onClose={() => setDialog(null)} />
          <CompleteDialog enrollment={enrollment} open={dialog === 'complete'} onClose={() => setDialog(null)} />
        </div>
      ) : null}
    </SidePanel>
  );
}

function Actions({ enrollment, onOpen }: { enrollment: EnrollmentDetail; onOpen: (d: 'batch' | 'pause' | 'withdraw' | 'complete') => void }) {
  const action = useEnrollmentAction(enrollment.id);
  const { can } = enrollment;
  if (!can.changeBatch && !can.pause && !can.resume && !can.withdraw && !can.complete) return null;
  return (
    <div className="stack gap-8">
      {action.isError ? <ErrorAlert error={action.error} /> : null}
      <div className="row gap-8">
        {can.changeBatch ? (
          <Button size="sm" icon="move" onClick={() => onOpen('batch')}>
            {enrollment.batch || enrollment.waitlist ? 'Change batch' : 'Assign batch'}
          </Button>
        ) : null}
        {can.pause ? (
          <Button size="sm" icon="clock" onClick={() => onOpen('pause')}>
            Pause
          </Button>
        ) : null}
        {can.resume ? (
          <Button size="sm" icon="restore" loading={action.isPending} onClick={() => action.mutate({ kind: 'resume' })}>
            Resume
          </Button>
        ) : null}
        {can.complete ? (
          <Button size="sm" icon="check" onClick={() => onOpen('complete')}>
            Mark completed
          </Button>
        ) : null}
        {can.withdraw ? (
          <Button size="sm" variant="danger" icon="logout" onClick={() => onOpen('withdraw')}>
            Withdraw
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function Details({ enrollment }: { enrollment: EnrollmentDetail }) {
  const action = useEnrollmentAction(enrollment.id);
  const contact = (person: EnrollmentDetail['student']) =>
    person ? (
      <span className="stack gap-2">
        <span>{person.displayName}</span>
        {person.primaryPhone ? <span className="muted small">{person.piiMasked ? <Masked value={person.primaryPhone} kind="phone" label="Phone" /> : person.primaryPhone}</span> : null}
      </span>
    ) : null;
  return (
    <KeyValue
      items={[
        {
          label: 'Batch',
          value: enrollment.batch ? (
            <span className="stack gap-2">
              <span>{enrollment.batch.name}</span>
              <span className="muted small">{dateRange(enrollment.startsOn ?? enrollment.batch.startsOn, enrollment.endsOn ?? enrollment.batch.endsOn)}</span>
            </span>
          ) : enrollment.waitlist ? (
            `Waiting for ${enrollment.waitlist.batch?.name ?? 'a batch'} (#${enrollment.waitlist.position})`
          ) : (
            'Not assigned yet'
          ),
        },
        { label: 'Student', value: contact(enrollment.student) },
        { label: 'Paid by', value: contact(enrollment.payer) },
        { label: 'Deal', value: enrollment.deal ? <Link href={`/leads/${enrollment.deal.id}`}>{enrollment.deal.ref} · {enrollment.deal.title}</Link> : null },
        { label: 'Fee', value: enrollment.fee ? moneyText(enrollment.fee) : null },
        { label: 'Paid', value: moneyText(enrollment.paid) },
        { label: 'Owner', value: enrollment.owner?.name ?? null },
        { label: 'Enrolled', value: <RelativeTime value={enrollment.enrolledAt} /> },
        { label: 'Source', value: enrollment.source === 'checkout' ? 'Website checkout' : enrollment.source === 'payment' ? 'Payment' : 'Added by hand' },
        ...(enrollment.status === 'paused'
          ? [{ label: 'Paused', value: `${enrollment.resumeOn ? `Until ${dateLabel(enrollment.resumeOn)}` : 'No date to resume'}${enrollment.pauseReason ? ` · ${enrollment.pauseReason}` : ''}` }]
          : []),
        {
          label: 'Platform access',
          value: enrollment.can.manage && !['withdrawn', 'completed'].includes(enrollment.status) ? (
            <select
              className="select"
              aria-label="Platform access"
              value={enrollment.accessStatus}
              disabled={action.isPending}
              onChange={(event) => action.mutate({ kind: 'update', accessStatus: event.target.value as AccessStatus })}
            >
              {(Object.keys(ACCESS_STATUS) as AccessStatus[]).map((key) => (
                <option key={key} value={key}>
                  {ACCESS_STATUS[key].label}
                </option>
              ))}
            </select>
          ) : (
            ACCESS_STATUS[enrollment.accessStatus].label
          ),
        },
      ]}
    />
  );
}

function WithdrawalSection({ enrollment }: { enrollment: EnrollmentDetail }) {
  const w = enrollment.withdrawal!;
  const open = w.refundStatus === 'requested' || w.refundStatus === 'processing';
  const dueIn = daysUntil(w.refundDueAt.slice(0, 10));
  return (
    <Section title="Withdrawal and refund" level={3}>
      <div className="delivery-refund">
        <div className="row gap-8">
          <span className="delivery-refund__amount">{moneyText(w.refund)}</span>
          <StatusPill tone={REFUND_STATUS[w.refundStatus].tone}>{REFUND_STATUS[w.refundStatus].label}</StatusPill>
        </div>
        <span className="small">
          Asked on <RelativeTime value={w.receivedAt} sans /> by {WITHDRAWAL_CHANNELS[w.channel]}
          {w.reason ? ` · ${w.reason}` : ''}
        </span>
        {open ? (
          <span className={cx('small', dueIn < 2 && 'delivery-overdue')}>
            Due by {dateLabel(w.basis.dueOn ?? w.refundDueAt.slice(0, 10))} {dueIn < 0 ? `(${-dueIn} days late)` : `(${dueIn} days left)`}
          </span>
        ) : null}
        {w.basis.totalUnits ? (
          <span className="delivery-refund__basis">
            {w.basis.rule === 'cooling_off_full_refund'
              ? `Full refund: withdrew within ${w.basis.coolingOffDays} days of enrolling.`
              : `Used ${w.basis.usedUnits} of ${w.basis.totalUnits} ${w.basis.unit}; ${w.basis.remainingUnits} refunded pro rata.`}
          </span>
        ) : null}
      </div>
    </Section>
  );
}

function ChecklistSection({ enrollment }: { enrollment: EnrollmentDetail }) {
  const checklist = enrollment.checklist!;
  return (
    <Section title="Onboarding" level={3} actions={<Meter value={checklist.itemsDone} max={checklist.itemsTotal} label={`${checklist.itemsDone} of ${checklist.itemsTotal}`} tone={checklist.status === 'done' ? 'done' : undefined} />}>
      <ChecklistItems checklistId={checklist.id} items={enrollment.checklistItems} canManage={enrollment.can.manageChecklist} />
    </Section>
  );
}

/** Tick-off list shared by the enrollment panel and the onboarding page. */
export function ChecklistItems({ checklistId, items, canManage }: { checklistId: string; items: ChecklistItem[]; canManage: boolean }) {
  const update = useUpdateChecklistItem(checklistId);
  const today = todayInIndia();
  return (
    <>
      {update.isError ? <ErrorAlert error={update.error} /> : null}
      <ul className="delivery-checklist">
        {items.map((item) => (
          <li key={item.id} className={cx('delivery-checklist__item', `delivery-checklist__item--${item.status}`)}>
            <input
              type="checkbox"
              id={`item-${item.id}`}
              checked={item.status !== 'pending'}
              disabled={!canManage || update.isPending}
              onChange={(event) => update.mutate({ itemId: item.id, status: event.target.checked ? 'done' : 'pending' })}
            />
            <label htmlFor={`item-${item.id}`} className="delivery-checklist__title">
              {item.title}
            </label>
            {canManage && item.status === 'pending' ? (
              <Button size="sm" variant="ghost" onClick={() => update.mutate({ itemId: item.id, status: 'skipped' })}>
                Skip
              </Button>
            ) : (
              <span className="muted small">{item.status === 'skipped' ? 'Skipped' : ''}</span>
            )}
            <span className="delivery-checklist__meta">
              {item.owner ? <span>{item.owner.name}</span> : <span>No owner</span>}
              {item.dueOn ? (
                <span className={item.status === 'pending' && item.dueOn < today ? 'delivery-overdue' : undefined}>
                  {item.status === 'pending' && item.dueOn < today ? 'Overdue: ' : 'Due '}
                  {dateLabel(item.dueOn)}
                </span>
              ) : null}
              {item.completedAt ? (
                <span>
                  Done <RelativeTime value={item.completedAt} sans />
                  {item.completedBy ? ` by ${item.completedBy.name}` : ''}
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

// ---------- Dialogs ----------

function MoveBatchDialog({ enrollment, open, onClose }: { enrollment: EnrollmentDetail; open: boolean; onClose: () => void }) {
  const batches = useBatches(enrollment.unit?.id ?? enrollment.companyId, { productId: enrollment.product?.id, joinable: true }, open && Boolean(enrollment.product));
  const action = useEnrollmentAction(enrollment.id);
  const [batchId, setBatchId] = useState('');
  const [joinWaitlist, setJoinWaitlist] = useState(false);
  const rows = (batches.data?.pages.flatMap((p) => p.data) ?? []).filter((b) => b.id !== enrollment.batch?.id);
  const chosen = rows.find((b) => b.id === batchId);
  const errors = fieldErrorsOf(action.error);
  return (
    <Dialog open={open} onClose={onClose} title={enrollment.batch ? 'Change batch' : 'Assign a batch'} description={enrollment.product?.name}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!batchId) return;
          action.mutate({ kind: 'batch', batchId, joinWaitlist }, { onSuccess: onClose });
        }}
      >
        <DialogBody>
          <div className="stack gap-12">
            {formErrorOf(action.error, ['batchId']) ? <ErrorAlert error={action.error} /> : null}
            <Field label="Batch" error={errors.batchId}>
              {(control) => (
                <select {...control} className="select" required value={batchId} onChange={(event) => setBatchId(event.target.value)}>
                  <option value="">{batches.isPending ? 'Loading batches…' : 'Pick a batch'}</option>
                  {rows.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name} · {dateRange(b.startsOn, b.endsOn)} · {b.seatsLeft > 0 ? `${b.seatsLeft} seats left` : `full, ${b.waitlistCount} waiting`}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            {chosen && chosen.seatsLeft === 0 ? (
              chosen.waitlistEnabled ? (
                <label className="check">
                  <input type="checkbox" checked={joinWaitlist} onChange={(event) => setJoinWaitlist(event.target.checked)} />
                  This batch is full. Put the student on its waitlist instead (they give up their current seat and get the next free one here).
                </label>
              ) : (
                <Alert tone="warning">This batch is full and has no waitlist.</Alert>
              )
            ) : null}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={action.isPending} disabled={!batchId || (chosen?.seatsLeft === 0 && !joinWaitlist)}>
            {chosen?.seatsLeft === 0 ? 'Join the waitlist' : 'Move'}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

function PauseDialog({ enrollment, open, onClose }: { enrollment: EnrollmentDetail; open: boolean; onClose: () => void }) {
  const action = useEnrollmentAction(enrollment.id);
  const [resumeOn, setResumeOn] = useState('');
  const [reason, setReason] = useState('');
  const errors = fieldErrorsOf(action.error);
  return (
    <Dialog open={open} onClose={onClose} title="Pause the enrollment" description="The seat is kept and platform access is suspended until it resumes.">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          action.mutate({ kind: 'pause', resumeOn: resumeOn || null, reason: reason.trim() || null }, { onSuccess: onClose });
        }}
      >
        <DialogBody>
          <div className="stack gap-12">
            {formErrorOf(action.error, ['resumeOn', 'reason']) ? <ErrorAlert error={action.error} /> : null}
            <Field label="Resume on" optional hint="It resumes by itself on this day." error={errors.resumeOn}>
              {(control) => <input {...control} className="input" type="date" min={todayInIndia()} value={resumeOn} onChange={(event) => setResumeOn(event.target.value)} />}
            </Field>
            <Field label="Reason" optional error={errors.reason}>
              {(control) => <input {...control} className="input" maxLength={300} value={reason} onChange={(event) => setReason(event.target.value)} />}
            </Field>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={action.isPending}>
            Pause
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

const nowLocal = () => {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};

function WithdrawDialog({ enrollment, open, onClose }: { enrollment: EnrollmentDetail; open: boolean; onClose: () => void }) {
  const action = useEnrollmentAction(enrollment.id);
  const preview = useRefundPreview();
  const [channel, setChannel] = useState<WithdrawalChannel>('whatsapp');
  const [receivedAt, setReceivedAt] = useState(nowLocal);
  const [effectiveOn, setEffectiveOn] = useState('');
  const [classes, setClasses] = useState('');
  const [reason, setReason] = useState('');
  const errors = fieldErrorsOf(action.error);
  const receivedIso = receivedAt ? new Date(receivedAt).toISOString() : undefined;
  const classesAttended = classes === '' ? null : Number(classes);
  const { mutate: runPreview } = preview;

  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => runPreview({ id: enrollment.id, receivedAt: receivedIso, effectiveOn: effectiveOn || undefined, classesAttended }), 250);
    return () => clearTimeout(timer);
  }, [open, enrollment.id, receivedIso, effectiveOn, classesAttended, runPreview]);

  const result = preview.data;
  return (
    <Dialog open={open} onClose={onClose} size="lg" title="Withdraw from the course" description="Record when the family asked: the refund deadline counts from then. A reason is optional.">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          action.mutate(
            { kind: 'withdraw', channel, receivedAt: receivedIso, effectiveOn: effectiveOn || undefined, classesAttended, reason: reason.trim() || null },
            { onSuccess: onClose },
          );
        }}
      >
        <DialogBody>
          <div className="stack gap-12">
            {formErrorOf(action.error, ['channel', 'receivedAt', 'effectiveOn', 'classesAttended', 'reason']) ? <ErrorAlert error={action.error} /> : null}
            <div className="form-grid">
              <Field label="Asked by" error={errors.channel}>
                {(control) => (
                  <select {...control} className="select" value={channel} onChange={(event) => setChannel(event.target.value as WithdrawalChannel)}>
                    {(Object.keys(WITHDRAWAL_CHANNELS) as WithdrawalChannel[]).map((key) => (
                      <option key={key} value={key}>
                        {WITHDRAWAL_CHANNELS[key]}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field label="Asked on" error={errors.receivedAt}>
                {(control) => <input {...control} className="input" type="datetime-local" required max={nowLocal()} value={receivedAt} onChange={(event) => setReceivedAt(event.target.value)} />}
              </Field>
              <Field label="Last day attending" optional hint="Defaults to the day they asked." error={errors.effectiveOn}>
                {(control) => <input {...control} className="input" type="date" value={effectiveOn} onChange={(event) => setEffectiveOn(event.target.value)} />}
              </Field>
              {result?.basis.unit === 'classes' ? (
                <Field label="Classes attended" error={errors.classesAttended}>
                  {(control) => <input {...control} className="input" type="number" min={0} value={classes} onChange={(event) => setClasses(event.target.value)} />}
                </Field>
              ) : null}
            </div>
            <Field label="Reason" optional error={errors.reason}>
              {(control) => <input {...control} className="input" maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} />}
            </Field>
            <div className="delivery-refund" aria-live="polite">
              {preview.isError ? (
                <ErrorAlert error={preview.error} />
              ) : result ? (
                <>
                  <span className="small">Refund to request</span>
                  <span className="delivery-refund__amount">{moneyText(result.refund)}</span>
                  <span className="delivery-refund__basis">
                    {result.coolingOff
                      ? `Full refund: within ${result.basis.coolingOffDays} days of enrolling.`
                      : `${result.basis.usedUnits} of ${result.basis.totalUnits} ${result.basis.unit} used; paid ${formatMoney(result.basis.paidMinor ?? 0, result.refund.currency)}.`}{' '}
                    Due by {dateLabel(result.basis.dueOn)} ({result.basis.slaDays} days).
                  </span>
                </>
              ) : (
                <Spinner label="Working out the refund" />
              )}
            </div>
            <p className="muted small">The seat goes to the next person on the waitlist and platform access is revoked. Finance gets the refund request.</p>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="danger" loading={action.isPending}>
            {result && result.refund.valueMinor > 0 ? `Withdraw and request ${moneyText(result.refund)}` : 'Withdraw'}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

function CompleteDialog({ enrollment, open, onClose }: { enrollment: EnrollmentDetail; open: boolean; onClose: () => void }) {
  const action = useEnrollmentAction(enrollment.id);
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      title="Mark the course completed?"
      confirmLabel="Mark completed"
      pending={action.isPending}
      error={action.error}
      onConfirm={() => action.mutate({ kind: 'complete' }, { onSuccess: onClose })}
    >
      <p>{enrollment.student?.displayName ?? 'The student'} finished {enrollment.product?.name ?? 'the programme'}. Their seat is freed for the waitlist.</p>
    </ConfirmDialog>
  );
}
