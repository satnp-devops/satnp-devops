# Webhooks and background jobs

Phase 3 of docs/ARCHITECTURE.md, and the reliability rules of the brief: "webhooks verified, acknowledged quickly, queued and processed idempotently by event ID; retries with backoff and a dead-letter queue; bulk actions, imports, reminders and AI calls run as background jobs; outbound sends throttled to provider limits".

It builds on the integration framework (docs/platform/INTEGRATIONS.md): a connection's adapter verifies and parses its provider's webhooks; this layer owns the endpoint, storage, de-duplication, the queues, retries, dead letters, throttling and the admin screens.

| Where | What |
| --- | --- |
| `apps/api/src/core/webhooks/ingress.js` | The endpoint's logic: load the connection, handshake, verify, parse, store once, queue |
| `core/webhooks/processor.js` | The worker side: run the modules' handlers for each event, record attempts, dead-letter |
| `core/webhooks/handlers.js` | `webhookHandlers` keys: validation and matching |
| `core/webhooks/maintenance.js` | The sweeper (re-queues lost work) and the pruner |
| `core/jobs/queue.js` | `enqueueJob()` and `cancelJob()` |
| `core/jobs/runner.js` | Runs module jobs: records, progress, errors, dead letters; `PermanentJobError` |
| `core/jobs/definitions.js` | `jobs` declarations: validation |
| `core/jobs/schedules.js` | Repeating (cron) jobs as BullMQ job schedulers |
| `core/jobs/policy.js` | Retry policy and backoff |
| `core/jobs/throttle.js`, `core/jobs/limits.js` | Outbound throttling (Redis token bucket) and default limits |
| `modules/webhooks/` | Public endpoint routes (`ingress.js`), admin API (`/webhook-events`), module `webhooks` |
| `modules/webhooks/jobs/` | Admin API (`/jobs`), module `jobs` |
| `apps/web/src/app/(app)/settings/integrations/webhooks/` | Settings › Integrations › Webhooks and jobs |

Tables (migration `20261106002100_webhooks_jobs.js`): `webhook_events` and `background_jobs`. Queues (`core/queue.js`): `webhooks` and `jobs`, both run by `worker.js`.

## Inbound webhooks

```
POST /api/v1/webhooks/:provider/:connectionId
```

Configure this URL at the provider. For example, `https://crm.example.com/api/v1/webhooks/razorpay/2f0c...` points at one Razorpay connection. Settings › Integrations › Webhooks and jobs shows the URL of a connection when you filter by it.

- **No session and no `X-Phoenix-Client` header.** `app.js` mounts this route on its own router, before the session, CSRF and API-key middleware. The provider's signature is the authentication.
- **Rate limits.** Each connection takes up to `WEBHOOK_RATE_LIMIT` deliveries a minute (default 1200). A source IP whose deliveries were refused (unknown or inactive connection 404, bad signature 401, unreadable body 400) `WEBHOOK_FAILURE_LIMIT` times in 10 minutes (default 100) gets **429** with `Retry-After` until the window ends, so guessing connection ids or signatures stops quickly while real providers, which are almost never refused, are not slowed. The counters live in Redis and fail open: with Redis down, deliveries are still stored in Postgres.
- **Raw body.** `express.raw()` keeps the exact bytes for `/api/v1/webhooks/*` (up to 1 MB). The JSON parser never touches them, because signatures are computed over those bytes and never over re-serialised JSON.
- `GET` on the same URL answers subscription handshakes (Meta `hub.challenge`, mocks `?challenge=`).

### Steps (`core/webhooks/ingress.js`)

