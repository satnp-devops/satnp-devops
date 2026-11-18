import { env } from '../../config/env.js';
import { getQueue, QUEUES } from '../queue.js';
import { envelopeOf, JOB_RETENTION } from '../jobs/queue.js';
import { RETRY_POLICY, retryOptions } from '../jobs/policy.js';
import { webhookJobOptions } from './ingress.js';

/**
 * Housekeeping jobs the webhooks module schedules (modules/webhooks/module.js):
 *
 *   webhooks.sweep  every minute: a webhook event or tracked job still waiting in Postgres whose
 *                   queue job is gone (Redis restarted, enqueue failed after the insert) is queued
 *                   again. Queue job ids are the row ids, so this never duplicates a live job.
 *   webhooks.prune  daily: processed and rejected webhook events older than WEBHOOK_RETENTION_DAYS
 *                   are deleted in batches (failed ones stay until someone replays them).
 */

const STALE_AFTER = "interval '2 minutes'";
const BATCH = 200;

async function missingJobs(queue, rows, idOf) {
  const missing = [];
  for (const row of rows) {
    const job = await queue.getJob(idOf(row));
    if (!job) missing.push(row);
  }
  return missing;
}

export async function sweepStuck({ db, log }) {
  const webhooks = getQueue(QUEUES.webhooks);
  const events = await db('webhook_events')
    .whereIn('status', ['queued', 'processing', 'retrying'])
    .where('updated_at', '<', db.raw(`now() - ${STALE_AFTER}`))
    .orderBy('updated_at')
    .limit(BATCH)
    .select('id', 'type', 'replay_count');
  const lostEvents = await missingJobs(webhooks, events, (row) => queueIdForEvent(row));
  if (lostEvents.length) {
    await webhooks.addBulk(
      lostEvents.map((row) => ({ name: row.type, data: { eventId: row.id }, opts: { jobId: queueIdForEvent(row), ...webhookJobOptions() } })),
    );
    await db('webhook_events').whereIn('id', lostEvents.map((row) => row.id)).update({ updated_at: db.fn.now() });
  }

  const jobsQueue = getQueue(QUEUES.jobs);
  const records = await db('background_jobs')
    .whereIn('status', ['queued', 'running', 'retrying'])
    .where('updated_at', '<', db.raw(`now() - ${STALE_AFTER}`))
    .where((q) => q.whereNull('run_at').orWhere('run_at', '<', db.raw('now()')))
    .orderBy('updated_at')
    .limit(BATCH)
    .select('id', 'name', 'data', 'unit_id', 'created_by', 'queue_job_id', 'max_attempts');
  const lostJobs = await missingJobs(jobsQueue, records, (row) => row.queue_job_id ?? row.id);
  for (const row of lostJobs) {
    await jobsQueue.add(row.name, envelopeOf({ data: row.data ?? {}, unitId: row.unit_id, recordId: row.id, createdBy: row.created_by }), {
      jobId: row.queue_job_id ?? row.id,
      ...retryOptions(RETRY_POLICY.jobs, { attempts: row.max_attempts }),
      ...JOB_RETENTION,
    });
  }
  if (lostJobs.length) {
    await db('background_jobs')
      .whereIn('id', lostJobs.map((row) => row.id))
      .update({ status: 'queued', updated_at: db.fn.now() });
  }
  if (lostEvents.length || lostJobs.length) log.warn({ events: lostEvents.length, jobs: lostJobs.length }, 'Re-queued work whose queue job was lost');
  return { events: lostEvents.length, jobs: lostJobs.length };
}

/** The queue job id carrying a webhook event: its row id, or row id + replay number after a replay. */
export const queueIdForEvent = (row) => (row.replay_count > 0 ? `${row.id}-r${row.replay_count}` : row.id);

export async function pruneOld({ db, log }) {
  let removed = 0;
  for (;;) {
    const count = await db('webhook_events')
      .whereIn(
        'id',
        db('webhook_events')
          .whereIn('status', ['processed', 'rejected'])
          .where('received_at', '<', db.raw(`now() - make_interval(days => ?)`, [env.WEBHOOK_RETENTION_DAYS]))
          .limit(1000)
          .select('id'),
      )
      .delete();
    removed += count;
    if (count < 1000) break;
  }
  if (removed) log.info({ removed }, 'Pruned old webhook events');
  return { removed };
}
