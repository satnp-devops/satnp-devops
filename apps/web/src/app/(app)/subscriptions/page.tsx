import type { Metadata } from 'next';
import { SubscriptionsView } from './SubscriptionsView';

export const metadata: Metadata = { title: 'Subscriptions' };

export default function SubscriptionsPage() {
  return <SubscriptionsView />;
}
