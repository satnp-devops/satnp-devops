import type { Metadata } from 'next';
import { Guard } from '@/components/Guard';
import { SandboxView } from './SandboxView';

export const metadata: Metadata = { title: 'Sandbox outbox · Integrations' };

export default function SandboxPage() {
  return (
    <Guard anyOf={['integrations.view']} anywhere>
      <SandboxView />
    </Guard>
  );
}
