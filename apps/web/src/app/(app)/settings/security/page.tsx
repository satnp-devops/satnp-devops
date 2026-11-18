import type { Metadata } from 'next';
import { SecurityView } from './SecurityView';

export const metadata: Metadata = { title: 'Your account' };

export default function SecurityPage() {
  return <SecurityView />;
}
