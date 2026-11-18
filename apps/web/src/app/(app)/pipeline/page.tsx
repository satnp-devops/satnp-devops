import type { Metadata } from 'next';
import { BeingBuilt } from '@/components/shell/BeingBuilt';
import { PageHeader } from '@/components/ui';

export const metadata: Metadata = { title: 'Pipeline' };

export default function PipelinePage() {
  return (
    <>
      <PageHeader title="Pipeline" description="Deals by stage, with counts, value and SLA flags." />
      <div className="content">
        <BeingBuilt icon="kanban">A board and a table for each pipeline arrive in the second half of this phase.</BeingBuilt>
      </div>
    </>
  );
}
