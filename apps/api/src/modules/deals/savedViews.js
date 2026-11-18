import { db, json } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { writeAudit } from '../../core/audit.js';
import { emitEvent } from '../../core/events.js';
import { isWithin } from '../../core/orgTree.js';
import { companyOf, unitsIndex } from '../../core/crm/scope.js';
import { presentSavedView } from './present.js';

// Saved views of the Leads list (docs/crm/PHASE2_CONTRACT.md §9.7). Personal views belong to their
// owner, wherever they were saved. Shared views belong to a unit: they show when working in that
// unit, above it or inside it, to people who can see leads there; changing them needs
// deals.share_views at their unit (or being their owner).

export const MAX_PERSONAL_VIEWS = 50;

/** May the user see a shared view's unit and the leads in it? */
function sharedVisible(req, unit) {
  return Boolean(unit) && req.access.canSee(unit.path) && req.access.canAnywhereWithin('deals.view', unit.path);
}

function canEdit(req, view, unit) {
  const userId = req.auth.user.id;
  if (view.visibility === 'personal') return view.owner_user_id === userId;
  return view.owner_user_id === userId || Boolean(unit && req.access.can('deals.share_views', unit.path));
}

async function present(req, views) {
  const units = await unitsIndex(req);
  const ownerIds = [...new Set(views.map((v) => v.owner_user_id))];
  const owners = new Map(ownerIds.length ? (await db('users').whereIn('id', ownerIds).select('id', 'name')).map((u) => [u.id, u]) : []);
  return views.map((view) => presentSavedView(view, { owner: owners.get(view.owner_user_id), canEdit: canEdit(req, view, units.get(view.unit_id)) }));
}

const order = (a, b) => a.position - b.position || a.name.localeCompare(b.name);

export async function listSavedViews(req, { unitId, entity }) {
  const units = await unitsIndex(req);
  const unit = units.get(unitId);
  if (!unit || !req.access.canSee(unit.path)) throw errors.notFound('Unit');
  const userId = req.auth.user.id;
  const rows = await db('saved_views')
    .where({ entity })
    .where((where) => {
      where.where({ visibility: 'personal', owner_user_id: userId }).orWhere((shared) => {
        shared.where({ visibility: 'shared', group_id: unit.root_id });
      });
    });
  const personal = rows.filter((v) => v.visibility === 'personal').sort(order);
  const shared = rows
    .filter((v) => v.visibility === 'shared')
    .filter((v) => {
      const viewUnit = units.get(v.unit_id);
      if (!sharedVisible(req, viewUnit)) return false;
      return isWithin(unit.path, viewUnit.path) || isWithin(viewUnit.path, unit.path);
    })
    .sort(order);
  return present(req, [...personal, ...shared]);
}

async function loadEditable(req, trx, id) {
  const view = await trx('saved_views').where({ id }).forUpdate().first();
  if (!view) throw errors.notFound('Saved view');
  const units = await unitsIndex(req, trx);
  const unit = units.get(view.unit_id);
  const mine = view.owner_user_id === req.auth.user.id;
  if (view.visibility === 'personal' ? !mine : !sharedVisible(req, unit)) throw errors.notFound('Saved view');
  if (!canEdit(req, view, unit)) throw errors.forbidden("You can't change this shared view");
  return { view, unit };
}

const auditUnit = (view) => ({ id: view.unit_id, root_id: view.group_id });

async function record(trx, req, view, type) {
  await emitEvent(trx, {
    type,
    groupId: view.group_id,
    unitId: view.unit_id,
    aggregateType: 'saved_view',
    aggregateId: view.id,
    actorUserId: req.auth.user.id,
    payload: { savedViewId: view.id, visibility: view.visibility, unitId: view.unit_id },
  });
}

