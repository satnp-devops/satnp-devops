import type { Metadata } from 'next';
import { PartnerProfile } from '@/components/partners/PartnerProfile';

export const metadata: Metadata = { title: 'Partner' };

export default async function PartnerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PartnerProfile id={id} />;
}
