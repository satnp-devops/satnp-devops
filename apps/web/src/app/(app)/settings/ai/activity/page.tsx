import type { Metadata } from 'next';
import { ActivityView } from './ActivityView';

export const metadata: Metadata = { title: 'AI activity' };

export default function AiActivityPage() {
  return <ActivityView />;
}
