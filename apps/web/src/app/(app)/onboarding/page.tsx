import type { Metadata } from 'next';
import { ChecklistsView } from './ChecklistsView';

export const metadata: Metadata = { title: 'Onboarding' };

export default function OnboardingPage() {
  return <ChecklistsView />;
}
