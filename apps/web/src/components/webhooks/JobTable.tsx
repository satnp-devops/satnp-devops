'use client';

import { Fragment, useState } from 'react';
import { DateTime, Mono, StatusPill, useNow } from '@/components/crm';
import { Button, cx, ErrorAlert, Spinner } from '@/components/ui';
import { formatCount } from '@/lib/crm/format';
import { JOB_STATUS_LABEL, JOB_STATUS_TONE } from '@/lib/webhooks/display';
import { useJob, useJobAction } from '@/lib/webhooks/queries';
import type { BackgroundJob } from '@/lib/webhooks/types';

/** Background jobs: what ran, who started it, how far it got, and what went wrong. */
export function JobTable({ jobs }: { jobs: BackgroundJob[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const now = useNow();
  const retry = useJobAction('retry');
  const cancel = useJobAction('cancel');
  const failure = retry.error ?? cancel.error;

  return (
    <>
      {failure ? (
        <div className="card__body">
          <ErrorAlert error={failure} title={retry.error ? 'The job could not be retried' : 'The job could not be cancelled'} />
        </div>
      ) : null}
      <div className="table-wrap">
        <table className="table wh-table">
          <thead>
            <tr>
              <th scope="col">Started</th>
              <th scope="col">Job</th>
              <th scope="col" className="wh-hide-sm">
                By
              </th>
              <th scope="col">Status</th>
              <th scope="col">
                Progress
              </th>
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <Fragment key={j.id}>
                <tr>
                  <td className="nowrap wh-cell-time">
                    <DateTime value={j.createdAt} format="short" />
                  </td>
                  <td className="wh-cell-main">
                    <div className="wh-event">
                      <span className="strong">{j.label ?? j.name}</span>
                      {j.label && j.label !== j.name ? <Mono>{j.name}</Mono> : null}
                      {!j.tracked ? <span className="small muted">Recorded when it failed every attempt</span> : null}
                      {j.failures > 1 ? <span className="small muted">Failed {j.failures} times</span> : null}
                    </div>
                  </td>
                  <td className="wh-hide-sm">
                    <div className="stack gap-0">
                      <span>{j.createdBy?.name ?? 'System'}</span>
                      {j.unit ? <span className="small muted">{j.unit.name}</span> : null}
                    </div>
                  </td>
                  <td className="wh-cell-status">
                    <div className="wh-status">
                      <StatusPill tone={JOB_STATUS_TONE[j.status]}>{JOB_STATUS_LABEL[j.status]}</StatusPill>
                      {j.status === 'queued' && j.runAt && Date.parse(j.runAt) > now ? (
                        <span className="small muted">
                          Runs <DateTime value={j.runAt} format="short" />
                        </span>
                      ) : null}
                      {j.nextAttemptAt ? (
                        <span className="small muted">
                          Next try <DateTime value={j.nextAttemptAt} format="time" />
                        </span>
                      ) : null}
                      {j.lastError && (j.status === 'failed' || j.status === 'retrying') ? <span className="wh-error">{j.lastError}</span> : null}
                    </div>
                  </td>
                  <td className="wh-cell-progress">
                    <JobProgressBar job={j} />
                  </td>
                  <td className="cell-actions wh-cell-actions">
                    <div className="wh-actions">
                      {j.canRetry ? (
                        <Button size="sm" icon="refresh" loading={retry.isPending && retry.variables === j.id} onClick={() => retry.mutate(j.id)}>
                          Retry
                        </Button>
                      ) : null}
                      {j.canCancel ? (
                        <Button size="sm" variant="ghost" loading={cancel.isPending && cancel.variables === j.id} onClick={() => cancel.mutate(j.id)}>
                          Cancel
                        </Button>
                      ) : null}
                      <Button size="sm" variant="ghost" aria-expanded={open === j.id} onClick={() => setOpen(open === j.id ? null : j.id)}>
                        {open === j.id ? 'Hide' : 'Details'}
                      </Button>
                    </div>
                  </td>
                </tr>
                {open === j.id ? (
                  <tr className="wh-details">
                    <td colSpan={6}>
                      <JobDetails id={j.id} />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function JobProgressBar({ job }: { job: BackgroundJob }) {
  const p = job.progress;
  if (!p) return <span className="small muted">{job.status === 'completed' ? 'Done' : '—'}</span>;
  const percent = job.status === 'completed' ? 100 : (p.percent ?? null);
  const text = p.total ? `${formatCount(p.done)} of ${formatCount(p.total)}` : `${formatCount(p.done)} done`;
  return (
    <div className={cx('wh-progress', job.status === 'completed' && 'wh-progress--done', job.status === 'failed' && 'wh-progress--failed')}>
      {percent !== null ? (
        <div className="wh-progress__track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={`${job.label ?? job.name}: ${percent}%`}>
          <div className="wh-progress__bar" style={{ width: `${percent}%` }} />
        </div>
      ) : null}
      <span className="wh-progress__text">
        {text}
        {job.errorCount > 0 ? ` · ${formatCount(job.errorCount)} skipped` : ''}
      </span>
    </div>
  );
}

function JobDetails({ id }: { id: string }) {
  const detail = useJob(id);
  if (detail.isPending) return <Spinner label="Loading the job" />;
  if (detail.isError) return <ErrorAlert error={detail.error} />;
  const j = detail.data;
  return (
    <div className="stack gap-8">
      <dl className="wh-dl small">
        <dt>Progress</dt>
        <dd>
          <JobProgressBar job={j} />
          {j.progress?.message ? <span className="small muted">{j.progress.message}</span> : null}
        </dd>
        <dt>Attempts</dt>
        <dd>
          {j.attempts} of {j.maxAttempts}
          {j.replayCount > 0 ? ` · retried ${j.replayCount} time${j.replayCount === 1 ? '' : 's'}` : ''}
        </dd>
        {j.startedAt ? (
          <>
            <dt>Started</dt>
            <dd>
              <DateTime value={j.startedAt} />
            </dd>
          </>
        ) : null}
        {j.finishedAt ? (
          <>
            <dt>Finished</dt>
            <dd>
              <DateTime value={j.finishedAt} />
            </dd>
          </>
        ) : null}
        {j.lastError ? (
          <>
            <dt>Last error</dt>
            <dd className="wh-text-danger">{j.lastError}</dd>
          </>
        ) : null}
      </dl>
      {j.errors.length > 0 ? (
        <div className="stack gap-4">
          <p className="small strong">
            Problems ({formatCount(j.errorCount)}
            {j.errorCount > j.errors.length ? `, first ${j.errors.length} shown` : ''})
          </p>
          <ul className="wh-errors small">
            {j.errors.map((error, index) => (
              <li key={index}>{error.message}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {j.result !== null && j.result !== undefined ? (
        <div className="stack gap-4">
          <p className="small strong">Result</p>
          <pre className="code-pre wh-payload">{JSON.stringify(j.result, null, 2)}</pre>
        </div>
      ) : null}
      <div className="stack gap-4">
        <p className="small strong">Data</p>
        <pre className="code-pre wh-payload">{JSON.stringify(j.data, null, 2)}</pre>
      </div>
    </div>
  );
}
