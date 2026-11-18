import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { DevMessaging } from './DevMessaging';

const isProduction = process.env.NODE_ENV === 'production';

export const metadata: Metadata = isProduction ? {} : { title: 'Messaging playground', robots: { index: false } };

/** The reply box on a real deal, with buttons that pretend to be provider webhooks. Not part of production builds. */
export default function DevMessagingPage() {
  if (isProduction) notFound();
  return <DevMessaging />;
}
