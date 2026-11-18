import type { Metadata } from 'next';
import { TemplatesView } from './TemplatesView';

export const metadata: Metadata = { title: 'Message templates' };

export default function TemplatesPage() {
  return <TemplatesView />;
}
