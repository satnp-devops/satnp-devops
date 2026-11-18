import { db } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { decodeCursor, pageOf } from '../../lib/pagination.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
import { STATE_CODES } from '../../core/billing/index.js';
import { DEAL_COLUMNS, applyBillingScope, billingListScope } from './access.js';

// Keyset lists of billing records, scoped through their deal (access.js). Every list sorts by
// (created_at desc, id desc) and filters by company_id (or group_id at group scope) first, so the
// (company_id, created_at desc, id desc) indexes serve it; the deal join is by primary key.

/**
 * @param {import('express').Request} req
 * @param {{ table: string, unitId: string, cursor?: string, limit: number, permission?: string,
 *   filter?: (q: import('knex').Knex.QueryBuilder) => void, select?: any[], sortColumn?: string, sortOrder?: 'asc' | 'desc' }} options
 */
export async function listRecords(req, { table, unitId, cursor, limit, permission = 'billing.view', filter, select = [], sortColumn = 'created_at', sortOrder = 'desc' }) {
  const scope = await billingListScope(req, permission, unitId);
  const after = decodeCursor(cursor);
  const op = sortOrder === 'desc' ? '<' : '>';
  const query = db(`${table} as r`)
    .join('deals as d', 'd.id', 'r.deal_id')
    .select(['r.*', ...DEAL_COLUMNS, db.raw(`r.${sortColumn}::text as _cursor`), ...select])
    .orderBy([
      { column: `r.${sortColumn}`, order: sortOrder },
      { column: 'r.id', order: sortOrder },
    ])
    .limit(limit + 1);
  applyBillingScope(query, scope, 'r');
  if (filter) filter(query);
  if (after) {
    if (typeof after.v !== 'string' || typeof after.id !== 'string' || !UUID.test(after.id)) throw errors.badRequest('Invalid cursor');
    query.whereRaw(`(r.${sortColumn}, r.id) ${op} (?, ?)`, [after.v, after.id]);
  }
  const rows = await query;
  const { page, nextCursor } = pageOf(rows, limit, (row) => ({ v: row._cursor, id: row.id }));
  return { page, nextCursor, scope };
}

/** GST state code for a state name ("Karnataka" → "29"), or null. */
export function stateCodeForName(name) {
  if (!name) return null;
  const wanted = String(name).trim().toLowerCase();
  return STATE_CODES.find((s) => s.active && s.name.toLowerCase() === wanted)?.code ?? null;
}
