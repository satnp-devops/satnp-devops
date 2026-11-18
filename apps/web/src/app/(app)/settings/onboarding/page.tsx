import type { Metadata } from 'next';
import { TemplatesView } from './TemplatesView';

export const metadata: Metadata = { title: 'Onboarding templates' };

export default function OnboardingSettingsPage() {
  return <TemplatesView />;
}
