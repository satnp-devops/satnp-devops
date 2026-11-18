import { UnrecoverableError } from 'bullmq';
import { json } from '../../lib/db.js';
import { enqueueJob } from './queue.js';
import { RETRY_POLICY, nextAttemptAt } from './policy.js';
import { throttle } from './throttle.js';

/**
 * Runs background jobs in the worker (worker.js). For each queue job:
 *
 *   1. A tracked job's record is claimed (queued/retrying → running). A cancelled, finished or
 *      superseded record is skipped, so a stale queue job can never run it twice.
 *   2. The module's processor runs as handler(data, ctx). ctx.progress() and ctx.addError() feed
 *      the record the admin screen and GET /jobs/:id show.
 *   3. Success stores the result. A failure records the error and rethrows, so the queue retries
 *      with backoff; after the last attempt the job is dead-lettered (status failed). An untracked
 *      job gets a record only then, so every dead letter is visible and can be retried.
 */

const MAX_ERRORS = 200;
const MAX_RESULT_BYTES = 100_000;
const PROGRESS_EVERY_MS = 500;

/** Throw this from a processor or webhook handler to fail at once, without retries. */
export class PermanentJobError extends UnrecoverableError {
  constructor(message) {
    super(message);
    this.name = 'PermanentJobError';
  }
}

export const errorText = (err) => String(err?.message || err || 'Unknown error').slice(0, 1000);

export function isFinalAttempt(job, err) {
  return err instanceof UnrecoverableError || job.attemptsMade + 1 >= (job.opts?.attempts ?? 1);
}

function cappedResult(result) {
  if (result === undefined) return null;
  const text = JSON.stringify(result);
  if (text === undefined) return null;
  return text.length > MAX_RESULT_BYTES ? { truncated: true, bytes: text.length } : result;
}

function cleanProgress({ done, total, message } = {}) {
  const count = (value) => (Number.isFinite(value) && value >= 0 ? Math.floor(value) : null);
  return { done: count(done) ?? 0, total: count(total), message: message ? String(message).slice(0, 300) : null };
}

/** The ctx a processor receives. */
function jobContext({ job, envelope, recordId, deps }) {
  let progress = null;
  let lastWrite = 0;
  let trailing = null;
  const errors = [];
  let errorCount = 0;

  async function write() {
    if (!recordId) return;
    lastWrite = Date.now();
    await deps.db('background_jobs')
      .where({ id: recordId, status: 'running' })
      .update({ progress: json(progress), errors: json(errors), error_count: errorCount, updated_at: deps.db.fn.now() });
  }

  return {
    db: deps.db,
    redis: deps.redis,
    log: deps.log,
    registry: deps.registry,
    enqueueJob,
    throttle,
    job: {
      id: job.id,
      name: job.name,
      attempt: job.attemptsMade + 1,
      maxAttempts: job.opts?.attempts ?? 1,
      recordId,
      unitId: envelope.unitId ?? null,
      createdBy: envelope.createdBy ?? null,
    },
    /** Report progress: { done, total?, message? }. Written to the record at most twice a second (and at the end). */
    async progress(value) {
      progress = cleanProgress(value);
      await job.updateProgress(progress);
      const since = Date.now() - lastWrite;
      if (since >= PROGRESS_EVERY_MS) {
        await write();
      } else if (!trailing) {
        // Too soon: write the latest value a little later, so a slow step still shows where it is.
        trailing = setTimeout(() => {
          trailing = null;
          write().catch((err) => deps.log.warn({ err }, 'Could not record job progress'));
        }, PROGRESS_EVERY_MS - since);
        trailing.unref?.();
      }
    },
    /** Record a per-item problem (a CSV row that failed) without failing the job. */
    addError(error) {
      errorCount += 1;
      if (errors.length < MAX_ERRORS) {
        const entry = typeof error === 'string' ? { message: error } : { message: String(error?.message ?? 'Error'), item: error?.item ?? null };
        entry.message = entry.message.slice(0, 500);
        errors.push(entry);
      }
    },
    /** @internal the runner's view of what the processor reported */
    state: () => {
      if (trailing) clearTimeout(trailing);
      trailing = null;
      return { progress, errors, errorCount };
    },
  };
}

/**
 * The record of an untracked job that failed its last attempt. Repeating jobs fold their failures
 * into one open dead letter per schedule (dedupe_key), so a broken cron job doesn't flood the list.
 */
