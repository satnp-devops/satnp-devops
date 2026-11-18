import type { Metadata } from 'next';
import { LinksView } from '@/components/partners/ListsViews';

export const metadata: Metadata = { title: 'Referral links' };

export default function PartnerLinksPage() {
  return <LinksView />;
}
