import { randomUUID } from 'node:crypto';
import { db, json, PG } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { parseOrThrow } from '../../lib/validate.js';
import { stripEmpty } from '../../lib/text.js';
import { childPath, idsFromPath, isAllowedParent, isWithin, outermostPaths } from '../../core/orgTree.js';
import { writeAudit } from '../../core/audit.js';
import { emitEvent } from '../../core/events.js';
import { bumpAccessVersion } from '../../core/access.js';
import { requireUnit } from '../../core/guards.js';
import { assertUnitCanChangeCompany, companyForUnit } from '../../core/crm/scope.js';

export function presentUnit(unit, access) {
  let level = 'view';
  if (access) {
    if (access.can('org.manage', unit.path)) level = 'manage';
    else if (!access.assignments.some((a) => isWithin(unit.path, a.unitPath))) level = 'context';
  }
  return {
    id: unit.id,
    parentId: unit.parent_id,
    groupId: unit.root_id,
    type: unit.type,
    name: unit.name,
    code: unit.code,
    path: unit.path,
    depth: unit.depth,
    status: unit.status,
    profile: unit.profile ?? {},
    access: level,
    createdAt: unit.created_at,
    updatedAt: unit.updated_at,
  };
}

const snapshot = (unit) => ({
  name: unit.name,
  code: unit.code,
  type: unit.type,
  status: unit.status,
  parentId: unit.parent_id,
  profile: unit.profile,
});

function friendlyConflict(err) {
  if (err?.code === PG.UNIQUE_VIOLATION && err.constraint === 'org_units_sibling_code_uq') {
    return errors.conflict('Another unit at this level already uses this code');
  }
  return err;
}

/** Units the user works in (and everything below), plus their ancestors for context. */
export async function listVisibleUnits(access) {
  if (access.assignments.length === 0) return [];
  const prefixes = outermostPaths(access.assignments.map((a) => a.unitPath));
  const ancestorIds = [...new Set(access.assignments.flatMap((a) => idsFromPath(a.unitPath)))];
  const rows = await db('org_units')
    .where((query) => {
      for (const prefix of prefixes) query.orWhere('path', 'like', `${prefix}%`);
      query.orWhereIn('id', ancestorIds);
    })
    .orderBy([{ column: 'depth' }, { column: 'name' }]);
  return rows.map((unit) => presentUnit(unit, access));
}

function unitTypeOrThrow(registry, key, path = 'body.type') {
  const type = registry.unitTypes.get(key);
  if (!type) throw errors.validation([{ path, message: 'Unknown unit type' }]);
  return type;
}

export async function createUnit(req, registry, input) {
  const parent = await requireUnit(req, input.parentId, 'org.manage');
  if (parent.status !== 'active') throw errors.conflict('You can only add units under an active unit');
  const type = unitTypeOrThrow(registry, input.type);
  if (!isAllowedParent(registry.unitTypes, input.type, parent.type)) {
    const parentLabel = registry.unitTypes.get(parent.type)?.label.toLowerCase() ?? parent.type;
    throw errors.validation([
      { path: 'body.type', message: `A ${type.label.toLowerCase()} can't be added under a ${parentLabel}` },
    ]);
  }
  const profile = parseOrThrow(type.profile, stripEmpty(input.profile ?? {}), 'body.profile');
  const id = randomUUID();

  try {
    return await db.transaction(async (trx) => {
      const [unit] = await trx('org_units')
        .insert({
          id,
          parent_id: parent.id,
          root_id: parent.root_id,
          type: input.type,
          name: input.name,
          code: input.code,
          path: childPath(parent.path, id),
          depth: parent.depth + 1,
          profile: json(profile),
        })
        .returning('*');
      await writeAudit(trx, req, {
        action: 'org_unit.created',
        entityType: 'org_unit',
        entityId: unit.id,
        unit,
        after: snapshot(unit),
      });
      await emitEvent(trx, {
        type: 'org_unit.created',
        groupId: unit.root_id,
        unitId: unit.id,
        aggregateType: 'org_unit',
        aggregateId: unit.id,
        actorUserId: req.auth.user.id,
        payload: { name: unit.name, type: unit.type, parentId: parent.id },
      });
      return unit;
    });
  } catch (err) {
    throw friendlyConflict(err);
  }
}

