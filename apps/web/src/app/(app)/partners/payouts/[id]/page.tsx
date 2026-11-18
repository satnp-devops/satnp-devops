import type { Metadata } from 'next';
import { PayoutView } from '@/components/partners/PayoutsView';

export const metadata: Metadata = { title: 'Payout batch' };

export default async function PartnerPayoutPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PayoutView id={id} />;
}
