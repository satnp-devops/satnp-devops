import type { Metadata } from 'next';
import { PortalCommissions } from '@/components/partners/PortalViews';

export const metadata: Metadata = { title: 'Your commissions' };

export default function PortalCommissionsPage() {
  return <PortalCommissions />;
}
