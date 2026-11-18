import type { Metadata } from 'next';
import { PortalPayouts } from '@/components/partners/PortalViews';

export const metadata: Metadata = { title: 'Your payouts' };

export default function PortalPayoutsPage() {
  return <PortalPayouts />;
}
