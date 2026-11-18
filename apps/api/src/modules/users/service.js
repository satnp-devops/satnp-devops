import { env } from '../../config/env.js';
import { db } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { randomToken, sha256 } from '../../lib/crypto.js';
import { decodeCursor, pageOf } from '../../lib/pagination.js';
import { bumpAccessVersion } from '../../core/access.js';
import { writeAudit } from '../../core/audit.js';
import { emitEvent } from '../../core/events.js';
import { enqueueMail } from '../../core/queue.js';
import { requireUnit } from '../../core/guards.js';
import { commonAncestorId } from '../../core/orgTree.js';
import { revokeUserSessions } from '../auth/sessions.js';
import { presentAssignment, presentUser } from './present.js';

const INVITE_TTL_MS = 7 * 86_400_000;

async function assignmentsFor(userIds, trx = db) {
  if (userIds.length === 0) return new Map();
  const rows = await trx('role_assignments as ra')
    .join('roles as r', 'r.id', 'ra.role_id')
    .join('org_units as u', 'u.id', 'ra.org_unit_id')
    .whereIn('ra.user_id', userIds)
    .orderBy('u.depth')
    .select(
      'ra.id',
      'ra.user_id',
      'r.id as role_id',
      'r.key as role_key',
      'r.name as role_name',
      'r.permissions',
      'u.id as unit_id',
      'u.name as unit_name',
      'u.type as unit_type',
      'u.status as unit_status',
      'u.path as unit_path',
      'u.root_id as group_id',
      'u.parent_id as unit_parent_id',
    );
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.user_id)) map.set(row.user_id, []);
    map.get(row.user_id).push(row);
  }
  return map;
}

/**
 * The narrowest unit that covers every place a person works. Changes to the person are
 * recorded there, so admins at that level (and above) see them in the audit log.
 */
export function homeUnitOf(assignments) {
  const id = commonAncestorId(assignments.map((a) => a.unit_path));
  return id ? { id, root_id: assignments[0].group_id } : null;
}

export async function homeUnitForUser(userId, trx = db) {
  return homeUnitOf((await assignmentsFor([userId], trx)).get(userId) ?? []);
}

const escapeLike = (value) => value.replace(/[\\%_]/g, (char) => `\\${char}`);

export async function listUsers(req, { unitId, q, status, cursor, limit }) {
  const unit = await requireUnit(req, unitId, 'users.view');
  const after = decodeCursor(cursor);
  const rows = await db('users as u')
    .whereExists(
      db('role_assignments as ra')
        .join('org_units as o', 'o.id', 'ra.org_unit_id')
        .whereRaw('ra.user_id = u.id')
        .where('o.path', 'like', `${unit.path}%`)
        .select(db.raw('1')),
    )
    .modify((query) => {
      if (q) {
        const term = `%${escapeLike(q)}%`;
        query.where((w) => w.whereILike('u.name', term).orWhereILike('u.email', term));
      }
      if (status) query.where('u.status', status);
      if (after) query.whereRaw('(lower(u.name), u.id) > (?, ?)', [after.name, after.id]);
    })
    .orderByRaw('lower(u.name), u.id')
    .limit(limit + 1)
    .select('u.*');

  const { page, nextCursor } = pageOf(rows, limit, (user) => ({ name: user.name.toLowerCase(), id: user.id }));
  const assignments = await assignmentsFor(page.map((user) => user.id));
  return {
    data: page.map((user) => ({
      ...presentUser(user),
      assignments: (assignments.get(user.id) ?? [])
        .filter((a) => req.access.canSee(a.unit_path))
        .map(presentAssignment),
    })),
    nextCursor,
  };
}

/** The user's assignments, after checking the viewer may see this person. */
async function loadVisibleUser(req, userId, permission) {
  const user = await db('users').where({ id: userId }).first();
  if (!user) throw errors.notFound('User');
  const assignments = (await assignmentsFor([user.id])).get(user.id) ?? [];
  const isSelf = user.id === req.auth.user.id;
  const viewable = assignments.some((a) => req.access.can('users.view', a.unit_path));
  if (!isSelf && !viewable) throw errors.notFound('User');
  if (permission && !isSelf) {
    // Managing someone needs the permission over every place they work.
    const allowed = assignments.length > 0 && assignments.every((a) => req.access.can(permission, a.unit_path));
    if (!allowed) throw errors.forbidden("You can't manage this person because they also work outside your area");
  }
  return { user, assignments };
}

export async function getUser(req, userId) {
  const { user, assignments } = await loadVisibleUser(req, userId);
  return {
    ...presentUser(user),
    assignments: assignments.filter((a) => req.access.canSee(a.unit_path)).map(presentAssignment),
  };
}

