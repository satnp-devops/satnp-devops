import type { Metadata } from 'next';
import { BookingPage } from './BookingPage';

// The public booking page: no sign-in, the signed token in the URL is the credential.
export const metadata: Metadata = { title: 'Book a time', robots: { index: false, follow: false }, referrer: 'no-referrer' };

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <BookingPage token={token} />;
}
