'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Dialog, DialogBody, DialogFooter, ConfirmDialog } from '@/components/dialog';
import { KeyValue, SidePanel, StatusPill, type KeyValueItem } from '@/components/crm';
import { Alert, Button, ErrorAlert, Field, Spinner } from '@/components/ui';
import { api, isApiError } from '@/lib/api';
import { crmKeys } from '@/lib/crm/keys';
import { safeExternalUrl } from '@/lib/objects';
import {
  LOCATION_LABELS,
  STATUS_LABELS,
  durationLabel,
  schedulingKeys,
  statusTone,
  timeLabel,
  useReassignCandidates,
  zonedParts,
  dayLabel,
} from '@/lib/scheduling/api';
import type { Booking, Slot } from '@/lib/scheduling/types';
import { useSession } from '@/lib/session';
import { SendBookingLinkDialog } from './SendBookingLinkDialog';
import { SlotPicker } from './SlotPicker';
import './scheduling.css';

export function whenLabel(booking: Pick<Booking, 'startAt' | 'endAt'>, zone: string): string {
  const date = zonedParts(booking.startAt, zone).date;
  return `${dayLabel(date, { weekday: 'short', day: 'numeric', month: 'short' })}, ${timeLabel(booking.startAt, zone)} – ${timeLabel(booking.endAt, zone)}`;
}

const minutes = (seconds: number) => `${Math.round(seconds / 60)} min`;

