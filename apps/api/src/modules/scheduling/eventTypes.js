import { db, json, PG } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { writeAudit } from '../../core/audit.js';
import { emitEvent } from '../../core/events.js';
import { requireCreateUnit, unitsIndex } from '../../core/crm/scope.js';
import { canEditAvailability, canSeeAvailability, eventTypeUnitIdsInScope, hostCandidates, loadEventType } from './access.js';
import { presentAvailability, presentEventType, publicLinkOf } from './present.js';

// Event types (what can be booked), their hosts, and people's availability.

const COLUMN_OF = {
  name: 'name',
  slug: 'slug',
  description: 'description',
  durationMin: 'duration_min',
  slotIntervalMin: 'slot_interval_min',
  bufferBeforeMin: 'buffer_before_min',
  bufferAfterMin: 'buffer_after_min',
  minNoticeMin: 'min_notice_min',
  maxPerDay: 'max_per_day',
  horizonDays: 'horizon_days',
  alignTimeZone: 'align_time_zone',
  locationKind: 'location_kind',
  locationDetail: 'location_detail',
  assignment: 'assignment',
  attendanceThresholdMin: 'attendance_threshold_min',
  reminderOffsetsMin: 'reminder_offsets_min',
  questions: 'questions',
  attendees: 'attendees',
  branding: 'branding',
  dealKind: 'deal_kind',
  active: 'active',
};
const JSON_COLUMNS = new Set(['questions', 'attendees', 'branding']);

function columnsFrom(body) {
  const out = {};
  for (const [key, column] of Object.entries(COLUMN_OF)) {
    if (body[key] === undefined) continue;
    out[column] = JSON_COLUMNS.has(column) ? json(body[key]) : body[key];
  }
  return out;
}

function slugTaken(err) {
  return err?.code === PG.UNIQUE_VIOLATION && String(err.constraint ?? '').includes('slug');
}

const auditUnit = (row) => ({ id: row.unit_id, root_id: row.group_id });

/** Hosts (with whether they've saved availability) and public links for event types, one query each. */
async function loadExtras(rows, trx = db) {
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return { hosts: new Map(), links: new Map() };
  const [hosts, links] = await Promise.all([
    trx('scheduling_event_type_hosts as h')
      .join('users as u', 'u.id', 'h.user_id')
      .leftJoin('scheduling_availability as a', 'a.user_id', 'h.user_id')
      .whereIn('h.event_type_id', ids)
      .orderBy([{ column: 'h.priority', order: 'desc' }, { column: 'u.name' }])
      .select('h.*', 'u.name', trx.raw('(a.user_id is not null) as has_availability')),
    trx('scheduling_booking_links').whereIn('event_type_id', ids).where('kind', 'public').whereNull('revoked_at'),
  ]);
  const hostsBy = new Map();
  for (const host of hosts) {
    if (!hostsBy.has(host.event_type_id)) hostsBy.set(host.event_type_id, []);
    hostsBy.get(host.event_type_id).push(host);
  }
  return { hosts: hostsBy, links: new Map(links.map((l) => [l.event_type_id, l])) };
}

function canFor(req, unit) {
  return {
    configure: Boolean(unit && req.access.can('scheduling.configure', unit.path)),
    book: Boolean(unit && req.access.canAnywhereWithin('scheduling.manage', unit.path)),
  };
}

async function present(req, rows, trx = db) {
  const [{ hosts, links }, index] = await Promise.all([loadExtras(rows, trx), unitsIndex(req, trx)]);
  return rows.map((row) => {
    const unit = index.get(row.unit_id);
    return presentEventType(row, { hosts: hosts.get(row.id) ?? [], publicLink: publicLinkOf(links.get(row.id)), unit, can: canFor(req, unit) });
  });
}

export async function listEventTypes(req, { unitId, includeArchived }) {
  const unitIds = await eventTypeUnitIdsInScope(req, unitId);
  if (unitIds.length === 0) return [];
  const rows = await db('scheduling_event_types')
    .whereIn('unit_id', unitIds)
    .modify((query) => {
      if (includeArchived !== 'true') query.whereNull('archived_at');
    })
    .orderBy([{ column: 'name' }, { column: 'id' }])
    .limit(500);
  return present(req, rows);
}

export async function getEventType(req, id) {
  const { eventType } = await loadEventType(req, id);
  const [presented] = await present(req, [eventType]);
  return presented;
}

