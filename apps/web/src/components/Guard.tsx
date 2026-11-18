'use client';

import type { ReactNode } from 'react';
import { useSession } from '@/lib/session';
import { EmptyState } from './ui';

/**
 * Show children only when the user holds one of the permissions in their current scope.
 * This only shapes the screen; the API enforces the same rules on every request.
 */
export function Guard({
  anyOf,
  anywhere = false,
  children,
}: {
  anyOf: string[];
  /** Accept the permission anywhere inside the scope, not only at the scope itself. */
  anywhere?: boolean;
  children: ReactNode;
}) {
  const { can, canAnywhere, scope } = useSession();
  const allowed = anyOf.length === 0 || anyOf.some((permission) => (anywhere ? canAnywhere(permission) : can(permission)));
  if (allowed) return <>{children}</>;
  return (
    <div className="card">
      <EmptyState icon="lock" title="You don't have access to this here">
        Your roles don&apos;t include this in {scope.name}. Pick another place in &ldquo;Working in&rdquo;, or ask an admin.
      </EmptyState>
    </div>
  );
}
