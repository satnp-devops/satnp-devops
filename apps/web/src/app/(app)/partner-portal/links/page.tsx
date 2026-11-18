import type { Metadata } from 'next';
import { PortalLinks } from '@/components/partners/PortalViews';

export const metadata: Metadata = { title: 'Your referral links' };

export default function PortalLinksPage() {
  return <PortalLinks />;
}
