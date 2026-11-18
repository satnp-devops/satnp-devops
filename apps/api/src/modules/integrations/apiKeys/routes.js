import { z } from 'zod';
import { validate } from '../../../lib/validate.js';
import { idParams } from '../../../lib/schemas.js';
import { requireAuth } from '../../../core/guards.js';
import { describe } from '../../../core/openapi/describe.js';
import { createApiKey, grantableScopes, listApiKeys, revokeApiKey } from './service.js';

const MANAGE = 'api_keys.manage';
const permissionKey = z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/, 'A permission key such as contacts.view');

const apiKeySchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    prefix: z.string().describe('The first characters of the key, e.g. phx_3fA9xYz1'),
    unit: z.object({ id: z.uuid(), name: z.string(), type: z.string() }).nullable(),
    scopes: z.array(z.string()),
    status: z.enum(['active', 'revoked', 'expired']),
    expiresAt: z.iso.datetime().nullable(),
    lastUsedAt: z.iso.datetime().nullable(),
    lastUsedIp: z.string().nullable(),
    createdAt: z.iso.datetime(),
    createdBy: z.object({ id: z.uuid(), name: z.string().nullable() }).nullable(),
    revokedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'ApiKey', description: 'An API key for machine access. The key itself is shown only once, when it is created.' });

const createBody = z.strictObject({
  unitId: z.uuid().describe('The group or a company: where the scopes apply'),
  name: z.string().trim().min(1, 'Name the key after what uses it').max(120),
  scopes: z.array(permissionKey).min(1, 'Pick at least one permission').max(200),
  expiresAt: z.iso.datetime({ offset: true }).optional(),
});

export function apiKeyRoutes(router) {
  router.get(
    '/api-keys',
    describe({ summary: 'List API keys in a unit', permission: MANAGE, list: true, responses: { 200: apiKeySchema } }),
    requireAuth(),
    validate({
      query: z.strictObject({
        unitId: z.uuid(),
        status: z.enum(['active', 'all']).default('all'),
        cursor: z.string().max(500).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      }),
    }),
    async (req, res) => {
      res.json(await listApiKeys(req, req.valid.query));
    },
  );

  router.get(
    '/api-keys/scopes',
    describe({ summary: 'List the permissions a new key may carry', description: 'Those you hold at the unit, without api_keys.*.', permission: MANAGE }),
    requireAuth(),
    validate({ query: z.strictObject({ unitId: z.uuid() }) }),
    async (req, res) => {
      res.json({ data: await grantableScopes(req, req.valid.query) });
    },
  );

  router.post(
    '/api-keys',
    describe({
      summary: 'Create an API key',
      description:
        'Returns the key once, in `secret`; only its hash is stored. Send it as `Authorization: Bearer <secret>`. Emits `api_key.created`.',
      permission: MANAGE,
      status: 201,
      responses: { 201: apiKeySchema.extend({ secret: z.string().describe('phx_..., shown only now') }) },
    }),
    requireAuth(),
    validate({ body: createBody }),
    async (req, res) => {
      res.status(201).json({ data: await createApiKey(req, req.valid.body) });
    },
  );

  router.delete(
    '/api-keys/:id',
    describe({ summary: 'Revoke an API key', description: 'Requests with the key fail from now on. Emits `api_key.revoked`.', permission: MANAGE, status: 204 }),
    requireAuth(),
    validate({ params: idParams }),
    async (req, res) => {
      await revokeApiKey(req, req.valid.params.id);
      res.status(204).end();
    },
  );
}
