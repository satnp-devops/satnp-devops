import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { db, json } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { parseOrThrow, toFieldErrors } from '../../lib/validate.js';
import { writeAudit } from '../../core/audit.js';
import { emitEvent } from '../../core/events.js';
import { unitsIndex } from '../../core/crm/scope.js';
import { adapterForConnection, getKind, getProvider, isIntegrationError, mocksAllowed } from '../../integrations/index.js';
import { decryptCredentials, encryptCredentials } from '../../integrations/framework/credentials.js';
import { credentialHints } from '../../integrations/framework/fields.js';
import { summarisePayload } from '../../integrations/framework/mocks/common.js';
import { presentConnection } from './present.js';
import { ownerUnit, requirePlaces, workingScope } from './scope.js';

const VIEW = 'integrations.view';
const MANAGE = 'integrations.manage';

/** Drop unset values so stored config and credentials hold only what was given. */
const clean = (values) => Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined && v !== null && v !== ''));

/** Apply a partial update: undefined keeps, null clears, anything else replaces. */
function applyPatch(base, partial) {
  const out = { ...(base ?? {}) };
  for (const [key, value] of Object.entries(partial)) {
    if (value === undefined) continue;
    if (value === null) delete out[key];
    else out[key] = value;
  }
  return out;
}

async function linksFor(connectionIds, trx = db) {
  const byConnection = new Map(connectionIds.map((id) => [id, []]));
  if (connectionIds.length === 0) return byConnection;
  const rows = await trx('integration_connection_companies').whereIn('connection_id', connectionIds);
  for (const row of rows) byConnection.get(row.connection_id)?.push(row);
  return byConnection;
}

function presenter(req, index) {
  return (row, links) =>
    presentConnection(row, {
      links,
      index,
      canManage: Boolean(index.get(row.unit_id) && req.access.can(MANAGE, index.get(row.unit_id).path)),
      canSeeUnit: (unit) => req.access.canSee(unit.path),
    });
}

/** Connections the user may see in the working scope (owned by its companies or the group, or used by its companies). */
export async function listConnections(req, { unitId, kind }) {
  const scope = await workingScope(req, unitId);
  const places = requirePlaces(req, scope, VIEW);
  const companyIds = places.companies.map((c) => c.id);
  const ownerIds = [...companyIds, ...(places.group ? [places.group.id] : [])];
  const rows = await db('integration_connections as c')
    .where('c.group_id', scope.unit.root_id)
    .whereNull('c.disconnected_at')
    .where((q) => {
      q.whereIn('c.unit_id', ownerIds);
      if (companyIds.length) {
        q.orWhereExists(db('integration_connection_companies as l').whereRaw('l.connection_id = c.id').whereIn('l.company_id', companyIds));
      }
    })
    .modify((q) => {
      if (kind) q.where('c.kind', kind);
    })
    .orderBy([{ column: 'c.kind' }, { column: 'c.created_at' }, { column: 'c.id' }])
    .limit(1000)
    .select('c.*');
  const links = await linksFor(rows.map((r) => r.id));
  const present = presenter(req, scope.index);
  return rows.map((row) => present(row, links.get(row.id) ?? []));
}

/**
 * Load a connection the user may see: they hold integrations.view at its owner or at a company
 * that uses it. Anything else is 404.
 */
async function loadConnection(req, id, trx = db, { forUpdate = false } = {}) {
  const query = trx('integration_connections').where({ id }).whereNull('disconnected_at').first();
  if (forUpdate) query.forUpdate();
  const row = await query;
  if (!row) throw errors.notFound('Connection');
  const index = await unitsIndex(req, trx);
  const owner = index.get(row.unit_id);
  if (!owner) throw errors.notFound('Connection');
  const links = await trx('integration_connection_companies').where({ connection_id: id });
  const can = (permission, unit) => Boolean(unit && req.access.can(permission, unit.path));
  const visible = can(VIEW, owner) || links.some((l) => can(VIEW, index.get(l.company_id)));
  if (!visible) throw errors.notFound('Connection');
  const canManage = can(MANAGE, owner);
  const operateCompanies = links.filter((l) => can(MANAGE, index.get(l.company_id))).map((l) => l.company_id);
  return { row, links, index, owner, canManage, canOperate: canManage || operateCompanies.length > 0, operateCompanies };
}

export async function getConnection(req, id) {
  const { row, links, index } = await loadConnection(req, id);
  return presenter(req, index)(row, links);
}

