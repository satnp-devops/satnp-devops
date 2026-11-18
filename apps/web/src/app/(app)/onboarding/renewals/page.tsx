import type { Metadata } from 'next';
import { RenewalsView } from './RenewalsView';

export const metadata: Metadata = { title: 'Renewals' };

export default function RenewalsPage() {
  return <RenewalsView />;
}
