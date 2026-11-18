import { z } from 'zod';
import { db } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { validate } from '../../lib/validate.js';
import { idParams } from '../../lib/schemas.js';
import { requireAuth } from '../../core/guards.js';
import { describe } from '../../core/openapi/describe.js';
import { KIND_KEYS, mocksAllowed } from '../../integrations/index.js';
import { presentCatalog } from '../../integrations/framework/catalog.js';
import { IDENTITY_HINTS, IDENTITY_TYPES, KIND_IDENTITY_TYPES } from '../../integrations/framework/identities.js';
import { rawAdapterForConnection } from '../../integrations/framework/resolve.js';
import {
  createConnection,
  disconnectConnection,
  getConnection,
  listConnections,
  makeDefault,
  testConnection,
  tryConnection,
  updateConnection,
} from './connections.js';
import { archiveIdentity, createIdentity, listIdentities, updateIdentity } from './identities.js';
import { clearSandbox, listSandbox } from './sandbox.js';
import { connectionSchema, identitySchema, sandboxMessageSchema, testResultSchema, tryResultSchema } from './schemas.js';

const VIEW = 'integrations.view';
const MANAGE = 'integrations.manage';

const name = z.string().trim().min(1, 'Enter a name').max(120);
const values = z.record(z.string().max(40), z.unknown());
const providerKey = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/, 'A provider key such as razorpay');

const connectionCreate = z.strictObject({
  unitId: z.uuid().describe('Owner: a company, or the group for a connection shared by several companies'),
  kind: z.enum(KIND_KEYS),
  provider: providerKey,
  name,
  config: values.default({}),
  credentials: values.default({}),
  companyIds: z.array(z.uuid()).max(100).optional().describe('Group connections only: the companies that use it (default: all)'),
  makeDefault: z.boolean().optional().describe("Make it each company's default for the kind (default: only where none is set)"),
});

const connectionUpdate = z.strictObject({
  name: name.optional(),
  config: values.optional().describe('Changed fields only; null clears an optional field'),
  credentials: values.optional().describe('Secrets to replace; leave a field out to keep it, null clears an optional one'),
  status: z.enum(['active', 'disabled']).optional(),
  companyIds: z.array(z.uuid()).max(100).optional(),
});

const scopeQuery = z.strictObject({ unitId: z.uuid(), kind: z.enum(KIND_KEYS).optional() });

const identityCreate = z.strictObject({
  type: z.enum(IDENTITY_TYPES),
  identity: z.string().trim().min(1, 'Enter the number, inbox, form or link').max(300),
  label: z.string().trim().max(120).optional(),
  companyId: z.uuid().optional().describe('The owning company (not for shared channels)'),
  shared: z.boolean().default(false),
  companyIds: z.array(z.uuid()).max(100).optional().describe('Shared channels: the companies it may route to (two or more)'),
  connectionId: z.uuid().nullable().optional(),
  productLineId: z.uuid().nullable().optional(),
});

const identityUpdate = z.strictObject({
  label: z.string().trim().max(120).nullable().optional(),
  connectionId: z.uuid().nullable().optional(),
  productLineId: z.uuid().nullable().optional(),
  companyIds: z.array(z.uuid()).max(100).optional(),
});

