import { db } from '../../../lib/db.js';
import { errors } from '../../../lib/errors.js';
import { logger } from '../../../lib/logger.js';
import { decodeCursor, pageOf } from '../../../lib/pagination.js';
import { writeAudit } from '../../../core/audit.js';
import { emitEvent } from '../../../core/events.js';
import { isWithin } from '../../../core/orgTree.js';
import { unitsIndex } from '../../../core/crm/scope.js';
import { getQueue, QUEUES } from '../../../core/queue.js';
import { cancelJob, envelopeOf, JOB_RETENTION } from '../../../core/jobs/queue.js';
import { RETRY_POLICY, retryOptions } from '../../../core/jobs/policy.js';
import { presentJob, presentJobDetail } from '../present.js';

// Background job records (docs/platform/WEBHOOKS_AND_JOBS.md): bulk actions and imports people
// started, and every job that failed its last attempt (dead letters).
//
// Visibility: the person who started a job always sees it. Others need jobs.view at the job's unit
// (roles flow down the tree). A dead letter with no unit (a platform job) needs jobs.view at a group.
// Retrying and cancelling need jobs.manage there, or being the person who started it.
// Records outside the user's scope are 404.

const VIEW = 'jobs.view';
const MANAGE = 'jobs.manage';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const LIST_COLUMNS = [
  'j.id',
  'j.name',
  'j.label',
  'j.status',
  'j.tracked',
  'j.unit_id',
  'j.group_id',
  'j.created_by',
  'j.progress',
  'j.result',
  'j.error_count',
  'j.attempts',
  'j.max_attempts',
  'j.failures',
  'j.last_error',
  'j.run_at',
  'j.next_attempt_at',
  'j.created_at',
  'j.started_at',
  'j.finished_at',
  'j.replay_count',
  'u.name as created_by_name',
];

/** Can the user hold a permission at any group root (for unit-less platform dead letters)? */
const canAtAGroup = (req, index, permission) =>
  req.access.groupIds().some((groupId) => {
    const root = index.get(groupId);
    return root ? req.access.can(permission, root.path) : false;
  });

/** What the user may do with one record. */
function rightsFor(req, index, row) {
  const userId = req.auth.user.id;
  const unit = row.unit_id ? index.get(row.unit_id) : null;
  const can = (permission) => (unit ? req.access.can(permission, unit.path) : !row.unit_id && canAtAGroup(req, index, permission));
  const mine = row.created_by === userId && row.tracked;
  return { visible: mine || can(VIEW), canRetry: mine || can(MANAGE), canCancel: mine || can(MANAGE) };
}

function parseCursor(cursor) {
  const after = decodeCursor(cursor);
  if (!after) return null;
  if (typeof after.t !== 'string' || Number.isNaN(Date.parse(after.t)) || !UUID.test(String(after.id ?? ''))) {
    throw errors.badRequest('Invalid cursor');
  }
  return after;
}

/**
 * Jobs in the working scope: those the user started there, plus everyone's at the units where they
 * hold jobs.view. Filter by status (failed = dead letters), name, or mine.
 */
export async function listJobs(req, { unitId, status, name, mine, cursor, limit }) {
  const index = await unitsIndex(req);
  const unit = index.get(unitId);
  if (!unit || !req.access.canSee(unit.path)) throw errors.notFound('Unit');
  const within = [...index.values()].filter((u) => isWithin(u.path, unit.path));
  const viewable = mine ? [] : within.filter((u) => req.access.can(VIEW, u.path)).map((u) => u.id);
  const platform = !mine && unit.type === 'group' && req.access.can(VIEW, unit.path);
  const userId = req.auth.user.id;
  const after = parseCursor(cursor);

  const rows = await db('background_jobs as j')
    .leftJoin('users as u', 'u.id', 'j.created_by')
    .where((q) => {
      q.where((own) =>
        own
          .where('j.created_by', userId)
          .where('j.tracked', true)
          .whereIn(
            'j.unit_id',
            within.map((u) => u.id),
          ),
      );
      if (viewable.length) q.orWhereIn('j.unit_id', viewable);
      if (platform) q.orWhereNull('j.unit_id');
    })
    .modify((q) => {
      if (status) q.where('j.status', status);
      if (name) q.where('j.name', name);
      if (after) q.whereRaw('(j.created_at, j.id) < (?, ?)', [after.t, after.id]);
    })
    .orderBy([
      { column: 'j.created_at', order: 'desc' },
      { column: 'j.id', order: 'desc' },
    ])
    .limit(limit + 1)
    .select(LIST_COLUMNS);
  const { page, nextCursor } = pageOf(rows, limit, (row) => ({ t: row.created_at.toISOString(), id: row.id }));
  return {
    data: page.map((row) => presentJob(row, { index, ...rightsFor(req, index, row) })),
    nextCursor,
  };
}

