import type { Metadata } from 'next';
import { LeadsView } from './LeadsView';

export const metadata: Metadata = { title: 'Leads' };

/** /leads: the unified Leads list (docs/crm/PHASE2_CONTRACT.md §15.2). The layout draws the header and tabs. */
export default function LeadsPage() {
  return <LeadsView />;
}
