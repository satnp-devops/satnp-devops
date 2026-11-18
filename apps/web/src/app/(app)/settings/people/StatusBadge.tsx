import { Badge } from '@/components/ui';
import type { UserStatus } from '@/lib/types';

export function StatusBadge({ status }: { status: UserStatus }) {
  if (status === 'active') return <Badge tone="success">Active</Badge>;
  if (status === 'invited') return <Badge tone="accent">Invited</Badge>;
  return <Badge tone="danger">Disabled</Badge>;
}