export function integrationRoutes(router) {
  router.get(
    '/integrations/kinds',
    describe({
      summary: 'List adapter kinds and their providers',
      description: 'Each kind with its providers and the fields their connection form asks for. Mock providers are listed only when mocks are allowed.',
    }),
    requireAuth(),
    (_req, res) => {
      res.json({
        data: {
          mocksAllowed: mocksAllowed(),
          kinds: presentCatalog({ mocksAllowed: mocksAllowed() }),
          identityTypes: IDENTITY_TYPES.map((type) => ({ key: type, hint: IDENTITY_HINTS[type] ?? '' })),
          kindIdentityTypes: KIND_IDENTITY_TYPES,
        },
      });
    },
  );

  router.get(
    '/integrations/connections',
    describe({ summary: 'List connections in a unit', permission: VIEW, responses: { 200: z.array(connectionSchema) } }),
    requireAuth(),
    validate({ query: scopeQuery }),
    async (req, res) => {
      res.json({ data: await listConnections(req, req.valid.query) });
    },
  );

  router.post(
    '/integrations/connections',
    describe({
      summary: 'Connect a provider',
      description: 'Credentials are checked against the provider fields and stored encrypted. Emits `integration_connection.created`.',
      permission: MANAGE,
      status: 201,
      errors: [409],
      responses: { 201: connectionSchema },
    }),
    requireAuth(),
    validate({ body: connectionCreate }),
    async (req, res) => {
      res.status(201).json({ data: await createConnection(req, req.valid.body) });
    },
  );

  router.get(
    '/integrations/connections/:id',
    describe({ summary: 'Get a connection', permission: VIEW, responses: { 200: connectionSchema } }),
    requireAuth(),
    validate({ params: idParams }),
    async (req, res) => {
      res.json({ data: await getConnection(req, req.valid.params.id) });
    },
  );

  router.patch(
    '/integrations/connections/:id',
    describe({ summary: 'Change a connection', description: 'Changing config or credentials resets its health to unknown.', permission: MANAGE, errors: [409], responses: { 200: connectionSchema } }),
    requireAuth(),
    validate({ params: idParams, body: connectionUpdate }),
    async (req, res) => {
      res.json({ data: await updateConnection(req, req.valid.params.id, req.valid.body) });
    },
  );

  router.delete(
    '/integrations/connections/:id',
    describe({ summary: 'Disconnect a provider', description: 'Wipes the credentials and unlinks the companies; the record stays for history.', permission: MANAGE, status: 204 }),
    requireAuth(),
    validate({ params: idParams }),
    async (req, res) => {
      await disconnectConnection(req, req.valid.params.id);
      res.status(204).end();
    },
  );

  router.post(
    '/integrations/connections/:id/default',
    describe({ summary: "Make a connection a company's default", permission: MANAGE, errors: [409], responses: { 200: connectionSchema } }),
    requireAuth(),
    validate({ params: idParams, body: z.strictObject({ companyId: z.uuid() }) }),
    async (req, res) => {
      res.json({ data: await makeDefault(req, req.valid.params.id, req.valid.body) });
    },
  );

  router.post(
    '/integrations/connections/:id/test',
    describe({ summary: 'Test a connection', description: "Runs the adapter's health check and stores the result.", permission: MANAGE, responses: { 200: testResultSchema } }),
    requireAuth(),
    validate({ params: idParams }),
    async (req, res) => {
      res.json({ data: await testConnection(req, req.valid.params.id) });
    },
  );

  router.post(
    '/integrations/connections/:id/try',
    describe({ summary: 'Make a sample call through a mock connection', description: 'The result appears in the sandbox outbox.', permission: MANAGE, errors: [409], responses: { 200: tryResultSchema } }),
    requireAuth(),
    validate({ params: idParams }),
    async (req, res) => {
      res.json({ data: await tryConnection(req, req.valid.params.id) });
    },
  );

  router.get(
    '/integrations/identities',
    describe({ summary: 'List channel identities in a unit', permission: VIEW, responses: { 200: z.array(identitySchema) } }),
    requireAuth(),
    validate({ query: z.strictObject({ unitId: z.uuid(), type: z.enum(IDENTITY_TYPES).optional(), connectionId: z.uuid().optional() }) }),
    async (req, res) => {
      res.json({ data: await listIdentities(req, req.valid.query) });
    },
  );

  router.post(
    '/integrations/identities',
    describe({ summary: 'Register a channel identity', description: 'Emits `channel_identity.created`.', permission: MANAGE, status: 201, errors: [409], responses: { 201: identitySchema } }),
    requireAuth(),
    validate({ body: identityCreate }),
    async (req, res) => {
      res.status(201).json({ data: await createIdentity(req, req.valid.body) });
    },
  );

  router.patch(
    '/integrations/identities/:id',
    describe({ summary: 'Change a channel identity', permission: MANAGE, responses: { 200: identitySchema } }),
    requireAuth(),
    validate({ params: idParams, body: identityUpdate }),
    async (req, res) => {
      res.json({ data: await updateIdentity(req, req.valid.params.id, req.valid.body) });
    },
  );

  router.delete(
    '/integrations/identities/:id',
    describe({ summary: 'Remove a channel identity', permission: MANAGE, status: 204 }),
    requireAuth(),
    validate({ params: idParams }),
    async (req, res) => {
      await archiveIdentity(req, req.valid.params.id);
      res.status(204).end();
    },
  );

  router.get(
    '/integrations/sandbox',
    describe({ summary: 'List what mock adapters sent', permission: VIEW, list: true, responses: { 200: sandboxMessageSchema } }),
    requireAuth(),
    validate({
      query: z.strictObject({
        unitId: z.uuid(),
        kind: z.enum(KIND_KEYS).optional(),
        connectionId: z.uuid().optional(),
        cursor: z.string().max(500).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      }),
    }),
    async (req, res) => {
      res.json(await listSandbox(req, req.valid.query));
    },
  );

  router.delete(
    '/integrations/sandbox',
    describe({ summary: 'Clear the sandbox outbox', permission: MANAGE, status: 204 }),
    requireAuth(),
    validate({ query: z.strictObject({ unitId: z.uuid() }) }),
    async (req, res) => {
      await clearSandbox(req, req.valid.query);
      res.status(204).end();
    },
  );

  // Development only: serves the signed links of the local-disk storage mock. The signature and
  // expiry in the link are the authorisation, as with an Azure SAS link.
  router.get(
    '/integrations/local-files/:connectionId/*path',
    describe({
      summary: 'Download a file from local-disk storage (development)',
      description: 'Serves the signed links of the local-disk storage mock. 404 when mocks are off (production).',
      auth: 'public',
    }),
    async (req, res) => {
      if (!mocksAllowed() || !z.uuid().safeParse(req.params.connectionId).success) throw errors.notFound('File');
      const row = await db('integration_connections')
        .where({ id: req.params.connectionId, kind: 'storage', provider: 'mock' })
        .whereNull('disconnected_at')
        .first();
      if (!row) throw errors.notFound('File');
      let file;
      try {
        file = await rawAdapterForConnection(row).disk.readDownload(req.originalUrl);
      } catch (error) {
        if (error?.kind === 'forbidden') throw errors.forbidden('This download link is invalid or has expired');
        if (error?.kind === 'not_found') throw errors.notFound('File');
        throw error;
      }
      res.set('Content-Type', file.contentType || 'application/octet-stream');
      if (file.contentDisposition) res.set('Content-Disposition', file.contentDisposition);
      res.set('Cache-Control', 'private, no-store');
      res.set('X-Content-Type-Options', 'nosniff');
      // Files are served from the app's origin: never let one run script or load anything.
      res.set('Content-Security-Policy', "default-src 'none'; sandbox");
      res.send(Buffer.from(file.body));
    },
  );
}
