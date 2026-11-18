import type { Metadata } from 'next';
import { PipelinesView } from './PipelinesView';

export const metadata: Metadata = { title: 'Pipelines' };

export default function PipelinesSettingsPage() {
  return <PipelinesView />;
}
