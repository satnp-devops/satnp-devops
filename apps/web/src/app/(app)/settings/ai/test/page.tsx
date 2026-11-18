import type { Metadata } from 'next';
import { TestPanelView } from './TestPanelView';

export const metadata: Metadata = { title: 'Test an AI agent' };

export default function AiTestPage() {
  return <TestPanelView />;
}
