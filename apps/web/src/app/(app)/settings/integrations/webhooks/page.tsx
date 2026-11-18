import type { Metadata } from 'next';
import { Guard } from '@/components/Guard';
import { DeliveriesView } from './DeliveriesView';

export const metadata: Metadata = { title: 'Webhook deliveries · Integrations' };

export default function WebhookDeliveriesPage() {
  return (
    <Guard anyOf={['webhooks.view']} anywhere>
      <DeliveriesView />
    </Guard>
  );
}
