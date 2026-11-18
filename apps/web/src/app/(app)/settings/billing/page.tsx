import type { Metadata } from 'next';
import { BillingSettingsView } from './BillingSettingsView';

export const metadata: Metadata = { title: 'Billing settings' };

export default function BillingSettingsPage() {
  return <BillingSettingsView />;
}
