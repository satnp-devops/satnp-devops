import { db } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { decodeCursor, pageOf } from '../../lib/pagination.js';
import { writeAudit } from '../../core/audit.js';
import { presentSandboxMessage } from './present.js';
import { requirePlaces, workingScope } from './scope.js';

// The sandbox outbox: what mock adapters "sent", newest first. Recipients are masked for people
// without contacts.view_pii at the company, and the full payload is shown only to those with it.

export async function listSandbox(req, { unitId, kind, connectionId, cursor, limit }) {
  const scope = await workingScope(req, unitId);
  const places = requirePlaces(req, scope, 'integrations.view');
  const companyIds = places.companies.map((c) => c.id);
  const after = decodeCursor(cursor);
  if (after && !/^\d{1,18}$/.test(String(after.id ?? ''))) throw errors.badRequest('Invalid cursor');
  const rows = await db('integration_sandbox_messages')
    .where({ group_id: scope.unit.root_id })
    .whereIn('company_id', companyIds)
    .modify((q) => {
      if (kind) q.where({ kind });
      if (connectionId) q.where({ connection_id: connectionId });
      if (after) q.where('id', '<', after.id);
    })
    .orderBy('id', 'desc')
    .limit(limit + 1);
  const { page, nextCursor } = pageOf(rows, limit, (row) => ({ id: String(row.id) }));
  const connectionIds = [...new Set(page.map((r) => r.connection_id).filter(Boolean))];
  const names = new Map(
    connectionIds.length ? (await db('integration_connections').whereIn('id', connectionIds).select('id', 'name')).map((r) => [r.id, r.name]) : [],
  );
  const pii = new Map(places.companies.map((c) => [c.id, req.access.can('contacts.view_pii', c.path)]));
  return {
    data: page.map((row) =>
      presentSandboxMessage(row, { index: scope.index, connectionName: names.get(row.connection_id), canViewPii: pii.get(row.company_id) === true }),
    ),
    nextCursor,
  };
}

/** Empty the sandbox outbox of the companies in scope where the user manages integrations. */
export async function clearSandbox(req, { unitId }) {
  const scope = await workingScope(req, unitId);
  const places = requirePlaces(req, scope, 'integrations.manage');
  const companyIds = places.companies.map((c) => c.id);
  await db.transaction(async (trx) => {
    const removed = await trx('integration_sandbox_messages').where({ group_id: scope.unit.root_id }).whereIn('company_id', companyIds).delete();
    await writeAudit(trx, req, {
      action: 'integration_sandbox.cleared',
      entityType: 'integration_sandbox',
      unit: scope.company ?? scope.group,
      meta: { companyIds, removed },
    });
  });
}
