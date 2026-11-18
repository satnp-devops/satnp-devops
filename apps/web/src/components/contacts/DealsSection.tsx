'use client';

import Link from 'next/link';
import { Mono, Money, RelativeTime, Section, StatusPill } from '@/components/crm';
import type { ContactDetail } from '@/lib/crm/types';
import './contacts.css';

/** Deals the person takes part in that the viewer may see; each opens the lead profile. */
export function DealsSection({ contact }: { contact: ContactDetail }) {
  const companyName = (id: string) => contact.links.find((link) => link.company.id === id)?.company.name ?? null;
  return (
    <Section title="Deals" level={3} count={contact.deals.length} flush>
      {contact.deals.length === 0 ? (
        <p className="contacts-empty-line">No deals you can see.</p>
      ) : (
        <ul className="contacts-rows">
          {contact.deals.map((deal) => (
            <li key={deal.id} className="contacts-row">
              <div className="contacts-row__text">
                <Link className="contacts-row__link" href={`/leads/${deal.id}`}>
                  {deal.title}
                </Link>
                <span className="contacts-sub">
                  <Mono>{deal.ref}</Mono>
                  {companyName(deal.companyId) ? ` · ${companyName(deal.companyId)}` : ''}
                  {deal.owner ? ` · ${deal.owner.name}` : ''} · updated <RelativeTime value={deal.updatedAt} sans />
                </span>
              </div>
              <div className="contacts-badges">
                <StatusPill tone={deal.status === 'won' ? 'success' : deal.status === 'lost' ? 'danger' : 'accent'}>{deal.stage.name}</StatusPill>
                <Money minor={deal.value.valueMinor} currency={deal.value.currency} compact />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
