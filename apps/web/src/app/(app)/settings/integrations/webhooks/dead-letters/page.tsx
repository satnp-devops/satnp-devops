import type { Metadata } from 'next';
import { Guard } from '@/components/Guard';
import { DeadLettersView } from './DeadLettersView';

export const metadata: Metadata = { title: 'Dead letters · Integrations' };

export default function DeadLettersPage() {
  return (
    <Guard anyOf={['webhooks.view', 'jobs.view']} anywhere>
      <DeadLettersView />
    </Guard>
  );
}
