import { db } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { writeAudit } from '../../core/audit.js';
import { emitEvent } from '../../core/events.js';
import { unitsIndex } from '../../core/crm/scope.js';
import { KIND_IDENTITY_TYPES, identityProblem, normalizeChannelIdentity } from '../../integrations/framework/identities.js';
import { presentIdentity } from './present.js';
import { requirePlaces, workingScope } from './scope.js';

// Channel identities: which company owns each number, inbox, form, page and link (or which
// companies share it). Owned identities are managed by the company; shared ones by the group.

const VIEW = 'integrations.view';
const MANAGE = 'integrations.manage';

async function connectionsById(ids, trx = db) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const rows = await trx('integration_connections').whereIn('id', unique).select('id', 'name', 'kind', 'provider', 'unit_id', 'disconnected_at');
  return new Map(rows.map((r) => [r.id, r]));
}

/** Who manages an identity: the owning company, or the group for a shared one. */
function managingUnit(row, index) {
  return row.shared ? index.get(row.group_id) : index.get(row.company_id);
}

function canManageIdentity(req, row, index) {
  const unit = managingUnit(row, index);
  return Boolean(unit && req.access.can(MANAGE, unit.path));
}

function canViewIdentity(req, row, index) {
  const companies = row.shared ? row.company_ids : [row.company_id];
  const units = [...companies.map((id) => index.get(id)), row.shared ? index.get(row.group_id) : null].filter(Boolean);
  return units.some((unit) => req.access.can(VIEW, unit.path));
}

export async function listIdentities(req, { unitId, type, connectionId }) {
  const scope = await workingScope(req, unitId);
  const places = requirePlaces(req, scope, VIEW);
  const companyIds = places.companies.map((c) => c.id);
  const rows = await db('channel_identities')
    .where({ group_id: scope.unit.root_id })
    .whereNull('archived_at')
    .where((q) => {
      if (places.group) q.where('shared', true);
      if (companyIds.length) {
        q.orWhereIn('company_id', companyIds).orWhere((s) => s.where('shared', true).whereRaw('company_ids && ?::uuid[]', [companyIds]));
      }
    })
    .modify((q) => {
      if (type) q.where({ type });
      if (connectionId) q.where({ connection_id: connectionId });
    })
    .orderBy([{ column: 'type' }, { column: 'identity_normalized' }, { column: 'id' }])
    .limit(1000);
  const connections = await connectionsById(rows.map((r) => r.connection_id));
  return rows.map((row) =>
    presentIdentity(row, { index: scope.index, connection: connections.get(row.connection_id), canManage: canManageIdentity(req, row, scope.index), canSeeUnit: (unit) => req.access.canSee(unit.path) }),
  );
}

async function loadIdentity(req, id, trx = db) {
  const row = await trx('channel_identities').where({ id }).whereNull('archived_at').forUpdate().first();
  if (!row) throw errors.notFound('Channel');
  const index = await unitsIndex(req, trx);
  if (!canViewIdentity(req, row, index)) throw errors.notFound('Channel');
  return { row, index };
}

/** The companies an identity routes to, validated: one company, or two or more of the group when shared. */
function resolveOwnership(req, body, index) {
  if (body.shared) {
    const ids = [...new Set(body.companyIds ?? [])];
    if (ids.length < 2) throw errors.validation([{ path: 'body.companyIds', message: 'Pick at least two companies for a shared channel' }]);
    const companies = ids.map((id, i) => {
      const unit = index.get(id);
      if (!unit || unit.type !== 'company' || !req.access.canSee(unit.path)) {
        throw errors.validation([{ path: `body.companyIds.${i}`, message: 'Not a company you can see' }]);
      }
      return unit;
    });
    const groups = new Set(companies.map((c) => c.root_id));
    if (groups.size !== 1) throw errors.validation([{ path: 'body.companyIds', message: 'Companies must belong to one group' }]);
    const group = index.get(companies[0].root_id);
    if (!req.access.can(MANAGE, group.path)) throw errors.forbidden('Shared channels are managed on the group');
    return { group, company: null, companyIds: ids };
  }
  if (!body.companyId) throw errors.validation([{ path: 'body.companyId', message: 'Choose the company that owns this channel' }]);
  const company = index.get(body.companyId);
  if (!company || company.type !== 'company' || !req.access.canSee(company.path)) throw errors.notFound('Company');
  if (!req.access.can(MANAGE, company.path)) throw errors.forbidden();
  return { group: index.get(company.root_id), company, companyIds: [company.id] };
}

/** A connection may carry an identity when it serves every company the identity routes to and its kind fits the type. */
async function checkConnection(trx, connectionId, { type, companyIds }) {
  if (!connectionId) return null;
  const connection = await trx('integration_connections').where({ id: connectionId }).whereNull('disconnected_at').first();
  const linked = connection
    ? await trx('integration_connection_companies').where({ connection_id: connectionId }).whereIn('company_id', companyIds).pluck('company_id')
    : [];
  if (!connection || linked.length !== companyIds.length) {
    throw errors.validation([{ path: 'body.connectionId', message: 'Choose a connection used by the same companies' }]);
  }
  const allowed = KIND_IDENTITY_TYPES[connection.kind] ?? [];
  if (!allowed.includes(type)) {
    throw errors.validation([{ path: 'body.connectionId', message: `A ${connection.kind} connection can't carry a ${type} channel` }]);
  }
  return connection;
}

async function checkProductLine(trx, productLineId, company) {
  if (!productLineId) return;
  if (!company) throw errors.validation([{ path: 'body.productLineId', message: 'Only a channel owned by one company can fix the product line' }]);
  const line = await trx('product_lines').where({ id: productLineId, company_id: company.id }).first('id');
  if (!line) throw errors.validation([{ path: 'body.productLineId', message: "Not one of this company's product lines" }]);
}

