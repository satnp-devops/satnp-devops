import type { Metadata } from 'next';
import { FlowsView } from './FlowsView';

export const metadata: Metadata = { title: 'Automations' };

export default function AutomationsPage() {
  return <FlowsView />;
}