/** 422 unless every host may host at the unit (scheduling.manage at, above or inside it). */
async function assertHosts(unit, hosts, trx, path = 'body.hosts') {
  if (!hosts?.length) return;
  const allowed = new Set((await hostCandidates(unit, { trx, userIds: hosts.map((h) => h.userId) })).map((p) => p.id));
  const issues = hosts
    .map((h, i) => (allowed.has(h.userId) ? null : { path: `${path}.${i}.userId`, message: 'This person cannot host here (they need to work bookings in this team)' }))
    .filter(Boolean);
  if (issues.length) throw errors.validation(issues);
}

async function writeHosts(trx, eventTypeId, hosts) {
  await trx('scheduling_event_type_hosts').where({ event_type_id: eventTypeId }).del();
  if (!hosts.length) return;
  await trx('scheduling_event_type_hosts').insert(
    hosts.map((h) => ({
      event_type_id: eventTypeId,
      user_id: h.userId,
      weight: h.weight ?? 1,
      priority: h.priority ?? 0,
      languages: h.languages ?? [],
      active: h.active ?? true,
    })),
  );
}

export async function createEventType(req, body) {
  const row = await db
    .transaction(async (trx) => {
      const { unit, company } = await requireCreateUnit(req, body.unitId, 'scheduling.configure', { trx });
      await assertHosts(unit, body.hosts, trx);
      const [created] = await trx('scheduling_event_types')
        .insert({ group_id: unit.root_id, company_id: company.id, unit_id: unit.id, ...columnsFrom(body), created_by: req.auth.user.id })
        .returning('*');
      if (body.hosts) await writeHosts(trx, created.id, body.hosts);
      await trx('scheduling_booking_links').insert({
        group_id: created.group_id,
        company_id: created.company_id,
        unit_id: created.unit_id,
        event_type_id: created.id,
        kind: 'public',
        created_by: req.auth.user.id,
      });
      await writeAudit(trx, req, {
        action: 'event_type.created',
        entityType: 'event_type',
        entityId: created.id,
        unit: auditUnit(created),
        after: { name: created.name, slug: created.slug, durationMin: created.duration_min, locationKind: created.location_kind },
      });
      await emitEvent(trx, {
        type: 'event_type.created',
        groupId: created.group_id,
        unitId: created.unit_id,
        aggregateType: 'event_type',
        aggregateId: created.id,
        actorUserId: req.auth.user.id,
        payload: { eventTypeId: created.id, companyId: created.company_id },
      });
      return created;
    })
    .catch((err) => {
      if (slugTaken(err)) throw errors.validation([{ path: 'body.slug', message: 'Another event type in this company uses this link name' }]);
      throw err;
    });
  return getEventType(req, row.id);
}

export async function updateEventType(req, id, body) {
  await db
    .transaction(async (trx) => {
      const { eventType: before } = await loadEventType(req, id, { write: true, trx, forUpdate: true });
      const changes = columnsFrom(body);
      const [after] = await trx('scheduling_event_types')
        .where({ id })
        .update({ ...changes, updated_at: trx.fn.now() })
        .returning('*');
      const changed = Object.keys(body);
      await writeAudit(trx, req, {
        action: 'event_type.updated',
        entityType: 'event_type',
        entityId: id,
        unit: auditUnit(after),
        before: Object.fromEntries(changed.map((key) => [key, before[COLUMN_OF[key]]])),
        after: Object.fromEntries(changed.map((key) => [key, after[COLUMN_OF[key]]])),
      });
      await emitEvent(trx, {
        type: 'event_type.updated',
        groupId: after.group_id,
        unitId: after.unit_id,
        aggregateType: 'event_type',
        aggregateId: id,
        actorUserId: req.auth.user.id,
        payload: { eventTypeId: id, companyId: after.company_id, changes: changed },
      });
    })
    .catch((err) => {
      if (slugTaken(err)) throw errors.validation([{ path: 'body.slug', message: 'Another event type in this company uses this link name' }]);
      throw err;
    });
  return getEventType(req, id);
}

export async function setArchived(req, id, archived) {
  await db.transaction(async (trx) => {
    const { eventType } = await loadEventType(req, id, { write: true, trx, forUpdate: true });
    if (Boolean(eventType.archived_at) === archived) return;
    const [after] = await trx('scheduling_event_types')
      .where({ id })
      .update({ archived_at: archived ? trx.fn.now() : null, active: !archived, updated_at: trx.fn.now() })
      .returning('*');
    const action = archived ? 'event_type.archived' : 'event_type.restored';
    await writeAudit(trx, req, { action, entityType: 'event_type', entityId: id, unit: auditUnit(after) });
    await emitEvent(trx, {
      type: action,
      groupId: after.group_id,
      unitId: after.unit_id,
      aggregateType: 'event_type',
      aggregateId: id,
      actorUserId: req.auth.user.id,
      payload: { eventTypeId: id, companyId: after.company_id },
    });
  });
  return getEventType(req, id);
}

