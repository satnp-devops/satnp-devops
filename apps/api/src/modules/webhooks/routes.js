import { z } from 'zod';
import { validate } from '../../lib/validate.js';
import { idParams } from '../../lib/schemas.js';
import { requireAuth } from '../../core/guards.js';
import { describe } from '../../core/openapi/describe.js';
import { getWebhookEvent, listWebhookEvents, replayFailedWebhookEvents, replayWebhookEvent, webhookSummary } from './service.js';
import { WEBHOOK_STATUSES, replayResultSchema, webhookEventDetailSchema, webhookEventSchema } from './schemas.js';

// Admin API of the webhook delivery log. These live under /webhook-events, not /webhooks/: the
// /webhooks/ prefix is the public provider endpoint, which skips the session and CSRF checks.

const VIEW = 'webhooks.view';
const MANAGE = 'webhooks.manage';

const key = z.string().regex(/^[a-z][a-z0-9_.]{0,59}$/);
const filters = {
  provider: key.optional().describe('Provider key, e.g. razorpay or mock'),
  kind: key.optional().describe('Adapter kind, e.g. payments'),
  connectionId: z.uuid().optional(),
  type: z.string().regex(/^[a-z][a-z0-9_.]{0,99}$/).optional().describe('Event type, e.g. payment.captured'),
};

const listQuery = z.strictObject({
  unitId: z.uuid().describe('The working unit: a company, or the group for every company plus shared connections'),
  ...filters,
  status: z.enum(WEBHOOK_STATUSES).optional().describe('failed lists the dead letters'),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const replayBody = z.strictObject({ unitId: z.uuid(), ...filters });

export function webhookRoutes(router) {
  router.get(
    '/webhook-events',
    describe({
      summary: 'List webhook deliveries',
      description: 'The delivery log, newest first: every event providers sent to connections in scope, with its processing status. `status=failed` lists the dead letters.',
      permission: VIEW,
      list: true,
      responses: { 200: { schema: webhookEventSchema, list: true } },
    }),
    requireAuth(),
    validate({ query: listQuery }),
    async (req, res) => {
      res.json(await listWebhookEvents(req, req.valid.query));
    },
  );

  router.get(
    '/webhook-events/summary',
    describe({
      summary: 'Count webhook events waiting, retrying and failed',
      permission: VIEW,
      responses: {
        200: z.object({ queued: z.number().int(), processing: z.number().int(), retrying: z.number().int(), failed: z.number().int() }),
      },
    }),
    requireAuth(),
    validate({ query: z.strictObject({ unitId: z.uuid() }) }),
    async (req, res) => {
      res.json({ data: await webhookSummary(req, req.valid.query) });
    },
  );

  router.post(
    '/webhook-events/replay',
    describe({
      summary: 'Replay failed webhook events',
      description:
        'Queues up to 200 dead letters in scope again (oldest first) with fresh attempts; call again while `remaining` is above zero. Handlers that finished before are skipped. Emits `webhook_event.bulk_replayed`.',
      permission: MANAGE,
      responses: { 200: replayResultSchema },
    }),
    requireAuth(),
    validate({ body: replayBody }),
    async (req, res) => {
      res.json({ data: await replayFailedWebhookEvents(req, req.valid.body) });
    },
  );

  router.get(
    '/webhook-events/:id',
    describe({
      summary: 'Get a webhook event',
      description: 'With the normalised payload (only for people with `contacts.view_pii` at the owner) and the handlers that finished.',
      permission: VIEW,
      responses: { 200: webhookEventDetailSchema },
    }),
    requireAuth(),
    validate({ params: idParams }),
    async (req, res) => {
      res.json({ data: await getWebhookEvent(req, req.valid.params.id) });
    },
  );

  router.post(
    '/webhook-events/:id/replay',
    describe({
      summary: 'Replay a failed webhook event',
      description: 'Only dead letters (status `failed`). Queues the event again with fresh attempts. Emits `webhook_event.replayed`.',
      permission: MANAGE,
      errors: [409],
      responses: { 200: webhookEventDetailSchema },
    }),
    requireAuth(),
    validate({ params: idParams }),
    async (req, res) => {
      res.json({ data: await replayWebhookEvent(req, req.valid.params.id) });
    },
  );
}
