import type { Metadata } from 'next';
import { GeneralView } from './GeneralView';

export const metadata: Metadata = { title: 'General settings' };

export default function GeneralPage() {
  return <GeneralView />;
}
