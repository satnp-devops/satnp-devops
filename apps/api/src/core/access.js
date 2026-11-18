import { db } from '../lib/db.js';
import { redis } from '../lib/redis.js';
import { idsFromPath } from './orgTree.js';
import { AccessContext } from './accessContext.js';

export { AccessContext } from './accessContext.js';

const CACHE_TTL_SECONDS = 300;
const VERSION_KEY = 'access:ver';

/** Load (and cache) a user's assignments and the permissions that come with them. */
export async function loadAccess(userId, registry) {
  const version = (await redis.get(VERSION_KEY)) ?? '0';
  const cacheKey = `access:${userId}:${version}`;
  const cached = await redis.get(cacheKey);
  if (cached) return new AccessContext(JSON.parse(cached));

  const rows = await db('role_assignments as ra')
    .join('roles as r', 'r.id', 'ra.role_id')
    .join('org_units as u', 'u.id', 'ra.org_unit_id')
    .where('ra.user_id', userId)
    .where('u.status', 'active')
    .select(
      'ra.id',
      'ra.org_unit_id',
      'u.path',
      'u.root_id',
      'u.name as unit_name',
      'u.type as unit_type',
      'r.id as role_id',
      'r.key as role_key',
      'r.name as role_name',
      'r.permissions',
    );

  const assignments = rows.map((row) => ({
    id: row.id,
    unitId: row.org_unit_id,
    unitPath: row.path,
    unitName: row.unit_name,
    unitType: row.unit_type,
    groupId: row.root_id,
    roleId: row.role_id,
    roleKey: row.role_key,
    roleName: row.role_name,
    permissions: row.permissions ?? [],
  }));

  const context = new AccessContext({
    userId,
    assignments,
    mfaRequired: await isMfaRequired(assignments, registry),
  });
  await redis.set(cacheKey, JSON.stringify(context), 'EX', CACHE_TTL_SECONDS);
  return context;
}

/** Call after anything that changes who can do what: roles, assignments, unit moves, MFA policy. */
export async function bumpAccessVersion(client = redis) {
  await client.incr(VERSION_KEY);
}

async function isMfaRequired(assignments, registry) {
  if (assignments.length === 0) return false;
  const fallback = registry?.settings.get('security.requireMfa')?.default === true;
  const chainIds = [...new Set(assignments.flatMap((a) => idsFromPath(a.unitPath)))];
  const rows = await db('settings').whereIn('org_unit_id', chainIds).where({ key: 'security.requireMfa' });
  const byUnit = new Map(rows.map((row) => [row.org_unit_id, row.value]));
  return assignments.some((assignment) => {
    const ids = idsFromPath(assignment.unitPath);
    for (let i = ids.length - 1; i >= 0; i -= 1) {
      if (byUnit.has(ids[i])) return byUnit.get(ids[i]) === true;
    }
    return fallback;
  });
}
