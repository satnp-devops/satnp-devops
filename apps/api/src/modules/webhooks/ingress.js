import { z } from 'zod';
import { validate } from '../../lib/validate.js';
import { describe } from '../../core/openapi/describe.js';
import { adapterRequest, checkWebhookRateLimits, noteRefusedWebhook, receiveWebhook } from '../../core/webhooks/ingress.js';
import { webhookAckSchema } from './schemas.js';

/**
 * The public provider endpoint. app.js mounts these routes before the session, CSRF and API-key
 * middleware, on a router that receives the raw body (express.raw), because signatures are
 * computed over the exact bytes. The signature is the authentication: no session, no
 * X-Phoenix-Client header.
 */

const params = z.strictObject({
  provider: z
    .string()
    .regex(/^[a-z][a-z0-9_]{1,39}$/)
    .describe('Provider key of the connection, e.g. razorpay or mock, or a module webhook source such as whatsapp_tool'),
  connectionId: z.uuid().describe('The connection the provider was configured with'),
});

const DESCRIPTION = [
  'Providers call this URL; configure it in their dashboard as `<API>/api/v1/webhooks/<provider>/<connectionId>`.',
  'No session and no `X-Phoenix-Client` header: the signature over the raw body is the authentication',
  '(mock connections: `x-phoenix-mock-signature: sha256=<hex HMAC-SHA256 of the body with the connection webhook secret>`).',
  'A bad signature answers 401 and nothing is processed. New events are stored and queued, and the provider gets 200 at once;',
  'an event id received before is acknowledged and ignored. Handlers run in the worker with retries and a dead-letter queue.',
].join(' ');

function context(req) {
  return {
    provider: req.valid.params.provider,
    connectionId: req.valid.params.connectionId,
    request: adapterRequest(req),
    ip: req.ip,
    requestId: req.id,
    log: req.log,
    registry: req.app.locals.registry,
  };
}

/** Refusals that count against the source IP: unknown connection, bad signature, unreadable body. */
const REFUSED = new Set([400, 401, 404]);

/**
 * receiveWebhook behind the URL's rate limits (core/webhooks/ingress.js): 429 with Retry-After when
 * the source IP was refused too often or the connection is flooded; refusals are counted per IP.
 */
async function limitedReceive(req, res) {
  try {
    await checkWebhookRateLimits({ ip: req.ip, connectionId: req.valid.params.connectionId });
    return await receiveWebhook(context(req));
  } catch (err) {
    if (err?.status === 429 && err.retryAfterSeconds) res.set('Retry-After', String(err.retryAfterSeconds));
    if (REFUSED.has(err?.status)) await noteRefusedWebhook(req.ip);
    throw err;
  }
}

export function webhookIngressRoutes(router) {
  router.post(
    '/webhooks/:provider/:connectionId',
    describe({
      summary: 'Receive a provider webhook',
      description: DESCRIPTION,
      auth: 'public',
      rateLimited: true,
      errors: [400, 401],
      responses: { 200: webhookAckSchema },
    }),
    validate({ params }),
    async (req, res) => {
      const result = await limitedReceive(req, res);
      if (result.kind === 'challenge') {
        res.status(result.status).type(result.contentType).send(result.body);
        return;
      }
      res.json({ data: result.data });
    },
  );

  router.get(
    '/webhooks/:provider/:connectionId',
    describe({
      summary: 'Answer a provider subscription handshake',
      description: 'Echoes the challenge providers send when a webhook URL is registered (Meta `hub.challenge`; mocks `?challenge=`).',
      auth: 'public',
      rateLimited: true,
      errors: [400],
      responses: { 200: { raw: true, description: 'The challenge, as the provider expects it (usually text/plain)' } },
    }),
    validate({ params }),
    async (req, res) => {
      const result = await limitedReceive(req, res);
      res.status(result.status).type(result.contentType).send(result.body);
    },
  );
}
