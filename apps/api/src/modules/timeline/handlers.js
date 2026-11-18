import { addTimelineEvent } from '../../core/crm/timeline.js';

// Timeline entries for events emitted by background sweeps (docs/crm/PHASE2_CONTRACT.md §11.1):
// producers write their own entries in their transaction; only sweep events land here. Each entry
// uses sourceEventId "event:<outbox event id>", so a retried job writes nothing twice.

const SWEEP_ENTRIES = {
  'deal.sla_breached': { title: 'Stage SLA missed', meta: (payload) => ({ stageId: payload.stageId ?? null }) },
  'deal.first_reply_overdue': { title: 'First reply overdue', meta: (payload) => ({ channel: payload.channel ?? null }) },
};

const validDate = (value) => {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
};

/**
 * Turn a sweep event into a system entry on its deal (also shown on the deal's contact and institute).
 * @returns {Promise<{ created: boolean, entryId: string | null }>}
 */
export async function writeSweepEntry(event, { db }) {
  const spec = SWEEP_ENTRIES[event.type];
  const dealId = event.payload?.dealId;
  if (!spec || !dealId || !event.id) return { created: false, entryId: null };
  return db.transaction(async (trx) => {
    const deal = await trx('deals')
      .where({ id: dealId })
      .first('id', 'group_id', 'company_id', 'unit_id', 'primary_contact_id', 'account_id');
    if (!deal) return { created: false, entryId: null };
    const dueAt = validDate(event.payload.dueAt);
    const { entry, created } = await addTimelineEvent(trx, {
      groupId: deal.group_id,
      companyId: deal.company_id,
      unitId: deal.unit_id,
      dealId: deal.id,
      contactId: deal.primary_contact_id,
      accountId: deal.account_id,
      kind: 'system',
      title: spec.title,
      meta: { action: event.type, dueAt: dueAt ? dueAt.toISOString() : null, ...spec.meta(event.payload) },
      actorType: 'system',
      sourceEventId: `event:${event.id}`,
      // When it was missed, so the entry sits at the right place in the timeline.
      occurredAt: dueAt ?? validDate(event.occurredAt) ?? new Date(),
      // A missed target is not activity on the deal.
      touchDeal: false,
    });
    return { created, entryId: entry ? String(entry.id) : null };
  });
}

export const timelineEventHandlers = {
  'deal.sla_breached': (event, deps) => writeSweepEntry(event, deps),
  'deal.first_reply_overdue': (event, deps) => writeSweepEntry(event, deps),
};