async function insertDeadLetter(db, { job, envelope, definition, error }) {
  const unit = envelope.unitId ? await db('org_units').where({ id: envelope.unitId }).first('id', 'root_id') : null;
  const dedupeKey = job.repeatJobKey ? `schedule:${job.name}` : null;
  const values = {
    name: job.name,
    label: definition?.label ?? job.name,
    group_id: unit?.root_id ?? null,
    unit_id: unit?.id ?? null,
    data: json(envelope.data ?? {}),
    attempts: job.attemptsMade + 1,
    max_attempts: job.opts?.attempts ?? 1,
    last_error: error,
    queue_job_id: String(job.id),
    dedupe_key: dedupeKey,
    created_by: envelope.createdBy ?? null,
  };
  await db.raw(
    `insert into background_jobs (name, label, group_id, unit_id, tracked, status, data, attempts, max_attempts, failures, last_error,
                                  queue_job_id, dedupe_key, created_by, started_at, finished_at)
     values (:name, :label, :group_id, :unit_id, false, 'failed', cast(:data as jsonb), :attempts, :max_attempts, 1, :last_error,
             :queue_job_id, :dedupe_key, :created_by, now(), now())
     on conflict (dedupe_key) where status = 'failed'
     do update set failures = background_jobs.failures + 1, last_error = excluded.last_error, attempts = excluded.attempts,
                   data = excluded.data, queue_job_id = excluded.queue_job_id, finished_at = now(), updated_at = now()`,
    values,
  );
}

/**
 * The jobs queue processor. deps: { registry, db, redis, log }.
 * @returns {(job: import('bullmq').Job) => Promise<unknown>}
 */
export function createJobProcessor(deps) {
  const { registry, db } = deps;
  return async function processJob(job) {
    const envelope = job.data && typeof job.data === 'object' && 'data' in job.data ? job.data : { data: job.data ?? {} };
    const definition = registry.jobs.get(job.name) ?? null;
    const recordId = envelope.recordId ?? null;
    const log = deps.log.child({ jobId: job.id, job: job.name, attempt: job.attemptsMade + 1 });

    if (recordId) {
      const claimed = await db('background_jobs')
        .where({ id: recordId, queue_job_id: String(job.id) })
        .whereIn('status', ['queued', 'retrying', 'running']) // running: the queue re-runs a job whose worker died
        .update({
          status: 'running',
          attempts: db.raw('attempts + 1'),
          started_at: db.raw('coalesce(started_at, now())'),
          next_attempt_at: null,
          errors: json([]),
          error_count: 0,
          updated_at: db.fn.now(),
        })
        .returning('id');
      if (claimed.length === 0) {
        log.info({ recordId }, 'Job record is cancelled, finished or superseded: skipping');
        return { skipped: true };
      }
    }

    const ctx = jobContext({ job, envelope, recordId, deps: { ...deps, log } });
    try {
      if (!definition) throw new PermanentJobError(`No module declares the job "${job.name}"`);
      const result = cappedResult(await definition.handler(envelope.data ?? {}, ctx));
      if (recordId) {
        const { progress, errors, errorCount } = ctx.state();
        await db('background_jobs')
          .where({ id: recordId })
          .update({
            status: 'completed',
            result: json(result),
            progress: progress ? json(progress) : null,
            errors: json(errors),
            error_count: errorCount,
            last_error: null,
            finished_at: db.fn.now(),
            updated_at: db.fn.now(),
          });
      }
      return result;
    } catch (err) {
      const final = isFinalAttempt(job, err);
      const message = errorText(err);
      log[final ? 'error' : 'warn']({ err, final }, final ? 'Job failed its last attempt: dead-lettered' : 'Job attempt failed: will retry');
      try {
        if (recordId) {
          const { progress, errors, errorCount } = ctx.state();
          const maxAttempts = job.opts?.attempts ?? 1;
          await db('background_jobs')
            .where({ id: recordId })
            .update({
              status: final ? 'failed' : 'retrying',
              last_error: message,
              progress: progress ? json(progress) : null,
              errors: json(errors),
              error_count: errorCount,
              failures: final ? db.raw('failures + 1') : db.raw('failures'),
              next_attempt_at: final
                ? null
                : nextAttemptAt({
                    failures: job.attemptsMade + 1,
                    maxAttempts,
                    baseMs: Number(job.opts?.backoff?.delay) || RETRY_POLICY.jobs.baseMs,
                    maxMs: RETRY_POLICY.jobs.maxMs,
                    seed: job.id,
                  }),
              finished_at: final ? db.fn.now() : null,
              updated_at: db.fn.now(),
            });
        } else if (final) {
          await insertDeadLetter(db, { job, envelope, definition, error: message });
        }
      } catch (recordErr) {
        log.error({ err: recordErr }, 'Could not record the job failure');
      }
      throw err;
    }
  };
}
