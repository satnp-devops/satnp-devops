import { randomUUID } from 'node:crypto';
import { db, json } from '../../lib/db.js';
import { logger } from '../../lib/logger.js';
import { getQueue, QUEUES } from '../queue.js';
import { isJobName } from './definitions.js';
import { RETRY_POLICY, retryOptions } from './policy.js';

/**
 * Background jobs (docs/platform/WEBHOOKS_AND_JOBS.md). Modules declare processors in module.js
 * (`jobs: { 'deals.bulk': async (data, ctx) => ... }`) and feature code enqueues them:
 *
 *   await enqueueJob('scheduling.reminder', { bookingId }, { runAt: startsAt - 24h, jobId: `reminder-${bookingId}-24h`, unitId });
 *   const { id } = await enqueueJob('deals.bulk', { dealIds, change }, { track: true, unitId, createdBy: req.auth.user.id, label: 'Move 120 deals' });
 *
 * Call it after your transaction commits (the job may start at once). Jobs run in the worker
 * process, retry with exponential backoff, and are dead-lettered after their last attempt.
 */

/** Queue job ids we accept: BullMQ refuses ":" and plain integers. */
const JOB_ID = /^[A-Za-z0-9_.-]{1,200}$/;
const MAX_DATA_BYTES = 256 * 1024;

/** How long finished queue jobs stay in Redis (the database keeps the records that matter). */
export const JOB_RETENTION = Object.freeze({
  removeOnComplete: { age: 24 * 3600, count: 2000 },
  removeOnFail: { age: 7 * 24 * 3600, count: 10000 },
});

export const isQueueJobId = (value) => typeof value === 'string' && JOB_ID.test(value) && !/^\d+$/.test(value);

/**
 * The payload as it travels on the queue: the job's own data plus where it belongs.
 *   data       what the processor receives as its first argument
 *   unitId     the company (or team, or group) it belongs to: scopes its record and dead letter
 *   recordId   background_jobs.id when the job is tracked (or replayed)
 *   createdBy  the user who started it
 */
export const envelopeOf = ({ data, unitId = null, recordId = null, createdBy = null }) => ({ data, unitId, recordId, createdBy });

function checkData(name, data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`Job "${name}": data must be an object`);
  const size = Buffer.byteLength(JSON.stringify(data));
  if (size > MAX_DATA_BYTES) throw new Error(`Job "${name}": data is ${size} bytes; keep it under ${MAX_DATA_BYTES} (store ids, not rows)`);
}

function delayOf({ delay, runAt }) {
  if (runAt !== undefined && runAt !== null) {
    const at = new Date(runAt).getTime();
    if (!Number.isFinite(at)) throw new Error('runAt must be a date or an ISO time');
    return Math.max(0, at - Date.now());
  }
  if (delay === undefined || delay === null) return 0;
  if (!Number.isFinite(delay) || delay < 0) throw new Error('delay must be a number of milliseconds');
  return Math.floor(delay);
}

/**
 * Put a job on the jobs queue.
 *
 * @param {string} name a job declared by a module (module.action)
 * @param {object} data JSON payload (ids, not rows; at most 256 KB)
 * @param {{ delay?: number, runAt?: Date | string, jobId?: string, attempts?: number, backoffMs?: number,
 *           unitId?: string, track?: boolean, label?: string, createdBy?: string }} [options]
 *   delay / runAt  run later (a reminder 24 h before a booking)
 *   jobId          de-duplicates untracked jobs: a second add with the same id is ignored while the
 *                  first is waiting, delayed or running (and for a day after it completes); cancelJob(jobId)
 *   attempts       overrides the job's declared attempts and JOB_MAX_ATTEMPTS
 *   unitId         where the job belongs; required with track, recommended otherwise (dead letters are scoped by it)
 *   track          create a user-visible record (status, progress, result, errors) at once: bulk actions, imports
 * @returns {Promise<{ id: string, queueJobId: string, tracked: boolean, runAt: string }>}
 *   id is the record id for tracked jobs (GET /jobs/:id), otherwise the queue job id
 */
export async function enqueueJob(name, data = {}, options = {}) {
  const { jobId, attempts, backoffMs, unitId = null, track = false, label = null, createdBy = null } = options;
  if (!isJobName(name)) throw new Error(`Job name "${name}" must look like module.action`);
  checkData(name, data);
  if (jobId !== undefined && !isQueueJobId(jobId)) throw new Error(`jobId "${jobId}" may use letters, digits, - _ . (not only digits, no ":")`);
  if (track && jobId !== undefined) throw new Error('A tracked job gets its own id; jobId is for de-duplicating untracked jobs');
  if (track && !unitId) throw new Error('A tracked job needs the unitId it belongs to');
  const wait = delayOf(options);
  const runAt = new Date(Date.now() + wait);
  const retry = retryOptions(RETRY_POLICY.jobs, { attempts, backoffMs });

  let recordId = null;
  if (track) {
    const unit = await db('org_units').where({ id: unitId }).first('id', 'root_id');
    if (!unit) throw new Error(`Job "${name}": unknown unit ${unitId}`);
    recordId = randomUUID();
    await db('background_jobs').insert({
      id: recordId,
      name,
      label: label ? String(label).slice(0, 200) : null,
      group_id: unit.root_id,
      unit_id: unit.id,
      tracked: true,
      status: 'queued',
      data: json(data),
      max_attempts: retry.attempts,
      queue_job_id: recordId,
      run_at: runAt,
      created_by: createdBy,
    });
  }
  const queueJobId = recordId ?? jobId ?? randomUUID();
  try {
    await getQueue(QUEUES.jobs).add(name, envelopeOf({ data, unitId, recordId, createdBy }), {
      jobId: queueJobId,
      ...(wait > 0 ? { delay: wait } : {}),
      ...retry,
      ...JOB_RETENTION,
    });
  } catch (err) {
    // No queue job, no record: the caller sees the failure and nothing runs later by surprise.
    if (recordId) await db('background_jobs').where({ id: recordId }).delete();
    throw err;
  }
  return { id: recordId ?? queueJobId, queueJobId, tracked: Boolean(recordId), runAt: runAt.toISOString() };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Cancel a job that hasn't started: a reminder for a booking that moved, a queued import.
 * Takes a tracked job's record id or an untracked job's queue job id. Running jobs finish.
 * @returns {Promise<boolean>} true when something was cancelled
 */
export async function cancelJob(id) {
  const record = UUID.test(id) ? await db('background_jobs').where({ id }).first('id', 'status', 'queue_job_id') : null;
  const queueJobId = record?.queue_job_id ?? id;
  let removed = false;
  const job = isQueueJobId(queueJobId) ? await getQueue(QUEUES.jobs).getJob(queueJobId) : null;
  if (job) {
    const state = await job.getState();
    if (['delayed', 'waiting', 'prioritized', 'paused'].includes(state)) {
      try {
        await job.remove();
        removed = true;
      } catch (err) {
        // It started between the check and the removal: let it finish.
        logger.debug({ err, jobId: queueJobId }, 'Job started before it could be cancelled');
      }
    }
  }
  if (record && ['queued', 'retrying'].includes(record.status) && (removed || !job)) {
    const updated = await db('background_jobs')
      .where({ id: record.id })
      .whereIn('status', ['queued', 'retrying'])
      .update({ status: 'cancelled', finished_at: db.fn.now(), next_attempt_at: null, updated_at: db.fn.now() });
    return updated > 0;
  }
  return removed;
}
