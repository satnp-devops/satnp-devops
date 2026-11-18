'use client';

import { StatusPill } from '@/components/crm';
import { Icon } from '@/components/icons';
import { ACCOUNT_STATUS_LABELS, ACCOUNT_STATUS_TONES } from '@/lib/accounts/labels';
import { formatPhone } from '@/lib/contacts/labels';
import type { LinkStatus } from '@/lib/crm/types';
import './accounts.css';

/** A company's relationship with an institute: Prospect, Customer or Churned. */
export function AccountStatusPill({ status, company }: { status: LinkStatus; company?: string }) {
  return (
    <StatusPill tone={ACCOUNT_STATUS_TONES[status]} title={company ? `${ACCOUNT_STATUS_LABELS[status]} for ${company}` : undefined}>
      {company ? <span className="accounts-pill-company">{company}: </span> : null}
      {ACCOUNT_STATUS_LABELS[status]}
    </StatusPill>
  );
}

/**
 * A phone number (spaced for reading) or email. Masked values (the viewer has no right to personal
 * details here) come with a lock and a spoken explanation; the API never sends the full value.
 */
export function PiiText({ value, masked, kind }: { value: string | null; masked: boolean; kind: 'phone' | 'email' }) {
  if (!value) return <span className="muted">Not added</span>;
  if (!masked) {
    const href = kind === 'phone' ? `tel:${value}` : `mailto:${value}`;
    return (
      <a href={href} className={kind === 'phone' ? 'accounts-pii accounts-pii--phone' : 'accounts-pii'}>
        {kind === 'phone' ? formatPhone(value) : value}
      </a>
    );
  }
  return (
    <span className="accounts-pii accounts-pii--masked" title="Hidden: your role doesn't include personal details here">
      <Icon name="lock" size={13} aria-hidden="true" />
      <span aria-hidden="true">{value}</span>
      <span className="visually-hidden">{kind === 'phone' ? 'Phone' : 'Email'} hidden</span>
    </span>
  );
}
