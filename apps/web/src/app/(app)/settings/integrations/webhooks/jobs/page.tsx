import type { Metadata } from 'next';
import { Guard } from '@/components/Guard';
import { JobsView } from './JobsView';

export const metadata: Metadata = { title: 'Background jobs · Integrations' };

export default function BackgroundJobsPage() {
  return (
    <Guard anyOf={['webhooks.view', 'jobs.view']} anywhere>
      <JobsView />
    </Guard>
  );
}
