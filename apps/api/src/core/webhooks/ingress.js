import { env } from '../../config/env.js';
import { db, json } from '../../lib/db.js';
import { AppError, errors } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { redis } from '../../lib/redis.js';
import { adapterForConnection, getKind, isIntegrationError, mocksAllowed } from '../../integrations/index.js';
import { getQueue, QUEUES } from '../queue.js';
import { RETRY_POLICY, retryOptions } from '../jobs/policy.js';

/**
 * Inbound provider webhooks: POST /api/v1/webhooks/:provider/:connectionId (docs/platform/WEBHOOKS_AND_JOBS.md).
 *
 *   1. Load the connection; it must exist, be active, be of that provider and of a kind that
 *      receives webhooks. Otherwise 404.
 *   2. Subscription handshakes (Meta hub.challenge, Zoom url_validation, ...) are answered as the
 *      adapter says.
 *   3. The adapter verifies the request over the exact raw bytes (mocks: HMAC-SHA256 in
 *      x-phoenix-mock-signature). A bad signature is 401, logged and kept as a `rejected` row
 *      without its body; nothing is processed.
 *   4. The adapter parses it into normalised events with the provider's event ids.
 *   5. One INSERT ... ON CONFLICT stores the new events; a redelivered event id only bumps
 *      `duplicates`, so it is acknowledged and ignored.
 *   6. New events are queued (job id = webhook event id) and the provider gets 200 at once.
 *      Handlers run later in the worker (processor.js).
 *
 * A module's own webhook source (registry.webhookSources, e.g. the WhatsApp tool) takes the place
 * of the adapter: its URL names the source key instead of the provider, it accepts any active
 * connection of its kind, and its events are stored with provider = the source key.
 */

/** Rejected deliveries kept per connection per 10 minutes (the rest are only logged), so a flood can't fill the table. */
const REJECTIONS_KEPT = 20;

// ---------- Rate limits of the public URL ----------
//
// The URL takes no session, so two limits keep a flood from turning into database work:
//   - deliveries per connection per minute (WEBHOOK_RATE_LIMIT, generous: providers burst);
//   - refused deliveries per source IP per 10 minutes (WEBHOOK_FAILURE_LIMIT): unknown or inactive
//     connections, bad signatures and unreadable bodies. Providers almost never get refused, so this
//     stops guessing connection ids or signatures without slowing real traffic.
// Both answer 429 with Retry-After. The counters fail open: when Redis is down deliveries are still
// stored in Postgres (the sweeper queues them later), and a limiter must not be what refuses them.

const DELIVERY_WINDOW_SECONDS = 60;
const FAILURE_WINDOW_SECONDS = 600;
const deliveryKey = (connectionId) => `rl:webhook:${connectionId}`;
const failureKey = (ip) => `rl:webhook-refused:${ip ?? 'unknown'}`;

async function bumpCounter(key, windowSeconds) {
  try {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, windowSeconds);
    return count;
  } catch {
    return 0;
  }
}

async function readCounter(key) {
  try {
    return Number(await redis.get(key)) || 0;
  } catch {
    return 0;
  }
}

function tooManyDeliveries(retryAfterSeconds, message) {
  const err = new AppError(429, 'rate_limited', message, { retryAfterSeconds });
  err.retryAfterSeconds = retryAfterSeconds;
  return err;
}

/** Throws 429 when the source IP was refused too often lately, or the connection got too many deliveries this minute. */
export async function checkWebhookRateLimits({ ip, connectionId }) {
  if ((await readCounter(failureKey(ip))) >= env.WEBHOOK_FAILURE_LIMIT) {
    throw tooManyDeliveries(FAILURE_WINDOW_SECONDS, 'Too many refused webhook deliveries from this address. Try again later.');
  }
  if ((await bumpCounter(deliveryKey(connectionId), DELIVERY_WINDOW_SECONDS)) > env.WEBHOOK_RATE_LIMIT) {
    throw tooManyDeliveries(DELIVERY_WINDOW_SECONDS, 'Too many webhook deliveries for this connection. Retry in a minute.');
  }
}

