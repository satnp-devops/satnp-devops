import type { Metadata } from 'next';
import { PortalLeads } from '@/components/partners/PortalViews';

export const metadata: Metadata = { title: 'Leads you referred' };

export default function PortalLeadsPage() {
  return <PortalLeads />;
}
