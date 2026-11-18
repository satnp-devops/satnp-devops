import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db } from '../../../lib/db.js';
import { errors } from '../../../lib/errors.js';
import { redis } from '../../../lib/redis.js';
import { decodeCursor, pageOf } from '../../../lib/pagination.js';
import { writeAudit } from '../../../core/audit.js';
import { emitEvent } from '../../../core/events.js';
import { permissionCatalog } from '../../../core/registry.js';
import { unitsIndex } from '../../../core/crm/scope.js';
import { ownerUnit, requirePlaces, unitRef, workingScope } from '../scope.js';
import { apiKeyCacheKey } from './auth.js';
import { DENIED_SCOPE_MODULES, generateApiKey, keyStatus, scopeProblems, serviceUserFor } from './keys.js';

const MANAGE = 'api_keys.manage';
const iso = (value) => (value ? new Date(value).toISOString() : null);

export function presentApiKey(row, index) {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    unit: unitRef(index.get(row.unit_id)),
    scopes: row.scopes,
    status: keyStatus(row),
    expiresAt: iso(row.expires_at),
    lastUsedAt: iso(row.last_used_at),
    lastUsedIp: row.last_used_ip ?? null,
    createdAt: iso(row.created_at),
    createdBy: row.created_by ? { id: row.created_by, name: row.created_by_name ?? null } : null,
    revokedAt: iso(row.revoked_at),
  };
}

const keyColumns = (q) => q.leftJoin('users as c', 'c.id', 'k.created_by').select('k.*', 'c.name as created_by_name');

const cursorShape = z.object({ createdAt: z.iso.datetime(), id: z.uuid() });

/** Keys at the working company, or at the group and every company where the user manages keys. Newest first. */
export async function listApiKeys(req, { unitId, status, cursor, limit }) {
  const scope = await workingScope(req, unitId);
  const places = requirePlaces(req, scope, MANAGE);
  const unitIds = [...places.companies.map((c) => c.id), ...(places.group ? [places.group.id] : [])];
  const after = cursor ? cursorShape.safeParse(decodeCursor(cursor)) : null;
  if (after && !after.success) throw errors.badRequest('Invalid cursor');
  const rows = await db('api_keys as k')
    .where('k.group_id', scope.unit.root_id)
    .whereIn('k.unit_id', unitIds)
    .modify((q) => {
      if (status === 'active') q.whereNull('k.revoked_at').where((s) => s.whereNull('k.expires_at').orWhere('k.expires_at', '>', db.fn.now()));
      if (after) q.whereRaw('(k.created_at, k.id) < (?::timestamptz, ?::uuid)', [after.data.createdAt, after.data.id]);
    })
    .modify(keyColumns)
    .orderBy([
      { column: 'k.created_at', order: 'desc' },
      { column: 'k.id', order: 'desc' },
    ])
    .limit(limit + 1);
  const { page, nextCursor } = pageOf(rows, limit, (row) => ({ createdAt: iso(row.created_at), id: row.id }));
  return { data: page.map((row) => presentApiKey(row, scope.index)), nextCursor };
}

/** The permissions a key at this unit may carry: the ones the user could grant there, minus api_keys.*. */
export async function grantableScopes(req, { unitId }) {
  const index = await unitsIndex(req);
  const unit = ownerUnit(req, index, unitId, 'query.unitId');
  if (!req.access.can(MANAGE, unit.path)) throw errors.forbidden();
  return permissionCatalog(req.app.locals.registry)
    .filter((group) => !DENIED_SCOPE_MODULES.includes(group.module))
    .map((group) => ({
      module: group.module,
      label: group.label,
      permissions: group.permissions
        .filter((p) => req.access.canGrant([p.key], unit.path))
        .map(({ key, label, description }) => ({ key, label, description })),
    }))
    .filter((group) => group.permissions.length > 0);
}

export async function createApiKey(req, body) {
  const index = await unitsIndex(req);
  const unit = ownerUnit(req, index, body.unitId);
  if (!req.access.can(MANAGE, unit.path)) throw errors.forbidden();
  const scopes = [...new Set(body.scopes)].sort();
  const problems = scopeProblems(req.app.locals.registry, scopes, (scope) => req.access.canGrant([scope], unit.path));
  if (problems.length) throw errors.validation(problems.map((p) => ({ path: `body.scopes.${p.index}`, message: `${scopes[p.index]}: ${p.message}` })));
  if (body.expiresAt && new Date(body.expiresAt).getTime() <= Date.now()) {
    throw errors.validation([{ path: 'body.expiresAt', message: 'Pick a time in the future' }]);
  }

  const id = randomUUID();
  const key = generateApiKey();
  const row = await db.transaction(async (trx) => {
    const [serviceUser] = await trx('users').insert(serviceUserFor(id, body.name)).returning('id');
    const [created] = await trx('api_keys')
      .insert({
        id,
        group_id: unit.root_id,
        unit_id: unit.id,
        name: body.name,
        prefix: key.prefix,
        key_hash: key.hash,
        scopes,
        service_user_id: serviceUser.id,
        created_by: req.auth.user.id,
        expires_at: body.expiresAt ?? null,
      })
      .returning('*');
    const after = { name: created.name, prefix: created.prefix, scopes, expiresAt: iso(created.expires_at) };
    await writeAudit(trx, req, { action: 'api_key.created', entityType: 'api_key', entityId: id, unit, after });
    await emitEvent(trx, {
      type: 'api_key.created',
      groupId: unit.root_id,
      unitId: unit.id,
      aggregateType: 'api_key',
      aggregateId: id,
      actorUserId: req.auth.user.id,
      payload: { name: created.name, scopes },
    });
    return created;
  });
  // The one time the key is shown. It isn't stored anywhere.
  return { ...presentApiKey({ ...row, created_by_name: req.auth.user.name }, index), secret: key.secret };
}

/** Revoke a key. Keys the user can't manage are 404, like records outside their scope. Revoking twice is a no-op. */
export async function revokeApiKey(req, id) {
  const index = await unitsIndex(req);
  const hash = await db.transaction(async (trx) => {
    const row = await trx('api_keys').where({ id }).forUpdate().first();
    const unit = row ? index.get(row.unit_id) : null;
    if (!row || !unit || !req.access.can(MANAGE, unit.path)) throw errors.notFound('API key');
    if (row.revoked_at) return row.key_hash;
    await trx('api_keys').where({ id }).update({ revoked_at: trx.fn.now(), revoked_by: req.auth.user.id });
    await writeAudit(trx, req, { action: 'api_key.revoked', entityType: 'api_key', entityId: id, unit, before: { name: row.name, prefix: row.prefix, scopes: row.scopes } });
    await emitEvent(trx, {
      type: 'api_key.revoked',
      groupId: unit.root_id,
      unitId: unit.id,
      aggregateType: 'api_key',
      aggregateId: id,
      actorUserId: req.auth.user.id,
      payload: { name: row.name },
    });
    return row.key_hash;
  });
  await redis.del(apiKeyCacheKey(hash));
}
