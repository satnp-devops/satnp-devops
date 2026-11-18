import type { Metadata } from 'next';
import { DealBillingView } from './DealBillingView';

export const metadata: Metadata = { title: 'Deal billing' };

export default function DealBillingPage() {
  return <DealBillingView />;
}
