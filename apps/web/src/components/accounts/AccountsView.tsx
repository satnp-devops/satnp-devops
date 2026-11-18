'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { DataTable, FilterBar, RelativeTime, infiniteRows, type ChipGroupProps, type Column, type SortState } from '@/components/crm';
import { Guard } from '@/components/Guard';
import { Avatar, Badge, Button, EmptyState, Field, PageHeader } from '@/components/ui';
import {
  ACCOUNT_KINDS,
  ACCOUNT_STATUSES,
  ACCOUNT_STATUS_LABELS,
  accountKindLabel,
  sizeSummary,
} from '@/lib/accounts/labels';
import { useAccounts } from '@/lib/accounts/queries';
import { unitsForNewAccount } from '@/lib/accounts/units';
import { formatCount } from '@/lib/crm/format';
import { useDebounced } from '@/lib/hooks';
import type { AccountKind, AccountListItem, AccountSort, LinkStatus } from '@/lib/crm/types';
import { useSession } from '@/lib/session';
import { AccountCreateDialog } from './AccountCreateDialog';
import { AccountStatusPill } from './parts';
import './accounts.css';

// /accounts: institutes known to the working scope's companies, filtered and sorted on the server.

/** The server's sorts; each has one direction. */
const SORTS: Record<string, { sort: AccountSort; direction: SortState['direction'] }> = {
  name: { sort: 'name', direction: 'asc' },
  updatedAt: { sort: '-updatedAt', direction: 'desc' },
  createdAt: { sort: '-createdAt', direction: 'desc' },
};
const DEFAULT_SORT: SortState = { key: 'updatedAt', direction: 'desc' };

type OwnerChoice = '' | 'me' | 'none';

interface Filters {
  q: string;
  kind: AccountKind[];
  status: LinkStatus[];
  owner: OwnerChoice;
  city: string;
  state: string;
  software: string;
  studentsMin: string;
  studentsMax: string;
  includeArchived: boolean;
}

const EMPTY: Filters = {
  q: '',
  kind: [],
  status: [],
  owner: '',
  city: '',
  state: '',
  software: '',
  studentsMin: '',
  studentsMax: '',
  includeArchived: false,
};

const toCount = (text: string): number | undefined => {
  const value = Number.parseInt(text, 10);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
};
/** The working company's link is archived: the institute is hidden from its lists unless asked for. */
const isArchived = (row: AccountListItem): boolean => row.link !== null && !row.companies.some((company) => company.id === row.link?.companyId);

const csvOf = (text: string): string[] =>
  text
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

export function AccountsView() {
  const { canAnywhere } = useSession();
  if (canAnywhere('accounts.view')) return <Accounts />;
  // No institutes in this scope: the shared no-access message, inside the page frame.
  return (
    <>
      <PageHeader title="Accounts" description="Coaching institutes, schools and independent mentors." />
      <div className="content">
        <Guard anyOf={['accounts.view']} anywhere>
          {null}
        </Guard>
      </div>
    </>
  );
}

