'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { Alert, Button, ErrorAlert, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { formatMoney } from '@/lib/crm/format';
import type { CheckoutSession } from '@/lib/delivery/types';
import { CheckoutHeader } from '../CheckoutView';

/**
 * Development stand-in for the payment page: until the money module's payment links are
 * connected, the checkout sends families here, and "Pay" emits payment.succeeded the way the
 * real provider webhook will. The API refuses this outside development.
 */
export function DevPayView({ company }: { company: string }) {
  const params = useSearchParams();
  const router = useRouter();
  const sessionId = params.get('session') ?? '';
  const token = params.get('token') ?? '';
  const session = useQuery({
    queryKey: ['public-checkout-session', sessionId],
    queryFn: () => api.get<CheckoutSession>(`/public/checkout/sessions/${sessionId}`, { token }),
    enabled: Boolean(sessionId && token),
  });
  const pay = useMutation({
    mutationFn: () => api.post(`/public/checkout/sessions/${sessionId}/simulate-payment`, { token }),
    onSuccess: () => router.push(`/checkout/${encodeURIComponent(company)}/done?session=${sessionId}&token=${encodeURIComponent(token)}`),
  });
  const s = session.data;
  return (
    <>
      <CheckoutHeader company={s?.company.name ?? 'Payment'} title="Payment" lead="Test payment page (development only)." />
      <div className="delivery-checkout__body">
        <Alert tone="warning" title="Test mode">
          No money moves here. In production this step is the payment provider&apos;s page.
        </Alert>
        {session.isPending ? <Spinner label="Loading the checkout" /> : null}
        {session.isError ? <ErrorAlert error={session.error} /> : null}
        {s ? (
          <div className="delivery-checkout__step delivery-checkout__pay">
            <div className="stack gap-2">
              <span className="delivery-checkout__total">{formatMoney(s.amount.valueMinor, s.amount.currency)}</span>
              <span className="delivery-checkout__note">{s.batch.name}</span>
            </div>
            {s.status === 'pending' ? (
              <Button variant="primary" loading={pay.isPending} onClick={() => pay.mutate()}>
                Simulate a successful payment
              </Button>
            ) : (
              <Alert tone="info">This checkout is {s.status}.</Alert>
            )}
          </div>
        ) : null}
        {pay.isError ? <ErrorAlert error={pay.error} /> : null}
      </div>
    </>
  );
}