/** Check that the current user may give `roleId` at `unitId`. */
async function checkAssignable(req, { roleId, unitId }, trx = db) {
  const unit = await requireUnit(req, unitId, 'users.manage', trx);
  if (unit.status !== 'active') throw errors.conflict(`${unit.name} is archived`);
  const role = await trx('roles').where({ id: roleId }).first();
  if (!role || (role.group_id && role.group_id !== unit.root_id)) {
    throw errors.validation([{ path: 'body.roleId', message: 'This role is not available in this group' }]);
  }
  if (!req.access.canGrant(role.permissions, unit.path)) {
    throw errors.forbidden(`You can't give the ${role.name} role here because it includes permissions you don't have`);
  }
  return { unit, role };
}

async function issueInvite(trx, user, invitedBy) {
  const token = randomToken();
  await trx('user_tokens').where({ user_id: user.id, type: 'invite' }).whereNull('used_at').update({ used_at: trx.fn.now() });
  await trx('user_tokens').insert({
    user_id: user.id,
    type: 'invite',
    token_hash: sha256(token),
    expires_at: new Date(Date.now() + INVITE_TTL_MS),
    created_by: invitedBy,
  });
  return `${env.APP_URL}/accept-invite?token=${token}`;
}

function inviteEmail(user, inviter, url) {
  return {
    to: user.email,
    subject: `${inviter.name} invited you to Phoenix Platform`,
    text: `Hi ${user.name},\n\n${inviter.name} has given you access to Phoenix Platform. Set your password to get started:\n${url}\n\nThis link works once and expires in 7 days.`,
  };
}

export async function inviteUser(req, input) {
  const inviter = req.auth.user;
  const checked = [];
  for (const assignment of input.assignments) checked.push(await checkAssignable(req, assignment));

  const existing = await db('users').whereRaw('lower(email) = ?', [input.email]).first();
  if (existing?.status === 'disabled') throw errors.conflict('This person has a disabled account. Re-enable it instead.');

  const result = await db.transaction(async (trx) => {
    let user = existing;
    if (!user) {
      [user] = await trx('users')
        .insert({ email: input.email, name: input.name, phone: input.phone ?? null, status: 'invited' })
        .returning('*');
    }
    const added = [];
    for (const { unit, role } of checked) {
      const [row] = await trx('role_assignments')
        .insert({ user_id: user.id, role_id: role.id, org_unit_id: unit.id, created_by: inviter.id })
        .onConflict(['user_id', 'role_id', 'org_unit_id'])
        .ignore()
        .returning('*');
      if (!row) continue;
      added.push(row);
      await writeAudit(trx, req, {
        action: 'role_assignment.added',
        entityType: 'user',
        entityId: user.id,
        unit,
        after: { role: role.key, unitId: unit.id },
      });
    }
    const firstUnit = checked[0].unit;
    await writeAudit(trx, req, {
      action: existing ? 'user.access_added' : 'user.invited',
      entityType: 'user',
      entityId: user.id,
      unit: firstUnit,
      after: { email: user.email, name: user.name },
    });
    await emitEvent(trx, {
      type: existing ? 'user.access_added' : 'user.invited',
      groupId: firstUnit.root_id,
      unitId: firstUnit.id,
      aggregateType: 'user',
      aggregateId: user.id,
      actorUserId: inviter.id,
      payload: { email: user.email, assignments: added.map((a) => ({ roleId: a.role_id, unitId: a.org_unit_id })) },
    });
    const inviteUrl = user.status === 'invited' ? await issueInvite(trx, user, inviter.id) : null;
    return { user, inviteUrl, added: added.length };
  });

  await bumpAccessVersion();
  if (result.inviteUrl) await enqueueMail(inviteEmail(result.user, inviter, result.inviteUrl));

  return {
    user: await getUser(req, result.user.id),
    alreadyHadAccount: Boolean(existing),
    // Handy in development; in production the link only travels by email.
    inviteUrl: env.isProd ? undefined : (result.inviteUrl ?? undefined),
  };
}

export async function resendInvite(req, userId) {
  const { user, assignments } = await loadVisibleUser(req, userId, 'users.manage');
  if (user.status !== 'invited') throw errors.conflict('This person has already accepted their invitation');
  const inviteUrl = await db.transaction(async (trx) => {
    const url = await issueInvite(trx, user, req.auth.user.id);
    await writeAudit(trx, req, {
      action: 'user.invite_resent',
      entityType: 'user',
      entityId: user.id,
      unit: homeUnitOf(assignments),
    });
    return url;
  });
  await enqueueMail(inviteEmail(user, req.auth.user, inviteUrl));
  return { inviteUrl: env.isProd ? undefined : inviteUrl };
}

