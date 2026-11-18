'use client';

import { useParams } from 'next/navigation';
import { Guard } from '@/components/Guard';
import { AgreementPanel, FeesPanel } from '@/components/money';
import { ButtonLink, PageHeader } from '@/components/ui';
import { useDealBilling } from '@/lib/money/queries';

/**
 * A deal's fees and agreements on their own page, linked from the billing lists. The deal profile
 * (/leads/[id], wave 2) shows the same FeesPanel and AgreementPanel.
 */
export function DealBillingView() {
  const params = useParams<{ dealId: string }>();
  const dealId = params.dealId;
  const billing = useDealBilling(dealId);
  const deal = billing.data?.deal;
  return (
    <>
      <PageHeader
        title={deal ? `${deal.ref} · ${deal.title}` : 'Deal billing'}
        description={deal ? (deal.kind === 'b2c' ? 'Fees, payments and agreement for this family' : 'Quotes, subscriptions and agreement for this institute') : undefined}
        actions={
          <ButtonLink href="/billing" icon="card" size="sm">
            Fees and billing
          </ButtonLink>
        }
      />
      <div className="content">
        <Guard anyOf={['billing.view']} anywhere>
          <div className="split">
            <div className="split__main">
              <FeesPanel dealId={dealId} />
            </div>
            <div className="split__side">
              <AgreementPanel dealId={dealId} />
            </div>
          </div>
        </Guard>
      </div>
    </>
  );
}
