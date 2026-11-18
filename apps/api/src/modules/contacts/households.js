import { db } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { decodeCursor, pageOf } from '../../lib/pagination.js';
import { writeAudit } from '../../core/audit.js';
import { emitEvent } from '../../core/events.js';
import { listScope, loadVisibleContact, unitsIndex, whereLinkedInScope } from '../../core/crm/scope.js';
import { addTimelineEvent } from '../../core/crm/timeline.js';
import { actingLink, changeUnit, decideContacts, escapeLike, groupBy, inOrder } from './context.js';
import { presentHousehold } from './present.js';

// Households: parents, guardians and students of one family (docs/crm/PHASE2_CONTRACT.md §5.3,
// §9.1). A household is group-level; the viewer sees it when they can see any member, and may
// change it ("manage the household") when they can manage any visible member.

/** "Sharma family" → "the Sharma family"; other names read as "household Rao". */
export function householdPhrase(name) {
  return /\b(family|household)$/i.test(name.trim()) ? `the ${name.trim()}` : `household ${name.trim()}`;
}

/** Household rows with members (each with its contact row) and how the viewer reaches each member. */
export async function loadHouseholdAccess(req, id, { trx = db, forUpdate = false } = {}) {
  const query = trx('households').where({ id }).first();
  if (forUpdate) query.forUpdate();
  const household = await query;
  if (!household || !req.access.groupIds().includes(household.group_id)) {
    return { household: null, members: [], decisions: new Map(), canView: false, canManage: false };
  }
  const members = await membersOf(trx, [id]);
  const decisions = await decideContacts(
    req,
    members.map((member) => member.contact.id),
    trx,
  );
  const visible = members.filter((member) => decisions.get(member.contact.id)?.canView);
  return {
    household,
    members,
    decisions,
    canView: visible.length > 0,
    canManage: visible.some((member) => decisions.get(member.contact.id).canManage),
  };
}

/** Members of households with their contact rows (as JSON), oldest first. */
function membersOf(trx, householdIds) {
  return trx('household_members as hm')
    .join('contacts as c', 'c.id', 'hm.contact_id')
    .whereIn('hm.household_id', householdIds)
    .orderBy([{ column: 'hm.created_at' }, { column: 'hm.contact_id' }])
    .select('hm.household_id', 'hm.contact_id', 'hm.role', 'hm.relation', 'hm.is_primary', 'hm.created_at', db.raw('row_to_json(c.*) as contact'));
}

/** Load a household for a change: 404 when invisible, 403 when the viewer can't manage it. */
async function loadForChange(req, id, trx) {
  const access = await loadHouseholdAccess(req, id, { trx, forUpdate: true });
  if (!access.canView) throw errors.notFound('Household');
  if (!access.canManage) throw errors.forbidden("You can't change this household");
  return access;
}

/** The unit a household change is recorded at: a manageable member's link unit, else the group. */
async function householdUnit(req, access, trx) {
  const unitsById = await unitsIndex(req, trx);
  for (const member of access.members) {
    const decision = access.decisions.get(member.contact.id);
    if (!decision?.canManage) continue;
    const link = actingLink(req, unitsById, decision.visibleLinks);
    if (link) return { id: link.unit_id, root_id: access.household.group_id };
  }
  return { id: access.household.group_id, root_id: access.household.group_id };
}

const present = (access) =>
  presentHousehold(access.household, access.members, { decisions: access.decisions, canManage: access.canManage });

async function reload(req, id, trx = db) {
  return present(await loadHouseholdAccess(req, id, { trx }));
}

async function recordHousehold(trx, req, { type, household, unit, payload, audit }) {
  await emitEvent(trx, {
    type,
    groupId: household.group_id,
    unitId: unit.id,
    aggregateType: 'household',
    aggregateId: household.id,
    actorUserId: req.auth.user.id,
    payload: { householdId: household.id, ...payload },
  });
  await writeAudit(trx, req, { action: type, entityType: 'household', entityId: household.id, unit, ...audit });
}

