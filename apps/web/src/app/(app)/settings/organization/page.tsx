import type { Metadata } from 'next';
import { OrganizationView } from './OrganizationView';

export const metadata: Metadata = { title: 'Organisation' };

export default function OrganizationPage() {
  return <OrganizationView />;
}
