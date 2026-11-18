import type { Metadata } from 'next';
import { BookingSettingsView } from './BookingSettingsView';

export const metadata: Metadata = { title: 'Booking settings' };

export default function BookingSettingsPage() {
  return <BookingSettingsView />;
}
