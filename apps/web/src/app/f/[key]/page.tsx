import type { Metadata } from 'next';
import { PublicFormView } from './PublicFormView';

export const metadata: Metadata = { title: 'Enquiry', robots: { index: false, follow: false } };

/** The hosted website form; also what the embed snippet's iframe loads. */
export default async function PublicFormPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  return <PublicFormView formKey={key} />;
}
