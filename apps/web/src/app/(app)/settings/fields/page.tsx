import type { Metadata } from 'next';
import { FieldsView } from './FieldsView';

export const metadata: Metadata = { title: 'Custom fields' };

export default function CustomFieldsSettingsPage() {
  return <FieldsView />;
}
