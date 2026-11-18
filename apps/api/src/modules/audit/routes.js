import { z } from 'zod';
import { db } from '../../lib/db.js';
import { validate } from '../../lib/validate.js';
import { decodeCursor, pageOf } from '../../lib/pagination.js';
import { requireAuth, requireUnit } from '../../core/guards.js';

function presentEntry(row) {
  return {
    id: row.id,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    unit: row.org_unit_id ? { id: row.org_unit_id, name: row.unit_name } : null,
    actor: row.actor_user_id ? { id: row.actor_user_id, name: row.actor_name, email: row.actor_email } : null,
    actorType: row.actor_type,
    before: row.before,
    after: row.after,
    meta: row.meta,
    ip: row.ip,
    requestId: row.request_id,
    createdAt: row.created_at,
  };
}

export function auditRoutes(router) {
  router.get(
    '/audit',
    requireAuth(),
    validate({
      query: z.object({
        unitId: z.uuid(),
        action: z.string().trim().max(100).optional(),
        entityType: z.string().trim().max(60).optional(),
        entityId: z.string().trim().max(100).optional(),
        actorId: z.uuid().optional(),
        from: z.iso.datetime({ offset: true }).optional(),
        to: z.iso.datetime({ offset: true }).optional(),
        cursor: z.string().max(200).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      }),
    }),
    async (req, res) => {
      const q = req.valid.query;
      const unit = await requireUnit(req, q.unitId, 'audit.view');
      const unitIds = await db('org_units').where('path', 'like', `${unit.path}%`).pluck('id');
      const after = decodeCursor(q.cursor);

      const rows = await db('audit_logs as a')
        .leftJoin('users as u', 'u.id', 'a.actor_user_id')
        .leftJoin('org_units as o', 'o.id', 'a.org_unit_id')
        .whereIn('a.org_unit_id', unitIds)
        .modify((query) => {
          if (q.action) query.where('a.action', 'like', `${q.action.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
          if (q.entityType) query.where('a.entity_type', q.entityType);
          if (q.entityId) query.where('a.entity_id', q.entityId);
          if (q.actorId) query.where('a.actor_user_id', q.actorId);
          if (q.from) query.where('a.created_at', '>=', q.from);
          if (q.to) query.where('a.created_at', '<', q.to);
          if (after) query.where('a.id', '<', after.id);
        })
        .orderBy('a.id', 'desc')
        .limit(q.limit + 1)
        .select('a.*', 'u.name as actor_name', 'u.email as actor_email', 'o.name as unit_name');

      const { page, nextCursor } = pageOf(rows, q.limit, (row) => ({ id: row.id }));
      res.json({ data: page.map(presentEntry), nextCursor });
    },
  );
}