1. **Load the connection.** It must exist, be active, not be disconnected, belong to `:provider`, and be of a kind that receives webhooks. AI and storage connections receive none. Mock connections count only while mocks are allowed. Anything else answers **404** and is logged.
2. **Handshake.** If `adapter.webhookChallenge(request)` returns a reply, it is sent as is.
3. **Verify.** `adapter.verifyWebhook(request)` checks the signature over `rawBody`. A bad or missing signature answers **401** `webhook_signature_invalid` and is logged (`Webhook rejected`). It is kept as a `rejected` row with the reason, the source IP, the request id and the body size, but **not the body**. At most 20 rejected rows are kept per connection per 10 minutes, so a flood can't fill the table. Nothing is processed.
4. **Parse.** `adapter.parseWebhook(request)` returns normalised events with the provider's event ids. A body the adapter can't read answers **400** and is kept as `rejected` (`unreadable`).
5. **Store once.** A single `INSERT ... ON CONFLICT (provider, connection_id, external_event_id) DO UPDATE SET duplicates = duplicates + 1` stores the whole delivery. A redelivered event only bumps `duplicates` and is not queued again. Parallel redeliveries race on the unique index, so exactly one copy is accepted.
6. **Queue and acknowledge.** New events go on the `webhooks` queue with **job id = `webhook_events.id`**, and the provider gets **200** `{ data: { received, accepted, duplicates } }` within one database round trip. If Redis is down, the events stay `queued` in Postgres and the sweeper queues them within about two minutes.

**Mock signatures.** The mock adapter of every kind expects `x-phoenix-mock-signature: sha256=<hex HMAC-SHA256 of the raw body>`. The key is the connection's `webhookSecret` credential, or a secret derived from `APP_ENCRYPTION_KEY` and the connection id. `buildMockWebhookRequest({ connectionId, events })` from `integrations/index.js` builds a signed request:

```js
const { rawBody, headers } = await buildMockWebhookRequest({
  connectionId,
  events: [{ id: 'evt_1', type: 'payment.captured', occurredAt: new Date().toISOString(), reference: dealId, data: { amountMinor: 150000, currency: 'INR' } }],
});
await fetch(`${api}/api/v1/webhooks/mock/${connectionId}`, { method: 'POST', headers, body: rawBody });
```

Real providers bring their own scheme: Meta `X-Hub-Signature-256`, Razorpay `X-Razorpay-Signature`, `Stripe-Signature`, Zoom `x-zm-signature`, SendGrid ECDSA. Each adapter implements it in `verifyWebhook` (INTEGRATIONS.md, "What adapters must expose for webhooks").

### Idempotency rules

