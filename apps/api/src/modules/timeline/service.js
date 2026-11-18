import { db } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { decodeCursor, encodeCursor } from '../../lib/pagination.js';
import { writeAudit } from '../../core/audit.js';
import { emitEvent } from '../../core/events.js';
import { isKnownChannel } from '../../core/crm/channels.js';
import { TIMELINE_KINDS } from '../../core/crm/constants.js';
import { unitsIndex } from '../../core/crm/scope.js';
import { addTimelineEvent } from '../../core/crm/timeline.js';
import {
  applySubjectVisibility,
  entryCanViewPii,
  entryFlags,
  entryPermissionPaths,
  loadSubject,
  loadVisibleEntry,
  pickSubject,
} from './access.js';
import { presentEntry } from './present.js';

// Timeline lists and manual entries (docs/crm/PHASE2_CONTRACT.md §9.8). Producers write their own
// entries through core/crm/timeline.js; this service lists them and handles notes and logged activity.

const MAX_PINNED = 5;
const PINNED_LIST_LIMIT = 20;
const FUTURE_SLACK_MS = 5 * 60_000;

/** Columns read for a page, the same for the hot table and the archive (which has archived_at too). */
const ENTRY_COLUMNS = [
  'id',
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
  'created_at',
  'edited_at',
  'pinned_at',
  'deleted_at',
];

