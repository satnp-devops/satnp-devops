'use client';

import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { DateTime, KeyValue, Mono, Section, StatusPill, type KeyValueItem } from '@/components/crm';
import { Icon } from '@/components/icons';
import { Alert, Badge, Button, ButtonLink, EmptyState, ErrorAlert, Spinner } from '@/components/ui';
import { isApiError } from '@/lib/api';
import { safeExternalUrl } from '@/lib/objects';
import { ACCOUNT_STATUS_LABELS, accountKindLabel, displayUrl, sizeSummary } from '@/lib/accounts/labels';
import { useAccount, useAccountFields } from '@/lib/accounts/queries';
import { channelLabel, formatCount, humanize } from '@/lib/crm/format';
import type { AccountDetail, CompanyLink, CustomFieldDefinition, CustomValue } from '@/lib/crm/types';
import { useSession } from '@/lib/session';
import { AccountActivity } from './AccountActivity';
import { AccountDeals } from './AccountDeals';
import { AccountEditDialog } from './AccountEditDialog';
import { AccountPeople } from './AccountPeople';
import { AccountStatusPill, PiiText } from './parts';
import './accounts.css';

// /accounts/[id]: the institute's profile, its people, deals and activity, and each company's
// relationship with it (only the companies the viewer can see).

const MATCH_WORDS: Record<string, string> = {
  domain: 'the same website',
  email: 'the same email address',
  phone: 'the same phone number',
  name: 'the same name in the same city',
};

