import type { Metadata } from 'next';
import { AttributionsView } from '@/components/partners/ListsViews';

export const metadata: Metadata = { title: 'Referred leads' };

export default function PartnerLeadsPage() {
  return <AttributionsView />;
}
