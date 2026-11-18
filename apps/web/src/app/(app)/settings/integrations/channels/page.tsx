import type { Metadata } from 'next';
import { Guard } from '@/components/Guard';
import { ChannelsView } from './ChannelsView';

export const metadata: Metadata = { title: 'Channels · Integrations' };

export default function ChannelsPage() {
  return (
    <Guard anyOf={['integrations.view']} anywhere>
      <ChannelsView />
    </Guard>
  );
}
