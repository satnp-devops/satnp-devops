import { z } from 'zod';
import { validate } from '../../lib/validate.js';
import { codeSchema, idParams, nameSchema } from '../../lib/schemas.js';
import { requireAuth, requireUnit } from '../../core/guards.js';
import { createUnit, listVisibleUnits, moveUnit, presentUnit, updateUnit } from './service.js';

const profileSchema = z.record(z.string(), z.unknown());

export function orgRoutes(router) {
  router.get('/org/unit-types', requireAuth(), (req, res) => {
    const { registry } = req.app.locals;
    res.json({
      data: [...registry.unitTypes.values()].map(({ key, label, pluralLabel, parents, fields }) => ({
        key,
        label,
        pluralLabel: pluralLabel ?? `${label}s`,
        parents,
        fields: fields ?? [],
      })),
    });
  });

  router.get('/org/units', requireAuth(), async (req, res) => {
    res.json({ data: await listVisibleUnits(req.access) });
  });

  router.get('/org/units/:id', requireAuth(), validate({ params: idParams }), async (req, res) => {
    const unit = await requireUnit(req, req.valid.params.id);
    res.json({ data: presentUnit(unit, req.access) });
  });

  router.post(
    '/org/units',
    requireAuth(),
    validate({
      body: z.object({
        parentId: z.uuid(),
        type: z.string().min(1).max(40),
        name: nameSchema,
        code: codeSchema,
        profile: profileSchema.optional(),
      }),
    }),
    async (req, res) => {
      const unit = await createUnit(req, req.app.locals.registry, req.valid.body);
      res.status(201).json({ data: presentUnit(unit, req.access) });
    },
  );

  router.patch(
    '/org/units/:id',
    requireAuth(),
    validate({
      params: idParams,
      body: z.object({
        name: nameSchema.optional(),
        code: codeSchema.optional(),
        profile: profileSchema.optional(),
        status: z.enum(['active', 'archived']).optional(),
      }),
    }),
    async (req, res) => {
      const unit = await updateUnit(req, req.app.locals.registry, req.valid.params.id, req.valid.body);
      res.json({ data: presentUnit(unit, req.access) });
    },
  );

  router.post(
    '/org/units/:id/move',
    requireAuth(),
    validate({ params: idParams, body: z.object({ parentId: z.uuid() }) }),
    async (req, res) => {
      const unit = await moveUnit(req, req.app.locals.registry, req.valid.params.id, req.valid.body.parentId);
      res.json({ data: presentUnit(unit, req.access) });
    },
  );
}
