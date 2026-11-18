import type { Metadata } from 'next';
import { RoutingView } from './RoutingView';

export const metadata: Metadata = { title: 'Routing' };

export default function RoutingPage() {
  return <RoutingView />;
}
