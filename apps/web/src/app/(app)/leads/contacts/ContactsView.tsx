'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { DataTable, FilterBar, RelativeTime, infiniteRows, type Column } from '@/components/crm';
import { ContactDrawer, CreateContactDialog, PiiText, useCreatableUnits } from '@/components/contacts';
import { Guard } from '@/components/Guard';
import { Avatar, Button, EmptyState } from '@/components/ui';
import { KIND_LABELS, nameOf } from '@/lib/contacts/labels';
import { useContactList, type ContactFilters } from '@/lib/contacts/queries';
import type { ContactKind, ContactListItem, ContactSort } from '@/lib/crm/types';
import { useSession } from '@/lib/session';
import { isWithin } from '@/lib/tree';
import './contacts-page.css';

const KIND_FILTERS: ContactKind[] = ['parent', 'student', 'staff'];
const SORTS: Array<{ value: ContactSort; label: string }> = [
  { value: '-updatedAt', label: 'Recently updated' },
  { value: '-createdAt', label: 'Recently added' },
  { value: 'name', label: 'Name, A to Z' },
];
const ALL = '';

export function ContactsView() {
  return (
    <Guard anyOf={['contacts.view']} anywhere>
      <ContactsDirectory />
    </Guard>
  );
}

function ContactsDirectory() {
  const { scope, workUnits } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const contactId = searchParams.get('contact');

  const [q, setQ] = useState('');
  const [kind, setKind] = useState<ContactKind[]>([]);
  const [sort, setSort] = useState<ContactSort>('-updatedAt');
  const [companyId, setCompanyId] = useState(ALL);
  const [creating, setCreating] = useState(false);
  const creatable = useCreatableUnits();

  // At group level (or above companies) the list can be narrowed to one company.
  const companies = useMemo(
    () => workUnits.filter((unit) => unit.type === 'company' && unit.id !== scope.id && isWithin(unit.path, scope.path)),
    [workUnits, scope],
  );
  const company = companies.find((unit) => unit.id === companyId) ?? null;
  const unitId = company?.id ?? scope.id;

  const filters: ContactFilters = { q, kind, sort };
  const list = useContactList(unitId, filters);
  const filtered = q !== '' || kind.length > 0 || company !== null;

  function openContact(id: string | null) {
    const params = new URLSearchParams(searchParams.toString());
    if (id) params.set('contact', id);
    else params.delete('contact');
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  function clearFilters() {
    setQ('');
    setKind([]);
    setCompanyId(ALL);
  }

  const columns: Column<ContactListItem>[] = [
    {
      id: 'name',
      header: 'Name',
      card: 'title',
      cell: (row) => (
        <span className="contacts-person">
          <Avatar name={nameOf(row)} size={30} />
          <span className="contacts-person__text">
            <span className={row.erased ? 'contacts-person__name contacts-person__name--erased' : 'contacts-person__name'}>{nameOf(row)}</span>
            {row.city ? <span className="contacts-sub">{row.city}</span> : null}
          </span>
        </span>
      ),
    },
    {
      id: 'role',
      header: 'Role',
      width: 140,
      cell: (row) => (
        <span>
          {KIND_LABELS[row.kind]}
          {row.kind === 'student' && row.studentProfile.grade ? <span className="contacts-sub"> · Grade {row.studentProfile.grade}</span> : null}
        </span>
      ),
    },
    {
      id: 'reach',
      header: 'Phone and email',
      cell: (row) =>
        row.primaryPhone || row.primaryEmail ? (
          <span className="contacts-reach">
            <PiiText value={row.primaryPhone} kind="phone" masked={row.piiMasked} />
            <PiiText value={row.primaryEmail} kind="email" masked={row.piiMasked} />
          </span>
        ) : (
          <span className="contacts-sub">None</span>
        ),
    },
    {
      id: 'companies',
      header: 'Companies',
      hideBelow: 'md',
      cell: (row) => <span className="contacts-companies">{row.companies.map((c) => c.name).join(', ')}</span>,
    },
    {
      id: 'deals',
      header: 'Open deals',
      width: 100,
      align: 'end',
      hideBelow: 'lg',
      card: 'hidden',
      cell: (row) => <span className="mono">{row.openDealCount}</span>,
    },
    {
      id: 'activity',
      header: 'Last activity',
      width: 130,
      cell: (row) => (row.lastActivityAt ? <RelativeTime value={row.lastActivityAt} /> : <span className="contacts-sub">None yet</span>),
    },
  ];

  const toolbar = (
    <FilterBar
      search={{ value: q, onChange: setQ, label: 'Search contacts', placeholder: 'Search name, phone or email' }}
      chips={[
        {
          label: 'Role',
          options: KIND_FILTERS.map((value) => ({ value, label: KIND_LABELS[value] })),
          selected: kind,
          onChange: (next) => setKind(next as ContactKind[]),
        },
      ]}
      extraActiveCount={company ? 1 : 0}
      onClear={clearFilters}
      end={
        <>
          <label className="visually-hidden" htmlFor="contacts-sort">
            Sort contacts
          </label>
          <select id="contacts-sort" className="select contacts-toolbar-select" value={sort} onChange={(event) => setSort(event.target.value as ContactSort)}>
            {SORTS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          {creatable.length > 0 ? (
            <Button variant="primary" icon="plus" className="contacts-new" onClick={() => setCreating(true)}>
              New contact
            </Button>
          ) : null}
        </>
      }
    >
      {companies.length > 1 ? (
        <>
          <label className="visually-hidden" htmlFor="contacts-company">
            Company
          </label>
          <select id="contacts-company" className="select contacts-toolbar-select" value={companyId} onChange={(event) => setCompanyId(event.target.value)}>
            <option value={ALL}>All companies</option>
            {companies.map((unit) => (
              <option key={unit.id} value={unit.id}>
                {unit.name}
              </option>
            ))}
          </select>
        </>
      ) : null}
    </FilterBar>
  );

  return (
    <>
      <DataTable
        {...infiniteRows(list)}
        label="Contacts"
        columns={columns}
        rowId={(row) => row.id}
        onRowActivate={(row) => openContact(row.id)}
        activeRowId={contactId}
        toolbar={toolbar}
        empty={
          filtered ? (
            <EmptyState icon="search" title="No contacts match" action={<Button onClick={clearFilters}>Clear filters</Button>}>
              Try another name, number or email, or clear the filters.
            </EmptyState>
          ) : (
            <EmptyState
              icon="family"
              title="No contacts yet"
              action={
                creatable.length > 0 ? (
                  <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
                    New contact
                  </Button>
                ) : null
              }
            >
              Parents, students and institute staff appear here once an enquiry arrives or someone adds them.
            </EmptyState>
          )
        }
      />

      <ContactDrawer contactId={contactId} onClose={() => openContact(null)} onOpenContact={openContact} />
      <CreateContactDialog
        open={creating}
        onClose={() => setCreating(false)}
        onDone={(result) => {
          setCreating(false);
          openContact(result.contact.id);
        }}
        onOpenExisting={(id) => {
          setCreating(false);
          openContact(id);
        }}
      />
    </>
  );
}
