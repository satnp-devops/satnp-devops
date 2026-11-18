import { z } from 'zod';
import { validate } from '../../lib/validate.js';
import { emailSchema, idParams, nameSchema, phoneSchema, timeZoneSchema } from '../../lib/schemas.js';
import { requireAuth } from '../../core/guards.js';
import { addAssignment, getUser, inviteUser, listUsers, removeAssignment, resendInvite, updateUser } from './service.js';

const assignmentSchema = z.object({ roleId: z.uuid(), unitId: z.uuid() });

export function userRoutes(router) {
  router.get(
    '/users',
    requireAuth(),
    validate({
      query: z.object({
        unitId: z.uuid(),
        q: z.string().trim().max(100).optional(),
        status: z.enum(['invited', 'active', 'disabled']).optional(),
        cursor: z.string().max(500).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      }),
    }),
    async (req, res) => {
      res.json(await listUsers(req, req.valid.query));
    },
  );

  router.get('/users/:id', requireAuth(), validate({ params: idParams }), async (req, res) => {
    res.json({ data: await getUser(req, req.valid.params.id) });
  });

  router.post(
    '/users/invite',
    requireAuth(),
    validate({
      body: z.object({
        email: emailSchema,
        name: nameSchema,
        phone: phoneSchema.optional(),
        assignments: z.array(assignmentSchema).min(1, 'Give at least one role').max(20),
      }),
    }),
    async (req, res) => {
      res.status(201).json({ data: await inviteUser(req, req.valid.body) });
    },
  );

  router.patch(
    '/users/:id',
    requireAuth(),
    validate({
      params: idParams,
      body: z.object({
        name: nameSchema.optional(),
        phone: phoneSchema.nullable().optional(),
        timeZone: timeZoneSchema.nullable().optional(),
        status: z.enum(['active', 'disabled']).optional(),
      }),
    }),
    async (req, res) => {
      res.json({ data: await updateUser(req, req.valid.params.id, req.valid.body) });
    },
  );

  router.post('/users/:id/invite', requireAuth(), validate({ params: idParams }), async (req, res) => {
    res.json({ data: await resendInvite(req, req.valid.params.id) });
  });

  router.post(
    '/users/:id/assignments',
    requireAuth(),
    validate({ params: idParams, body: assignmentSchema }),
    async (req, res) => {
      res.status(201).json({ data: await addAssignment(req, req.valid.params.id, req.valid.body) });
    },
  );

  router.delete(
    '/users/:id/assignments/:assignmentId',
    requireAuth(),
    validate({ params: z.object({ id: z.uuid(), assignmentId: z.uuid() }) }),
    async (req, res) => {
      await removeAssignment(req, req.valid.params.id, req.valid.params.assignmentId);
      res.status(204).end();
    },
  );
}
