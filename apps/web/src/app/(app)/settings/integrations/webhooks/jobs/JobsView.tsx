'use client';

import { useState } from 'react';
import { JobTable } from '@/components/webhooks/JobTable';
import { Button, Card, EmptyState, ErrorAlert, PageLoading } from '@/components/ui';
import { useSession } from '@/lib/session';
import { JOB_STATUS_LABEL } from '@/lib/webhooks/display';
import { useJobs } from '@/lib/webhooks/queries';
import { JOB_STATUSES, type JobFilters, type JobStatus } from '@/lib/webhooks/types';

export function JobsView() {
  const { scope, canAnywhere } = useSession();
  const seesEveryone = canAnywhere('jobs.view');
  const [filters, setFilters] = useState<JobFilters>({ status: '', mine: false });
  const jobs = useJobs(scope.id, filters);

  if (jobs.isPending) return <PageLoading />;
  if (jobs.isError) return <ErrorAlert error={jobs.error} />;
  const rows = jobs.data.pages.flatMap((page) => page.data);
  const filtered = Boolean(filters.status || filters.mine);

  return (
    <Card
      flush
      title="Background jobs"
      description={
        seesEveryone
          ? 'Bulk actions, imports and other work running in the background in this scope, with their progress and problems. Jobs that failed every attempt are listed too.'
          : 'The bulk actions and imports you started, with their progress and problems.'
      }
    >
      <div className="toolbar wh-toolbar">
        <label className="visually-hidden" htmlFor="wh-job-status">
          Status
        </label>
        <select
          id="wh-job-status"
          className="select toolbar__select"
          value={filters.status}
          onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value as JobStatus | '' }))}
        >
          <option value="">Every status</option>
          {JOB_STATUSES.map((s) => (
            <option key={s} value={s}>
              {JOB_STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        {seesEveryone ? (
          <label className="wh-toolbar__check">
            <input type="checkbox" checked={filters.mine} onChange={(e) => setFilters((f) => ({ ...f, mine: e.target.checked }))} />
            Only jobs I started
          </label>
        ) : null}
      </div>
      {rows.length === 0 ? (
        <EmptyState icon="list" title={filtered ? 'No jobs match these filters' : 'No background jobs yet'}>
          {filtered
            ? 'Try another status.'
            : 'Bulk actions and imports run in the background; they show up here with their progress, and so does any job that fails every attempt.'}
        </EmptyState>
      ) : (
        <JobTable jobs={rows} />
      )}
      {jobs.hasNextPage ? (
        <div className="load-more">
          <Button onClick={() => jobs.fetchNextPage()} loading={jobs.isFetchingNextPage}>
            Show older
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
