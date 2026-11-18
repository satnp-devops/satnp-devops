'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { DataTable, FilterBar, StatusPill, infiniteRows, type Column } from '@/components/crm';
import { Button } from '@/components/ui';
import { kindLabel } from '@/lib/partners/format';
import { usePartners } from '@/lib/partners/queries';
import type { PartnerSummary, PartnershipStatus } from '@/lib/partners/types';
import { useSession } from '@/lib/session';
import { PartnerDialog } from './PartnerDialog';
import { PartnershipPill } from './Parts';

const STATUSES: Array<{ value: '' | PartnershipStatus; label: string }> = [
  { value: '', label: 'Any status' },
  { value: 'active', label: 'Active' },
  { value: 'pending', label: 'Pending' },
  { value: 'suspended', label: 'Suspended' },
  { value: 'terminated', label: 'Ended' },
];

export function PartnersListView() {
  const { scope, workUnits, can } = useSession();
  const router = useRouter();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'' | PartnershipStatus>('');
  const [adding, setAdding] = useState(false);
  const partners = usePartners(scope.id, { q, status });
  const canAdd = workUnits.some((unit) => unit.path.startsWith(scope.path) && unit.type !== 'group' && can('partners.manage', unit));
  const filtered = Boolean(q || status);

  const columns: Column<PartnerSummary>[] = [
    {
      id: 'name',
      header: 'Partner',
      card: 'title',
      cell: (p) => (
        <span className="partners-name">
          <Link href={`/partners/${p.id}`}>{p.name}</Link>
          <span className="partners-sub">
            {kindLabel(p.kind)}
            {p.city ? ` · ${p.city}` : ''}
          </span>
        </span>
      ),
    },
    {
      id: 'companies',
      header: 'Partnerships',
      cell: (p) => (
        <span className="partners-pills">
          {p.companies.map((c) => (
            <span key={c.id} className="row gap-4 nowrap">
              <span className="small">{c.company?.name}</span>
              <PartnershipPill status={c.status} />
            </span>
          ))}
        </span>
      ),
    },
    {
      id: 'owner',
      header: 'Their counsellor',
      hideBelow: 'md',
      cell: (p) => {
        const owners = [...new Set(p.companies.map((c) => c.owner?.name).filter(Boolean))];
        return owners.length ? owners.join(', ') : <span className="muted">Not set</span>;
      },
    },
    {
      id: 'payout',
      header: 'Payouts to',
      hideBelow: 'lg',
      cell: (p) => (p.payout ? <span className="small">{p.payout.summary}</span> : <StatusPill tone="warning">No details</StatusPill>),
    },
    {
      id: 'portal',
      header: 'Portal',
      hideBelow: 'md',
      cell: (p) => (p.hasPortalAccess ? <StatusPill tone="success">Can sign in</StatusPill> : <span className="muted">No sign-in</span>),
    },
  ];

  return (
    <>
      <DataTable
        {...infiniteRows(partners)}
        columns={columns}
        rowId={(p) => p.id}
        label="Partners"
        onRowActivate={(p) => router.push(`/partners/${p.id}`)}
        toolbar={
          <FilterBar
            search={{ value: q, onChange: setQ, label: 'Search partners', placeholder: 'Name, email or phone' }}
            extraActiveCount={status ? 1 : 0}
            onClear={() => {
              setQ('');
              setStatus('');
            }}
            end={
              canAdd ? (
                <Button variant="primary" icon="plus" onClick={() => setAdding(true)}>
                  Add partner
                </Button>
              ) : null
            }
          >
            <select className="select toolbar__select" aria-label="Partnership status" value={status} onChange={(e) => setStatus(e.target.value as '' | PartnershipStatus)}>
                {STATUSES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
            </select>
          </FilterBar>
        }
        empty={
          filtered ? (
            'No partners match these filters.'
          ) : (
            <>
              No brokers or referral partners here yet.
              {canAdd ? ' Add one to give them referral links and track their commissions.' : ''}
            </>
          )
        }
      />
      <PartnerDialog open={adding} onClose={() => setAdding(false)} onCreated={(id) => router.push(`/partners/${id}`)} />
    </>
  );
}
