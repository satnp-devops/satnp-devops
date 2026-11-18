import type { Metadata } from 'next';
import { PlansView } from '@/components/partners/PlansView';

export const metadata: Metadata = { title: 'Partner programmes' };

export default function PartnerProgrammesPage() {
  return <PlansView />;
}
