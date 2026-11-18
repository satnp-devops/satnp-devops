import type { Metadata } from 'next';
import { ManageBooking } from './ManageBooking';

// Reschedule or cancel a booking from the link in the confirmation email (no sign-in).
export const metadata: Metadata = { title: 'Your booking', robots: { index: false, follow: false }, referrer: 'no-referrer' };

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <ManageBooking token={token} />;
}
