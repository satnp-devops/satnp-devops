import { z } from 'zod';
import { db } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { validate } from '../../lib/validate.js';
import { idParams, nameSchema } from '../../lib/schemas.js';
import { slugify } from '../../lib/text.js';
import { isKnownPermission, permissionCatalog } from '../../core/registry.js';
import { bumpAccessVersion } from '../../core/access.js';
import { writeAudit } from '../../core/audit.js';
import { emitEvent } from '../../core/events.js';
import { requireAuth, requireUnit } from '../../core/guards.js';

function presentRole(role) {
  return {
    id: role.id,
    groupId: role.group_id,
    key: role.key,
    name: role.name,
    description: role.description,
    permissions: role.permissions ?? [],
    isSystem: role.is_system,
    // How many people in the group have this role (anywhere in it).
    peopleCount: role.people_count !== undefined ? Number(role.people_count) : undefined,
    updatedAt: role.updated_at,
  };
}

function checkPermissionKeys(registry, permissions) {
  const unknown = permissions.filter((key) => key === '*' || !isKnownPermission(registry, key));
  if (unknown.length) {
    throw errors.validation([{ path: 'body.permissions', message: `Unknown or not allowed: ${unknown.join(', ')}` }]);
  }
}

/** The group's root unit, checked for a permission. */
async function requireGroup(req, groupId, permission) {
  const group = await requireUnit(req, groupId);
  if (group.parent_id !== null) throw errors.validation([{ path: 'groupId', message: 'Roles belong to a group' }]);
  if (permission && !req.access.can(permission, group.path)) throw errors.forbidden();
  return group;
}

async function loadCustomRole(req, roleId) {
  const role = await db('roles').where({ id: roleId }).first();
  if (!role) throw errors.notFound('Role');
  if (role.is_system || !role.group_id) throw errors.conflict("Built-in roles can't be changed. Duplicate it to make your own.");
  const group = await requireGroup(req, role.group_id, 'roles.manage');
  return { role, group };
}

