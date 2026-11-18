import type { Metadata } from 'next';
import { ApiDocsView } from './ApiDocsView';

export const metadata: Metadata = { title: 'API reference' };

export default function ApiReferencePage() {
  return <ApiDocsView />;
}
