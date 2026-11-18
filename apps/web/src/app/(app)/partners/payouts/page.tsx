import type { Metadata } from 'next';
import { PayoutsView } from '@/components/partners/PayoutsView';

export const metadata: Metadata = { title: 'Partner payouts' };

export default function PartnerPayoutsPage() {
  return <PayoutsView />;
}
