import { json } from '../../lib/db.js';
import { emitEvent } from '../events.js';
import { ACTOR_TYPES, REPLY_KINDS, TIMELINE_DIRECTIONS } from './constants.js';

// The timeline is one append-only stream per deal, contact and account (timeline_events).
// Producers write their entry synchronously, in the same transaction as the change, through
// addTimelineEvent (docs/crm/PHASE2_CONTRACT.md §11 lists which change writes which entry).
//
// Visibility: an entry with company_id = null is a group-level fact about a person (shown to
// anyone who can see them); otherwise it belongs to that company. Entries on a deal are shown
// to whoever can see the deal.

const KIND = /^[a-z][a-z0-9_]{1,39}$/;

/**
 * Check an entry and turn it into a row. Throws TypeError on a programming mistake. Pure.
 * @param {TimelineInput} entry
 * @typedef {{
 *   groupId: string, companyId?: string | null, unitId?: string | null,
 *   dealId?: string | null, contactId?: string | null, accountId?: string | null,
 *   kind: string, channel?: string | null, direction?: 'inbound' | 'outbound' | 'internal' | null,
 *   title?: string | null, body?: string | null, meta?: Record<string, unknown>,
 *   actorType?: 'user' | 'system' | 'ai' | 'contact', actorUserId?: string | null,
 *   sourceEventId?: string | null, occurredAt?: Date | string,
 *   touchDeal?: boolean
 * }} TimelineInput
 */
export function timelineRow(entry) {
  if (!entry?.groupId) throw new TypeError('A timeline entry needs groupId');
  if (!entry.dealId && !entry.contactId && !entry.accountId) {
    throw new TypeError('A timeline entry needs a deal, a contact or an account');
  }
  if (!KIND.test(entry.kind ?? '')) throw new TypeError(`Unknown timeline kind "${entry.kind}"`);
  if (entry.dealId && !entry.companyId) throw new TypeError('Entries on a deal belong to its company');
  const actorType = entry.actorType ?? (entry.actorUserId ? 'user' : 'system');
  if (!ACTOR_TYPES.includes(actorType)) throw new TypeError(`Unknown actor type "${actorType}"`);
  if (entry.direction && !TIMELINE_DIRECTIONS.includes(entry.direction)) {
    throw new TypeError(`Unknown direction "${entry.direction}"`);
  }
  const occurredAt = entry.occurredAt ? new Date(entry.occurredAt) : new Date();
  if (Number.isNaN(occurredAt.getTime())) throw new TypeError('occurredAt is not a valid date');
  return {
    group_id: entry.groupId,
    company_id: entry.companyId ?? null,
    unit_id: entry.unitId ?? null,
    deal_id: entry.dealId ?? null,
    contact_id: entry.contactId ?? null,
    account_id: entry.accountId ?? null,
    kind: entry.kind,
    channel: entry.channel ?? null,
    direction: entry.direction ?? null,
    title: entry.title ? String(entry.title).slice(0, 300) : null,
    body: entry.body ?? null,
    meta: json(entry.meta ?? {}),
    actor_type: actorType,
    actor_user_id: entry.actorUserId ?? null,
    source_event_id: entry.sourceEventId ?? null,
    occurred_at: occurredAt,
  };
}

/** Does this entry answer an enquiry (an outbound message, call, email or meeting by a person or the AI)? */
export const isFirstReplyCandidate = (row) =>
  row.direction === 'outbound' && REPLY_KINDS.includes(row.kind) && (row.actor_type === 'user' || row.actor_type === 'ai');

const COLUMNS = [
  'group_id',
  'company_id',
  'unit_id',
  'deal_id',
  'contact_id',
  'account_id',
  'kind',
  'channel',
  'direction',
  'title',
  'body',
  'meta',
  'actor_type',
  'actor_user_id',
  'source_event_id',
  'occurred_at',
];

/**
 * Append a timeline entry inside the caller's transaction.
 *   - sourceEventId makes it idempotent: a second call with the same id writes nothing and
 *     returns the existing entry (use the provider's message id, the webhook event id, ...).
 *   - An entry on a deal moves deals.last_activity_at forward (touchDeal: false to skip), and the
 *     first outbound reply sets deals.first_replied_at and emits deal.first_replied.
 * One round trip for the common case.
 * @param {import('knex').Knex.Transaction} trx
 * @param {TimelineInput} entry
 * @returns {Promise<{ entry: object, created: boolean }>}
 */
export async function addTimelineEvent(trx, entry) {
  const row = timelineRow(entry);
  const touch = entry.touchDeal !== false && row.deal_id !== null;
  const values = COLUMNS.map((column) => row[column]);
  const { rows } = await trx.raw(
    `with inserted as (
       insert into timeline_events (${COLUMNS.join(', ')})
       values (${COLUMNS.map((column) => (column === 'meta' ? '?::jsonb' : '?')).join(', ')})
       on conflict (source_event_id) where source_event_id is not null do nothing
       returning *
     ), touched as (
       update deals
          set last_activity_at = greatest(deals.last_activity_at, inserted.occurred_at)
         from inserted
        where ?::boolean and deals.id = inserted.deal_id
       returning deals.id
     )
     select * from inserted`,
    [...values, touch],
  );

  if (rows.length === 0) {
    const existing = await trx('timeline_events').where({ source_event_id: row.source_event_id }).first();
    return { entry: existing, created: false };
  }

  const created = rows[0];
  if (created.deal_id && isFirstReplyCandidate(created)) {
    const [deal] = await trx('deals')
      .where({ id: created.deal_id })
      .whereNull('first_replied_at')
      .update({ first_replied_at: created.occurred_at })
      .returning(['id', 'group_id', 'company_id', 'unit_id', 'first_reply_due_at']);
    if (deal) {
      await emitEvent(trx, {
        type: 'deal.first_replied',
        groupId: deal.group_id,
        unitId: deal.unit_id,
        aggregateType: 'deal',
        aggregateId: deal.id,
        actorUserId: created.actor_user_id,
        payload: {
          dealId: deal.id,
          companyId: deal.company_id,
          timelineEventId: String(created.id),
          repliedAt: new Date(created.occurred_at).toISOString(),
          dueAt: deal.first_reply_due_at ? new Date(deal.first_reply_due_at).toISOString() : null,
        },
      });
    }
  }
  return { entry: created, created: true };
}

/**
 * Append many entries at once (seeds, imports, backfills). No idempotency check beyond the unique
 * source_event_id index, and no deal touch: callers set last_activity_at themselves.
 */
export async function insertTimelineEvents(trx, entries, { chunkSize = 500 } = {}) {
  const rows = entries.map(timelineRow);
  for (let i = 0; i < rows.length; i += chunkSize) {
    await trx('timeline_events').insert(rows.slice(i, i + chunkSize));
  }
  return rows.length;
}

/** Present a timeline row for the API (the timeline module adds canEdit/canDelete). */
export function presentTimelineEntry(row, { actor = null } = {}) {
  return {
    id: String(row.id),
    kind: row.kind,
    channel: row.channel ?? null,
    direction: row.direction ?? null,
    title: row.title ?? null,
    body: row.body ?? null,
    meta: row.meta ?? {},
    actorType: row.actor_type,
    actor,
    companyId: row.company_id ?? null,
    unitId: row.unit_id ?? null,
    dealId: row.deal_id ?? null,
    contactId: row.contact_id ?? null,
    accountId: row.account_id ?? null,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
    editedAt: row.edited_at ?? null,
    pinnedAt: row.pinned_at ?? null,
  };
}