export function AccountProfile({ id, matched, linked }: { id: string; matched?: string; linked?: boolean }) {
  const account = useAccount(id);

  if (account.isPending) {
    return (
      <div className="content accounts-loading" aria-busy="true">
        <Spinner label="Loading institute" />
      </div>
    );
  }
  if (account.isError) {
    const missing = isApiError(account.error) && account.error.status === 404;
    return (
      <div className="content">
        <div className="card">
          {missing ? (
            <EmptyState
              icon="building"
              title="Institute not found"
              action={
                <ButtonLink href="/accounts">Back to accounts</ButtonLink>
              }
            >
              It may belong to a company outside your access, or the link is wrong.
            </EmptyState>
          ) : (
            <div className="card__body stack gap-12">
              <ErrorAlert error={account.error} title="Couldn't load this institute" />
              <div>
                <Button icon="refresh" onClick={() => void account.refetch()}>
                  Try again
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }
  return <Profile account={account.data} matched={matched} linked={linked} />;
}

function Profile({ account, matched, linked }: { account: AccountDetail; matched?: string; linked?: boolean }) {
  const session = useSession();
  const [editing, setEditing] = useState(false);
  const [editLinkId, setEditLinkId] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  /** May the viewer change this company's relationship? (The server checks again.) */
  const canManageLink = (link: CompanyLink) => {
    const unit = session.unitsById.get(link.unit.id);
    const level = unit ? session.level('accounts.manage', unit) : null;
    return level === 'all' || (level === 'own' && link.owner?.id === session.user.id);
  };
  const scopeCompanyLink =
    account.links.find((link) => session.scope.path.includes(link.company.id) && canManageLink(link)) ??
    account.links.find((link) => canManageLink(link)) ??
    null;
  const editLink = account.links.find((link) => link.id === editLinkId) ?? scopeCompanyLink;
  const canEditSomething = account.can.manage || scopeCompanyLink !== null;
  const place = [account.city, account.state].filter(Boolean).join(', ');

  const openEdit = (link: CompanyLink | null) => {
    setEditLinkId(link?.id ?? null);
    setEditing(true);
  };

  return (
    <>
      <header className="page-header accounts-header">
        <div className="page-header__text">
          <Link href="/accounts" className="accounts-back">
            <Icon name="chevronRight" size={14} className="accounts-back__icon" aria-hidden="true" />
            Accounts
          </Link>
          <h1>{account.name}</h1>
          <p>{[accountKindLabel(account.kind), place, account.legalName].filter(Boolean).join(' · ')}</p>
          {account.website || account.primaryPhone || account.primaryEmail ? (
            <ul className="accounts-reach" aria-label="Contact details">
              {account.website ? (
                <li>
                  <Icon name="link" size={14} aria-hidden="true" />
                  <a href={safeExternalUrl(account.website) ?? undefined} target="_blank" rel="noopener noreferrer" className="accounts-external">
                    {displayUrl(account.website)}
                    <span className="visually-hidden"> (website, opens in a new tab)</span>
                  </a>
                </li>
              ) : null}
              {account.primaryPhone ? (
                <li>
                  <Icon name="phone" size={14} aria-hidden="true" />
                  <PiiText value={account.primaryPhone} masked={account.piiMasked} kind="phone" />
                </li>
              ) : null}
              {account.primaryEmail ? (
                <li>
                  <Icon name="mail" size={14} aria-hidden="true" />
                  <PiiText value={account.primaryEmail} masked={account.piiMasked} kind="email" />
                </li>
              ) : null}
            </ul>
          ) : null}
          {account.links.length > 0 ? (
            <div className="accounts-header__links" aria-label="Status per company">
              {account.links.map((link) => (
                <span key={link.id} className="row gap-4 nowrap">
                  <AccountStatusPill status={link.status} company={link.company.name} />
                  {link.archivedAt ? <Badge>Archived</Badge> : null}
                </span>
              ))}
            </div>
          ) : null}
        </div>
        {canEditSomething ? (
          <div className="row">
            <Button icon="edit" onClick={() => openEdit(scopeCompanyLink)}>
              Edit
            </Button>
          </div>
        ) : null}
      </header>

      <div className="content stack gap-16">
        {matched && !dismissed ? (
          <Alert
            tone="info"
            title="This institute was already in the group"
            action={<Button size="sm" variant="ghost" iconOnly icon="x" aria-label="Dismiss" onClick={() => setDismissed(true)} />}
          >
            Found by {MATCH_WORDS[matched] ?? 'its details'}, so nothing was copied.
            {linked ? ' It is now linked to your company too.' : ''} Fill in anything that's missing with Edit.
          </Alert>
        ) : null}

        <dl className="accounts-facts">
          <Fact label="Students" value={account.studentCount !== null ? formatCount(account.studentCount) : null} />
          <Fact label="Branches" value={account.branchCount !== null ? formatCount(account.branchCount) : null} />
          <Fact label="Current software" value={account.currentSoftware} />
          <Fact label="Open deals" value={formatCount(account.openDealCount)} />
        </dl>

        <div className="split">
          <div className="split__main stack gap-16">
            <AccountPeople account={account} />
            <AccountDeals account={account} />
            <AccountActivity accountId={account.id} companies={account.links.map((link) => link.company)} />
          </div>
          <aside className="split__side stack gap-16" aria-label="Institute details">
            <ProfileSection account={account} onEdit={account.can.manage ? () => openEdit(scopeCompanyLink) : undefined} />
            {account.links.map((link) => (
              <RelationshipSection key={link.id} link={link} onEdit={canManageLink(link) ? () => openEdit(link) : undefined} />
            ))}
          </aside>
        </div>
      </div>

      <AccountEditDialog
        account={account}
        link={editLink}
        canEditLink={editLink !== null && canManageLink(editLink)}
        open={editing}
        onClose={() => setEditing(false)}
      />
    </>
  );
}

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="accounts-fact">
      <dt>{label}</dt>
      <dd>{value === null || value === undefined || value === '' ? <span className="muted">Not known</span> : value}</dd>
    </div>
  );
}

function ProfileSection({ account, onEdit }: { account: AccountDetail; onEdit?: () => void }) {
  const address = account.address ? [account.address.line1, account.address.line2, account.address.pincode].filter(Boolean).join(', ') : null;
  const items: KeyValueItem[] = [
    { label: 'Size', value: sizeSummary(account.studentCount, account.branchCount) || null },
    { label: 'Legal name', value: account.legalName },
    { label: 'GSTIN', value: account.profile.gstin ? <Mono>{account.profile.gstin}</Mono> : null },
    {
      label: 'Address',
      value: account.piiMasked ? (
        <span className="accounts-pii accounts-pii--masked">
          <Icon name="lock" size={13} aria-hidden="true" />
          Hidden
        </span>
      ) : (
        address
      ),
    },
    { label: 'Country', value: account.countryCode },
    { label: 'Domain', value: account.domain ? <Mono>{account.domain}</Mono> : null },
    { label: 'Boards', value: account.profile.boards?.join(', ') || null },
    { label: 'Exams', value: account.profile.exams?.join(', ') || null },
    { label: 'Budget', value: account.profile.budgetBand ?? null },
    { label: 'Decision timeline', value: account.profile.decisionTimeline ?? null },
  ];
  return (
    <Section
      title="Profile"
      level={2}
      actions={
        onEdit ? (
          <Button size="sm" variant="ghost" icon="edit" onClick={onEdit}>
            Edit
          </Button>
        ) : undefined
      }
    >
      <KeyValue items={items} />
      {account.profile.notes ? <p className="accounts-notes">{account.profile.notes}</p> : null}
    </Section>
  );
}

function customText(definition: CustomFieldDefinition, value: CustomValue | undefined): string | null {
  if (value === undefined || value === null || value === '') return null;
  const label = (raw: string) => definition.options.find((option) => option.value === raw)?.label ?? raw;
  if (Array.isArray(value)) return value.map(label).join(', ') || null;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (definition.type === 'select') return label(String(value));
  return String(value);
}

function RelationshipSection({ link, onEdit }: { link: CompanyLink; onEdit?: () => void }) {
  const fields = useAccountFields(link.company.id);
  const definitions = fields.data ?? [];
  const known = new Set(definitions.map((definition) => definition.key));
  const items: KeyValueItem[] = [
    { label: 'Status', value: <AccountStatusPill status={link.status} /> },
    { label: 'Owner', value: link.owner?.name ?? null },
    { label: 'Team', value: link.unit.name },
    { label: 'Since', value: <DateTime value={link.firstSeenAt} format="date" sans /> },
    {
      label: 'Source',
      value: link.source ? [channelLabel(link.source.channel), link.source.campaign].filter(Boolean).join(' · ') : null,
    },
    {
      label: 'Tags',
      value:
        link.tags.length > 0 ? (
          <span className="row gap-4">
            {link.tags.map((tag) => (
              <Badge key={tag}>{tag}</Badge>
            ))}
          </span>
        ) : null,
    },
    ...definitions.map((definition) => ({ key: definition.key, label: definition.label, value: customText(definition, link.custom[definition.key]) })),
    // Values of fields this page has no definition for (inactive, or the list didn't load): shown raw.
    ...Object.entries(link.custom)
      .filter(([key]) => !known.has(key))
      .map(([key, value]) => ({ key, label: humanize(key), value: Array.isArray(value) ? value.join(', ') : value === null ? null : String(value) })),
  ];
  return (
    <Section
      title={link.company.name}
      description={`${ACCOUNT_STATUS_LABELS[link.status]} · ${link.unit.name}`}
      actions={
        <>
          {link.archivedAt ? <StatusPill tone="warning">Archived</StatusPill> : null}
          {onEdit ? (
            <Button size="sm" variant="ghost" icon="edit" onClick={onEdit} aria-label={`Edit ${link.company.name}'s relationship`}>
              Edit
            </Button>
          ) : null}
        </>
      }
    >
      <KeyValue items={items} />
    </Section>
  );
}
