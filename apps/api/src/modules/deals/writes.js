import { json } from '../../lib/db.js';
import { diffObjects } from '../../core/audit.js';
import { insertTimelineEvents } from '../../core/crm/timeline.js';
import { refreshSearchDocuments } from '../../core/crm/search.js';

// Writing planned deal changes. A plan is what one deal's change needs written: column updates,
// a stage history row, timeline entries, outbox events and audit entries. The single endpoints
// commit one plan; bulk actions commit a chunk of plans with one statement per kind of row, in the
// same transaction, so 1000 records don't cost 1000 round trips per table.
//
// emitEvents and writeAudits write exactly the rows core/events.js emitEvent and core/audit.js
// writeAudit write, many at a time.

/**
 * @typedef {{
 *   deal: object,
 *   update: Record<string, unknown>,                 plain column values
 *   updateKey?: string,                              plans with the same key share one UPDATE
 *   rawUpdate?: (trx) => Record<string, unknown>,    values built with trx.raw (same for the group)
 *   history?: object | null,                         a deal_stage_history row
 *   timeline: object[],                              addTimelineEvent inputs (no idempotency key)
 *   events: object[],                                emitEvent inputs
 *   audits: object[],                                writeAudit inputs
 * }} DealPlan
 */

export function newPlan(deal) {
  return { deal, update: {}, history: null, timeline: [], events: [], audits: [] };
}

/** Insert outbox events (core/events.js emitEvent, many at once). */
export async function emitEvents(trx, events) {
  if (events.length === 0) return;
  await trx('outbox_events').insert(
    events.map((event) => ({
      type: event.type,
      group_id: event.groupId ?? null,
      org_unit_id: event.unitId ?? null,
      aggregate_type: event.aggregateType ?? null,
      aggregate_id: event.aggregateId != null ? String(event.aggregateId) : null,
      payload: json(event.payload ?? {}),
      actor_user_id: event.actorUserId ?? null,
    })),
  );
}

/** Insert audit entries (core/audit.js writeAudit, many at once). */
export async function writeAudits(trx, req, entries) {
  if (entries.length === 0) return;
  await trx('audit_logs').insert(
    entries.map((entry) => {
      const { before, after } = diffObjects(entry.before, entry.after);
      const unit = entry.unit ?? null;
      return {
        group_id: unit?.root_id ?? entry.groupId ?? null,
        org_unit_id: unit?.id ?? null,
        actor_user_id: entry.actorUserId ?? req?.auth?.user?.id ?? null,
        actor_type: entry.actorType ?? (req?.auth || entry.actorUserId ? 'user' : 'system'),
        action: entry.action,
        entity_type: entry.entityType ?? null,
        entity_id: entry.entityId != null ? String(entry.entityId) : null,
        before: before && Object.keys(before).length ? json(before) : null,
        after: after && Object.keys(after).length ? json(after) : null,
        meta: entry.meta ? json(entry.meta) : null,
        ip: req?.ip ?? null,
        user_agent: req?.get?.('user-agent')?.slice(0, 400) ?? null,
        request_id: req?.id ?? null,
      };
    }),
  );
}

/**
 * Write a list of plans in the caller's transaction:
 *   one UPDATE per group of identical updates (updated_at = now; last_activity_at moves forward when
 *   a timeline entry is written), the stage history rows, timeline entries, events and audit entries,
 *   then the search documents of every deal touched (removed for archived ones).
 * @param {import('knex').Knex.Transaction} trx
 * @param {import('express').Request | null} req
 * @param {DealPlan[]} plans
 * @param {Date} now
 */
export async function commitPlans(trx, req, plans, now) {
  if (plans.length === 0) return;
  const groups = new Map();
  for (const plan of plans) {
    const touch = plan.timeline.length > 0;
    const key = `${plan.updateKey ?? JSON.stringify(plan.update)}|${touch}`;
    const group = groups.get(key) ?? { ids: [], plan, touch };
    group.ids.push(plan.deal.id);
    groups.set(key, group);
  }
  for (const { ids, plan, touch } of groups.values()) {
    const values = { ...plan.update, ...(plan.rawUpdate ? plan.rawUpdate(trx) : {}), updated_at: now };
    if (touch) values.last_activity_at = trx.raw('greatest(last_activity_at, ?::timestamptz)', [now]);
    for (let i = 0; i < ids.length; i += 500) await trx('deals').whereIn('id', ids.slice(i, i + 500)).update(values);
  }

  const history = plans.map((plan) => plan.history).filter(Boolean);
  if (history.length) await trx('deal_stage_history').insert(history);
  const timeline = plans.flatMap((plan) => plan.timeline);
  if (timeline.length) await insertTimelineEvents(trx, timeline);
  await emitEvents(trx, plans.flatMap((plan) => plan.events));
  await writeAudits(trx, req, plans.flatMap((plan) => plan.audits));
  await refreshSearchDocuments(
    trx,
    'deal',
    plans.map((plan) => plan.deal.id),
  );
}
