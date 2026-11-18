import type { Metadata } from 'next';
import { PortalOverview } from '@/components/partners/PortalViews';

export const metadata: Metadata = { title: 'Partner portal' };

export default function PartnerPortalPage() {
  return <PortalOverview />;
}