/** One booking with what the viewer may do to it. */
export function BookingPanel({ booking, zone, onClose }: { booking: Booking | null; zone: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const session = useSession();
  const [dialog, setDialog] = useState<'reschedule' | 'cancel' | 'reassign' | 'no_show' | 'attended' | 'rebook' | null>(null);
  const [current, setCurrent] = useState<Booking | null>(null);
  const shown = current && booking && current.id === booking.id ? current : booking;

  const refresh = (updated: Booking) => {
    setCurrent(updated);
    setDialog(null);
    void queryClient.invalidateQueries({ queryKey: schedulingKeys.all });
    void queryClient.invalidateQueries({ queryKey: crmKeys.all });
  };

  if (!shown) return <SidePanel open={false} onClose={onClose} title="" />;
  const b = shown;
  const inviteeZoneDiffers = b.timeZone !== zone;
  const items: KeyValueItem[] = [
    { label: 'When', value: <span className="mono">{whenLabel(b, zone)}</span> },
    ...(inviteeZoneDiffers ? [{ label: 'Their time', value: <span className="mono">{`${whenLabel(b, b.timeZone)} (${b.timeZone.replace(/_/g, ' ')})`}</span> }] : []),
    { label: 'Invitee', value: b.invitee.name },
    { label: 'Email', value: b.invitee.email ? <span className="mono">{b.invitee.email}</span> : null },
    { label: 'Phone', value: b.invitee.phone ? <span className="mono">{b.invitee.phone}</span> : null },
    { label: 'Who will attend', value: b.attendingLabel },
    ...(b.guests.length ? [{ label: 'Also joining', value: b.guests.map((g) => (g.email ? `${g.name} (${g.email})` : g.name)).join(', ') }] : []),
    { label: 'Host', value: b.host?.name ?? null },
    { label: 'Deal', value: b.deal ? <Link href={`/leads/${b.deal.id}`}>{`${b.deal.ref} · ${b.deal.title}`}</Link> : null },
    {
      label: 'Where',
      value: b.location.meetingUrl ? (
        <a href={safeExternalUrl(b.location.meetingUrl) ?? undefined} target="_blank" rel="noopener noreferrer">
          {LOCATION_LABELS[b.location.kind]} link
        </a>
      ) : (
        [LOCATION_LABELS[b.location.kind], b.location.detail].filter(Boolean).join(': ')
      ),
    },
    ...b.answerList.map((a) => ({ key: `answer-${a.key}`, label: a.label, value: a.value })),
    { label: 'Notes', value: b.notes },
    { label: 'Booked through', value: b.source === 'personal_link' ? 'Personal link' : b.source === 'staff' ? 'Staff' : 'Booking page' },
    { label: 'Host chosen', value: b.assignmentReason },
  ];
  if (b.meeting && b.meeting.status !== 'scheduled') {
    items.push({
      label: 'Attendance',
      value: `${minutes(b.meeting.inviteeSeconds)} (needs ${b.meeting.thresholdMin} min)${b.meeting.result !== 'pending' ? ` · ${b.meeting.result === 'attended' ? 'attended' : 'no-show'}` : ''}`,
    });
  }
  // After a no-show or a cancellation, offer a fresh personal link to rebook the deal.
  const canRebook = Boolean(b.deal && b.unit && (b.status === 'no_show' || b.status === 'cancelled') && session.canAnywhere('scheduling.manage'));
  if (b.cancelledAt) items.push({ label: 'Cancelled', value: `${b.cancelledBy === 'invitee' ? 'By the invitee' : 'By the team'}${b.cancelReason ? `: ${b.cancelReason}` : ''}` });

  return (
    <>
      <SidePanel
        open
        onClose={onClose}
        title={b.eventType?.name ?? 'Booking'}
        subtitle={
          <span className="row gap-8">
            <StatusPill tone={statusTone(b)}>{b.live ? 'Live now' : STATUS_LABELS[b.status]}</StatusPill>
            {b.eventType ? <span className="small muted">{durationLabel(b.eventType.durationMin)}</span> : null}
          </span>
        }
        footer={
          b.can.manage ? (
            <div className="row gap-8">
              {b.can.markOutcome ? (
                <>
                  <Button size="sm" icon="check" onClick={() => setDialog('attended')}>
                    Attended
                  </Button>
                  <Button size="sm" icon="x" onClick={() => setDialog('no_show')}>
                    No-show
                  </Button>
                </>
              ) : null}
              {b.can.reschedule ? (
                <Button size="sm" icon="calendar" onClick={() => setDialog('reschedule')}>
                  Reschedule
                </Button>
              ) : null}
              {b.can.assign ? (
                <Button size="sm" icon="users" onClick={() => setDialog('reassign')}>
                  Reassign
                </Button>
              ) : null}
              {b.can.cancel ? (
                <Button size="sm" variant="danger" onClick={() => setDialog('cancel')}>
                  Cancel
                </Button>
              ) : null}
            </div>
          ) : canRebook ? (
            <Button size="sm" icon="link" onClick={() => setDialog('rebook')}>
              Send a booking link
            </Button>
          ) : null
        }
      >
        <div className="stack gap-16">
          {b.rescheduleRequest ? (
            <Alert tone="warning" title="Asked for another time">
              {b.rescheduleRequest.note ?? 'No note.'}
            </Alert>
          ) : null}
          {b.live && b.location.meetingUrl ? (
            <a className="btn btn--primary" href={safeExternalUrl(b.location.meetingUrl) ?? undefined} target="_blank" rel="noopener noreferrer">
              Join now
            </a>
          ) : null}
          <KeyValue items={items} />
          {b.invitee.piiMasked ? <p className="small muted">Contact details are hidden for your role.</p> : null}
        </div>
      </SidePanel>

      {dialog === 'reschedule' ? <RescheduleDialog booking={b} zone={zone} onClose={() => setDialog(null)} onDone={refresh} /> : null}
      {dialog === 'reassign' ? <ReassignDialog booking={b} zone={zone} onClose={() => setDialog(null)} onDone={refresh} /> : null}
      {dialog === 'cancel' ? <CancelDialog booking={b} onClose={() => setDialog(null)} onDone={refresh} /> : null}
      {canRebook && b.unit && b.deal ? (
        <SendBookingLinkDialog open={dialog === 'rebook'} onClose={() => setDialog(null)} unitId={b.unit.id} dealId={b.deal.id} contactName={b.invitee.name} />
      ) : null}
      {dialog === 'no_show' || dialog === 'attended' ? <OutcomeDialog booking={b} outcome={dialog} onClose={() => setDialog(null)} onDone={refresh} /> : null}
    </>
  );
}

function RescheduleDialog({ booking, zone: initialZone, onClose, onDone }: { booking: Booking; zone: string; onClose: () => void; onDone: (b: Booking) => void }) {
  const [zone, setZone] = useState(initialZone);
  const [slot, setSlot] = useState<Slot | null>(null);
  const move = useMutation({
    mutationFn: () => api.post<Booking>(`/scheduling/bookings/${booking.id}/reschedule`, { start: slot?.start }),
    onSuccess: onDone,
  });
  return (
    <Dialog open onClose={onClose} size="lg" title="Reschedule" description={`${booking.invitee.name} gets the new time by email, with an updated calendar invitation.`}>
      <DialogBody>
        {isApiError(move.error) && move.error.code === 'slot_unavailable' ? <Alert tone="warning">That time was just taken. Pick another.</Alert> : <ErrorAlert error={move.error} />}
        <SlotPicker source={{ kind: 'booking', id: booking.id }} timeZone={zone} onTimeZoneChange={setZone} horizonDays={60} selected={slot?.start ?? null} onSelect={setSlot} keepStart={booking.startAt} />
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!slot} loading={move.isPending} onClick={() => move.mutate()}>
          {slot ? `Move to ${timeLabel(slot.start, zone)}` : 'Pick a time'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function ReassignDialog({ booking, zone, onClose, onDone }: { booking: Booking; zone: string; onClose: () => void; onDone: (b: Booking) => void }) {
  const candidates = useReassignCandidates(booking.id);
  const [hostId, setHostId] = useState<string | null>(null);
  const reassign = useMutation({
    mutationFn: () => api.post<Booking>(`/scheduling/bookings/${booking.id}/reassign`, { hostUserId: hostId }),
    onSuccess: onDone,
  });
  return (
    <Dialog open onClose={onClose} title="Reassign" description={`Give ${whenLabel(booking, zone)} to another host. Only people free at that time can take it.`}>
      <DialogBody>
        <ErrorAlert error={candidates.error ?? reassign.error} />
        {candidates.isLoading ? <Spinner /> : null}
        {candidates.data && candidates.data.length === 0 ? <p className="small muted">This event type has no other hosts.</p> : null}
        <div className="stack gap-8" role="radiogroup" aria-label="New host">
          {(candidates.data ?? []).map((c) => (
            <label key={c.id} className="chip-toggle" aria-disabled={!c.available}>
              <input type="radio" name="host" disabled={!c.available} checked={hostId === c.id} onChange={() => setHostId(c.id)} />
              {c.name}
              <span className="small muted">{c.available ? `free · ${c.timeZone.replace(/_/g, ' ')}` : 'busy'}</span>
            </label>
          ))}
        </div>
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!hostId} loading={reassign.isPending} onClick={() => reassign.mutate()}>
          Reassign
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function CancelDialog({ booking, onClose, onDone }: { booking: Booking; onClose: () => void; onDone: (b: Booking) => void }) {
  const [reason, setReason] = useState('');
  const cancel = useMutation({
    mutationFn: () => api.post<Booking>(`/scheduling/bookings/${booking.id}/cancel`, { reason: reason.trim() || undefined }),
    onSuccess: onDone,
  });
  return (
    <ConfirmDialog open onClose={onClose} title="Cancel this booking?" confirmLabel="Cancel booking" danger pending={cancel.isPending} error={cancel.error} onConfirm={() => cancel.mutate()}>
      <p>{booking.invitee.name} gets a cancellation email and the calendar invitation is withdrawn.</p>
      <Field label="Reason" optional>
        {(control) => <textarea {...control} className="textarea" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />}
      </Field>
    </ConfirmDialog>
  );
}

function OutcomeDialog({ booking, outcome, onClose, onDone }: { booking: Booking; outcome: 'no_show' | 'attended'; onClose: () => void; onDone: (b: Booking) => void }) {
  const [note, setNote] = useState('');
  const mark = useMutation({
    mutationFn: () => api.post<Booking>(`/scheduling/bookings/${booking.id}/${outcome === 'no_show' ? 'no-show' : 'attended'}`, { note: note.trim() || undefined }),
    onSuccess: onDone,
  });
  return (
    <ConfirmDialog
      open
      onClose={onClose}
      title={outcome === 'no_show' ? 'Mark as no-show?' : 'Mark as attended?'}
      confirmLabel={outcome === 'no_show' ? 'Mark no-show' : 'Mark attended'}
      danger={outcome === 'no_show'}
      pending={mark.isPending}
      error={mark.error}
      onConfirm={() => mark.mutate()}
    >
      <p>{outcome === 'no_show' ? 'The deal moves on as a missed meeting.' : 'The deal moves on as a held meeting.'} This can’t be undone here.</p>
      <Field label="Note" optional>
        {(control) => <textarea {...control} className="textarea" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />}
      </Field>
    </ConfirmDialog>
  );
}
