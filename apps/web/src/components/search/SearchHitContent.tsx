import { Fragment, type ReactNode } from 'react';
import { Money, StatusPill } from '@/components/crm';
import { Icon } from '@/components/icons';
import type { SearchHit } from '@/lib/crm/types';
import { highlightRanges, reasonIcon, TYPE_ICONS, TYPE_NAMES } from '@/lib/search/format';
import './search.css';

/** The title with the typed words marked. */
export function Highlighted({ text, query }: { text: string; query: string }) {
  const ranges = highlightRanges(text, query);
  if (ranges.length === 0) return <>{text}</>;
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start < at) continue;
    if (start > at) parts.push(text.slice(at, start));
    parts.push(
      <mark key={start} className="search-mark">
        {text.slice(start, end)}
      </mark>,
    );
    at = end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

/** Personal data the server masked for this viewer, marked as hidden for screen readers too. */
function ContactPoint({ value, masked }: { value: string; masked: boolean }) {
  return (
    <span className="search-hit__point">
      {masked ? <Icon name="eyeOff" size={13} /> : null}
      <span className="mono">{value}</span>
      {masked ? <span className="visually-hidden"> (partly hidden)</span> : null}
    </span>
  );
}

function facts(hit: SearchHit, showCompany: boolean): ReactNode[] {
  const items: ReactNode[] = [];
  if (hit.type === 'deal') {
    if (hit.status === 'won') {
      items.push(
        <StatusPill key="status" tone="success">
          Won
        </StatusPill>,
      );
    }
    if (hit.status === 'lost') {
      items.push(
        <StatusPill key="status" tone="danger">
          Lost
        </StatusPill>,
      );
    }
    if (showCompany && hit.company) items.push(<span key="company">{hit.company.name}</span>);
    if (hit.value && hit.value.valueMinor > 0) items.push(<Money key="value" minor={hit.value.valueMinor} currency={hit.value.currency} compact />);
    if (hit.owner) {
      items.push(
        <span key="owner" className="search-hit__owner">
          <Icon name="user" size={13} />
          <span className="visually-hidden">Owner: </span>
          {hit.owner.name}
        </span>,
      );
    }
    return items;
  }
  // A phone or email match already shows the matched value in the reason.
  if (hit.contactPoint && hit.matchedOn !== 'phone' && hit.matchedOn !== 'email') {
    items.push(<ContactPoint key="point" value={hit.contactPoint} masked={hit.piiMasked} />);
  }
  return items;
}

/**
 * What a hit shows: type icon, title (typed words marked), subtitle, key facts (deal status,
 * company, value and owner; a person's or institute's phone or email, masked as the server
 * decided) and why it matched.
 */
export function SearchHitContent({
  hit,
  query,
  showCompany = true,
}: {
  hit: SearchHit;
  query: string;
  /** Hide the company name when everything shown is in one company. */
  showCompany?: boolean;
}) {
  const shown = facts(hit, showCompany);
  // Name matches are visible in the title; the server sends a snippet only when it adds something
  // ("Phone +91 •••••••210", "Ref SP-1042", "Contact Priya Sharma").
  const why = hit.snippet;
  return (
    <>
      <span className={`search-hit__icon search-hit__icon--${hit.type}`} aria-hidden="true">
        <Icon name={TYPE_ICONS[hit.type]} size={16} />
      </span>
      <span className="search-hit__body">
        <span className="search-hit__title">
          <span className="visually-hidden">{TYPE_NAMES[hit.type]}: </span>
          <Highlighted text={hit.title} query={query} />
        </span>
        {hit.subtitle ? <span className="search-hit__subtitle">{hit.subtitle}</span> : null}
        {shown.length > 0 || why ? (
          <span className="search-hit__facts">
            {shown.map((item, index) => (
              <Fragment key={index}>
                {index > 0 ? (
                  <span className="search-hit__sep" aria-hidden="true">
                    ·
                  </span>
                ) : null}
                {item}
              </Fragment>
            ))}
            {why ? (
              <span className="search-hit__reason">
                <Icon name={reasonIcon(hit.matchedOn)} size={13} />
                <span className="visually-hidden">Matched on </span>
                {why}
              </span>
            ) : null}
          </span>
        ) : null}
      </span>
    </>
  );
}