const auditView = (row) => ({
  type: row.type,
  label: row.label,
  companyId: row.company_id,
  shared: row.shared,
  companyIds: row.company_ids,
  connectionId: row.connection_id,
  productLineId: row.product_line_id,
});

export async function createIdentity(req, body) {
  const index = await unitsIndex(req);
  const owner = resolveOwnership(req, body, index);
  const normalized = normalizeChannelIdentity(body.type, body.identity);
  const problem = identityProblem(body.type, normalized);
  if (problem) throw errors.validation([{ path: 'body.identity', message: problem }]);

  const row = await db.transaction(async (trx) => {
    const clash = await trx('channel_identities')
      .where({ group_id: owner.group.id, type: body.type, identity_normalized: normalized })
      .whereNull('archived_at')
      .first();
    if (clash) {
      const visible = canViewIdentity(req, clash, index);
      throw errors.conflict('This channel is already registered', visible ? { identityId: clash.id } : undefined);
    }
    const connection = await checkConnection(trx, body.connectionId, { type: body.type, companyIds: owner.companyIds });
    await checkProductLine(trx, body.productLineId, owner.company);
    const [created] = await trx('channel_identities')
      .insert({
        group_id: owner.group.id,
        connection_id: connection?.id ?? null,
        type: body.type,
        identity: body.identity.trim(),
        identity_normalized: normalized,
        label: body.label || null,
        company_id: owner.company?.id ?? null,
        product_line_id: body.productLineId ?? null,
        shared: Boolean(body.shared),
        company_ids: body.shared ? owner.companyIds : [],
        created_by: req.auth.user.id,
        updated_by: req.auth.user.id,
      })
      .returning('*');
    const unit = owner.company ?? owner.group;
    // The identity itself (a business number or inbox) stays out of the audit entry, like other contact values.
    await writeAudit(trx, req, { action: 'channel_identity.created', entityType: 'channel_identity', entityId: created.id, unit, after: auditView(created) });
    await emitEvent(trx, {
      type: 'channel_identity.created',
      groupId: owner.group.id,
      unitId: unit.id,
      aggregateType: 'channel_identity',
      aggregateId: created.id,
      actorUserId: req.auth.user.id,
      payload: { type: created.type, companyId: created.company_id, shared: created.shared, companyIds: created.company_ids },
    });
    return created;
  });
  const connections = await connectionsById([row.connection_id]);
  return presentIdentity(row, { index, connection: connections.get(row.connection_id), canManage: true, canSeeUnit: (unit) => req.access.canSee(unit.path) });
}

export async function updateIdentity(req, id, body) {
  const result = await db.transaction(async (trx) => {
    const { row, index } = await loadIdentity(req, id, trx);
    if (!canManageIdentity(req, row, index)) throw errors.forbidden();
    const patch = { updated_by: req.auth.user.id, updated_at: trx.fn.now() };
    let companyIds = row.shared ? row.company_ids : [row.company_id];
    if (body.companyIds !== undefined) {
      if (!row.shared) throw errors.validation([{ path: 'body.companyIds', message: 'Only shared channels list companies' }]);
      companyIds = resolveOwnership(req, { shared: true, companyIds: body.companyIds }, index).companyIds;
      patch.company_ids = companyIds;
    }
    if (body.label !== undefined) patch.label = body.label || null;
    if (body.connectionId !== undefined) {
      patch.connection_id = (await checkConnection(trx, body.connectionId, { type: row.type, companyIds }))?.id ?? null;
    }
    if (body.productLineId !== undefined) {
      await checkProductLine(trx, body.productLineId, row.shared ? null : index.get(row.company_id));
      patch.product_line_id = body.productLineId;
    }
    const [updated] = await trx('channel_identities').where({ id }).update(patch).returning('*');
    const unit = managingUnit(row, index);
    await writeAudit(trx, req, { action: 'channel_identity.updated', entityType: 'channel_identity', entityId: id, unit, before: auditView(row), after: auditView(updated) });
    await emitEvent(trx, {
      type: 'channel_identity.updated',
      groupId: row.group_id,
      unitId: unit.id,
      aggregateType: 'channel_identity',
      aggregateId: id,
      actorUserId: req.auth.user.id,
      payload: { type: updated.type, companyId: updated.company_id, shared: updated.shared, companyIds: updated.company_ids },
    });
    return { updated, index };
  });
  const connections = await connectionsById([result.updated.connection_id]);
  return presentIdentity(result.updated, { index: result.index, connection: connections.get(result.updated.connection_id), canManage: true, canSeeUnit: (unit) => req.access.canSee(unit.path) });
}

export async function archiveIdentity(req, id) {
  await db.transaction(async (trx) => {
    const { row, index } = await loadIdentity(req, id, trx);
    if (!canManageIdentity(req, row, index)) throw errors.forbidden();
    await trx('channel_identities').where({ id }).update({ archived_at: trx.fn.now(), updated_by: req.auth.user.id, updated_at: trx.fn.now() });
    const unit = managingUnit(row, index);
    await writeAudit(trx, req, { action: 'channel_identity.archived', entityType: 'channel_identity', entityId: id, unit, before: auditView(row) });
    await emitEvent(trx, {
      type: 'channel_identity.archived',
      groupId: row.group_id,
      unitId: unit.id,
      aggregateType: 'channel_identity',
      aggregateId: id,
      actorUserId: req.auth.user.id,
      payload: { type: row.type, companyId: row.company_id, shared: row.shared },
    });
  });
}
