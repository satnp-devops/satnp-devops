import type { Metadata } from 'next';
import { BeingBuilt } from '@/components/shell/BeingBuilt';
import { PageHeader } from '@/components/ui';

export const metadata: Metadata = { title: 'Lead' };

export default function LeadProfilePage() {
  return (
    <>
      <PageHeader title="Lead" description="Stage tracker, family or institute, timeline and tasks." />
      <div className="content">
        <BeingBuilt icon="user">The lead profile arrives in the second half of this phase.</BeingBuilt>
      </div>
    </>
  );
}
