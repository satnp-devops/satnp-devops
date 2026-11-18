'use client';

import { useState } from 'react';
import { ConfirmDialog } from '@/components/dialog';
import { EventTable } from '@/components/webhooks/EventTable';
import { JobTable } from '@/components/webhooks/JobTable';
import { Alert, Button, Card, EmptyState, ErrorAlert, PageLoading } from '@/components/ui';
import { formatCount } from '@/lib/crm/format';
import { useJobs, useReplayAll, useWebhookEvents } from '@/lib/webhooks/queries';
import { useSession } from '@/lib/session';

const FAILED_EVENTS = { provider: '', status: 'failed', connectionId: '' } as const;
const FAILED_JOBS = { status: 'failed', mine: false } as const;

/** Everything that failed its last attempt: webhook events and background jobs, each replayable. */
export function DeadLettersView() {
  const { canAnywhere } = useSession();
  return (
    <div className="stack gap-16">
      {canAnywhere('webhooks.view') ? <FailedEvents /> : null}
      <FailedJobs />
    </div>
  );
}

function FailedEvents() {
  const { scope, canAnywhere } = useSession();
  const events = useWebhookEvents(scope.id, FAILED_EVENTS);
  const replayAll = useReplayAll();
  const [confirming, setConfirming] = useState(false);

  if (events.isPending) return <PageLoading />;
  if (events.isError) return <ErrorAlert error={events.error} />;
  const rows = events.data.pages.flatMap((page) => page.data);
  const canReplay = canAnywhere('webhooks.manage') && rows.some((e) => e.canReplay);

  return (
    <Card
      flush
      title="Webhook events"
      description="Events whose handlers failed every attempt. Fix the cause, then replay: the event runs again with fresh attempts, and handlers that had finished are skipped."
      actions={
        canReplay ? (
          <Button size="sm" icon="refresh" onClick={() => setConfirming(true)}>
            Replay all
          </Button>
        ) : null
      }
    >
      {replayAll.isSuccess ? (
        <div className="card__body">
          <Alert tone="success">
            {formatCount(replayAll.data.replayed)} event{replayAll.data.replayed === 1 ? '' : 's'} queued again
            {replayAll.data.remaining > 0 ? `; ${formatCount(replayAll.data.remaining)} still waiting (replay again for the next batch)` : ''}.
          </Alert>
        </div>
      ) : null}
      {rows.length === 0 ? (
        <EmptyState icon="check" title="No dead letters">
          Every webhook event in this scope was processed, or is still being retried.
        </EmptyState>
      ) : (
        <EventTable events={rows} showOwner={scope.type === 'group'} />
      )}
      {events.hasNextPage ? (
        <div className="load-more">
          <Button onClick={() => events.fetchNextPage()} loading={events.isFetchingNextPage}>
            Show older
          </Button>
        </div>
      ) : null}
      <ConfirmDialog
        open={confirming}
        onClose={() => {
          setConfirming(false);
          replayAll.reset();
        }}
        title="Replay every failed event?"
        confirmLabel="Replay all"
        pending={replayAll.isPending}
        error={replayAll.error}
        onConfirm={() => replayAll.mutate({ unitId: scope.id }, { onSuccess: () => setConfirming(false) })}
      >
        <p>
          Up to 200 dead letters in {scope.name} go back on the queue, oldest first. Make sure whatever made them fail is fixed, or they will fail
          again.
        </p>
      </ConfirmDialog>
    </Card>
  );
}

function FailedJobs() {
  const { scope } = useSession();
  const jobs = useJobs(scope.id, FAILED_JOBS);
  if (jobs.isPending) return <PageLoading />;
  if (jobs.isError) return <ErrorAlert error={jobs.error} />;
  const rows = jobs.data.pages.flatMap((page) => page.data);
  return (
    <Card
      flush
      title="Background jobs"
      description="Jobs that failed every attempt: reminders, AI calls, imports and bulk actions. Retry runs them again with the same data."
    >
      {rows.length === 0 ? (
        <EmptyState icon="check" title="No failed jobs">
          Background jobs in this scope either finished or are still being retried.
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
