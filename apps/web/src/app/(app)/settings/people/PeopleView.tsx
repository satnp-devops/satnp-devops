'use client';

import { useState } from 'react';
import { Guard } from '@/components/Guard';
import { Avatar, Badge, Button, Card, EmptyState, ErrorAlert, Spinner } from '@/components/ui';
import { formatRelative } from '@/lib/format';
import { useDebounced } from '@/lib/hooks';
import { usePeople } from '@/lib/queries';
import { useSession } from '@/lib/session';
import type { Person, UserStatus } from '@/lib/types';
import { useAssignableUnits } from './AccessPicker';
import { InviteDialog } from './InviteDialog';
import { PersonDialog } from './PersonDialog';
import { StatusBadge } from './StatusBadge';

export function PeopleView() {
  return (
    <Guard anyOf={['users.view']}>
      <People />
    </Guard>
  );
}

function People() {
  const { scope } = useSession();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<UserStatus | ''>('');
  const q = useDebounced(search.trim(), 300);
  const people = usePeople(scope.id, { q, status });
  const canInvite = useAssignableUnits().length > 0;
  const [inviteOpen, setInviteOpen] = useState(false);
  const [openPerson, setOpenPerson] = useState<Person | null>(null);

  const rows: Person[] = people.data?.pages.flatMap((page) => page.data) ?? [];
  const filtered = q !== '' || status !== '';

  return (
    <>
      <Card
        flush
        title="People"
        description={`Everyone with a role in ${scope.name} or anywhere inside it`}
        actions={
          canInvite ? (
            <Button variant="primary" size="sm" icon="plus" onClick={() => setInviteOpen(true)}>
              Invite people
            </Button>
          ) : undefined
        }
      >
        <div className="toolbar">
          <input
            className="input toolbar__search"
            type="search"
            placeholder="Search by name or email"
            aria-label="Search people"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <select
            className="select toolbar__select"
            aria-label="Filter by status"
            value={status}
            onChange={(event) => setStatus(event.target.value as UserStatus | '')}
          >
            <option value="">Everyone</option>
            <option value="active">Active</option>
            <option value="invited">Invited</option>
            <option value="disabled">Disabled</option>
          </select>
          {people.isFetching && !people.isPending ? <Spinner label="Updating" /> : null}
        </div>

        {people.isPending ? (
          <div className="empty">
            <Spinner />
          </div>
        ) : people.isError ? (
          <div className="card__body">
            <ErrorAlert error={people.error} />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState icon="users" title={filtered ? 'Nobody matches' : 'Nobody here yet'}>
            {filtered ? 'Try a different name, email or status.' : canInvite ? 'Invite the first person to get started.' : null}
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Person</th>
                  <th scope="col">Roles</th>
                  <th scope="col">Status</th>
                  <th scope="col">Two-step</th>
                  <th scope="col">Last sign-in</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((person) => (
                  <tr key={person.id} className="is-clickable" onClick={() => setOpenPerson(person)}>
                    <td>
                      <div className="row gap-10 nowrap">
                        <Avatar name={person.name} size={32} />
                        <div className="stack gap-0">
                          <button
                            type="button"
                            className="link-button link-button--plain strong"
                            onClick={(event) => {
                              event.stopPropagation();
                              setOpenPerson(person);
                            }}
                          >
                            {person.name}
                          </button>
                          <span className="small muted">{person.email}</span>
                        </div>
                      </div>
                    </td>
                    <td>
                      <div className="row gap-4">
                        {person.assignments.map((assignment) => (
                          <Badge key={assignment.id} title={`${assignment.role.name} at ${assignment.unit.name}`}>
                            {assignment.role.name} · {assignment.unit.name}
                          </Badge>
                        ))}
                      </div>
                    </td>
                    <td>
                      <StatusBadge status={person.status} />
                    </td>
                    <td>{person.mfaEnabled ? <Badge tone="success">On</Badge> : <span className="muted">Off</span>}</td>
                    <td className="nowrap muted">{person.status === 'invited' ? '—' : formatRelative(person.lastLoginAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {people.hasNextPage ? (
          <div className="load-more">
            <Button loading={people.isFetchingNextPage} onClick={() => void people.fetchNextPage()}>
              Show more
            </Button>
          </div>
        ) : null}
      </Card>

      <InviteDialog open={inviteOpen} onClose={() => setInviteOpen(false)} />
      <PersonDialog person={openPerson} onClose={() => setOpenPerson(null)} />
    </>
  );
}
