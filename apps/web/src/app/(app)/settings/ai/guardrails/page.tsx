import type { Metadata } from 'next';
import { GuardrailsView } from './GuardrailsView';

export const metadata: Metadata = { title: 'AI guardrails' };

export default function AiGuardrailsPage() {
  return <GuardrailsView />;
}