export async function updateUnit(req, registry, unitId, input) {
  const unit = await requireUnit(req, unitId, 'org.manage');
  const changes = {};
  if (input.name !== undefined) changes.name = input.name;
  if (input.code !== undefined) changes.code = input.code;
  if (input.profile !== undefined) {
    const type = unitTypeOrThrow(registry, unit.type);
    changes.profile = json(parseOrThrow(type.profile, stripEmpty(input.profile), 'body.profile'));
  }

  let action = 'org_unit.updated';
  if (input.status !== undefined && input.status !== unit.status) {
    if (!unit.parent_id) throw errors.conflict("The group itself can't be archived");
    // Archiving cuts off everyone who works there, so it's decided one level up
    // (a company admin can't archive their own company and lock themselves out).
    await requireUnit(req, unit.parent_id, 'org.manage');
    if (input.status === 'archived') {
      const { n } = await db('org_units').where({ parent_id: unit.id, status: 'active' }).count({ n: '*' }).first();
      if (Number(n) > 0) throw errors.conflict('Archive or move the units inside it first');
      changes.archived_at = db.fn.now();
      action = 'org_unit.archived';
    } else {
      const parent = await db('org_units').where({ id: unit.parent_id }).first();
      if (parent?.status !== 'active') throw errors.conflict('Restore its parent unit first');
      changes.archived_at = null;
      action = 'org_unit.restored';
    }
    changes.status = input.status;
  }
  if (Object.keys(changes).length === 0) return unit;
  changes.updated_at = db.fn.now();

  try {
    const updated = await db.transaction(async (trx) => {
      const [row] = await trx('org_units').where({ id: unit.id }).update(changes).returning('*');
      await writeAudit(trx, req, {
        action,
        entityType: 'org_unit',
        entityId: row.id,
        unit: row,
        before: snapshot(unit),
        after: snapshot(row),
      });
      await emitEvent(trx, {
        type: action,
        groupId: row.root_id,
        unitId: row.id,
        aggregateType: 'org_unit',
        aggregateId: row.id,
        actorUserId: req.auth.user.id,
        payload: { name: row.name, status: row.status },
      });
      return row;
    });
    if (changes.status) await bumpAccessVersion();
    return updated;
  } catch (err) {
    throw friendlyConflict(err);
  }
}

/** Move a unit (and everything under it) to a new parent in the same group. */
export async function moveUnit(req, registry, unitId, newParentId) {
  const unit = await requireUnit(req, unitId, 'org.manage');
  if (!unit.parent_id) throw errors.conflict("The group can't be moved");
  await requireUnit(req, unit.parent_id, 'org.manage');
  const newParent = await requireUnit(req, newParentId, 'org.manage');
  if (newParent.id === unit.parent_id) return unit;
  if (newParent.root_id !== unit.root_id) throw errors.conflict("Units can't move between groups");
  if (isWithin(newParent.path, unit.path)) throw errors.conflict("A unit can't move inside itself");
  if (newParent.status !== 'active') throw errors.conflict('Pick an active unit to move into');
  if (!isAllowedParent(registry.unitTypes, unit.type, newParent.type)) {
    throw errors.validation([{ path: 'body.parentId', message: `This kind of unit can't sit under a ${newParent.type}` }]);
  }

  const oldPrefix = unit.path;
  const newPrefix = childPath(newParent.path, unit.id);
  const depthDelta = newParent.depth + 1 - unit.depth;

  try {
    const moved = await db.transaction(async (trx) => {
      // CRM records belong to a company (its pipelines, products and fields), so a unit that holds
      // any can only move within its company.
      const [fromCompany, toCompany] = await Promise.all([companyForUnit(unit, trx), companyForUnit(newParent, trx)]);
      if (fromCompany?.id !== toCompany?.id) await assertUnitCanChangeCompany(trx, unit);

      await trx('org_units')
        .where('path', 'like', `${oldPrefix}%`)
        .update({
          path: trx.raw('? || substr(path, ?)', [newPrefix, oldPrefix.length + 1]),
          depth: trx.raw('depth + ?', [depthDelta]),
          updated_at: trx.fn.now(),
        });
      const [row] = await trx('org_units').where({ id: unit.id }).update({ parent_id: newParent.id }).returning('*');
      await writeAudit(trx, req, {
        action: 'org_unit.moved',
        entityType: 'org_unit',
        entityId: row.id,
        unit: row,
        before: { parentId: unit.parent_id },
        after: { parentId: newParent.id },
      });
      await emitEvent(trx, {
        type: 'org_unit.moved',
        groupId: row.root_id,
        unitId: row.id,
        aggregateType: 'org_unit',
        aggregateId: row.id,
        actorUserId: req.auth.user.id,
        payload: { fromParentId: unit.parent_id, toParentId: newParent.id },
      });
      return row;
    });
    await bumpAccessVersion();
    return moved;
  } catch (err) {
    throw friendlyConflict(err);
  }
}
