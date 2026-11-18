import type { Metadata } from 'next';
import { PartnersListView } from '@/components/partners/PartnersListView';

export const metadata: Metadata = { title: 'Partners' };

export default function PartnersPage() {
  return <PartnersListView />;
}
