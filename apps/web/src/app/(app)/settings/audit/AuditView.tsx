'use client';

import { Fragment, useState } from 'react';
import { Guard } from '@/components/Guard';
import { Button, Card, EmptyState, ErrorAlert, Spinner } from '@/components/ui';
import { describeAction, formatDateTime, prettyJson } from '@/lib/format';
import { useAudit } from '@/lib/queries';
import { useSession } from '@/lib/session';
import type { AuditEntry } from '@/lib/types';

// Filters are action prefixes, so new modules' actions ("lead.", "payment.") fit the same way.
const FILTERS = [
  { value: '', label: 'All activity' },
  { value: 'org_unit.', label: 'Organisation changes' },
  { value: 'user.', label: 'People' },
  { value: 'role_assignment.', label: 'Roles given or removed' },
  { value: 'role.', label: 'Role definitions' },
  { value: 'settings.', label: 'Settings' },
];

export function AuditView() {
  return (
    <Guard anyOf={['audit.view']}>
      <Audit />
    </Guard>
  );
}

function Audit() {
  const { scope } = useSession();
  const [action, setAction] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const audit = useAudit(scope.id, action);
  const entries = audit.data?.pages.flatMap((page) => page.data) ?? [];

  return (
    <Card flush title="Audit log" description={`Who changed what in ${scope.name} and everything inside it, newest first`}>
      <div className="toolbar">
        <select
          className="select toolbar__select"
          aria-label="Show"
          value={action}
          onChange={(event) => {
            setAction(event.target.value);
            setOpenId(null);
          }}
        >
          {FILTERS.map((filter) => (
            <option key={filter.value} value={filter.value}>
              {filter.label}
            </option>
          ))}
        </select>
        {audit.isFetching && !audit.isPending ? <Spinner label="Updating" /> : null}
      </div>

      {audit.isPending ? (
        <div className="empty">
          <Spinner />
        </div>
      ) : audit.isError ? (
        <div className="card__body">
          <ErrorAlert error={audit.error} />
        </div>
      ) : entries.length === 0 ? (
        <EmptyState icon="history" title="Nothing to show">
          Changes appear here as soon as they&apos;re made.
        </EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Who</th>
                <th scope="col">What</th>
                <th scope="col">Where</th>
                <th scope="col">
                  <span className="visually-hidden">Details</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <Fragment key={entry.id}>
                  <tr>
                    <td className="nowrap">{formatDateTime(entry.createdAt)}</td>
                    <td>
                      {entry.actor ? (
                        <div className="stack gap-0">
                          <span className="strong">{entry.actor.name}</span>
                          <span className="small muted">{entry.actor.email}</span>
                        </div>
                      ) : (
                        <span className="muted">System</span>
                      )}
                    </td>
                    <td>
                      <div className="stack gap-0">
                        <span>{describeAction(entry.action)}</span>
                        <span className="mono muted">{entry.action}</span>
                      </div>
                    </td>
                    <td>{entry.unit?.name ?? '—'}</td>
                    <td className="cell-actions">
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={openId === entry.id ? 'chevronDown' : 'chevronRight'}
                        aria-expanded={openId === entry.id}
                        onClick={() => setOpenId(openId === entry.id ? null : entry.id)}
                      >
                        Details
                      </Button>
                    </td>
                  </tr>
                  {openId === entry.id ? (
                    <tr className="detail-row">
                      <td colSpan={5}>
                        <EntryDetails entry={entry} />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {audit.hasNextPage ? (
        <div className="load-more">
          <Button loading={audit.isFetchingNextPage} onClick={() => void audit.fetchNextPage()}>
            Show older
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

function EntryDetails({ entry }: { entry: AuditEntry }) {
  return (
    <div className="stack gap-8">
      {entry.before || entry.after ? (
        <div className="diff">
          <div className="stack gap-4">
            <span className="small strong">Before</span>
            <pre>{prettyJson(entry.before)}</pre>
          </div>
          <div className="stack gap-4">
            <span className="small strong">After</span>
            <pre>{prettyJson(entry.after)}</pre>
          </div>
        </div>
      ) : null}
      {entry.meta ? (
        <div className="stack gap-4">
          <span className="small strong">More</span>
          <pre className="code-pre">{prettyJson(entry.meta)}</pre>
        </div>
      ) : null}
      <p className="small muted">
        {entry.entityType ? `${entry.entityType} ${entry.entityId ?? ''}` : null}
        {entry.ip ? ` · from ${entry.ip}` : null}
        {entry.requestId ? ` · request ${entry.requestId}` : null}
      </p>
    </div>
  );
}