/**
 * Add a person to a household (inside the caller's transaction): the membership, a group-level
 * timeline entry on the person, the household.member_added event and audit entry.
 * `ifMissing` makes an existing membership a no-op instead of a 409. Returns whether a row was added.
 */
export async function addHouseholdMember(trx, req, access, contact, { role, relation = null, isPrimary = false, unit, ifMissing = false }) {
  const { household } = access;
  if (access.members.some((member) => member.contact.id === contact.id)) {
    if (ifMissing) return false;
    throw errors.conflict(`${contact.display_name} is already in this household`);
  }
  if (household.archived_at) throw errors.conflict('This household is archived. Restore it first.');
  if (isPrimary) await trx('household_members').where({ household_id: household.id }).update({ is_primary: false });
  await trx('household_members').insert({
    household_id: household.id,
    contact_id: contact.id,
    role,
    relation,
    is_primary: isPrimary,
  });
  await trx('households').where({ id: household.id }).update({ updated_at: trx.fn.now() });
  await addTimelineEvent(trx, {
    groupId: household.group_id,
    contactId: contact.id,
    kind: 'system',
    title: `Added to ${householdPhrase(household.name)}`,
    meta: { action: 'household.member_added', householdId: household.id },
    actorType: 'user',
    actorUserId: req.auth.user.id,
  });
  await recordHousehold(trx, req, {
    type: 'household.member_added',
    household,
    unit,
    payload: { contactId: contact.id, role },
    audit: { after: { contactId: contact.id, role, relation, isPrimary } },
  });
  return true;
}

// ---------- Reading ----------

/** GET /households */
export async function listHouseholds(req, { unitId, q, cursor, limit }) {
  const scope = await listScope(req, 'contacts.view', { unitId });
  const after = decodeCursor(cursor);
  const rows = await db('households as h')
    .where('h.group_id', scope.groupId)
    .whereNull('h.archived_at')
    .whereExists(function member() {
      this.select(db.raw('1')).from('household_members as hm').whereRaw('hm.household_id = h.id');
      whereLinkedInScope(this, scope, { idColumn: 'hm.contact_id' });
    })
    .modify((query) => {
      if (q) query.whereRaw('lower(h.name) like ?', [`${escapeLike(q.toLowerCase())}%`]);
      if (after) query.whereRaw('(lower(h.name), h.id) > (?, ?::uuid)', [after.v, after.id]);
    })
    .orderByRaw('lower(h.name), h.id')
    .limit(limit + 1)
    .select('h.*', db.raw('lower(h.name) as sort_key'));
  const { page, nextCursor } = pageOf(rows, limit, (row) => ({ v: row.sort_key, id: row.id }));
  if (page.length === 0) return { data: [], nextCursor };

  const members = await membersOf(db, page.map((row) => row.id));
  const decisions = await decideContacts(
    req,
    members.map((member) => member.contact.id),
  );
  const membersBy = groupBy(members, (member) => member.household_id);
  const data = page.map((household) => {
    const all = membersBy.get(household.id) ?? [];
    const visible = all.filter((member) => decisions.get(member.contact.id)?.canView);
    return {
      id: household.id,
      name: household.name,
      city: household.city ?? null,
      members: visible.map((member) => ({
        id: member.contact.id,
        displayName: member.contact.display_name,
        kind: member.contact.kind,
        role: member.role,
      })),
      hiddenMemberCount: all.length - visible.length,
      updatedAt: new Date(household.updated_at).toISOString(),
    };
  });
  return { data, nextCursor };
}

/** GET /households/:id */
export async function getHousehold(req, id) {
  const access = await loadHouseholdAccess(req, id);
  if (!access.canView) throw errors.notFound('Household');
  return present(access);
}

// ---------- Writing ----------

