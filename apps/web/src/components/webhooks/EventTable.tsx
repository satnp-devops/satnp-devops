'use client';

import { Fragment, useState } from 'react';
import { DateTime, Mono, StatusPill } from '@/components/crm';
import { Button, ErrorAlert, Spinner } from '@/components/ui';
import { eventTypeLabel, WEBHOOK_STATUS_LABEL, WEBHOOK_STATUS_TONE } from '@/lib/webhooks/display';
import { useReplayEvent, useWebhookEvent } from '@/lib/webhooks/queries';
import type { WebhookEvent } from '@/lib/webhooks/types';

/** The delivery log table: one row per provider event, with details and replay. */
export function EventTable({ events, showOwner }: { events: WebhookEvent[]; showOwner: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const replay = useReplayEvent();

  return (
    <>
      {replay.isError ? (
        <div className="card__body">
          <ErrorAlert error={replay.error} title="The event could not be replayed" />
        </div>
      ) : null}
      <div className="table-wrap">
        <table className="table wh-table">
          <thead>
            <tr>
              <th scope="col">Received</th>
              <th scope="col">Event</th>
              <th scope="col" className="wh-hide-sm">
                Connection
              </th>
              <th scope="col">Status</th>
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <Fragment key={e.id}>
                <tr>
                  <td className="nowrap wh-cell-time">
                    <DateTime value={e.receivedAt} format="short" />
                  </td>
                  <td className="wh-cell-main">
                    <div className="wh-event">
                      <span className="strong">{eventTypeLabel(e.type)}</span>
                      {e.eventId ? <Mono>{e.eventId}</Mono> : null}
                      {e.duplicates > 0 ? (
                        <span className="small muted">
                          Delivered {e.duplicates + 1} times (extra copies ignored)
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td className="wh-hide-sm">
                    <div className="stack gap-0">
                      <span>{e.connection.name}</span>
                      <span className="small muted">
                        {e.provider}
                        {showOwner && e.owner ? ` · ${e.owner.name}` : ''}
                      </span>
                    </div>
                  </td>
                  <td className="wh-cell-status">
                    <div className="wh-status">
                      <StatusPill tone={WEBHOOK_STATUS_TONE[e.status]}>{WEBHOOK_STATUS_LABEL[e.status]}</StatusPill>
                      {e.status !== 'rejected' && e.attempts > 0 && e.status !== 'processed' ? (
                        <span className="small muted">
                          Attempt {e.attempts} of {e.maxAttempts}
                        </span>
                      ) : null}
                      {e.nextAttemptAt ? (
                        <span className="small muted">
                          Next try <DateTime value={e.nextAttemptAt} format="time" />
                        </span>
                      ) : null}
                      {e.lastError && e.status !== 'processed' ? <span className="wh-error">{e.lastError}</span> : null}
                    </div>
                  </td>
                  <td className="cell-actions wh-cell-actions">
                    <div className="wh-actions">
                      {e.canReplay ? (
                        <Button
                          size="sm"
                          icon="refresh"
                          loading={replay.isPending && replay.variables === e.id}
                          onClick={() => replay.mutate(e.id)}
                          aria-label={`Replay ${eventTypeLabel(e.type)} ${e.eventId ?? ''}`}
                        >
                          Replay
                        </Button>
                      ) : null}
                      <Button size="sm" variant="ghost" aria-expanded={open === e.id} onClick={() => setOpen(open === e.id ? null : e.id)}>
                        {open === e.id ? 'Hide' : 'Details'}
                      </Button>
                    </div>
                  </td>
                </tr>
                {open === e.id ? (
                  <tr className="wh-details">
                    <td colSpan={5}>
                      <EventDetails id={e.id} />
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

function EventDetails({ id }: { id: string }) {
  const detail = useWebhookEvent(id);
  if (detail.isPending) return <Spinner label="Loading the event" />;
  if (detail.isError) return <ErrorAlert error={detail.error} />;
  const e = detail.data;
  return (
    <div className="stack gap-8">
      <dl className="wh-dl small">
        <dt>Connection</dt>
        <dd>
          {e.connection.name} ({e.provider}, {e.kind})
        </dd>
        {e.reference ? (
          <>
            <dt>Our reference</dt>
            <dd>
              <Mono>{e.reference}</Mono>
            </dd>
          </>
        ) : null}
        {e.occurredAt ? (
          <>
            <dt>Happened</dt>
            <dd>
              <DateTime value={e.occurredAt} />
            </dd>
          </>
        ) : null}
        {e.processedAt ? (
          <>
            <dt>Processed</dt>
            <dd>
              <DateTime value={e.processedAt} /> by {e.handlerCount ?? 0} handler{e.handlerCount === 1 ? '' : 's'}
            </dd>
          </>
        ) : null}
        {e.failedAt ? (
          <>
            <dt>Gave up</dt>
            <dd>
              <DateTime value={e.failedAt} /> after {e.attempts} attempts
            </dd>
          </>
        ) : null}
        {e.replayCount > 0 ? (
          <>
            <dt>Replayed</dt>
            <dd>
              {e.replayCount} time{e.replayCount === 1 ? '' : 's'}
              {e.replayedBy ? `, last by ${e.replayedBy.name}` : ''}
              {e.replayedAt ? (
                <>
                  {' '}
                  (<DateTime value={e.replayedAt} format="short" />)
                </>
              ) : null}
            </dd>
          </>
        ) : null}
        {e.lastError ? (
          <>
            <dt>{e.status === 'processed' ? 'Earlier error' : 'Last error'}</dt>
            <dd className="wh-text-danger">{e.lastError}</dd>
          </>
        ) : null}
        {e.completedHandlers.length > 0 ? (
          <>
            <dt>Finished handlers</dt>
            <dd>
              <ul className="wh-handlers">
                {e.completedHandlers.map((h) => (
                  <li key={h}>
                    <Mono>{h}</Mono>
                  </li>
                ))}
              </ul>
            </dd>
          </>
        ) : null}
        {e.requestId ? (
          <>
            <dt>Request id</dt>
            <dd>
              <Mono>{e.requestId}</Mono>
            </dd>
          </>
        ) : null}
        {e.sourceIp ? (
          <>
            <dt>From</dt>
            <dd>
              <Mono>{e.sourceIp}</Mono>
            </dd>
          </>
        ) : null}
      </dl>
      {e.payload ? (
        <pre className="code-pre wh-payload">{JSON.stringify(e.payload, null, 2)}</pre>
      ) : (
        <p className="small muted">The payload is hidden: it may contain contact details you don&apos;t have access to.</p>
      )}
    </div>
  );
}
