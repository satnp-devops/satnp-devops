'use client';

import Link from 'next/link';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { DataTable, DateTime, FilterBar, Masked, Mono, StatusPill, infiniteRows, type Column } from '@/components/crm';
import { ErrorAlert } from '@/components/ui';
import { api } from '@/lib/api';
import { SOURCE_LABEL } from '@/lib/partners/format';
import { partnerKeys, useAttributions, useReferralLinks } from '@/lib/partners/queries';
import type { Attribution, ReferralLink, Touch } from '@/lib/partners/types';
import { useSession } from '@/lib/session';
import { Code, ShareLink } from './Parts';

// /partners/links and /partners/leads: every referral link and referred lead in the working scope.

export function LinksView() {
  const { scope, canAnywhere } = useSession();
  const queryClient = useQueryClient();
  const [q, setQ] = useState('');
  const [active, setActive] = useState<'' | 'true' | 'false'>('');
  const links = useReferralLinks(scope.id, { q, active });
  const canManage = canAnywhere('partners.manage');
  const toggle = useMutation({
    mutationFn: (link: ReferralLink) => api.patch<ReferralLink>(`/partner-links/${link.id}`, { active: !link.active }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: partnerKeys.all }),
  });
  const columns: Column<ReferralLink>[] = [
    {
      id: 'code',
      header: 'Code',
      card: 'title',
      width: 190,
      cell: (l) => (
        <span className="partners-name">
          <Code>{l.code}</Code>
          <span className="partners-sub">{l.label ?? 'No label'}</span>
        </span>
      ),
    },
    {
      id: 'partner',
      header: 'Partner',
      cell: (l) => (
        <span className="partners-name">
          <Link href={`/partners/${l.partner.id}`}>{l.partner.name}</Link>
          <span className="partners-sub">
            {l.company?.name}
            {l.productLine ? ` · ${l.productLine.name}` : ''}
          </span>
        </span>
      ),
    },
    { id: 'share', header: 'Share link', hideBelow: 'md', cell: (l) => <ShareLink url={l.shareUrl} /> },
    { id: 'leads', header: 'Leads', width: 70, align: 'end', cell: (l) => l.leadCount },
    {
      id: 'status',
      header: 'Status',
      width: 170,
      cell: (l) => (
        <span className="row gap-8 nowrap">
          {l.active ? <StatusPill tone="success">On</StatusPill> : <StatusPill tone="neutral">Off</StatusPill>}
          {l.createdByPartner ? <StatusPill tone="accent">By partner</StatusPill> : null}
        </span>
      ),
    },
    ...(canManage
      ? [
          {
            id: 'actions',
            header: <span className="visually-hidden">Actions</span>,
            label: 'Actions',
            width: 110,
            card: 'plain' as const,
            cell: (l: ReferralLink) => (
              <button type="button" className="link-button" onClick={() => toggle.mutate(l)} disabled={toggle.isPending} aria-label={`${l.active ? 'Turn off' : 'Turn on'} ${l.code}`}>
                {l.active ? 'Turn off' : 'Turn on'}
              </button>
            ),
          },
        ]
      : []),
  ];
  return (
    <>
      <ErrorAlert error={toggle.error} />
      <DataTable
        {...infiniteRows(links)}
        columns={columns}
        rowId={(l) => l.id}
        label="Referral links"
        toolbar={
          <FilterBar
            search={{ value: q, onChange: setQ, label: 'Search codes', placeholder: 'Code' }}
            extraActiveCount={active ? 1 : 0}
            onClear={() => {
              setQ('');
              setActive('');
            }}
          >
            <select className="select toolbar__select" aria-label="Link status" value={active} onChange={(e) => setActive(e.target.value as '' | 'true' | 'false')}>
                <option value="">On and off</option>
                <option value="true">On</option>
              <option value="false">Off</option>
            </select>
          </FilterBar>
        }
        empty={q || active ? 'No links match these filters.' : 'No referral links yet. Make one from a partner’s page.'}
      />
    </>
  );
}

export function AttributionsView() {
  const { scope } = useSession();
  const [touch, setTouch] = useState<'' | Touch>('');
  const leads = useAttributions(scope.id, { touch, onePerLead: true });
  const columns: Column<Attribution>[] = [
    {
      id: 'deal',
      header: 'Lead',
      card: 'title',
      cell: (a) => (
        <span className="partners-name">
          {a.deal.visible ? <Link href={`/leads/${a.deal.id}`}>{a.deal.title ?? a.deal.ref}</Link> : <span>{a.deal.ref}</span>}
          <span className="partners-sub">
            <Mono>{a.deal.ref}</Mono> · {a.company?.name}
          </span>
        </span>
      ),
    },
    {
      id: 'contact',
      header: 'Family',
      hideBelow: 'md',
      cell: (a) =>
        a.contact ? (
          <span className="partners-name">
            <span>{a.contact.displayName}</span>
            {a.contact.primaryPhone ? (
              a.contact.piiMasked ? (
                <Masked value={a.contact.primaryPhone} kind="phone" />
              ) : (
                <Mono>{a.contact.primaryPhone}</Mono>
              )
            ) : null}
          </span>
        ) : (
          <span className="muted">Not your lead</span>
        ),
    },
    {
      id: 'partner',
      header: 'Partner',
      cell: (a) => <Link href={`/partners/${a.partner.id}`}>{a.partner.name}</Link>,
    },
    {
      id: 'how',
      header: 'Credited by',
      hideBelow: 'lg',
      cell: (a) => (
        <span className="partners-name">
          <span>{SOURCE_LABEL[a.source]}</span>
          <span className="partners-sub">
            {a.bothTouches ? 'First and last touch' : a.touch === 'first' ? 'First touch' : 'Last touch'}
            {a.code ? ` · ${a.code}` : ''}
          </span>
        </span>
      ),
    },
    { id: 'status', header: 'Lead status', width: 120, cell: (a) => <StatusPill tone={a.deal.status === 'won' ? 'success' : a.deal.status === 'lost' ? 'neutral' : 'accent'}>{a.deal.status === 'won' ? 'Won' : a.deal.status === 'lost' ? 'Lost' : 'Open'}</StatusPill> },
    { id: 'at', header: 'Referred', width: 130, cell: (a) => <DateTime value={a.touchedAt} format="date" /> },
  ];
  return (
    <DataTable
      {...infiniteRows(leads)}
      columns={columns}
      rowId={(a) => a.id}
      label="Referred leads"
      toolbar={
        <div className="partners-toolbar">
          <div className="partners-toolbar__filters">
            <select className="select toolbar__select" aria-label="Touch" value={touch} onChange={(e) => setTouch(e.target.value as '' | Touch)}>
              <option value="">One row per lead</option>
              <option value="first">First touch only</option>
              <option value="last">Last touch only</option>
            </select>
          </div>
        </div>
      }
      empty="No referred leads yet. Leads that arrive with a referral or partner code show here."
    />
  );
}