export async function updateUser(req, userId, input) {
  const isSelf = userId === req.auth.user.id;
  const managing = input.status !== undefined || !isSelf;
  const { user, assignments } = await loadVisibleUser(req, userId, managing ? 'users.manage' : undefined);
  const home = homeUnitOf(assignments);

  const changes = {};
  if (input.name !== undefined) changes.name = input.name;
  if (input.phone !== undefined) changes.phone = input.phone;
  if (input.timeZone !== undefined) changes.time_zone = input.timeZone;

  let action = 'user.updated';
  if (input.status !== undefined && input.status !== user.status) {
    if (isSelf) throw errors.conflict("You can't change your own account status");
    if (input.status === 'disabled') {
      action = 'user.disabled';
      changes.status = 'disabled';
    } else {
      action = 'user.enabled';
      changes.status = user.password_hash ? 'active' : 'invited';
    }
  }
  if (Object.keys(changes).length === 0) return getUser(req, userId);
  changes.updated_at = db.fn.now();

  await db.transaction(async (trx) => {
    const [row] = await trx('users').where({ id: user.id }).update(changes).returning('*');
    await writeAudit(trx, req, {
      action,
      entityType: 'user',
      entityId: user.id,
      unit: home,
      before: { name: user.name, phone: user.phone, timeZone: user.time_zone, status: user.status },
      after: { name: row.name, phone: row.phone, timeZone: row.time_zone, status: row.status },
    });
    await emitEvent(trx, {
      type: action,
      groupId: home?.root_id,
      unitId: home?.id,
      aggregateType: 'user',
      aggregateId: user.id,
      actorUserId: req.auth.user.id,
      payload: { status: row.status },
    });
  });
  if (changes.status === 'disabled') await revokeUserSessions(user.id);
  return getUser(req, userId);
}

export async function addAssignment(req, userId, input) {
  const { user } = await loadVisibleUser(req, userId);
  if (user.status === 'disabled') throw errors.conflict('Re-enable this account before giving it access');
  const { unit, role } = await checkAssignable(req, input);
  await db.transaction(async (trx) => {
    const [row] = await trx('role_assignments')
      .insert({ user_id: user.id, role_id: role.id, org_unit_id: unit.id, created_by: req.auth.user.id })
      .onConflict(['user_id', 'role_id', 'org_unit_id'])
      .ignore()
      .returning('*');
    if (!row) throw errors.conflict(`${user.name} already has this role here`);
    await writeAudit(trx, req, {
      action: 'role_assignment.added',
      entityType: 'user',
      entityId: user.id,
      unit,
      after: { role: role.key, unitId: unit.id },
    });
    await emitEvent(trx, {
      type: 'role_assignment.added',
      groupId: unit.root_id,
      unitId: unit.id,
      aggregateType: 'user',
      aggregateId: user.id,
      actorUserId: req.auth.user.id,
      payload: { roleId: role.id, roleKey: role.key },
    });
  });
  await bumpAccessVersion();
  return getUser(req, userId);
}

export async function removeAssignment(req, userId, assignmentId) {
  const assignment = await db('role_assignments as ra')
    .join('roles as r', 'r.id', 'ra.role_id')
    .where({ 'ra.id': assignmentId, 'ra.user_id': userId })
    .select('ra.*', 'r.key as role_key', 'r.name as role_name')
    .first();
  if (!assignment) throw errors.notFound('Access');
  const unit = await requireUnit(req, assignment.org_unit_id, 'users.manage');

  await db.transaction(async (trx) => {
    if (assignment.role_key === 'group_owner' && unit.parent_id === null) {
      const { n } = await trx('role_assignments as ra')
        .join('roles as r', 'r.id', 'ra.role_id')
        .join('users as u', 'u.id', 'ra.user_id')
        .where({ 'r.key': 'group_owner', 'ra.org_unit_id': unit.id, 'u.status': 'active' })
        .count({ n: '*' })
        .first();
      if (Number(n) <= 1) throw errors.conflict('A group needs at least one active owner');
    }
    await trx('role_assignments').where({ id: assignment.id }).delete();
    await writeAudit(trx, req, {
      action: 'role_assignment.removed',
      entityType: 'user',
      entityId: userId,
      unit,
      before: { role: assignment.role_key, unitId: unit.id },
    });
    await emitEvent(trx, {
      type: 'role_assignment.removed',
      groupId: unit.root_id,
      unitId: unit.id,
      aggregateType: 'user',
      aggregateId: userId,
      actorUserId: req.auth.user.id,
      payload: { roleKey: assignment.role_key },
    });
  });
  await bumpAccessVersion();
}
