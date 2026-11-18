import type { Metadata } from 'next';
import { Guard } from '@/components/Guard';
import { ApiKeysView } from './ApiKeysView';

export const metadata: Metadata = { title: 'API keys · Integrations' };

export default function ApiKeysPage() {
  return (
    <Guard anyOf={['api_keys.manage']} anywhere>
      <ApiKeysView />
    </Guard>
  );
}
