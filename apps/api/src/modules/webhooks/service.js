import { db } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { decodeCursor, pageOf } from '../../lib/pagination.js';
import { writeAudit } from '../../core/audit.js';
import { emitEvent } from '../../core/events.js';
import { getQueue, QUEUES } from '../../core/queue.js';
import { webhookJobOptions } from '../../core/webhooks/ingress.js';
import { queueIdForEvent } from '../../core/webhooks/maintenance.js';
import { placesWith, workingScope } from '../integrations/scope.js';
import { presentWebhookEvent, presentWebhookEventDetail } from './present.js';

// The webhook delivery log and dead letters (docs/platform/WEBHOOKS_AND_JOBS.md).
//
// An event belongs to its connection's owner: a company, or the group for a connection several
// companies share. People with webhooks.view at the owner see it; at the group they see every
// company's events plus the group's own. The payload (phone numbers, messages) is shown only to
// people with contacts.view_pii there. Events outside the user's scope are 404.

const VIEW = 'webhooks.view';
const MANAGE = 'webhooks.manage';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BULK_REPLAY_LIMIT = 200;

const LIST_COLUMNS = [
  'e.id',
  'e.unit_id',
  'e.group_id',
  'e.connection_id',
  'e.provider',
  'e.kind',
  'e.external_event_id',
  'e.type',
  'e.reference',
  'e.status',
  'e.attempts',
  'e.max_attempts',
  'e.last_error',
  'e.duplicates',
  'e.handler_count',
  'e.occurred_at',
  'e.received_at',
  'e.last_received_at',
  'e.next_attempt_at',
  'e.processed_at',
  'e.failed_at',
  'e.replay_count',
  'e.replayed_at',
  'c.name as connection_name',
];

/** Owner unit ids in the working scope where the user holds a permission. */
async function ownersWith(req, unitId, permission) {
  const scope = await workingScope(req, unitId);
  const { companies, group } = placesWith(req, scope, permission);
  return { scope, unitIds: [...companies.map((c) => c.id), ...(group ? [group.id] : [])] };
}

function parseCursor(cursor) {
  const after = decodeCursor(cursor);
  if (!after) return null;
  if (typeof after.t !== 'string' || Number.isNaN(Date.parse(after.t)) || !UUID.test(String(after.id ?? ''))) {
    throw errors.badRequest('Invalid cursor');
  }
  return after;
}

function applyFilters(query, { provider, kind, status, connectionId, type }) {
  if (provider) query.where('e.provider', provider);
  if (kind) query.where('e.kind', kind);
  if (status) query.where('e.status', status);
  if (connectionId) query.where('e.connection_id', connectionId);
  if (type) query.where('e.type', type);
  return query;
}

export async function listWebhookEvents(req, filters) {
  const { scope, unitIds } = await ownersWith(req, filters.unitId, VIEW);
  if (unitIds.length === 0) throw errors.forbidden();
  const after = parseCursor(filters.cursor);
  const rows = await applyFilters(
    db('webhook_events as e').join('integration_connections as c', 'c.id', 'e.connection_id').whereIn('e.unit_id', unitIds),
    filters,
  )
    .modify((q) => {
      if (after) q.whereRaw('(e.received_at, e.id) < (?, ?)', [after.t, after.id]);
    })
    .orderBy([
      { column: 'e.received_at', order: 'desc' },
      { column: 'e.id', order: 'desc' },
    ])
    .limit(filters.limit + 1)
    .select(LIST_COLUMNS);
  const { page, nextCursor } = pageOf(rows, filters.limit, (row) => ({ t: row.received_at.toISOString(), id: row.id }));
  const managed = placesWith(req, scope, MANAGE);
  const canReplay = new Set([...managed.companies.map((c) => c.id), ...(managed.group ? [managed.group.id] : [])]);
  return {
    data: page.map((row) => presentWebhookEvent(row, { index: scope.index, canReplay: canReplay.has(row.unit_id) })),
    nextCursor,
  };
}

/** Status counts in scope for the tabs: dead letters, retrying, waiting. */
export async function webhookSummary(req, { unitId }) {
  const { unitIds } = await ownersWith(req, unitId, VIEW);
  if (unitIds.length === 0) throw errors.forbidden();
  const rows = await db('webhook_events')
    .whereIn('unit_id', unitIds)
    .whereIn('status', ['queued', 'processing', 'retrying', 'failed'])
    .groupBy('status')
    .select('status', db.raw('count(*)::int as count'));
  const counts = Object.fromEntries(rows.map((row) => [row.status, row.count]));
  return { queued: counts.queued ?? 0, processing: counts.processing ?? 0, retrying: counts.retrying ?? 0, failed: counts.failed ?? 0 };
}