/** The companies a connection serves: its own company, or companies of the group for a group connection. */
function resolveCompanies(owner, companyIds, index, path) {
  if (owner.type === 'company') {
    if (companyIds && !(companyIds.length === 1 && companyIds[0] === owner.id)) {
      throw errors.validation([{ path, message: 'A company connection is used by that company only. Connect it on the group to share it.' }]);
    }
    return [owner.id];
  }
  const all = [...index.values()].filter((u) => u.type === 'company' && u.root_id === owner.id && u.status === 'active');
  if (!companyIds) return all.map((u) => u.id);
  const ids = [...new Set(companyIds)];
  ids.forEach((companyId, i) => {
    if (!all.some((u) => u.id === companyId)) throw errors.validation([{ path: `${path}.${i}`, message: 'Not an active company of this group' }]);
  });
  return ids;
}

/**
 * Link companies to a connection. A company gets it as its default for the kind when asked
 * (makeDefault true) or when it has no default yet (makeDefault undefined).
 */
async function linkCompanies(trx, connection, companyIds, { makeDefault }) {
  if (companyIds.length === 0) return;
  const defaults = new Set(
    await trx('integration_connection_companies').whereIn('company_id', companyIds).where({ kind: connection.kind, is_default: true }).pluck('company_id'),
  );
  const rows = companyIds.map((companyId) => ({
    connection_id: connection.id,
    company_id: companyId,
    kind: connection.kind,
    is_default: connection.status === 'active' && (makeDefault === true || (makeDefault !== false && !defaults.has(companyId))),
  }));
  const replacing = rows.filter((r) => r.is_default && defaults.has(r.company_id)).map((r) => r.company_id);
  if (replacing.length) {
    await trx('integration_connection_companies').whereIn('company_id', replacing).where({ kind: connection.kind, is_default: true }).update({ is_default: false });
  }
  await trx('integration_connection_companies').insert(rows);
}

async function assertNameFree(trx, unitId, name, exceptId) {
  const clash = await trx('integration_connections')
    .where({ unit_id: unitId })
    .whereNull('disconnected_at')
    .whereRaw('lower(name) = lower(?)', [name])
    .modify((q) => {
      if (exceptId) q.whereNot({ id: exceptId });
    })
    .first('id');
  if (clash) throw errors.conflict('A connection with this name already exists here', { connectionId: clash.id });
}

function providerFor(kind, providerKey, path = 'body.provider') {
  const provider = getProvider(kind, providerKey);
  if (!provider) throw errors.validation([{ path, message: `Not a provider for ${getKind(kind)?.label ?? kind}` }]);
  if (provider.mock && !mocksAllowed()) throw errors.validation([{ path, message: 'Mock connections are switched off on this server' }]);
  return provider;
}

export async function createConnection(req, body) {
  const index = await unitsIndex(req);
  const owner = ownerUnit(req, index, body.unitId);
  if (!req.access.can(MANAGE, owner.path)) throw errors.forbidden();
  const provider = providerFor(body.kind, body.provider);
  // Check config and credentials together, so the form shows every problem at once.
  const configResult = provider.configSchema.safeParse(body.config ?? {});
  const credentialsResult = provider.credentialsSchema.safeParse(body.credentials ?? {});
  if (!configResult.success || !credentialsResult.success) {
    throw errors.validation([
      ...(configResult.success ? [] : toFieldErrors(configResult.error, 'body.config')),
      ...(credentialsResult.success ? [] : toFieldErrors(credentialsResult.error, 'body.credentials')),
    ]);
  }
  const config = clean(configResult.data);
  const credentials = clean(credentialsResult.data);
  const companyIds = resolveCompanies(owner, body.companyIds, index, 'body.companyIds');
  const id = randomUUID();

  await db.transaction(async (trx) => {
    await assertNameFree(trx, owner.id, body.name);
    const [row] = await trx('integration_connections')
      .insert({
        id,
        group_id: owner.root_id,
        unit_id: owner.id,
        kind: body.kind,
        provider: provider.key,
        name: body.name,
        config: json(config),
        credentials_enc: encryptCredentials(id, credentials, env.encryptionKey),
        credential_hints: json(credentialHints(provider.fields, credentials)),
        created_by: req.auth.user.id,
        updated_by: req.auth.user.id,
      })
      .returning('*');
    await linkCompanies(trx, row, companyIds, { makeDefault: body.makeDefault });
    await writeAudit(trx, req, {
      action: 'integration_connection.created',
      entityType: 'integration_connection',
      entityId: id,
      unit: owner,
      after: { kind: row.kind, provider: row.provider, name: row.name, config, companyIds },
      meta: { credentialFields: Object.keys(credentials) },
    });
    await emitEvent(trx, {
      type: 'integration_connection.created',
      groupId: owner.root_id,
      unitId: owner.id,
      aggregateType: 'integration_connection',
      aggregateId: id,
      actorUserId: req.auth.user.id,
      payload: { kind: row.kind, provider: row.provider, companyIds },
    });
  });
  return getConnection(req, id);
}