/** POST /households */
export async function createHousehold(req, body) {
  const id = await db.transaction(async (trx) => {
    const unitsById = await unitsIndex(req, trx);
    const unit = unitsById.get(body.unitId);
    if (!unit || !req.access.canSee(unit.path)) throw errors.notFound('Unit');
    if (!req.access.canAnywhereWithin('contacts.manage', unit.path)) throw errors.forbidden();
    if (body.members.filter((member) => member.isPrimary).length > 1) {
      throw errors.validation([{ path: 'body.members', message: 'Mark at most one main contact' }]);
    }
    const ids = body.members.map((member) => member.contactId);
    const issues = [];
    ids.forEach((contactId, index) => {
      if (ids.indexOf(contactId) !== index) issues.push({ path: `body.members.${index}.contactId`, message: 'This person is listed twice' });
    });
    if (issues.length) throw errors.validation(issues);

    const [contacts, decisions] = await inOrder(trx, [trx('contacts').whereIn('id', ids), () => decideContacts(req, ids, trx)]);
    const byId = new Map(contacts.map((row) => [row.id, row]));
    body.members.forEach((member, index) => {
      const contact = byId.get(member.contactId);
      const decision = decisions.get(member.contactId);
      const path = `body.members.${index}.contactId`;
      if (!contact || contact.group_id !== unit.root_id || contact.merged_into_id || !decision?.canView) {
        issues.push({ path, message: 'Contact not found' });
      } else if (contact.erased_at) issues.push({ path, message: 'This contact was erased' });
      else if (!decision.canManage) issues.push({ path, message: `You can't change ${contact.display_name}` });
    });
    if (issues.length) throw errors.validation(issues);

    const [household] = await trx('households')
      .insert({ group_id: unit.root_id, name: body.name, city: body.city ?? null, created_by: req.auth.user.id })
      .returning('*');
    await trx('household_members').insert(
      body.members.map((member) => ({
        household_id: household.id,
        contact_id: member.contactId,
        role: member.role,
        relation: member.relation ?? null,
        is_primary: member.isPrimary,
      })),
    );
    await recordHousehold(trx, req, {
      type: 'household.created',
      household,
      unit: { id: unit.id, root_id: unit.root_id },
      payload: { memberIds: ids },
      audit: { after: { name: household.name, city: household.city, memberIds: ids } },
    });
    return household.id;
  });
  return reload(req, id);
}

/** PATCH /households/:id */
export async function updateHousehold(req, id, body) {
  await db.transaction(async (trx) => {
    const access = await loadForChange(req, id, trx);
    const { household } = access;
    const changes = {};
    const before = {};
    const after = {};
    if (body.name !== undefined && body.name !== household.name) {
      changes.name = body.name;
      before.name = household.name;
      after.name = body.name;
    }
    if (body.city !== undefined && body.city !== household.city) {
      changes.city = body.city;
      before.city = household.city;
      after.city = body.city;
    }
    if (body.archived !== undefined && body.archived !== Boolean(household.archived_at)) {
      changes.archived_at = body.archived ? trx.fn.now() : null;
      before.archived = Boolean(household.archived_at);
      after.archived = body.archived;
    }
    if (Object.keys(changes).length === 0) return;
    await trx('households').where({ id }).update({ ...changes, updated_at: trx.fn.now() });
    await recordHousehold(trx, req, {
      type: 'household.updated',
      household,
      unit: await householdUnit(req, access, trx),
      payload: { changes: Object.keys(after) },
      audit: { before, after },
    });
  });
  return reload(req, id);
}

/** A person the viewer names for a household: 422 when invisible (never revealing whether they exist), 403 without manage. */
async function loadMemberContact(req, contactId, groupId, trx) {
  await unitsIndex(req, trx);
  let loaded;
  try {
    loaded = await loadVisibleContact(req, contactId, { trx });
  } catch (error) {
    if (error.status === 404) throw errors.validation([{ path: 'body.contactId', message: 'Contact not found' }]);
    throw error;
  }
  if (loaded.contact.group_id !== groupId) throw errors.validation([{ path: 'body.contactId', message: 'Contact not found' }]);
  if (!loaded.canManage) throw errors.forbidden(`You can't change ${loaded.contact.display_name}`);
  if (loaded.contact.erased_at) throw errors.conflict('This contact was erased');
  return loaded;
}