export async function replaceHosts(req, id, hosts) {
  await db.transaction(async (trx) => {
    const { eventType, unit } = await loadEventType(req, id, { write: true, trx, forUpdate: true });
    await assertHosts(unit, hosts, trx, 'body');
    const before = await trx('scheduling_event_type_hosts').where({ event_type_id: id }).select('user_id', 'weight', 'priority', 'active');
    await writeHosts(trx, id, hosts);
    await writeAudit(trx, req, {
      action: 'event_type.hosts_updated',
      entityType: 'event_type',
      entityId: id,
      unit: auditUnit(eventType),
      before: { hosts: before.map((h) => ({ userId: h.user_id, weight: h.weight, priority: h.priority, active: h.active })) },
      after: { hosts: hosts.map((h) => ({ userId: h.userId, weight: h.weight, priority: h.priority, active: h.active })) },
    });
    await emitEvent(trx, {
      type: 'event_type.updated',
      groupId: eventType.group_id,
      unitId: eventType.unit_id,
      aggregateType: 'event_type',
      aggregateId: id,
      actorUserId: req.auth.user.id,
      payload: { eventTypeId: id, companyId: eventType.company_id, changes: ['hosts'] },
    });
  });
  return getEventType(req, id);
}

/** People who can host event types owned by a unit (the host picker). */
export async function listHostCandidates(req, unitId) {
  const index = await unitsIndex(req);
  const unit = index.get(unitId);
  if (!unit || !req.access.canSee(unit.path)) throw errors.notFound('Unit');
  if (!req.access.canAnywhereWithin('scheduling.view', unit.path)) throw errors.forbidden();
  const people = await hostCandidates(unit);
  const saved = people.length
    ? new Set((await db('scheduling_availability').whereIn('user_id', people.map((p) => p.id)).pluck('user_id')))
    : new Set();
  return people.map((p) => ({ id: p.id, name: p.name, hasAvailability: saved.has(p.id), worksHere: p.inside }));
}

// ---------- Availability ----------

const resolveUserId = (req, userId) => (userId === 'me' ? req.auth.user.id : userId);

export async function getAvailability(req, rawUserId) {
  const userId = resolveUserId(req, rawUserId);
  const user = await db('users').where({ id: userId }).first('id', 'name', 'time_zone');
  if (!user || !(await canSeeAvailability(req, userId))) throw errors.notFound('Person');
  const row = await db('scheduling_availability').where({ user_id: userId }).first();
  return { ...presentAvailability(row, user), suggestedTimeZone: user.time_zone ?? null, canEdit: await canEditAvailability(req, userId) };
}

export async function putAvailability(req, rawUserId, body) {
  const userId = resolveUserId(req, rawUserId);
  await db.transaction(async (trx) => {
    const user = await trx('users').where({ id: userId }).first('id');
    if (!user || !(await canSeeAvailability(req, userId, trx))) throw errors.notFound('Person');
    if (!(await canEditAvailability(req, userId, trx))) throw errors.forbidden();
    const before = await trx('scheduling_availability').where({ user_id: userId }).forUpdate().first();
    const values = { time_zone: body.timeZone, weekly: json(body.weekly), overrides: json(body.overrides ?? {}), updated_by: req.auth.user.id };
    await trx('scheduling_availability')
      .insert({ user_id: userId, ...values })
      .onConflict('user_id')
      .merge({ ...values, updated_at: trx.fn.now() });
    // People belong to the group; attach the entry to the actor's home unit for the audit screen.
    const home = await trx('role_assignments as ra').join('org_units as o', 'o.id', 'ra.org_unit_id').where('ra.user_id', userId).orderBy('o.depth').first('o.id', 'o.root_id');
    await writeAudit(trx, req, {
      action: 'availability.updated',
      entityType: 'user',
      entityId: userId,
      unit: home ? { id: home.id, root_id: home.root_id } : null,
      before: before ? { timeZone: before.time_zone, weekly: before.weekly, overrides: before.overrides } : null,
      after: { timeZone: body.timeZone, weekly: body.weekly, overrides: body.overrides ?? {} },
    });
    await emitEvent(trx, {
      type: 'availability.updated',
      groupId: home?.root_id ?? null,
      unitId: home?.id ?? null,
      aggregateType: 'user',
      aggregateId: userId,
      actorUserId: req.auth.user.id,
      payload: { userId },
    });
  });
  return getAvailability(req, userId);
}