/** Load one event the user may see (404 otherwise), with what they may do with it. */
async function loadVisibleEvent(req, id, trx = db) {
  const row = await trx('webhook_events as e')
    .join('integration_connections as c', 'c.id', 'e.connection_id')
    .leftJoin('users as r', 'r.id', 'e.replayed_by')
    .where('e.id', id)
    .first('e.*', 'c.name as connection_name', 'r.name as replayed_by_name');
  if (!row) throw errors.notFound('Webhook event');
  // An owner the user can't see is a 404, like the event itself; other errors stay errors.
  const scope = await workingScope(req, row.unit_id).catch((err) => {
    if (err?.status === 404) return null;
    throw err;
  });
  const owner = scope?.unit;
  if (!owner || !req.access.can(VIEW, owner.path)) throw errors.notFound('Webhook event');
  return {
    row,
    owner,
    index: scope.index,
    canReplay: req.access.can(MANAGE, owner.path),
    canViewPayload: req.access.can('contacts.view_pii', owner.path),
  };
}

export async function getWebhookEvent(req, id) {
  const { row, index, canReplay, canViewPayload } = await loadVisibleEvent(req, id);
  return presentWebhookEventDetail(row, { index, canReplay, canViewPayload });
}

/** Queue replayed events after their transaction committed; the sweeper covers a queue outage. */
async function queueReplays(rows) {
  try {
    await getQueue(QUEUES.webhooks).addBulk(
      rows.map((row) => ({ name: row.type, data: { eventId: row.id }, opts: { jobId: queueIdForEvent(row), ...webhookJobOptions() } })),
    );
  } catch (err) {
    logger.error({ err, count: rows.length }, 'Could not queue replayed webhook events; the sweeper will retry');
  }
}

const REPLAY_UPDATE = (trx, userId) => ({
  status: 'queued',
  attempts: 0,
  replay_count: trx.raw('replay_count + 1'),
  replayed_at: trx.fn.now(),
  replayed_by: userId,
  next_attempt_at: null,
  failed_at: null,
  updated_at: trx.fn.now(),
});

/** Replay one dead letter: it goes back on the queue with fresh attempts. Handlers that finished before are skipped. */
export async function replayWebhookEvent(req, id) {
  const { owner, canReplay } = await loadVisibleEvent(req, id);
  if (!canReplay) throw errors.forbidden();
  const updated = await db.transaction(async (trx) => {
    const [row] = await trx('webhook_events')
      .where({ id, status: 'failed' })
      .update(REPLAY_UPDATE(trx, req.auth.user.id))
      .returning(['id', 'type', 'provider', 'external_event_id', 'replay_count', 'group_id', 'unit_id']);
    if (!row) throw errors.conflict('Only events that failed every attempt can be replayed');
    await writeAudit(trx, req, {
      action: 'webhook_event.replayed',
      entityType: 'webhook_event',
      entityId: id,
      unit: owner,
      meta: { provider: row.provider, type: row.type, eventId: row.external_event_id, replay: row.replay_count },
    });
    await emitEvent(trx, {
      type: 'webhook_event.replayed',
      groupId: row.group_id,
      unitId: row.unit_id,
      aggregateType: 'webhook_event',
      aggregateId: id,
      payload: { provider: row.provider, type: row.type, replay: row.replay_count },
      actorUserId: req.auth.user.id,
    });
    return row;
  });
  await queueReplays([updated]);
  return getWebhookEvent(req, id);
}

/** Replay the failed events in scope (oldest first, up to 200 per call) where the user may replay. */
export async function replayFailedWebhookEvents(req, filters) {
  const { scope, unitIds } = await ownersWith(req, filters.unitId, MANAGE);
  if (unitIds.length === 0) throw errors.forbidden();
  const base = () =>
    applyFilters(db('webhook_events as e').whereIn('e.unit_id', unitIds).where('e.status', 'failed'), { ...filters, status: undefined });
  const replayed = await db.transaction(async (trx) => {
    const ids = await base()
      .transacting(trx)
      .orderBy('e.failed_at')
      .limit(BULK_REPLAY_LIMIT)
      .forUpdate()
      .skipLocked()
      .pluck('e.id');
    if (ids.length === 0) return [];
    const rows = await trx('webhook_events')
      .whereIn('id', ids)
      .where({ status: 'failed' })
      .update(REPLAY_UPDATE(trx, req.auth.user.id))
      .returning(['id', 'type', 'replay_count', 'unit_id']);
    const unit = scope.company ?? scope.group;
    await writeAudit(trx, req, {
      action: 'webhook_event.bulk_replayed',
      entityType: 'webhook_event',
      unit,
      meta: { count: rows.length, filters: { provider: filters.provider ?? null, connectionId: filters.connectionId ?? null, type: filters.type ?? null } },
    });
    await emitEvent(trx, {
      type: 'webhook_event.bulk_replayed',
      groupId: scope.unit.root_id,
      unitId: unit?.id ?? null,
      aggregateType: 'webhook_event',
      payload: { count: rows.length, ids: rows.map((row) => row.id) },
      actorUserId: req.auth.user.id,
    });
    return rows;
  });
  if (replayed.length) await queueReplays(replayed);
  const [{ count }] = await base().count({ count: '*' });
  return { replayed: replayed.length, remaining: Number(count) };
}