/** occurred_at with microseconds, for cursors (a JS Date would drop them and skip rows). */
const CURSOR_AT = `to_char(te.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export const listTimelineKinds = () => TIMELINE_KINDS.map(({ key, label }) => ({ key, label }));

function decodeTimelineCursor(cursor) {
  const after = decodeCursor(cursor);
  if (!after) return null;
  if (typeof after.v !== 'string' || Number.isNaN(Date.parse(after.v)) || !/^\d{1,19}$/.test(String(after.id))) {
    throw errors.badRequest('Invalid cursor');
  }
  return { v: after.v, id: String(after.id) };
}

/** One table's page query: visibility, filters, cursor, order and limit. */
function pageQuery(table, { req, subjectContext, unitsById, query, after, limit, archived }) {
  const builder = db(`${table} as te`).select(
    ...ENTRY_COLUMNS.map((column) => `te.${column}`),
    db.raw(`${CURSOR_AT} as cursor_at`),
    db.raw(`${archived ? 'true' : 'false'} as archived`),
  );
  applySubjectVisibility(builder, req, subjectContext, unitsById);
  if (query.kind?.length) builder.whereIn('te.kind', query.kind);
  if (query.channel?.length) builder.whereIn('te.channel', query.channel);
  if (query.pinned === true) builder.whereNotNull('te.pinned_at');
  if (query.pinned === false) builder.whereNull('te.pinned_at');
  if (after) builder.whereRaw('(te.occurred_at, te.id) < (?::timestamptz, ?::bigint)', [after.v, after.id]);
  return builder.orderBy([
    { column: 'te.occurred_at', order: 'desc' },
    { column: 'te.id', order: 'desc' },
  ]).limit(limit);
}

/** Actors and deals for a page, one query each. */
async function loadPageRelations(rows, trx = db) {
  const actorIds = [...new Set(rows.map((row) => row.actor_user_id).filter(Boolean))];
  const dealIds = [...new Set(rows.map((row) => row.deal_id).filter(Boolean))];
  const [actors, deals] = await Promise.all([
    actorIds.length ? trx('users').whereIn('id', actorIds).select('id', 'name') : [],
    dealIds.length ? trx('deals').whereIn('id', dealIds).select('id', 'ref', 'title', 'status') : [],
  ]);
  return { actors: new Map(actors.map((u) => [u.id, u])), deals: new Map(deals.map((d) => [d.id, d])) };
}

function presentRows(req, rows, { subjectContext, unitsById, relations }) {
  const userId = req.auth.user.id;
  return rows.map((row) => {
    const paths = entryPermissionPaths(row, subjectContext, unitsById);
    return presentEntry(row, {
      actor: relations.actors.get(row.actor_user_id) ?? null,
      deal: relations.deals.get(row.deal_id) ?? null,
      canViewPii: entryCanViewPii(req.access, row, subjectContext, unitsById),
      ...entryFlags(req.access, row, paths, userId),
    });
  });
}

/**
 * GET /timeline: one subject's entries, newest first, keyset-paginated on (occurred_at, id).
 * includeArchive reads timeline_events_archive too, with the same filters and cursor.
 */
export async function listTimeline(req, query) {
  const subject = pickSubject(query, 'query');
  const [subjectContext, unitsById] = await Promise.all([loadSubject(req, subject), unitsIndex(req)]);

  const pinnedOnly = query.pinned === true;
  const limit = pinnedOnly ? PINNED_LIST_LIMIT : query.limit;
  const after = pinnedOnly ? null : decodeTimelineCursor(query.cursor);
  const options = { req, subjectContext, unitsById, query, after, limit: limit + 1 };

  let rows;
  if (query.includeArchive) {
    const hot = pageQuery('timeline_events', { ...options, archived: false });
    const cold = pageQuery('timeline_events_archive', { ...options, archived: true });
    const result = await db.raw('select * from ((?) union all (?)) as page order by occurred_at desc, id desc limit ?', [
      hot,
      cold,
      limit + 1,
    ]);
    rows = result.rows;
  } else {
    rows = await pageQuery('timeline_events', { ...options, archived: false });
  }

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last && !pinnedOnly ? encodeCursor({ v: last.cursor_at, id: String(last.id) }) : null;
  const relations = await loadPageRelations(page);
  return { data: presentRows(req, page, { subjectContext, unitsById, relations }), nextCursor };
}

const defaultDirection = (kind) => (kind === 'note' ? 'internal' : 'outbound');
const DEFAULT_CHANNEL = { call: 'voice_call', email: 'email' };

function checkOccurredAt(value, path) {
  if (!value) return;
  if (new Date(value).getTime() > Date.now() + FUTURE_SLACK_MS) {
    throw errors.validation([{ path, message: "This can't be in the future" }]);
  }
}

/** The company link a person or institute entry belongs to (contract §9.8, POST /timeline). */
function pickLink(subjectContext, companyId) {
  const links = subjectContext.visibleLinks.filter((link) => !link.archived_at);
  if (companyId) {
    const link = links.find((candidate) => candidate.company_id === companyId);
    if (!link) throw errors.validation([{ path: 'body.companyId', message: 'Pick a company that knows this record' }]);
    return link;
  }
  if (links.length === 1) return links[0];
  if (links.length === 0) {
    throw errors.validation([{ path: 'body.companyId', message: 'None of your companies knows this record: add the note on its lead' }]);
  }
  throw errors.validation([{ path: 'body.companyId', message: 'Pick which company this entry belongs to' }]);
}

const auditUnit = (row) => ({ id: row.unit_id, root_id: row.group_id });

const eventPayload = (row) => ({
  entryId: String(row.id),
  kind: row.kind,
  dealId: row.deal_id ?? null,
  contactId: row.contact_id ?? null,
  accountId: row.account_id ?? null,
  companyId: row.company_id ?? null,
});

async function recordChange(trx, req, row, action, extraAudit = {}) {
  await writeAudit(trx, req, {
    action,
    entityType: 'timeline_event',
    entityId: String(row.id),
    unit: row.unit_id ? auditUnit(row) : null,
    groupId: row.group_id,
    ...extraAudit,
  });
  await emitEvent(trx, {
    type: action,
    groupId: row.group_id,
    unitId: row.unit_id ?? null,
    aggregateType: 'timeline_event',
    aggregateId: String(row.id),
    actorUserId: req.auth.user.id,
    payload: eventPayload(row),
  });
}

async function presentOne(req, row, context, unitsById) {
  const relations = await loadPageRelations([row]);
  return presentRows(req, [row], { subjectContext: context, unitsById, relations })[0];
}

/** POST /timeline: add a note or log a call, email, meeting or message. */
export async function addEntry(req, body) {
  const subject = pickSubject(body, 'body');
  if (body.kind === 'note' && !body.body) throw errors.validation([{ path: 'body.body', message: 'Write the note' }]);
  checkOccurredAt(body.occurredAt, 'body.occurredAt');
  const registry = req.app.locals.registry;
  const channel = body.channel === undefined ? (DEFAULT_CHANNEL[body.kind] ?? null) : body.channel;
  if (channel && !isKnownChannel(registry, channel)) throw errors.validation([{ path: 'body.channel', message: 'Unknown channel' }]);
  const userId = req.auth.user.id;

  const { row, context, unitsById } = await db.transaction(async (trx) => {
    const subjectContext = await loadSubject(req, subject, { trx });
    const index = await unitsIndex(req, trx);
    let owned;
    if (subjectContext.type === 'deal') {
      const { deal } = subjectContext;
      owned = {
        groupId: deal.group_id,
        companyId: deal.company_id,
        unitId: deal.unit_id,
        dealId: deal.id,
        contactId: deal.primary_contact_id ?? null,
        accountId: deal.account_id ?? null,
      };
    } else {
      const link = pickLink(subjectContext, body.companyId);
      owned = {
        groupId: subjectContext.groupId,
        companyId: link.company_id,
        unitId: link.unit_id,
        contactId: subjectContext.type === 'contact' ? subjectContext.id : null,
        accountId: subjectContext.type === 'account' ? subjectContext.id : null,
      };
    }
    const unit = index.get(owned.unitId);
    if (!unit || !req.access.can('timeline.write', unit.path)) throw errors.forbidden("You can't add to this timeline");

    const { entry } = await addTimelineEvent(trx, {
      ...owned,
      kind: body.kind,
      channel,
      direction: body.direction ?? defaultDirection(body.kind),
      title: body.title ?? null,
      body: body.body ?? null,
      meta: body.meta ?? {},
      actorType: 'user',
      actorUserId: userId,
      occurredAt: body.occurredAt ?? new Date(),
    });
    await recordChange(trx, req, entry, 'timeline.entry_added', {
      after: { kind: entry.kind, dealId: entry.deal_id, contactId: entry.contact_id, accountId: entry.account_id },
    });
    return { row: entry, context: subjectContext, unitsById: index };
  });
  return presentOne(req, row, context, unitsById);
}

/** PATCH /timeline/:id: the author edits a manual entry. */
export async function editEntry(req, id, body) {
  checkOccurredAt(body.occurredAt, 'body.occurredAt');
  const userId = req.auth.user.id;
  const result = await db.transaction(async (trx) => {
    const { row, context, unitsById } = await loadVisibleEntry(req, id, { trx, forUpdate: true });
    const flags = entryFlags(req.access, row, entryPermissionPaths(row, context, unitsById), userId);
    if (!flags.canEdit) throw errors.forbidden('Only the author can edit this entry');
    if (row.kind === 'note' && body.body !== undefined && !body.body) {
      throw errors.validation([{ path: 'body.body', message: 'Write the note' }]);
    }
    const changes = {};
    if (body.title !== undefined && body.title !== row.title) changes.title = body.title;
    if (body.body !== undefined && body.body !== row.body) changes.body = body.body;
    if (body.occurredAt !== undefined && new Date(body.occurredAt).getTime() !== new Date(row.occurred_at).getTime()) {
      changes.occurred_at = new Date(body.occurredAt);
    }
    if (Object.keys(changes).length === 0) return { row, context, unitsById };
    const [updated] = await trx('timeline_events')
      .where({ id: row.id })
      .update({ ...changes, edited_at: trx.fn.now() })
      .returning('*');
    await recordChange(trx, req, updated, 'timeline.entry_edited', { after: { changed: Object.keys(changes) } });
    return { row: updated, context, unitsById };
  });
  return presentOne(req, result.row, result.context, result.unitsById);
}

/** The column that names an entry's own subject, for the pin limit: its deal, else its person or institute. */
const pinSubject = (row) =>
  row.deal_id ? ['deal_id', row.deal_id] : row.contact_id ? ['contact_id', row.contact_id] : ['account_id', row.account_id];

/** POST /timeline/:id/pin and /unpin. */
export async function setPinned(req, id, pinned) {
  const userId = req.auth.user.id;
  const result = await db.transaction(async (trx) => {
    const { row, context, unitsById } = await loadVisibleEntry(req, id, { trx, forUpdate: true });
    const flags = entryFlags(req.access, row, entryPermissionPaths(row, context, unitsById), userId);
    if (!flags.canPin) throw errors.forbidden("You can't pin entries on this timeline");
    if (Boolean(row.pinned_at) === pinned) return { row, context, unitsById };
    if (pinned) {
      const [column, value] = pinSubject(row);
      const [{ count }] = await trx('timeline_events')
        .where(column, value)
        .whereNotNull('pinned_at')
        .whereNull('deleted_at')
        .count({ count: '*' });
      if (Number(count) >= MAX_PINNED) throw errors.conflict(`At most ${MAX_PINNED} entries can be pinned. Unpin one first.`);
    }
    const [updated] = await trx('timeline_events')
      .where({ id: row.id })
      .update({ pinned_at: pinned ? trx.fn.now() : null })
      .returning('*');
    await recordChange(trx, req, updated, pinned ? 'timeline.entry_pinned' : 'timeline.entry_unpinned');
    return { row: updated, context, unitsById };
  });
  return presentOne(req, result.row, result.context, result.unitsById);
}

/** DELETE /timeline/:id: soft delete of a manual entry by its author or a moderator. */
export async function deleteEntry(req, id) {
  const userId = req.auth.user.id;
  await db.transaction(async (trx) => {
    const { row, context, unitsById } = await loadVisibleEntry(req, id, { trx, forUpdate: true });
    const flags = entryFlags(req.access, row, entryPermissionPaths(row, context, unitsById), userId);
    if (!flags.canDelete) throw errors.forbidden("You can't delete this entry");
    const [deleted] = await trx('timeline_events').where({ id: row.id }).update({ deleted_at: trx.fn.now() }).returning('*');
    await recordChange(trx, req, deleted, 'timeline.entry_deleted', { before: { kind: row.kind, pinned: Boolean(row.pinned_at) } });
  });
}

