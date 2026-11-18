'use client';

import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { Alert, ButtonLink, ErrorAlert, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { formatMoney } from '@/lib/crm/format';
import { dateRange } from '@/lib/delivery/format';
import type { CheckoutSession } from '@/lib/delivery/types';
import { CheckoutHeader } from '../CheckoutView';

/** Where the payment provider sends the family back: waits for the payment to be confirmed. */
export function DoneView({ company }: { company: string }) {
  const params = useSearchParams();
  const sessionId = params.get('session') ?? '';
  const token = params.get('token') ?? '';
  const session = useQuery({
    queryKey: ['public-checkout-session', sessionId, 'done'],
    queryFn: () => api.get<CheckoutSession>(`/public/checkout/sessions/${sessionId}`, { token }),
    enabled: Boolean(sessionId && token),
    refetchInterval: (query) => (query.state.data && ['completed', 'expired', 'failed'].includes(query.state.data.status) ? false : 2000),
  });
  const s = session.data;
  const done = s?.status === 'completed' && s.enrollment;
  return (
    <>
      <CheckoutHeader company={s?.company.name ?? 'Admission'} title={done ? 'You are enrolled' : 'Confirming your payment'} />
      <div className="delivery-checkout__body" aria-live="polite">
        {!sessionId || !token ? <Alert tone="error">This link is incomplete. Check the confirmation email or call the centre.</Alert> : null}
        {session.isError ? <ErrorAlert error={session.error} /> : null}
        {s && !done && (s.status === 'pending' || s.status === 'paid') ? (
          <div className="delivery-checkout__step">
            <Spinner label="Waiting for the payment confirmation" />
            <p className="delivery-checkout__note">This usually takes a few seconds. You can close this page: we also send the confirmation on WhatsApp and email.</p>
          </div>
        ) : null}
        {s && (s.status === 'expired' || s.status === 'failed') ? (
          <Alert tone="error" title="The payment didn't go through">
            Nothing was charged. <a href={`/checkout/${encodeURIComponent(company)}`}>Start again</a> or call the centre.
          </Alert>
        ) : null}
        {done && s.enrollment ? (
          <div className="delivery-checkout__step">
            {s.enrollment.seatStatus === 'waitlisted' ? (
              <Alert tone="warning" title={`You are #${s.enrollment.waitlistPosition ?? 1} on the waitlist`}>
                The last seat went just before your payment. You get the next free seat, or a full refund if none frees up: we will call you.
              </Alert>
            ) : (
              <Alert tone="success" title="Seat confirmed">
                {s.batch.name}, {dateRange(s.batch.startsOn, s.batch.endsOn)}.
              </Alert>
            )}
            <p>
              Enrollment number <span className="crm-mono">{s.enrollment.ref}</span> · paid {formatMoney(s.amount.valueMinor, s.amount.currency)}
            </p>
            <p className="delivery-checkout__note">We will send the timetable and joining details on WhatsApp and email.</p>
            <div>
              <ButtonLink href={`/checkout/${encodeURIComponent(company)}`}>Enroll another student</ButtonLink>
            </div>
          </div>
        ) : null}
      </div>
    </>
  );
}
