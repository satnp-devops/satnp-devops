'use client';

import Link from 'next/link';
import { Money, Mono, RelativeTime, Section, StatusPill, type PillTone } from '@/components/crm';
import { EmptyState } from '@/components/ui';
import type { AccountDetail, DealStatus, DealSummary } from '@/lib/crm/types';
import './accounts.css';

const STATUS: Record<DealStatus, { label: string; tone: PillTone }> = {
  open: { label: 'Open', tone: 'accent' },
  won: { label: 'Won', tone: 'success' },
  lost: { label: 'Lost', tone: 'danger' },
};

/** The institute's deals the viewer may see: open ones first, then the latest closed ones. */
export function AccountDeals({ account }: { account: AccountDetail }) {
  const companyName = new Map(account.links.map((link) => [link.company.id, link.company.name]));
  const showCompany = new Set([...account.openDeals, ...account.closedDeals].map((deal) => deal.companyId)).size > 1;
  const total = account.openDeals.length + account.closedDeals.length;

  return (
    <Section title="Deals" count={total} description={total > 0 ? 'Open deals first, then the latest won and lost' : undefined} flush>
      {total === 0 ? (
        <EmptyState icon="handshake" title="No deals you can see">
          Deals with this institute appear here once someone creates a lead for it.
        </EmptyState>
      ) : (
        <ul className="accounts-deals" aria-label="Deals with this institute">
          {[...account.openDeals, ...account.closedDeals].map((deal) => (
            <DealRow key={deal.id} deal={deal} company={showCompany ? companyName.get(deal.companyId) : undefined} />
          ))}
        </ul>
      )}
    </Section>
  );
}

function DealRow({ deal, company }: { deal: DealSummary; company: string | undefined }) {
  const status = STATUS[deal.status];
  return (
    <li className="accounts-deal">
      <div className="accounts-deal__main">
        <Link href={`/leads/${deal.id}`} className="accounts-deal__title">
          {deal.title}
        </Link>
        <span className="accounts-deal__meta">
          <Mono>{deal.ref}</Mono>
          {company ? <span>{company}</span> : null}
          <span>{deal.stage.name}</span>
          {deal.owner ? <span>{deal.owner.name}</span> : <span className="muted">No owner</span>}
        </span>
      </div>
      <div className="accounts-deal__side">
        {deal.status === 'open' ? null : <StatusPill tone={status.tone}>{status.label}</StatusPill>}
        <Money minor={deal.value.valueMinor} currency={deal.value.currency} />
        <span className="small muted">
          <RelativeTime value={deal.updatedAt} sans />
        </span>
      </div>
    </li>
  );
}