function Accounts() {
  const session = useSession();
  const { scope } = session;
  const router = useRouter();
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  const [creating, setCreating] = useState(false);
  const atCompany = scope.type !== 'group';
  // Typed filters wait for a pause in typing, so each keystroke isn't a request.
  const typed = {
    q: useDebounced(filters.q.trim()),
    city: useDebounced(filters.city),
    state: useDebounced(filters.state),
    software: useDebounced(filters.software.trim()),
    min: useDebounced(filters.studentsMin),
    max: useDebounced(filters.studentsMax),
  };

  const query = useAccounts(scope.id, {
    q: typed.q || undefined,
    kind: filters.kind,
    status: filters.status,
    owner: filters.owner ? [filters.owner] : undefined,
    city: csvOf(typed.city),
    state: csvOf(typed.state),
    currentSoftware: typed.software || undefined,
    studentCountMin: toCount(typed.min),
    studentCountMax: toCount(typed.max),
    includeArchived: filters.includeArchived,
    sort: SORTS[sort.key]?.sort ?? '-updatedAt',
  });
  const table = infiniteRows(query);
  const createUnits = unitsForNewAccount(session);

  const set = <K extends keyof Filters>(key: K, value: Filters[K]) => setFilters((current) => ({ ...current, [key]: value }));
  const moreCount =
    (filters.owner ? 1 : 0) +
    (filters.city.trim() ? 1 : 0) +
    (filters.state.trim() ? 1 : 0) +
    (filters.software.trim() ? 1 : 0) +
    (toCount(filters.studentsMin) !== undefined || toCount(filters.studentsMax) !== undefined ? 1 : 0) +
    (filters.includeArchived ? 1 : 0);
  const filtered = filters.q !== '' || filters.kind.length > 0 || filters.status.length > 0 || moreCount > 0;

  const chips: ChipGroupProps[] = [
    {
      label: 'Kind',
      options: ACCOUNT_KINDS.filter((kind) => kind !== 'other').map((kind) => ({ value: kind, label: accountKindLabel(kind) })),
      selected: filters.kind,
      onChange: (next) => set('kind', next as AccountKind[]),
    },
    {
      label: 'Status',
      options: ACCOUNT_STATUSES.map((status) => ({ value: status, label: ACCOUNT_STATUS_LABELS[status] })),
      selected: filters.status,
      onChange: (next) => set('status', next as LinkStatus[]),
    },
  ];

  const columns: Column<AccountListItem>[] = [
    {
      id: 'name',
      header: 'Institute',
      sortKey: 'name',
      firstDirection: 'asc',
      card: 'title',
      cell: (row) => (
        <div className="accounts-name">
          <Link href={`/accounts/${row.id}`} className="accounts-name__link">
            {row.name}
          </Link>
          <span className="accounts-name__meta">
            {[accountKindLabel(row.kind), [row.city, row.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ')}
          </span>
        </div>
      ),
    },
    {
      id: 'size',
      header: 'Size',
      width: 170,
      hideBelow: 'md',
      cell: (row) => sizeSummary(row.studentCount, row.branchCount) || <span className="muted">Not known</span>,
    },
    {
      id: 'software',
      header: 'Current software',
      width: 170,
      hideBelow: 'lg',
      cell: (row) => row.currentSoftware ?? <span className="muted">Not known</span>,
    },
    atCompany
      ? {
          id: 'status',
          header: 'Status',
          width: 130,
          card: 'plain',
          cell: (row) =>
            row.link ? (
              <span className="row gap-4 nowrap">
                <AccountStatusPill status={row.link.status} />
                {isArchived(row) ? <Badge>Archived</Badge> : null}
              </span>
            ) : null,
        }
      : {
          id: 'companies',
          header: 'Companies',
          width: 190,
          card: 'plain',
          cell: (row) => (
            <span className="row gap-4">
              {row.companies.map((company) => (
                <Badge key={company.id}>{company.name}</Badge>
              ))}
            </span>
          ),
        },
    ...(atCompany
      ? [
          {
            id: 'owner',
            header: 'Owner',
            width: 150,
            hideBelow: 'md',
            cell: (row: AccountListItem) =>
              row.link?.owner ? (
                <span className="row gap-6 nowrap">
                  <Avatar name={row.link.owner.name} size={22} />
                  {row.link.owner.name}
                </span>
              ) : (
                <span className="muted">No owner</span>
              ),
          } satisfies Column<AccountListItem>,
        ]
      : []),
    {
      id: 'deals',
      header: 'Open deals',
      width: 100,
      align: 'end',
      hideBelow: 'md',
      cell: (row) => (row.openDealCount > 0 ? formatCount(row.openDealCount) : <span className="muted">None</span>),
    },
    {
      id: 'updated',
      header: 'Updated',
      width: 120,
      sortKey: 'updatedAt',
      firstDirection: 'desc',
      cell: (row) => <RelativeTime value={row.updatedAt} />,
    },
    {
      id: 'created',
      header: 'Added',
      width: 120,
      sortKey: 'createdAt',
      firstDirection: 'desc',
      hideBelow: 'lg',
      card: 'hidden',
      cell: (row) => <RelativeTime value={row.createdAt} />,
    },
  ];

  const more = (
    <div className="accounts-more">
      <Field label="Owner">
        {(control) => (
          <select {...control} className="select" value={filters.owner} onChange={(event) => set('owner', event.target.value as OwnerChoice)} disabled={!atCompany}>
            <option value="">Anyone</option>
            <option value="me">Me</option>
            <option value="none">No owner</option>
          </select>
        )}
      </Field>
      <Field label="City" hint="Separate several with commas">
        {(control) => <input {...control} className="input" value={filters.city} onChange={(event) => set('city', event.target.value)} />}
      </Field>
      <Field label="State">
        {(control) => <input {...control} className="input" value={filters.state} onChange={(event) => set('state', event.target.value)} />}
      </Field>
      <Field label="Current software" hint="Part of the name, e.g. ERP">
        {(control) => <input {...control} className="input" value={filters.software} onChange={(event) => set('software', event.target.value)} />}
      </Field>
      <fieldset className="field field--group">
        <legend className="field__label">Students</legend>
        <div className="accounts-range">
          <input
            className="input"
            inputMode="numeric"
            aria-label="Students, at least"
            placeholder="From"
            value={filters.studentsMin}
            onChange={(event) => set('studentsMin', event.target.value.replace(/\D/g, ''))}
          />
          <span aria-hidden="true">–</span>
          <input
            className="input"
            inputMode="numeric"
            aria-label="Students, at most"
            placeholder="To"
            value={filters.studentsMax}
            onChange={(event) => set('studentsMax', event.target.value.replace(/\D/g, ''))}
          />
        </div>
      </fieldset>
      <label className="check">
        <input type="checkbox" checked={filters.includeArchived} onChange={(event) => set('includeArchived', event.target.checked)} />
        <span>Include archived</span>
      </label>
    </div>
  );

  const rows = table.rows;
  return (
    <>
      <PageHeader
        title="Accounts"
        description={`Coaching institutes, schools and independent mentors known to ${scope.name}.`}
        actions={
          createUnits.length > 0 ? (
            <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
              Add institute
            </Button>
          ) : undefined
        }
      />
      <div className="content">
        <DataTable
          {...table}
          label="Institutes"
          columns={columns}
          rowId={(row) => row.id}
          sort={sort}
          onSortChange={(next) => setSort({ key: next.key, direction: SORTS[next.key]?.direction ?? 'desc' })}
          onRowActivate={(row) => router.push(`/accounts/${row.id}`)}
          rowClassName={(row) => (isArchived(row) ? 'accounts-row--archived' : undefined)}
          toolbar={
            <FilterBar
              search={{ value: filters.q, onChange: (value) => set('q', value), label: 'Search institutes', placeholder: 'Name, website, email or phone' }}
              chips={chips}
              more={{ content: more, activeCount: moreCount }}
              onClear={() => setFilters(EMPTY)}
            />
          }
          empty={
            filtered ? (
              <EmptyState icon="search" title="No institutes match these filters" action={<Button onClick={() => setFilters(EMPTY)}>Clear filters</Button>}>
                Try another name, kind or city.
              </EmptyState>
            ) : (
              <EmptyState
                icon="building"
                title="No institutes yet"
                action={
                  createUnits.length > 0 ? (
                    <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
                      Add institute
                    </Button>
                  ) : undefined
                }
              >
                Coaching institutes, schools and mentors appear here when someone adds them or they enquire about your software.
              </EmptyState>
            )
          }
          footer={rows.length > 0 ? `Showing ${formatCount(rows.length)} ${rows.length === 1 ? 'institute' : 'institutes'}` : undefined}
        />
      </div>
      <AccountCreateDialog open={creating} onClose={() => setCreating(false)} units={createUnits} />
    </>
  );
}