/** Count a refused delivery (400, 401 or 404) against its source IP. */
export async function noteRefusedWebhook(ip) {
  await bumpCounter(failureKey(ip), FAILURE_WINDOW_SECONDS);
}

const REASONS = {
  missing_signature: 'The signature header is missing',
  bad_signature: 'The signature does not match the connection secret',
  not_implemented: 'This provider does not accept webhooks yet',
  unreadable: 'The body could not be read as events of this provider',
};

export const reasonText = (reason) => REASONS[reason] ?? `Verification failed (${String(reason).slice(0, 80)})`;

export const webhookJobOptions = () => ({
  ...retryOptions(RETRY_POLICY.webhooks),
  removeOnComplete: { age: 3600, count: 2000 },
  removeOnFail: { age: 7 * 24 * 3600, count: 10000 },
});

/** The request as adapters see it: method, lower-case headers, query, the exact body bytes, url. */
export function adapterRequest(req) {
  return {
    method: req.method,
    headers: req.headers,
    query: req.query ?? {},
    rawBody: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
    url: req.originalUrl,
  };
}

async function loadConnection(provider, connectionId) {
  const row = await db('integration_connections').where({ id: connectionId }).first();
  if (!row || row.provider !== provider || row.disconnected_at || row.status !== 'active') return null;
  if (!getKind(row.kind)?.webhooks) return null;
  return row;
}

async function loadSourceConnection(source, connectionId) {
  const row = await db('integration_connections').where({ id: connectionId }).first();
  if (!row || row.kind !== source.kind || row.disconnected_at || row.status !== 'active') return null;
  if (row.provider === 'mock' && !mocksAllowed()) return null;
  // Stored and de-duplicated under the source's key, apart from the provider's own events.
  return { ...row, provider: source.key };
}

/** A module's webhook source, shaped like an adapter's webhook methods for one connection. */
function sourceAdapter(source, connection) {
  const ctx = { connectionId: connection.id, connection };
  return {
    webhookChallenge: async (request) => (source.webhookChallenge ? source.webhookChallenge(request, ctx) : null),
    verifyWebhook: async (request) => source.verifyWebhook(request, ctx),
    parseWebhook: async (request) => source.parseWebhook(request, ctx),
  };
}