export function roleRoutes(router) {
  router.get('/permissions', requireAuth(), (req, res) => {
    res.json({ data: permissionCatalog(req.app.locals.registry) });
  });

  router.get('/roles', requireAuth(), validate({ query: z.object({ groupId: z.uuid().optional() }) }), async (req, res) => {
    const groupId = req.valid.query.groupId ?? req.access.groupIds()[0];
    if (!groupId) return res.json({ data: [] });
    const group = await requireGroup(req, groupId);
    // Anyone who can view roles, or give them to people, can list them.
    const allowed =
      req.access.canAnywhereWithin('roles.view', group.path) || req.access.canAnywhereWithin('users.manage', group.path);
    if (!allowed) throw errors.forbidden();

    const rows = await db('roles as r')
      .leftJoin('role_assignments as ra', 'ra.role_id', 'r.id')
      .leftJoin('org_units as u', (join) => {
        join.on('u.id', '=', 'ra.org_unit_id').andOnVal('u.root_id', '=', group.id);
      })
      .where((q) => q.whereNull('r.group_id').orWhere('r.group_id', group.id))
      .groupBy('r.id')
      .orderBy([{ column: 'r.is_system', order: 'desc' }, { column: 'r.name' }])
      .select('r.*', db.raw('count(distinct ra.user_id) filter (where u.id is not null) as people_count'));
    res.json({ data: rows.map(presentRole) });
  });

  const roleBody = z.object({
    name: nameSchema,
    description: z.string().trim().max(300).optional(),
    permissions: z.array(z.string().max(80)).max(500),
  });

  router.post('/roles', requireAuth(), validate({ body: roleBody.extend({ groupId: z.uuid() }) }), async (req, res) => {
    const { registry } = req.app.locals;
    const { groupId, name, description, permissions } = req.valid.body;
    const group = await requireGroup(req, groupId, 'roles.manage');
    const unique = [...new Set(permissions)].sort();
    checkPermissionKeys(registry, unique);
    if (!req.access.canGrant(unique, group.path)) {
      throw errors.forbidden("You can't create a role with permissions you don't have");
    }
    const key = slugify(name).replace(/-/g, '_');
    if (!key) throw errors.validation([{ path: 'body.name', message: 'Use letters or numbers in the name' }]);
    const clash = await db('roles')
      .where({ key })
      .where((q) => q.whereNull('group_id').orWhere('group_id', group.id))
      .first();
    if (clash) throw errors.conflict('A role with this name already exists');

    const role = await db.transaction(async (trx) => {
      const [row] = await trx('roles')
        .insert({ group_id: group.id, key, name, description: description ?? null, permissions: unique, is_system: false })
        .returning('*');
      await writeAudit(trx, req, {
        action: 'role.created',
        entityType: 'role',
        entityId: row.id,
        unit: group,
        after: { name, permissions: unique },
      });
      await emitEvent(trx, {
        type: 'role.created',
        groupId: group.id,
        unitId: group.id,
        aggregateType: 'role',
        aggregateId: row.id,
        actorUserId: req.auth.user.id,
        payload: { key, name },
      });
      return row;
    });
    res.status(201).json({ data: presentRole(role) });
  });

  router.patch(
    '/roles/:id',
    requireAuth(),
    validate({ params: idParams, body: roleBody.partial() }),
    async (req, res) => {
      const { registry } = req.app.locals;
      const { role, group } = await loadCustomRole(req, req.valid.params.id);
      const changes = {};
      if (req.valid.body.name !== undefined) changes.name = req.valid.body.name;
      if (req.valid.body.description !== undefined) changes.description = req.valid.body.description || null;
      if (req.valid.body.permissions !== undefined) {
        const unique = [...new Set(req.valid.body.permissions)].sort();
        checkPermissionKeys(registry, unique);
        if (!req.access.canGrant(unique, group.path)) {
          throw errors.forbidden("You can't add permissions you don't have yourself");
        }
        changes.permissions = unique;
      }
      if (Object.keys(changes).length === 0) return res.json({ data: presentRole(role) });
      changes.updated_at = db.fn.now();

      const updated = await db.transaction(async (trx) => {
        const [row] = await trx('roles').where({ id: role.id }).update(changes).returning('*');
        await writeAudit(trx, req, {
          action: 'role.updated',
          entityType: 'role',
          entityId: role.id,
          unit: group,
          before: { name: role.name, description: role.description, permissions: role.permissions },
          after: { name: row.name, description: row.description, permissions: row.permissions },
        });
        await emitEvent(trx, {
          type: 'role.updated',
          groupId: group.id,
          unitId: group.id,
          aggregateType: 'role',
          aggregateId: role.id,
          actorUserId: req.auth.user.id,
        });
        return row;
      });
      await bumpAccessVersion();
      res.json({ data: presentRole(updated) });
    },
  );

  router.delete('/roles/:id', requireAuth(), validate({ params: idParams }), async (req, res) => {
    const { role, group } = await loadCustomRole(req, req.valid.params.id);
    const { n } = await db('role_assignments').where({ role_id: role.id }).count({ n: '*' }).first();
    if (Number(n) > 0) throw errors.conflict(`Remove this role from ${n} ${Number(n) === 1 ? 'person' : 'people'} first`);
    await db.transaction(async (trx) => {
      await trx('roles').where({ id: role.id }).delete();
      await writeAudit(trx, req, {
        action: 'role.deleted',
        entityType: 'role',
        entityId: role.id,
        unit: group,
        before: { name: role.name, permissions: role.permissions },
      });
      await emitEvent(trx, {
        type: 'role.deleted',
        groupId: group.id,
        unitId: group.id,
        aggregateType: 'role',
        aggregateId: role.id,
        actorUserId: req.auth.user.id,
      });
    });
    res.status(204).end();
  });
}
