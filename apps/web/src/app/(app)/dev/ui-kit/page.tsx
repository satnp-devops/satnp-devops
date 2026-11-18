import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { UiKitGallery } from './UiKitGallery';

const isProduction = process.env.NODE_ENV === 'production';

export const metadata: Metadata = isProduction ? {} : { title: 'UI kit', robots: { index: false } };

/** Every CRM kit component with sample data, for building and checking screens. Not part of production builds. */
export default function UiKitPage() {
  if (isProduction) notFound();
  return <UiKitGallery />;
}
