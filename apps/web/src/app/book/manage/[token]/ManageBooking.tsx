'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, ErrorAlert, Field, PageLoading } from '@/components/ui';
import { BookingSummaryCard, PublicShell, whenText } from '@/components/scheduling/PublicShell';
import { SlotPicker } from '@/components/scheduling/SlotPicker';
import { api, isApiError } from '@/lib/api';
import { detectedTimeZone, schedulingKeys } from '@/lib/scheduling/api';
import type { PublicBooking, Slot } from '@/lib/scheduling/types';
import { LinkProblem } from '../../[token]/BookingPage';

type Mode = 'view' | 'reschedule' | 'cancel' | 'request';

export function ManageBooking({ token }: { token: string }) {
  const queryClient = useQueryClient();
  const booking = useQuery({
    queryKey: schedulingKeys.publicBooking(token),
    queryFn: () => api.get<PublicBooking>(`/public/bookings/${token}`),
    retry: false,
  });
  const [zone, setZone] = useState(() => (typeof window === 'undefined' ? 'Asia/Kolkata' : detectedTimeZone()));
  const [mode, setMode] = useState<Mode>('view');
  const [slot, setSlot] = useState<Slot | null>(null);
  const [reason, setReason] = useState('');
  const [flash, setFlash] = useState<string | null>(null);

  const done = (message: string) => (data: PublicBooking) => {
    queryClient.setQueryData(schedulingKeys.publicBooking(token), data);
    setMode('view');
    setSlot(null);
    setReason('');
    setFlash(message);
  };
  const reschedule = useMutation({
    mutationFn: () => api.post<PublicBooking>(`/public/bookings/${token}/reschedule`, { start: slot?.start, timeZone: zone }),
    onSuccess: done('Your booking has moved. We have emailed the new time.'),
  });
  const cancel = useMutation({
    mutationFn: () => api.post<PublicBooking>(`/public/bookings/${token}/cancel`, { reason: reason.trim() || undefined }),
    onSuccess: done('Your booking is cancelled.'),
  });
  const request = useMutation({
    mutationFn: () => api.post<PublicBooking>(`/public/bookings/${token}/reschedule-request`, { note: reason.trim() || undefined }),
    onSuccess: done('Thanks. The team will contact you to find another time.'),
  });

  if (booking.isLoading) return <PageLoading />;
  if (booking.error || !booking.data) return <LinkProblem error={booking.error} />;
  const data = booking.data;
  const active = data.status === 'booked' || data.status === 'rescheduled';
  const title = data.status === 'cancelled' ? 'This booking is cancelled' : data.status === 'completed' ? 'This meeting has taken place' : data.status === 'no_show' ? 'This meeting has passed' : 'Your booking';

  return (
    <PublicShell branding={data.branding}>
      {flash ? <Alert tone="success">{flash}</Alert> : null}
      <BookingSummaryCard booking={data} zone={zone} title={title}>
        {active && mode === 'view' ? (
          <div className="sch-actions">
            {data.can.reschedule ? <Button onClick={() => setMode('reschedule')}>Reschedule</Button> : null}
            {data.can.cancel ? (
              <Button variant="danger" onClick={() => setMode('cancel')}>
                Cancel booking
              </Button>
            ) : null}
          </div>
        ) : null}
        {data.rescheduleRequested && active ? <p className="small muted">You asked for another time. The team will be in touch.</p> : null}
      </BookingSummaryCard>

      {mode === 'reschedule' ? (
        <section className="sch-public__card" aria-label="Pick a new time">
          <h2 className="title-lg">Pick a new time</h2>
          {slot ? (
            <div className="stack gap-12">
              <div className="sch-chosen">
                <div className="stack gap-2">
                  <span className="small muted">New time</span>
                  <strong>{whenText(slot.start, slot.end, zone)}</strong>
                </div>
                <Button size="sm" onClick={() => setSlot(null)}>
                  Change
                </Button>
              </div>
              {isApiError(reschedule.error) && reschedule.error.code === 'slot_unavailable' ? (
                <Alert tone="warning">That time was just taken. Pick another time.</Alert>
              ) : (
                <ErrorAlert error={reschedule.error} />
              )}
              <div className="sch-actions">
                <Button variant="primary" loading={reschedule.isPending} onClick={() => reschedule.mutate()}>
                  Move my booking
                </Button>
                <Button onClick={() => setMode('view')}>Keep the current time</Button>
              </div>
            </div>
          ) : (
            <>
              <SlotPicker
                source={{ kind: 'manage', token }}
                timeZone={zone}
                onTimeZoneChange={setZone}
                horizonDays={data.eventType.horizonDays}
                selected={null}
                onSelect={setSlot}
                keepStart={data.startAt}
              />
              {data.can.requestReschedule ? (
                <p className="small">
                  None of these work?{' '}
                  <button type="button" className="link-button" onClick={() => setMode('request')}>
                    Ask us for another time
                  </button>
                </p>
              ) : null}
            </>
          )}
        </section>
      ) : null}

      {mode === 'cancel' || mode === 'request' ? (
        <section className="sch-public__card">
          <h2 className="title-lg">{mode === 'cancel' ? 'Cancel this booking?' : 'Ask for another time'}</h2>
          <Field label={mode === 'cancel' ? 'Reason' : 'When suits you?'} optional>
            {(control) => <textarea {...control} className="textarea" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />}
          </Field>
          <ErrorAlert error={mode === 'cancel' ? cancel.error : request.error} />
          <div className="sch-actions">
            {mode === 'cancel' ? (
              <Button variant="danger" loading={cancel.isPending} onClick={() => cancel.mutate()}>
                Cancel booking
              </Button>
            ) : (
              <Button variant="primary" loading={request.isPending} onClick={() => request.mutate()}>
                Send
              </Button>
            )}
            <Button onClick={() => setMode('view')}>Back</Button>
          </div>
        </section>
      ) : null}
    </PublicShell>
  );
}