export async function createSavedView(req, body) {
  const units = await unitsIndex(req);
  const unit = units.get(body.unitId);
  if (!unit || !req.access.canSee(unit.path)) throw errors.notFound('Unit');
  if (!req.access.canAnywhereWithin('deals.view', unit.path)) throw errors.forbidden();
  if (body.visibility === 'shared' && !req.access.can('deals.share_views', unit.path)) {
    throw errors.forbidden(`You can't share views with everyone in ${unit.name}`);
  }
  const userId = req.auth.user.id;
  const view = await db.transaction(async (trx) => {
    if (body.visibility === 'personal') {
      // Serialise this user's creates so the limit holds.
      await trx.raw('select pg_advisory_xact_lock(hashtextextended(?, 0))', [`crm.saved_views:${userId}`]);
      const [{ count }] = await trx('saved_views').where({ owner_user_id: userId, visibility: 'personal' }).count({ count: '*' });
      if (Number(count) >= MAX_PERSONAL_VIEWS) throw errors.conflict(`You can keep up to ${MAX_PERSONAL_VIEWS} views. Delete one first.`);
    }
    let position = body.position;
    if (position === undefined) {
      const scope = body.visibility === 'personal' ? { owner_user_id: userId, visibility: 'personal' } : { unit_id: unit.id, visibility: 'shared' };
      const [{ max }] = await trx('saved_views').where({ ...scope, entity: body.entity }).max({ max: 'position' });
      position = max === null || max === undefined ? 0 : Math.min(Number(max) + 1, 1000);
    }
    const [row] = await trx('saved_views')
      .insert({
        group_id: unit.root_id,
        company_id: companyOf(unit, units)?.id ?? null,
        unit_id: unit.id,
        owner_user_id: userId,
        entity: body.entity,
        name: body.name,
        visibility: body.visibility,
        filters: json(body.filters),
        sort: body.sort,
        columns: body.columns,
        position,
      })
      .returning('*');
    await record(trx, req, row, 'saved_view.created');
    await writeAudit(trx, req, {
      action: 'saved_view.created',
      entityType: 'saved_view',
      entityId: row.id,
      unit: auditUnit(row),
      after: { name: row.name, visibility: row.visibility },
    });
    return row;
  });
  const [presented] = await present(req, [view]);
  return presented;
}

export async function updateSavedView(req, id, body) {
  const view = await db.transaction(async (trx) => {
    const { view: current, unit } = await loadEditable(req, trx, id);
    const userId = req.auth.user.id;
    if (body.visibility === 'shared' && current.visibility !== 'shared' && !req.access.can('deals.share_views', unit.path)) {
      throw errors.forbidden(`You can't share views with everyone in ${unit.name}`);
    }
    if (body.visibility === 'personal' && current.visibility !== 'personal' && current.owner_user_id !== userId) {
      throw errors.forbidden('Only the person who made this view can make it personal again');
    }
    const changes = {};
    if (body.name !== undefined) changes.name = body.name;
    if (body.visibility !== undefined) changes.visibility = body.visibility;
    if (body.filters !== undefined) changes.filters = json(body.filters);
    if (body.sort !== undefined) changes.sort = body.sort;
    if (body.columns !== undefined) changes.columns = body.columns;
    if (body.position !== undefined) changes.position = body.position;
    if (Object.keys(changes).length === 0) return current;
    const [row] = await trx('saved_views')
      .where({ id })
      .update({ ...changes, updated_at: trx.fn.now() })
      .returning('*');
    await record(trx, req, row, 'saved_view.updated');
    await writeAudit(trx, req, {
      action: 'saved_view.updated',
      entityType: 'saved_view',
      entityId: row.id,
      unit: auditUnit(row),
      before: { name: current.name, visibility: current.visibility, sort: current.sort },
      after: { name: row.name, visibility: row.visibility, sort: row.sort },
      meta: { changed: Object.keys(changes) },
    });
    return row;
  });
  const [presented] = await present(req, [view]);
  return presented;
}

export async function deleteSavedView(req, id) {
  await db.transaction(async (trx) => {
    const { view } = await loadEditable(req, trx, id);
    await trx('saved_views').where({ id }).delete();
    await record(trx, req, view, 'saved_view.deleted');
    await writeAudit(trx, req, {
      action: 'saved_view.deleted',
      entityType: 'saved_view',
      entityId: view.id,
      unit: auditUnit(view),
      before: { name: view.name, visibility: view.visibility },
    });
  });
}