/** POST /households/:id/members */
export async function addMember(req, id, body) {
  await db.transaction(async (trx) => {
    const access = await loadForChange(req, id, trx);
    const loaded = await loadMemberContact(req, body.contactId, access.household.group_id, trx);
    const unitsById = await unitsIndex(req, trx);
    await addHouseholdMember(trx, req, access, loaded.contact, {
      role: body.role,
      relation: body.relation ?? null,
      isPrimary: body.isPrimary,
      unit: changeUnit(loaded.contact, actingLink(req, unitsById, loaded.visibleLinks)),
    });
  });
  return reload(req, id);
}

function findMember(access, contactId) {
  const member = access.members.find((row) => row.contact.id === contactId);
  if (!member || !access.decisions.get(contactId)?.canView) throw errors.notFound('Household member');
  return member;
}

/** PATCH /households/:id/members/:contactId */
export async function updateMember(req, id, contactId, body) {
  await db.transaction(async (trx) => {
    const access = await loadForChange(req, id, trx);
    const member = findMember(access, contactId);
    const changes = {};
    const after = {};
    if (body.role !== undefined && body.role !== member.role) changes.role = after.role = body.role;
    if (body.relation !== undefined && body.relation !== member.relation) changes.relation = after.relation = body.relation;
    if (body.isPrimary !== undefined && body.isPrimary !== member.is_primary) changes.is_primary = after.isPrimary = body.isPrimary;
    if (Object.keys(changes).length === 0) return;
    if (changes.is_primary) await trx('household_members').where({ household_id: id }).update({ is_primary: false });
    await trx('household_members').where({ household_id: id, contact_id: contactId }).update(changes);
    await trx('households').where({ id }).update({ updated_at: trx.fn.now() });
    await recordHousehold(trx, req, {
      type: 'household.member_updated',
      household: access.household,
      unit: await householdUnit(req, access, trx),
      payload: { contactId, role: changes.role ?? member.role },
      audit: { before: { role: member.role, relation: member.relation, isPrimary: member.is_primary }, after: { ...after, contactId } },
    });
  });
  return reload(req, id);
}

/** DELETE /households/:id/members/:contactId (removing the last member archives the household) */
export async function removeMember(req, id, contactId) {
  await db.transaction(async (trx) => {
    const access = await loadForChange(req, id, trx);
    const member = findMember(access, contactId);
    const unit = await householdUnit(req, access, trx);
    await trx('household_members').where({ household_id: id, contact_id: contactId }).delete();
    const last = access.members.length === 1;
    await trx('households')
      .where({ id })
      .update({ updated_at: trx.fn.now(), ...(last ? { archived_at: trx.fn.now() } : {}) });
    await addTimelineEvent(trx, {
      groupId: access.household.group_id,
      contactId,
      kind: 'system',
      title: `Removed from ${householdPhrase(access.household.name)}`,
      meta: { action: 'household.member_removed', householdId: id },
      actorType: 'user',
      actorUserId: req.auth.user.id,
    });
    await recordHousehold(trx, req, {
      type: 'household.member_removed',
      household: access.household,
      unit,
      payload: { contactId, role: member.role },
      audit: { before: { contactId, role: member.role }, meta: { archived: last } },
    });
  });
  return reload(req, id);
}

/** Households of several ids with every member (the DPDP export; members other than the person are masked). */
export async function householdsForExport(req, householdIds) {
  if (householdIds.length === 0) return [];
  const [households, members] = await Promise.all([db('households').whereIn('id', householdIds).orderBy('name'), membersOf(db, householdIds)]);
  const membersBy = groupBy(members, (member) => member.household_id);
  return households.map((household) =>
    presentHousehold(household, membersBy.get(household.id) ?? [], { decisions: new Map(), canManage: false, unmasked: true }),
  );
}