- **The key.** An event is identified by `(provider, connection_id, external_event_id)`. The brief says "by event ID". It is scoped per connection, as INTEGRATIONS.md specifies, so two accounts of one provider (two companies' Razorpay accounts, or two mock connections) can never swallow each other's events. Adapters use the provider's event id, or a stable hash of the event when the provider sends none.
- **One stored row, one queue job.** The queue job id is the row id, so a duplicate queue job is ignored while the first one exists.
- **The processor skips finished work.** Only `queued`, `retrying` and `processing` events run; `processing` covers a worker that died mid-way. Processed, failed and rejected events are skipped, so a stray duplicate job does nothing.
- **Finished handlers are not run again.** Each handler that finishes is appended to `completed_handlers` (`<module>/<key>/<index>`). A retry or a replay runs only the handlers that haven't succeeded yet.
- **Handlers must still be idempotent.** A handler can finish its work and then fail before its completion is recorded, so it may run twice. Key your writes on the event: `event.eventId`, `event.reference`, or the provider ids in `event.data`. Use unique constraints or upserts.
- **Retention.** Processed and rejected events are pruned after `WEBHOOK_RETENTION_DAYS` (default 30), so redeliveries are recognised within that window. Failed events stay until they are replayed.

### Registering a webhook handler

Declare handlers in the module's `module.js`, keyed by `"<kind or provider>:<event type>"`:

```js
export default {
  name: 'billing',
  webhookHandlers: {
    'payments:payment.captured': async (event, { db, log, enqueueJob }) => {
      // event: { id, eventId, provider, kind, type, occurredAt, reference, data, connectionId,
      //          groupId, unitId, companyId, receivedAt, attempt }
      await db('payments')
        .insert({ provider_payment_id: event.data.providerPaymentId /* ... */ })
        .onConflict('provider_payment_id')
        .ignore();
    },
    'razorpay:refund.processed': async (event, deps) => { /* Razorpay only */ },
    'meetings:*': [recordAttendance, summariseLater], // several handlers, run in order
  },
};
```

- **Source.** An adapter kind (`payments`, `messaging.whatsapp`, ...), a provider key (`razorpay`, `zoom`, `mock`), or `*`.
- **Event.** One of the kind's webhook events (`integrations/framework/kinds/*.js`), or `*`.
- **Validation.** The registry rejects unknown sources and events at start-up, so a misspelt topic fails loudly instead of never firing. `test/webhooks/registry.test.js` covers the rules.
- **Order.** Handlers run one after another, most specific first: `kind:event`, `kind:*`, `provider:event`, `provider:*`, `*:event`, `*:*`. Each runs once per event.
- **Where they run.** In the worker, with `{ db, redis, log, registry, enqueueJob, throttle }`.
- **Which company.** `event.companyId` is the connection's company. It is `null` for a group connection shared by several companies; route by the event's data, as intake does.
- **Slow work** (AI calls, sends): enqueue a job from the handler instead of doing it inline.
- **No retries.** Throw `PermanentJobError` (`core/jobs/runner.js`) to fail the event at once without retries, for example for data that will never be valid.

### Module webhook sources

A sender that isn't a provider adapter but posts signed events about one of a connection's kinds (the separate WhatsApp tool) is declared by its module as a webhook source:

```js
webhookSources: {
  whatsapp_tool: {
    kind: 'messaging.whatsapp',                    // connections of this kind, whatever their provider
    events: ['message.in', 'message.out', 'message.status', 'conversation.handover'],
    verifyWebhook: (request, { connectionId, connection }) => ({ ok: true } | { ok: false, reason }),
    parseWebhook: (request, ctx) => ({ events: [{ eventId, type, occurredAt, reference?, data }] }),  // 4xx AppError when unreadable
    webhookChallenge: (request) => null | { status, contentType, body },
  },
},
webhookHandlers: { 'whatsapp_tool:message.in': handle, ... },
```

- **URL.** `POST /api/v1/webhooks/<source key>/:connectionId` for any active, connected connection of the kind (404 otherwise).
- **Storage.** Events are stored, de-duplicated, queued, retried and replayed like a provider's, with `provider = '<source key>'`, so they never collide with the provider's own event ids.
- **Handlers.** Only `<source key>:<event>` and `<source key>:*` handlers run for them, not the kind's or the catch-alls, because their payloads differ from the provider's.
- **Validation.** Keys are lower case; a key can't reuse a kind or provider key; the registry checks sources before handlers, so a handler can name a source declared by a later module.

### Handlers and jobs registered today

| Module | Webhook handlers | Jobs |
| --- | --- | --- |
| `messaging` | `messaging.whatsapp:*`, `messaging.email:*`, `messaging.sms:*` (receipts, inbound, template approvals) and the `whatsapp_tool` source | none |
| `webhooks` | none | `webhooks.sweep` (every minute), `webhooks.prune` (02:30 daily) |
| `deals` | none | `deals.bulk` (a tracked bulk action), `deals.sla_sweep` (every minute) |
| `tasks` | none | `tasks.reminders` (every minute) |
| `automations` | none | `automations.tick` (every minute) |

## Retry policy and dead letters

Both queues use the same policy (`core/jobs/policy.js`):

- The delay doubles from `RETRY_BASE_DELAY_MS` (10 s) and is capped at `RETRY_MAX_DELAY_MS` (1 hour), with ±20 % jitter.
- The jitter is derived from the job id and the attempt, so the "next try" time on screen is the real one.
- **Webhook events** get `WEBHOOK_MAX_ATTEMPTS` (12) attempts: 10 s, 20 s, 40 s, ... up to 1 h. That is about 3.5 hours of retries before the event is dead-lettered.
- **Jobs** get `JOB_MAX_ATTEMPTS` (5) attempts, or the job's own `attempts`. Repeating jobs default to 1 attempt, because the next run comes soon anyway.
- **Dead letters.** After the last attempt the event or job gets status **`failed`**, which means dead letter. It keeps `attempts`, `last_error` and `failed_at` / `finished_at`, appears under Settings › Integrations › Webhooks and jobs › Dead letters, and can be replayed:
  - `POST /webhook-events/:id/replay`, or `POST /webhook-events/replay` to replay up to 200 events at a time
  - `POST /jobs/:id/retry`
- **Replaying** puts the item back on its queue with fresh attempts (queue job id `<id>-r<n>`), records who replayed it, and is audited and emits an event.
- **Untracked jobs** are recorded only when they dead-letter: a reminder, an AI call. Their record holds the job's data, so a retry runs it again.
- **Repeating jobs** keep one open dead letter per schedule (`dedupe_key`, counting `failures`), so a broken cron job can't flood the list.
- **The sweeper** (`webhooks.sweep`, every minute) re-queues events and tracked jobs still waiting in Postgres whose queue job is gone, for example after a Redis restart or a failed enqueue.
- **Limit.** Untracked jobs live only in Redis until they finish, so enable Redis persistence (AOF) in production.

## Background jobs

Declare processors in `module.js`:

```js
export default {
  name: 'deals',
  jobs: {
    'deals.bulk': async (data, ctx) => {
      const { dealIds, change } = data;
      for (const [i, id] of dealIds.entries()) {
        try { await applyChange(ctx.db, id, change); }
        catch (err) { ctx.addError({ message: `Deal ${id}: ${err.message}`, item: { id } }); }
        await ctx.progress({ done: i + 1, total: dealIds.length });
      }
      return { changed: dealIds.length };
    },
    'scheduling.reminder': { handler: sendReminder, attempts: 3, label: 'Booking reminder' },
    'integrations.health_sweep': { handler: sweep, repeat: { pattern: '*/15 * * * *' } },  // cron, UTC unless tz
    'webhooks.sweep': { handler: sweepStuck, repeat: { every: 60_000 }, attempts: 1 },
  },
};
```

Options:

- `handler(data, ctx)`, required.
- `label`
- `attempts` (1 to 50)
- `backoffMs` (the first retry delay)
- `repeat`: `{ pattern, tz? }` or `{ every }` in ms, at least 1000
- `data`: the payload of a repeating job

Names look like `module.action`. The registry validates everything at start-up.

`ctx` gives:

- `db`, `redis`, `log`, `registry`, `enqueueJob`, `throttle`
- `job: { id, name, attempt, maxAttempts, recordId, unitId, createdBy }`
- `progress({ done, total?, message? })`, written to the record at most twice a second and at the end
- `addError({ message, item? })` for per-item problems that don't fail the job (the first 200 are kept, all are counted)

The returned value is stored as the result, up to 100 KB.

### Enqueueing

Call `enqueueJob` from `core/jobs/queue.js` **after your transaction commits**:

```js
import { enqueueJob, cancelJob } from '../../core/jobs/queue.js';

// A bulk action people follow: a record with status, progress, result and errors (GET /jobs/:id).
const { id } = await enqueueJob('deals.bulk', { dealIds, change }, { track: true, unitId: company.id, createdBy: req.auth.user.id, label: `Move ${dealIds.length} deals` });

// Reminders 24 h and 1 h before a booking: delayed and de-duplicated by job id.
await enqueueJob('scheduling.reminder', { bookingId, offset: '24h' }, { runAt: new Date(startsAt - 24 * 3600_000), jobId: `reminder-${bookingId}-24h`, unitId });
await enqueueJob('scheduling.reminder', { bookingId, offset: '1h' }, { runAt: new Date(startsAt - 3600_000), jobId: `reminder-${bookingId}-1h`, unitId });
// Rescheduled: cancel and enqueue again.
await cancelJob(`reminder-${bookingId}-24h`);
```

| Option | |
| --- | --- |
| `delay` / `runAt` | Run later (milliseconds, or a time) |
| `jobId` | De-duplicates untracked jobs. A second add with the same id is ignored while the first is waiting, delayed or running, and for a day after it completes. `cancelJob(jobId)` removes it before it starts. Letters, digits, `-`, `_` and `.`; not only digits. |
| `attempts`, `backoffMs` | Override the declaration and the defaults |
| `unitId` | Where the job belongs. Required with `track`. Recommended otherwise, because a dead letter is scoped by it; without one, only group-level job admins see it. |
| `track`, `label`, `createdBy` | Create the user-visible record at once |

- **Data** is JSON of at most 256 KB. Store ids, not rows.
- **Return value.** `enqueueJob` returns `{ id, queueJobId, tracked, runAt }`. `id` is the record id for tracked jobs.
- **Cancelling.** `cancelJob(id)` takes a record id or a queue job id. It returns `false` once the job has started; a running job finishes.

### Job records and the API

| Method and path | Permission | |
| --- | --- | --- |
| `GET /jobs?unitId=&status=&name=&mine=&cursor=&limit=` | signed in | The jobs you started in scope, plus everyone's where you hold `jobs.view`. Newest first, keyset-paginated. `status=failed` lists the dead letters. |
| `GET /jobs/:id` | creator or `jobs.view` | Status, progress (`{ done, total, message, percent }`), result, the first 200 errors, data |
| `POST /jobs/:id/retry` | creator or `jobs.manage` | Dead letters only (409 otherwise) |
| `POST /jobs/:id/cancel` | creator or `jobs.manage` | Queued or waiting between attempts (409 once started) |

Statuses: `queued`, `running`, `retrying` (waiting between attempts), `completed`, `failed` (dead letter) and `cancelled`.

## Webhook admin API

These routes live under `/webhook-events`, not `/webhooks/`, because the `/webhooks/` prefix skips the CSRF check.

| Method and path | Permission | |
| --- | --- | --- |
| `GET /webhook-events?unitId=&provider=&kind=&status=&connectionId=&type=&cursor=&limit=` | `webhooks.view` | The delivery log, newest first, keyset-paginated |
| `GET /webhook-events/summary?unitId=` | `webhooks.view` | Counts of `queued`, `processing`, `retrying` and `failed` |
| `GET /webhook-events/:id` | `webhooks.view` | With the payload (only with `contacts.view_pii` at the owner), finished handlers, request id and source IP |
| `POST /webhook-events/:id/replay` | `webhooks.manage` | Dead letters only (409 otherwise) |
| `POST /webhook-events/replay` | `webhooks.manage` | `{ unitId, provider?, kind?, connectionId?, type? }`: up to 200 per call, returns `{ replayed, remaining }` |

Statuses: `queued`, `processing`, `retrying`, `processed`, `failed` (dead letter) and `rejected` (signature or body refused).

**Scoping.** An event belongs to its connection's owner: a company, or the group for a shared connection.

- Company admins see their company's events.
- At the group, group admins see every company's events plus the group connections'.
- Anything else answers 404, and the list answers 403 where the permission is held nowhere in scope.

**Permissions** (`roles:sync` grants them to group and company admins):

| Permission | Allows |
| --- | --- |
| `webhooks.view` | Seeing the delivery log and the dead letters |
| `webhooks.manage` | Replaying events |
| `jobs.view` | Seeing everyone's jobs |
| `jobs.manage` | Retrying and cancelling anyone's jobs |

People always see, retry and cancel the jobs they started themselves.

**Events and audit:** `webhook_event.replayed`, `webhook_event.bulk_replayed`, `background_job.retried` and `background_job.cancelled`, each with an audit entry.

## Outbound throttling

Adapters and the messaging service call `throttle` from `core/jobs/throttle.js` before each provider request:

```js
import { throttle, tryThrottle } from '../../core/jobs/throttle.js';

await throttle('whatsapp', connection.id);              // waits for a token (up to 30 s), then sends
const { allowed, retryAfterMs } = await tryThrottle('email', connection.id);  // never waits
```

- **The bucket.** One Redis token bucket per name and connection (`throttle:<name>:<connectionId>`). It runs as one Lua script on Redis' own clock, so every API and worker process shares it.
- **Limits.** `perSecond` tokens are added each second, up to `burst`. Defaults are in `core/jobs/limits.js`:
  - WhatsApp 80/s (Meta's default per number)
  - SMS 20/s
  - email 10/s
  - payments 25/s
  - calls 2/s
  - AI 2/s with a burst of 5
  - everything else 10/s
- **Names.** A channel name (`whatsapp`), a kind key (`messaging.whatsapp`) or a provider key (`whatsapp_cloud`). Override any of them with `THROTTLE_LIMITS`, for example `{"whatsapp":{"perSecond":20,"burst":40}}`.
- **Slow waits.** When a token would take longer than `maxWaitMs`, `throttle()` throws `ThrottledError`: HTTP 429, `code: 'throttled'`, `retryable: true`. Inside a job, that error means the job retries with backoff.
- **`cost`.** Pass it for batch calls (`{ cost: 10 }`). It can't exceed the burst.

## The admin screens

Settings › Integrations › **Webhooks and jobs** shows these tabs to people with `webhooks.view` or `jobs.view` somewhere:

- **Deliveries.** The delivery log in the working scope.
  - Filters: provider, status and connection.
  - Choosing a connection shows its webhook URL with a copy button.
  - A summary line counts dead letters, retries and waiting events.
  - Rows show attempts, the next try, the last error and duplicates.
  - Details show the payload (masked without `contacts.view_pii`), finished handlers and replays.
  - Lists refresh every 5 s while something is still moving.
- **Dead letters.** Failed webhook events, with Replay and Replay all, and failed jobs, with Retry.
- **Background jobs.** Jobs with status, progress bars, skipped-item counts, errors and results.
  - Filters: status, and only the jobs I started.
  - Actions: Retry and Cancel.

## Environment

| Variable | Default | |
| --- | --- | --- |
| `WEBHOOK_MAX_ATTEMPTS` | `12` | Attempts before a webhook event is dead-lettered |
| `JOB_MAX_ATTEMPTS` | `5` | Default attempts for jobs |
| `RETRY_BASE_DELAY_MS` | `10000` | First retry delay (it doubles from there) |
| `RETRY_MAX_DELAY_MS` | `3600000` | Longest delay between attempts |
| `WEBHOOK_RETENTION_DAYS` | `30` | Days processed and rejected events are kept |
| `WEBHOOK_RATE_LIMIT` | `1200` | Deliveries per connection per minute on the public URL |
| `WEBHOOK_FAILURE_LIMIT` | `100` | Refused deliveries (400, 401, 404) per source IP per 10 minutes before 429 |
| `THROTTLE_LIMITS` | (none) | JSON overrides of the throttling limits |

## Tests

- `test/webhooks/signature.test.js`: verification over the exact raw bytes. Covers re-serialised JSON, tampering, wrong secrets, malformed and missing headers, the stored secret, and the handshake.
- `test/webhooks/registry.test.js`: `webhookHandlers` keys, handler order and ids, and `jobs` declarations (names, attempts, repeat, cron, time zones, duplicates).
- `test/jobs/policy.test.js`: backoff growth, the cap and stable jitter, the queue strategy, and throttling limits and overrides.
- `test/integration/webhooks.test.js` (`INTEGRATION=1`) runs the webhook and job workers in process:
  - duplicates processed once, including parallel redeliveries
  - per-connection event ids
  - bad signatures (401, rejected row, not processed)
  - 404s and the handshake
  - a failing handler retrying and dead-lettering, then replay skipping finished handlers, and bulk replay
  - delayed jobs, job id de-duplication and `cancelJob`
  - progress visible while a job runs, and its result and errors
  - a failing job dead-lettered and retried
  - cancelling
  - throttling
  - who sees what, as the owner, `admin.satnpaper`, `admin.pivector`, `ritika` and `kabir`