export async function updateConnection(req, id, body) {
  await db.transaction(async (trx) => {
    const { row, links, index, owner, canManage } = await loadConnection(req, id, trx, { forUpdate: true });
    if (!canManage) throw errors.forbidden();
    const provider = providerFor(row.kind, row.provider);
    const patch = { updated_by: req.auth.user.id, updated_at: trx.fn.now() };
    const before = { name: row.name, status: row.status, config: row.config, companyIds: links.map((l) => l.company_id).sort() };
    const after = { ...before };
    let credentialFields = [];

    if (body.name !== undefined && body.name !== row.name) {
      await assertNameFree(trx, owner.id, body.name, row.id);
      patch.name = after.name = body.name;
    }
    if (body.config) {
      const partial = parseOrThrow(provider.configUpdateSchema, body.config, 'body.config');
      const config = clean(parseOrThrow(provider.configSchema, applyPatch(row.config, partial), 'body.config'));
      patch.config = json(config);
      after.config = config;
    }
    if (body.credentials) {
      const partial = parseOrThrow(provider.credentialsUpdateSchema, body.credentials, 'body.credentials');
      credentialFields = Object.keys(partial).filter((key) => partial[key] !== undefined);
      if (credentialFields.length) {
        const current = decryptCredentials(row.id, row.credentials_enc, env.encryptionKey);
        const credentials = clean(parseOrThrow(provider.credentialsSchema, applyPatch(current, partial), 'body.credentials'));
        patch.credentials_enc = encryptCredentials(row.id, credentials, env.encryptionKey);
        patch.credential_hints = json(credentialHints(provider.fields, credentials));
      }
    }
    if (body.status && body.status !== row.status) patch.status = after.status = body.status;
    if (JSON.stringify(after.config) !== JSON.stringify(before.config) || credentialFields.length) {
      Object.assign(patch, { health_status: 'unknown', health_message: null, last_error: null, last_checked_at: null });
    }
    await trx('integration_connections').where({ id }).update(patch);

    if (body.companyIds !== undefined) {
      const next = resolveCompanies(owner, body.companyIds, index, 'body.companyIds');
      const current = links.map((l) => l.company_id);
      const removed = current.filter((companyId) => !next.includes(companyId));
      const added = next.filter((companyId) => !current.includes(companyId));
      if (removed.length) await trx('integration_connection_companies').where({ connection_id: id }).whereIn('company_id', removed).delete();
      await linkCompanies(trx, { ...row, ...patch }, added, { makeDefault: undefined });
      after.companyIds = [...next].sort();
    }
    // A disabled connection is nobody's default.
    if (patch.status === 'disabled') await trx('integration_connection_companies').where({ connection_id: id }).update({ is_default: false });

    await writeAudit(trx, req, {
      action: 'integration_connection.updated',
      entityType: 'integration_connection',
      entityId: id,
      unit: owner,
      before,
      after,
      meta: credentialFields.length ? { credentialFieldsChanged: credentialFields } : undefined,
    });
    await emitEvent(trx, {
      type: 'integration_connection.updated',
      groupId: owner.root_id,
      unitId: owner.id,
      aggregateType: 'integration_connection',
      aggregateId: id,
      actorUserId: req.auth.user.id,
      payload: { kind: row.kind, provider: row.provider, status: after.status, companyIds: after.companyIds, credentialsChanged: credentialFields.length > 0 },
    });
  });
  return getConnection(req, id);
}

/** Make a connection the default for one company and its kind. A company decision: manage at that company. */
export async function makeDefault(req, id, { companyId }) {
  await db.transaction(async (trx) => {
    const { row, links, index } = await loadConnection(req, id, trx, { forUpdate: true });
    const link = links.find((l) => l.company_id === companyId);
    const company = index.get(companyId);
    if (!link || !company) throw errors.validation([{ path: 'body.companyId', message: 'This connection is not used by that company' }]);
    if (!req.access.can(MANAGE, company.path)) throw errors.forbidden();
    if (row.status !== 'active') throw errors.conflict('Enable the connection before making it the default');
    if (link.is_default) return;
    await trx('integration_connection_companies').where({ company_id: companyId, kind: row.kind, is_default: true }).update({ is_default: false });
    await trx('integration_connection_companies').where({ connection_id: id, company_id: companyId }).update({ is_default: true });
    await writeAudit(trx, req, {
      action: 'integration_connection.default_changed',
      entityType: 'integration_connection',
      entityId: id,
      unit: company,
      after: { companyId, kind: row.kind },
    });
    await emitEvent(trx, {
      type: 'integration_connection.default_changed',
      groupId: company.root_id,
      unitId: company.id,
      aggregateType: 'integration_connection',
      aggregateId: id,
      actorUserId: req.auth.user.id,
      payload: { companyId, kind: row.kind, provider: row.provider },
    });
  });
  return getConnection(req, id);
}