async function recordRejection(connection, reason, { ip, requestId, bytes, contentType, log }) {
  try {
    const key = `webhooks:rejected:${connection.id}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 600);
    if (count > REJECTIONS_KEPT) return;
    await db('webhook_events').insert({
      group_id: connection.group_id,
      unit_id: connection.unit_id,
      connection_id: connection.id,
      provider: connection.provider,
      kind: connection.kind,
      status: 'rejected',
      last_error: reasonText(reason),
      payload: json({ reason, bytes, contentType: contentType ? String(contentType).slice(0, 100) : null }),
      source_ip: ip ?? null,
      request_id: requestId ?? null,
      attempts: 0,
      max_attempts: 0,
    });
  } catch (err) {
    log.error({ err, connectionId: connection.id }, 'Could not record a rejected webhook');
  }
}

/** Store parsed events; returns each with its row id and whether it was new. One statement for the whole delivery. */
async function storeEvents(connection, events, { ip, requestId }) {
  // A delivery that repeats an event id inside itself: keep the first.
  const unique = [...new Map(events.map((event) => [event.eventId, event])).values()];
  const maxAttempts = RETRY_POLICY.webhooks.attempts;
  const placeholders = unique.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, cast(? as jsonb), ?, ?, ?, ?)').join(', ');
  const bindings = unique.flatMap((event) => [
    connection.group_id,
    connection.unit_id,
    connection.id,
    connection.provider,
    connection.kind,
    String(event.eventId).slice(0, 300),
    String(event.type).slice(0, 100),
    event.occurredAt ?? null,
    event.reference ? String(event.reference).slice(0, 300) : null,
    json(event.data ?? {}),
    'queued',
    maxAttempts,
    ip ?? null,
    requestId ?? null,
  ]);
  const { rows } = await db.raw(
    `insert into webhook_events (group_id, unit_id, connection_id, provider, kind, external_event_id, type, occurred_at, reference,
                                 payload, status, max_attempts, source_ip, request_id)
     values ${placeholders}
     on conflict (provider, connection_id, external_event_id)
     do update set duplicates = webhook_events.duplicates + 1, last_received_at = now()
     returning id, external_event_id, type, (xmax = 0) as inserted`,
    bindings,
  );
  return rows;
}

/** Put new events on the webhooks queue. If Redis is down the events stay queued in Postgres and the sweeper picks them up. */
export async function queueEvents(rows, log = logger) {
  if (rows.length === 0) return true;
  try {
    await getQueue(QUEUES.webhooks).addBulk(
      rows.map((row) => ({ name: row.type, data: { eventId: row.id }, opts: { jobId: row.id, ...webhookJobOptions() } })),
    );
    return true;
  } catch (err) {
    log.error({ err, count: rows.length }, 'Could not queue webhook events; the sweeper will retry');
    return false;
  }
}

/**
 * Handle one inbound request. Returns { kind: 'challenge', status, contentType, body } for a
 * handshake, or { kind: 'ack', data } for accepted events. Throws AppError (404/401/400) otherwise.
 */
export async function receiveWebhook({ provider, connectionId, request, ip, requestId, log = logger, registry }) {
  const source = registry?.webhookSources?.get(provider) ?? null;
  const connection = source ? await loadSourceConnection(source, connectionId) : await loadConnection(provider, connectionId);
  if (!connection) {
    log.warn({ provider, connectionId, ip }, 'Webhook for an unknown or inactive connection');
    throw errors.notFound('Webhook endpoint');
  }
  let adapter;
  try {
    adapter = source ? sourceAdapter(source, connection) : adapterForConnection(connection, { companyId: null, log });
  } catch (err) {
    if (!isIntegrationError(err)) throw err;
    log.warn({ provider, connectionId, code: err.code }, 'Webhook for a connection whose adapter is unavailable');
    throw errors.notFound('Webhook endpoint');
  }

  const challenge = await adapter.webhookChallenge(request).catch(() => null);
  if (challenge) return { kind: 'challenge', ...challenge };
  if (request.method !== 'POST') throw errors.badRequest('Expected a subscription handshake');

  const meta = { ip, requestId, bytes: request.rawBody.length, contentType: request.headers['content-type'], log };
  const verdict = await adapter.verifyWebhook(request).catch(() => ({ ok: false, reason: 'unverifiable' }));
  if (!verdict.ok) {
    log.warn({ provider, connectionId, reason: verdict.reason, ip }, 'Webhook rejected: signature check failed');
    await recordRejection(connection, verdict.reason, meta);
    throw new AppError(401, 'webhook_signature_invalid', 'The webhook signature is not valid');
  }

  let parsed;
  try {
    parsed = await adapter.parseWebhook(request);
  } catch (err) {
    // Adapters throw integration errors for a body they can't read; module sources throw AppError 4xx.
    if (!isIntegrationError(err) && !(source && err instanceof AppError && err.status < 500)) throw err;
    log.warn({ provider, connectionId, code: err.code }, 'Webhook rejected: unreadable body');
    await recordRejection(connection, 'unreadable', meta);
    throw errors.badRequest('The webhook body could not be read');
  }

  const rows = parsed.events.length ? await storeEvents(connection, parsed.events, { ip, requestId }) : [];
  const fresh = rows.filter((row) => row.inserted);
  await queueEvents(fresh, log);
  log.info({ provider, connectionId, received: parsed.events.length, accepted: fresh.length }, 'Webhook received');
  return {
    kind: 'ack',
    data: {
      received: parsed.events.length,
      accepted: fresh.length,
      duplicates: parsed.events.length - fresh.length,
    },
  };
}