async function loadVisibleJob(req, id, trx = db) {
  const row = await trx('background_jobs as j').leftJoin('users as u', 'u.id', 'j.created_by').where('j.id', id).first('j.*', 'u.name as created_by_name');
  if (!row) throw errors.notFound('Job');
  const index = await unitsIndex(req);
  if (row.group_id && !req.access.groupIds().includes(row.group_id)) throw errors.notFound('Job');
  const rights = rightsFor(req, index, row);
  if (!rights.visible) throw errors.notFound('Job');
  return { row, index, rights };
}

export async function getJob(req, id) {
  const { row, index, rights } = await loadVisibleJob(req, id);
  return presentJobDetail(row, { index, ...rights });
}

/** Retry a dead letter: it goes back on the queue with fresh attempts and the same data. */
export async function retryJob(req, id) {
  const { row, index, rights } = await loadVisibleJob(req, id);
  if (!rights.canRetry) throw errors.forbidden();
  const unit = row.unit_id ? index.get(row.unit_id) : null;
  const updated = await db.transaction(async (trx) => {
    const replay = row.replay_count + 1;
    const [record] = await trx('background_jobs')
      .where({ id, status: 'failed' })
      .update({
        status: 'queued',
        attempts: 0,
        replay_count: replay,
        replayed_at: trx.fn.now(),
        replayed_by: req.auth.user.id,
        queue_job_id: `${id}-r${replay}`,
        dedupe_key: null, // a retried schedule dead letter becomes its own record
        next_attempt_at: null,
        finished_at: null,
        run_at: trx.fn.now(),
        updated_at: trx.fn.now(),
      })
      .returning('*');
    if (!record) throw errors.conflict('Only jobs that failed every attempt can be retried');
    await writeAudit(trx, req, { action: 'background_job.retried', entityType: 'background_job', entityId: id, unit, meta: { name: row.name, replay } });
    await emitEvent(trx, {
      type: 'background_job.retried',
      groupId: row.group_id,
      unitId: row.unit_id,
      aggregateType: 'background_job',
      aggregateId: id,
      payload: { name: row.name, replay },
      actorUserId: req.auth.user.id,
    });
    return record;
  });
  try {
    await getQueue(QUEUES.jobs).add(
      updated.name,
      envelopeOf({ data: updated.data ?? {}, unitId: updated.unit_id, recordId: updated.id, createdBy: updated.created_by }),
      { jobId: updated.queue_job_id, ...retryOptions(RETRY_POLICY.jobs, { attempts: Math.max(1, updated.max_attempts) }), ...JOB_RETENTION },
    );
  } catch (err) {
    logger.error({ err, jobId: id }, 'Could not queue a retried job; the sweeper will retry');
  }
  return getJob(req, id);
}

/** Cancel a job that hasn't started (queued, or waiting between attempts). */
export async function cancelBackgroundJob(req, id) {
  const { row, index, rights } = await loadVisibleJob(req, id);
  if (!rights.canCancel) throw errors.forbidden();
  if (!['queued', 'retrying'].includes(row.status)) throw errors.conflict('Only jobs that have not started can be cancelled');
  const cancelled = await cancelJob(id);
  if (!cancelled) throw errors.conflict('The job has already started');
  const unit = row.unit_id ? index.get(row.unit_id) : null;
  await db.transaction(async (trx) => {
    await writeAudit(trx, req, { action: 'background_job.cancelled', entityType: 'background_job', entityId: id, unit, meta: { name: row.name } });
    await emitEvent(trx, {
      type: 'background_job.cancelled',
      groupId: row.group_id,
      unitId: row.unit_id,
      aggregateType: 'background_job',
      aggregateId: id,
      payload: { name: row.name },
      actorUserId: req.auth.user.id,
    });
  });
  return getJob(req, id);
}