/** Run the adapter's health check and store the result. Allowed for managers of the owner or of a company that uses it. */
export async function testConnection(req, id) {
  const { row, links, owner, canOperate, operateCompanies } = await loadConnection(req, id);
  if (!canOperate) throw errors.forbidden();
  let result;
  try {
    const adapter = adapterForConnection(row, { companyId: operateCompanies[0] ?? links[0]?.company_id ?? null });
    result = await adapter.healthCheck();
  } catch (error) {
    if (!isIntegrationError(error)) (req.log ?? logger).warn({ err: error, connectionId: id }, 'Connection health check failed');
    result = { ok: false, message: isIntegrationError(error) ? error.message : 'The health check failed. See the server log.' };
  }
  const health = result.ok ? 'healthy' : 'failing';
  const message = String(result.message ?? '').slice(0, 500);
  await db.transaction(async (trx) => {
    await trx('integration_connections')
      .where({ id })
      .update({ health_status: health, health_message: message, last_checked_at: trx.fn.now(), last_error: result.ok ? null : message });
    await writeAudit(trx, req, {
      action: 'integration_connection.tested',
      entityType: 'integration_connection',
      entityId: id,
      unit: owner,
      meta: { ok: result.ok },
    });
    if (row.health_status !== health) {
      await emitEvent(trx, {
        type: 'integration_connection.health_changed',
        groupId: owner.root_id,
        unitId: owner.id,
        aggregateType: 'integration_connection',
        aggregateId: id,
        actorUserId: req.auth.user.id,
        payload: { kind: row.kind, provider: row.provider, from: row.health_status, to: health },
      });
    }
  });
  return { result: { ok: result.ok, message }, connection: await getConnection(req, id) };
}

/**
 * Make the kind's sample call (kinds/*.js `sample`) through a mock connection, so people can see
 * the sandbox outbox fill up. Real providers are refused: the sample would reach a real number.
 */
export async function tryConnection(req, id) {
  const { row, links, owner, canOperate, operateCompanies } = await loadConnection(req, id);
  if (!canOperate) throw errors.forbidden();
  if (row.provider !== 'mock') throw errors.conflict('Try is for mock connections only. Use Test for a real provider.');
  if (row.status !== 'active') throw errors.conflict('Enable the connection first');
  const kind = getKind(row.kind);
  const input = kind.sample.input({ now: Date.now, provider: row.provider });
  let outcome;
  try {
    const adapter = adapterForConnection(row, { companyId: operateCompanies[0] ?? links[0]?.company_id ?? null });
    const output = await adapter[kind.sample.method](input);
    outcome = { method: kind.sample.method, ok: true, input: summarisePayload(input), output: summarisePayload(output), error: null };
  } catch (error) {
    if (!isIntegrationError(error)) throw error;
    outcome = { method: kind.sample.method, ok: false, input: summarisePayload(input), output: null, error: { code: error.code, message: error.message } };
  }
  await writeAudit(db, req, {
    action: 'integration_connection.tried',
    entityType: 'integration_connection',
    entityId: id,
    unit: owner,
    meta: { method: outcome.method, ok: outcome.ok },
  });
  return outcome;
}

/** Disconnect: credentials are wiped, companies unlinked, channels kept without a connection. The row stays for history. */
export async function disconnectConnection(req, id) {
  await db.transaction(async (trx) => {
    const { row, links, owner, canManage } = await loadConnection(req, id, trx, { forUpdate: true });
    if (!canManage) throw errors.forbidden();
    await trx('integration_connections').where({ id }).update({
      disconnected_at: trx.fn.now(),
      disconnected_by: req.auth.user.id,
      status: 'disabled',
      credentials_enc: null,
      credential_hints: json({}),
      updated_by: req.auth.user.id,
      updated_at: trx.fn.now(),
    });
    await trx('integration_connection_companies').where({ connection_id: id }).delete();
    await trx('channel_identities').where({ connection_id: id }).update({ connection_id: null, updated_at: trx.fn.now() });
    await writeAudit(trx, req, {
      action: 'integration_connection.disconnected',
      entityType: 'integration_connection',
      entityId: id,
      unit: owner,
      before: { name: row.name, kind: row.kind, provider: row.provider, companyIds: links.map((l) => l.company_id) },
    });
    await emitEvent(trx, {
      type: 'integration_connection.disconnected',
      groupId: owner.root_id,
      unitId: owner.id,
      aggregateType: 'integration_connection',
      aggregateId: id,
      actorUserId: req.auth.user.id,
      payload: { kind: row.kind, provider: row.provider, companyIds: links.map((l) => l.company_id) },
    });
  });
}
