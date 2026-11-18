import type { Metadata } from 'next';
import { RunsView } from './RunsView';

export const metadata: Metadata = { title: 'Automation runs' };

export default function AutomationRunsPage() {
  return <RunsView />;
}
