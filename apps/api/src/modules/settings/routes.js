import { z } from 'zod';
import { db, json } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { toFieldErrors, validate } from '../../lib/validate.js';
import { getEffectiveSettings } from '../../core/settings.js';
import { bumpAccessVersion } from '../../core/access.js';
import { writeAudit } from '../../core/audit.js';
import { emitEvent } from '../../core/events.js';
import { requireAuth, requireUnit } from '../../core/guards.js';

const POLICY_KEYS = new Set(['security.requireMfa']);

function definitionOrThrow(registry, key) {
  const definition = registry.settings.get(key);
  if (!definition) throw errors.notFound('Setting');
  return definition;
}

function assertLevel(definition, unit) {
  if (!definition.levels.includes(unit.type)) {
    throw errors.validation([{ path: 'body.unitId', message: `This setting can't be changed for a ${unit.type}` }]);
  }
}

export function settingsRoutes(router) {
  router.get('/settings/definitions', requireAuth(), (req, res) => {
    const { registry } = req.app.locals;
    // eslint-disable-next-line no-unused-vars
    res.json({ data: [...registry.settings.values()].map(({ schema, ...definition }) => definition) });
  });

  router.get('/settings', requireAuth(), validate({ query: z.object({ unitId: z.uuid() }) }), async (req, res) => {
    const { registry } = req.app.locals;
    const unit = await requireUnit(req, req.valid.query.unitId, 'settings.view');
    const definitions = [...registry.settings.values()];
    const effective = await getEffectiveSettings(unit, definitions);
    // Every setting applies everywhere; `settable` says whether this level may override it.
    const values = Object.fromEntries(
      definitions.map((d) => [d.key, { ...effective[d.key], settable: d.levels.includes(unit.type) }]),
    );
    res.json({
      data: {
        unitId: unit.id,
        canManage: req.access.can('settings.manage', unit.path),
        values,
      },
    });
  });

  router.put(
    '/settings/:key',
    requireAuth(),
    validate({ params: z.object({ key: z.string().max(100) }), body: z.object({ unitId: z.uuid(), value: z.unknown() }) }),
    async (req, res) => {
      const { registry } = req.app.locals;
      const definition = definitionOrThrow(registry, req.valid.params.key);
      const unit = await requireUnit(req, req.valid.body.unitId, 'settings.manage');
      assertLevel(definition, unit);
      const parsed = definition.schema.safeParse(req.valid.body.value);
      if (!parsed.success) throw errors.validation(toFieldErrors(parsed.error, 'body.value'));

      await db.transaction(async (trx) => {
        const before = await trx('settings').where({ org_unit_id: unit.id, key: definition.key }).first();
        await trx('settings')
          .insert({
            org_unit_id: unit.id,
            key: definition.key,
            value: json(parsed.data),
            updated_by: req.auth.user.id,
            updated_at: trx.fn.now(),
          })
          .onConflict(['org_unit_id', 'key'])
          .merge();
        await writeAudit(trx, req, {
          action: 'settings.updated',
          entityType: 'setting',
          entityId: definition.key,
          unit,
          before: { value: before?.value ?? null },
          after: { value: parsed.data },
        });
        await emitEvent(trx, {
          type: 'settings.updated',
          groupId: unit.root_id,
          unitId: unit.id,
          aggregateType: 'setting',
          aggregateId: definition.key,
          actorUserId: req.auth.user.id,
          payload: { key: definition.key },
        });
      });
      if (POLICY_KEYS.has(definition.key)) await bumpAccessVersion();
      res.json({ data: { key: definition.key, value: parsed.data } });
    },
  );

  router.delete(
    '/settings/:key',
    requireAuth(),
    validate({ params: z.object({ key: z.string().max(100) }), query: z.object({ unitId: z.uuid() }) }),
    async (req, res) => {
      const { registry } = req.app.locals;
      const definition = definitionOrThrow(registry, req.valid.params.key);
      const unit = await requireUnit(req, req.valid.query.unitId, 'settings.manage');
      await db.transaction(async (trx) => {
        const removed = await trx('settings').where({ org_unit_id: unit.id, key: definition.key }).delete().returning('*');
        if (removed.length === 0) return;
        await writeAudit(trx, req, {
          action: 'settings.reset',
          entityType: 'setting',
          entityId: definition.key,
          unit,
          before: { value: removed[0].value },
        });
        await emitEvent(trx, {
          type: 'settings.reset',
          groupId: unit.root_id,
          unitId: unit.id,
          aggregateType: 'setting',
          aggregateId: definition.key,
          actorUserId: req.auth.user.id,
          payload: { key: definition.key },
        });
      });
      if (POLICY_KEYS.has(definition.key)) await bumpAccessVersion();
      res.status(204).end();
    },
  );
}
