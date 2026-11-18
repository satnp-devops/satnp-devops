import type { Metadata } from 'next';
import { KnowledgeView } from './KnowledgeView';

export const metadata: Metadata = { title: 'AI knowledge base' };

export default function AiKnowledgePage() {
  return <KnowledgeView />;
}
