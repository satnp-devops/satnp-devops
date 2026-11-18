import { enqueueJob } from '../jobs/queue.js';
import { RETRY_POLICY, nextAttemptAt } from '../jobs/policy.js';
import { errorText, isFinalAttempt } from '../jobs/runner.js';
import { throttle } from '../jobs/throttle.js';
import { handlersFor } from './handlers.js';

/**
 * Processes queued webhook events in the worker (queue `webhooks`, job id = webhook_events.id).
 *
 *   - Only queued, retrying or processing (a worker died mid-way) events run. Processed, failed
 *     and rejected ones are skipped, so a duplicate queue job is harmless; a dead letter runs again
 *     only after a replay sets it back to queued.
 *   - Handlers run one after another, most specific first. Each one that finishes is recorded on
 *     the event (completed_handlers), so a retry runs only the handlers that haven't succeeded.
 *   - A failure stores the error and rethrows: the queue retries with backoff, and after the last
 *     attempt the event is dead-lettered (status failed), visible and replayable.
 */

/** What a handler receives as its first argument. */
export function toHandlerEvent(row, attempt) {
  return Object.freeze({
    id: row.id,
    eventId: row.external_event_id,
    provider: row.provider,
    kind: row.kind,
    type: row.type,
    occurredAt: row.occurred_at instanceof Date ? row.occurred_at.toISOString() : row.occurred_at,
    reference: row.reference ?? null,
    data: row.payload ?? {},
    connectionId: row.connection_id,
    groupId: row.group_id,
    unitId: row.unit_id,
    // The owning company, or null for a group connection shared by several companies.
    companyId: row.unit_type === 'company' ? row.unit_id : null,
    receivedAt: row.received_at instanceof Date ? row.received_at.toISOString() : row.received_at,
    attempt,
  });
}

/**
 * The webhooks queue processor. deps: { registry, db, redis, log }.
 * @returns {(job: import('bullmq').Job) => Promise<{ handled?: number, skipped?: string }>}
 */
export function createWebhookProcessor(deps) {
  const { registry, db } = deps;
  return async function processWebhookEvent(job) {
    const id = job.data?.eventId;
    const row = await db('webhook_events as e')
      .join('org_units as u', 'u.id', 'e.unit_id')
      .where('e.id', id)
      .first('e.*', 'u.type as unit_type');
    if (!row) return { skipped: 'missing' };
    if (!['queued', 'retrying', 'processing'].includes(row.status)) return { skipped: row.status };

    const attempt = job.attemptsMade + 1;
    const maxAttempts = job.opts?.attempts ?? 1;
    const log = deps.log.child({ webhookEventId: id, provider: row.provider, type: row.type, attempt });
    await db('webhook_events')
      .where({ id })
      .update({
        status: 'processing',
        attempts: db.raw('attempts + 1'),
        max_attempts: maxAttempts,
        last_attempt_at: db.fn.now(),
        next_attempt_at: null,
        updated_at: db.fn.now(),
      });

    const event = toHandlerEvent(row, attempt);
    const handlers = handlersFor(registry, row);
    const done = new Set(row.completed_handlers ?? []);
    try {
      for (const handler of handlers) {
        if (done.has(handler.id)) continue;
        await handler.handle(event, { db, redis: deps.redis, log: log.child({ handler: handler.id }), registry, enqueueJob, throttle });
        done.add(handler.id);
        await db('webhook_events')
          .where({ id })
          .update({ completed_handlers: db.raw('array_append(completed_handlers, ?)', [handler.id]), updated_at: db.fn.now() });
      }
      await db('webhook_events').where({ id }).update({
        status: 'processed',
        handler_count: handlers.length,
        last_error: null,
        processed_at: db.fn.now(),
        failed_at: null,
        updated_at: db.fn.now(),
      });
      return { handled: handlers.length };
    } catch (err) {
      const final = isFinalAttempt(job, err);
      log[final ? 'error' : 'warn']({ err, final }, final ? 'Webhook event failed its last attempt: dead-lettered' : 'Webhook handler failed: will retry');
      try {
        await db('webhook_events')
          .where({ id })
          .update({
            status: final ? 'failed' : 'retrying',
            last_error: errorText(err),
            failed_at: final ? db.fn.now() : null,
            next_attempt_at: final
              ? null
              : nextAttemptAt({
                  failures: attempt,
                  maxAttempts,
                  baseMs: Number(job.opts?.backoff?.delay) || RETRY_POLICY.webhooks.baseMs,
                  maxMs: RETRY_POLICY.webhooks.maxMs,
                  seed: job.id,
                }),
            updated_at: db.fn.now(),
          });
      } catch (recordErr) {
        log.error({ err: recordErr }, 'Could not record the webhook failure');
      }
      throw err;
    }
  };
}
