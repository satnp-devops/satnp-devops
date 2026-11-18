'use client';

import { useState } from 'react';
import { SearchInput } from '@/components/crm';
import { Avatar, ErrorAlert, Spinner } from '@/components/ui';
import { useContactSearch } from '@/lib/contacts/queries';
import { KIND_LABELS, nameOf } from '@/lib/contacts/labels';
import type { ContactListItem } from '@/lib/crm/types';
import { PiiText } from './PiiText';
import './contacts.css';

/**
 * Find a person in the viewer's scope by name, phone or email and pick one (household members,
 * merge targets). `exclude` hides people who can't be picked (the contact itself, current members).
 */
export function ContactPicker({
  unitId,
  selectedId,
  onSelect,
  exclude = [],
  label = 'Find a person',
}: {
  unitId: string;
  selectedId: string | null;
  onSelect: (contact: ContactListItem) => void;
  exclude?: readonly string[];
  label?: string;
}) {
  const [q, setQ] = useState('');
  const search = useContactSearch(unitId, q);
  const results = (search.data?.data ?? []).filter((contact) => !exclude.includes(contact.id) && !contact.erased);

  return (
    <div className="stack gap-8">
      <SearchInput value={q} onChange={setQ} label={label} placeholder="Name, phone or email" className="contacts-picker-search" />
      {q.length < 2 ? (
        <p className="contacts-sub">Type at least two characters.</p>
      ) : search.isPending ? (
        <Spinner label="Searching" />
      ) : search.isError ? (
        <ErrorAlert error={search.error} />
      ) : results.length === 0 ? (
        <p className="contacts-sub" role="status">
          Nobody matches “{q}”.
        </p>
      ) : (
        <ul className="contacts-candidates" aria-label="Search results">
          {results.map((contact) => (
            <li key={contact.id}>
              <button
                type="button"
                className="contacts-candidate"
                aria-pressed={selectedId === contact.id}
                onClick={() => onSelect(contact)}
              >
                <Avatar name={nameOf(contact)} size={28} />
                <span className="contacts-candidate__text">
                  <span className="strong">{nameOf(contact)}</span>
                  <span className="contacts-sub">
                    {[KIND_LABELS[contact.kind], contact.city].filter(Boolean).join(' · ')}
                    {contact.primaryPhone ? ' · ' : ''}
                    <PiiText value={contact.primaryPhone} kind="phone" masked={contact.piiMasked} />
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
