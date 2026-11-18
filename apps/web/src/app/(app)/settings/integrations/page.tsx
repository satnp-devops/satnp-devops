import type { Metadata } from 'next';
import { ConnectionsView } from './ConnectionsView';

export const metadata: Metadata = { title: 'Integrations' };

export default function IntegrationsPage() {
  return <ConnectionsView />;
}
