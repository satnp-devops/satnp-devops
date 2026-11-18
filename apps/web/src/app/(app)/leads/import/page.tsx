import type { Metadata } from 'next';
import { ImportView } from './ImportView';

export const metadata: Metadata = { title: 'Import leads' };

export default function ImportPage() {
  return <ImportView />;
}
