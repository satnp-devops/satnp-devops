import { json } from '../lib/db.js';

/**
 * Domain events use a transactional outbox: the event row is written in the same
 * transaction as the change, so an event is never lost and never sent for a change
 * that rolled back. The worker relays rows to a Redis queue and runs the handlers.
 */
export async function emitEvent(trx, event) {
  await trx('outbox_events').insert({
    type: event.type,
    group_id: event.groupId ?? null,
    org_unit_id: event.unitId ?? null,
    aggregate_type: event.aggregateType ?? null,
    aggregate_id: event.aggregateId != null ? String(event.aggregateId) : null,
    payload: json(event.payload ?? {}),
    actor_user_id: event.actorUserId ?? null,
  });
}

export function toEvent(row) {
  return {
    id: row.event_id,
    type: row.type,
    groupId: row.group_id,
    unitId: row.org_unit_id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    payload: row.payload,
    actorUserId: row.actor_user_id,
    occurredAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

/** Move unpublished outbox rows onto the events queue. Safe to run from several workers. */
export async function relayOutbox(db, queue, { batchSize = 100 } = {}) {
  return db.transaction(async (trx) => {
    const rows = await trx('outbox_events')
      .whereNull('published_at')
      .orderBy('id')
      .limit(batchSize)
      .forUpdate()
      .skipLocked();
    if (rows.length === 0) return 0;
    // jobId = event id, so a retried relay can never create duplicate jobs.
    await queue.addBulk(rows.map((row) => ({ name: row.type, data: toEvent(row), opts: { jobId: row.event_id } })));
    await trx('outbox_events')
      .whereIn(
        'id',
        rows.map((row) => row.id),
      )
      .update({ published_at: trx.fn.now() });
    return rows.length;
  });
}

/** Run every handler registered for the event type, plus catch-all handlers. Handlers must be idempotent. */
export async function dispatchEvent(registry, event, deps) {
  const handlers = [...(registry.eventHandlers.get(event.type) ?? []), ...(registry.eventHandlers.get('*') ?? [])];
  for (const handler of handlers) await handler(event, deps);
  return handlers.length;
}
