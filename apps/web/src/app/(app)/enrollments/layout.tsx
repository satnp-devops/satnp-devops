'use client';

import type { ReactNode } from 'react';
import { Tabs } from '@/components/crm';
import { PageHeader } from '@/components/ui';
import { useSession } from '@/lib/session';
import { trailOf } from '@/lib/tree';

/** Enrollments and Batches share a header and tabs. */
export default function EnrollmentsLayout({ children }: Readonly<{ children: ReactNode }>) {
  const session = useSession();
  const trail = trailOf(session.scope, session.unitsById)
    .map((unit) => unit.name)
    .join(' › ');
  return (
    <>
      <PageHeader title="Enrollments" description={`Students, batches and waitlists · ${trail}`} />
      <Tabs
        label="Enrollments sections"
        variant="page"
        items={[
          { href: '/enrollments', label: 'Enrollments', exact: true },
          { href: '/enrollments/batches', label: 'Batches' },
        ]}
      />
      <div className="content">{children}</div>
    </>
  );
}
