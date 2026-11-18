import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

// Webhooks and background jobs end to end (docs/platform/WEBHOOKS_AND_JOBS.md): the public endpoint,
// signatures, de-duplication, the worker with retries and dead letters, replay, delayed jobs, job
// progress, cancelling, throttling, and who sees what (owner, admin.satnpaper, admin.pivector,
// ritika, kabir). Runs the webhook and job workers in this process with a test module's handlers.
// Needs a migrated and seeded database. Unique ids per run.

const enabled = process.env.INTEGRATION === '1';
// Fast retries for this process only (node --test runs each file in its own process).
process.env.RETRY_BASE_DELAY_MS = '40';
process.env.WEBHOOK_MAX_ATTEMPTS = '3';
process.env.JOB_MAX_ATTEMPTS = '2';

const RUN = Date.now().toString(36);

async function waitFor(check, { timeout = 20_000, interval = 100, what = 'condition' } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${what}`);
    await sleep(interval);
  }
}

test('webhooks and background jobs end to end', { skip: !enabled && 'set INTEGRATION=1 to run' }, async (t) => {
  const { env } = await import('../../src/config/env.js');
  const { db } = await import('../../src/lib/db.js');
  const { redis, createQueueConnection } = await import('../../src/lib/redis.js');
  const { logger } = await import('../../src/lib/logger.js');
  const { closeQueues, getQueue, QUEUES } = await import('../../src/core/queue.js');
  const { createApp } = await import('../../src/app.js');
  const { createRegistry } = await import('../../src/core/registry.js');
  const { modules } = await import('../../src/modules/index.js');
  const { buildMockWebhookRequest } = await import('../../src/integrations/index.js');
  const { createWebhookProcessor } = await import('../../src/core/webhooks/processor.js');
  const { createJobProcessor } = await import('../../src/core/jobs/runner.js');
  const { backoffStrategy } = await import('../../src/core/jobs/policy.js');
  const { enqueueJob, cancelJob } = await import('../../src/core/jobs/queue.js');
  const { throttle, tryThrottle, ThrottledError } = await import('../../src/core/jobs/throttle.js');
  const { Worker } = await import('bullmq');

  // ---- A test module: webhook handlers and jobs the assertions can observe ----
  const calls = new Map(); // "<handler>:<event id>" -> count
  const count = (key) => calls.get(key) ?? 0;
  const bump = (key) => calls.set(key, count(key) + 1);
  const state = { brokenEvents: true, brokenJobs: true, ran: new Map(), gates: new Map() };
  const mine = (event) => String(event.eventId).startsWith(`evt_${RUN}`);
  const testModule = {
    name: 'webhookstest',
    webhookHandlers: {
      'payments:payment.captured': async (event) => {
        if (mine(event)) bump(`captured:${event.eventId}`);
      },
      'payments:payment.failed': [
        async (event) => {
          if (mine(event)) bump(`first:${event.eventId}`);
        },
        async (event) => {
          if (!mine(event)) return;
          bump(`second:${event.eventId}`);
          if (state.brokenEvents) throw new Error('The ledger is unavailable');
        },
      ],
    },
    jobs: {
      'webhookstest.ping': async (data) => {
        state.ran.set(data.token, Date.now());
        return { pong: data.token };
      },
      'webhookstest.import': {
        label: 'Import test rows',
        handler: async (data, ctx) => {
          for (let i = 1; i <= data.rows; i += 1) {
            if (i === 2) ctx.addError({ message: 'Row 2 has no phone number', item: { row: 2 } });
            await ctx.progress({ done: i, total: data.rows, message: `Row ${i}` });
            if (i === 2) await state.gates.get(data.token)?.promise;
          }
          return { imported: data.rows - 1, skipped: 1 };
        },
      },
      'webhookstest.flaky': async (data) => {
        state.ran.set(data.token, (state.ran.get(data.token) ?? 0) + 1);
        if (state.brokenJobs) throw new Error('The provider is down');
        return { ok: true };
      },
    },
  };
  const registry = createRegistry([...modules, testModule]);
  const app = createApp({ registry, modules });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;

  const deps = { registry, db, redis, log: logger };
  // BullMQ doesn't close connections it is handed: keep them to quit at the end.
  const connections = [createQueueConnection(), createQueueConnection()];
  const workers = [
    new Worker(QUEUES.webhooks, createWebhookProcessor(deps), { connection: connections[0], concurrency: 5, settings: { backoffStrategy } }),
    new Worker(QUEUES.jobs, createJobProcessor(deps), { connection: connections[1], concurrency: 5, settings: { backoffStrategy } }),
  ];
  const startedAt = new Date();
  let testConnections = [];

  t.after(async () => {
    for (const gate of state.gates.values()) gate.release(); // a gated job must finish, or closing its worker waits forever
    await Promise.allSettled(workers.map((w) => w.close()));
    await Promise.allSettled(connections.map((c) => c.quit()));
    await db('webhook_events').where('external_event_id', 'like', `evt_${RUN}%`).delete();
    if (testConnections.length) {
      await db('webhook_events').where({ status: 'rejected' }).where('received_at', '>=', startedAt).whereIn('connection_id', testConnections).delete();
    }
    await db('background_jobs').where('name', 'like', 'webhookstest.%').delete();
    const keys = await redis.keys('webhooks:rejected:*');
    if (keys.length) await redis.del(...keys);
    server.close();
    await closeQueues();
    await db.destroy();
    await redis.quit();
  });

  const limits = await redis.keys('rl:*');
  if (limits.length) await redis.del(...limits);

  function client() {
    let cookie = '';
    async function call(method, path, body) {
      const res = await fetch(base + path, {
        method,
        headers: { 'content-type': 'application/json', 'x-phoenix-client': 'integration-test', ...(cookie ? { cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      for (const header of res.headers.getSetCookie()) {
        const [pair] = header.split(';');
        if (pair.startsWith(`${env.SESSION_COOKIE_NAME}=`)) cookie = pair.endsWith('=') ? '' : pair;
      }
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null, text };
    }
    call.login = async (email) => {
      const res = await call('POST', '/auth/login', { email, password: env.SEED_PASSWORD });
      assert.equal(res.status, 200, `${email}: ${res.text}`);
    };
    return call;
  }

  /** What a provider sends: the signed raw bytes, no cookie, no X-Phoenix-Client header. */
  async function deliver(path, { rawBody, headers }) {
    const res = await fetch(base + path, { method: 'POST', headers, body: rawBody });
    const text = await res.text();
    return { status: res.status, body: text && text.startsWith('{') ? JSON.parse(text) : text };
  }

  const owner = client();
  const spAdmin = client();
  const pvAdmin = client();
  const ritika = client();
  const kabir = client();
  await Promise.all([
    owner.login('owner@phoenix.test'),
    spAdmin.login('admin.satnpaper@phoenix.test'),
    pvAdmin.login('admin.pivector@phoenix.test'),
    ritika.login('ritika@phoenix.test'),
    kabir.login('kabir@phoenix.test'),
  ]);
  const units = (await owner('GET', '/auth/me')).body.data.units;
  const unit = (name) => units.find((u) => u.name === name);
  const group = unit('Phoenix Educational Institute');
  const satnpaper = unit('SatnPaper');
  const pivector = unit('Pi Vector');
  const satAdmissions = unit('SAT admissions');
  const online = unit('Online');
  assert.ok(group && satnpaper && pivector && satAdmissions && online, 'seeded units');

  const mockPayments = (companyId) =>
    db('integration_connections')
      .where({ unit_id: companyId, kind: 'payments', provider: 'mock', status: 'active' })
      .whereNull('disconnected_at')
      .orderBy('created_at')
      .first();
  const spPay = await mockPayments(satnpaper.id);
  const pvPay = await mockPayments(pivector.id);
  assert.ok(spPay && pvPay, 'seeded mock payments connections');
  testConnections = [spPay.id, pvPay.id];
  const hookPath = (connection) => `/webhooks/mock/${connection.id}`;
  const occurredAt = new Date().toISOString();
  const captured = (id, extra = {}) => ({ id, type: 'payment.captured', occurredAt, reference: `deal-${RUN}`, data: { amountMinor: 150000, currency: 'INR', ...extra } });
  const eventRow = (eventId, connection = spPay) =>
    db('webhook_events').where({ provider: 'mock', connection_id: connection.id, external_event_id: eventId }).first();

  await t.test('the same webhook delivered twice is stored and processed once', async () => {
    const eventId = `evt_${RUN}_dup`;
    const request = await buildMockWebhookRequest({ connectionId: spPay.id, events: [captured(eventId)] });
    const first = await deliver(hookPath(spPay), request);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual(first.body.data, { received: 1, accepted: 1, duplicates: 0 });
    const second = await deliver(hookPath(spPay), request);
    assert.equal(second.status, 200);
    assert.deepEqual(second.body.data, { received: 1, accepted: 0, duplicates: 1 });

    const row = await waitFor(async () => {
      const r = await eventRow(eventId);
      return r?.status === 'processed' ? r : null;
    }, { what: 'the event to be processed' });
    await sleep(300); // a second job, if one had been queued, would have run by now
    assert.equal(count(`captured:${eventId}`), 1);
    assert.equal(row.duplicates, 1);
    assert.equal(row.handler_count, 1);
    assert.equal(row.attempts, 1);
    assert.equal(row.unit_id, satnpaper.id);
    assert.equal(row.reference, `deal-${RUN}`);
    assert.equal(row.payload.amountMinor, 150000);
  });

  await t.test('parallel redeliveries race on the unique key: exactly one is accepted', async () => {
    const eventId = `evt_${RUN}_race`;
    const request = await buildMockWebhookRequest({ connectionId: spPay.id, events: [captured(eventId)] });
    const results = await Promise.all([1, 2, 3, 4].map(() => deliver(hookPath(spPay), request)));
    assert.deepEqual(results.map((r) => r.status), [200, 200, 200, 200]);
    assert.equal(results.reduce((sum, r) => sum + r.body.data.accepted, 0), 1);
    await waitFor(async () => (await eventRow(eventId))?.status === 'processed', { what: 'the raced event' });
    assert.equal(count(`captured:${eventId}`), 1);
    assert.equal((await eventRow(eventId)).duplicates, 3);
  });

  await t.test('event ids are de-duplicated per connection: two companies may reuse an id', async () => {
    const eventId = `evt_${RUN}_shared`;
    const sp = await deliver(hookPath(spPay), await buildMockWebhookRequest({ connectionId: spPay.id, events: [captured(eventId)] }));
    const pv = await deliver(hookPath(pvPay), await buildMockWebhookRequest({ connectionId: pvPay.id, events: [captured(eventId)] }));
    assert.equal(sp.body.data.accepted, 1);
    assert.equal(pv.body.data.accepted, 1);
    await waitFor(async () => (await eventRow(eventId, pvPay))?.status === 'processed', { what: 'the Pi Vector event' });
  });

  await t.test('a bad signature is 401, kept as a rejected delivery without its body, and never processed', async () => {
    const eventId = `evt_${RUN}_forged`;
    const signed = await buildMockWebhookRequest({ connectionId: spPay.id, events: [captured(eventId)] });
    const forged = { headers: signed.headers, rawBody: Buffer.from(signed.rawBody.toString('utf8').replace('150000', '1')) };
    const res = await deliver(hookPath(spPay), forged);
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'webhook_signature_invalid');

    // Signed for Pi Vector's connection, sent to SatnPaper's: refused too.
    const crossed = await buildMockWebhookRequest({ connectionId: pvPay.id, events: [captured(eventId)] });
    assert.equal((await deliver(hookPath(spPay), crossed)).status, 401);
    // No signature header at all.
    assert.equal((await deliver(hookPath(spPay), { headers: { 'content-type': 'application/json' }, rawBody: signed.rawBody })).status, 401);

    await sleep(300);
    assert.equal(await eventRow(eventId), undefined);
    assert.equal(count(`captured:${eventId}`), 0);
    const rejected = await db('webhook_events')
      .where({ connection_id: spPay.id, status: 'rejected' })
      .where('received_at', '>=', startedAt)
      .orderBy('received_at', 'desc');
    assert.ok(rejected.length >= 3);
    assert.match(rejected[0].last_error, /signature/i);
    assert.equal(rejected[0].external_event_id, null);
    assert.deepEqual(Object.keys(rejected[0].payload).sort(), ['bytes', 'contentType', 'reason']);
  });

  await t.test('unknown connections, a wrong provider, bad bodies and the handshake', async () => {
    const request = await buildMockWebhookRequest({ connectionId: spPay.id, events: [captured(`evt_${RUN}_x`)] });
    assert.equal((await deliver(`/webhooks/mock/00000000-0000-4000-8000-000000000000`, request)).status, 404);
    assert.equal((await deliver(`/webhooks/razorpay/${spPay.id}`, request)).status, 404);
    const storage = await db('integration_connections').where({ unit_id: satnpaper.id, kind: 'storage', provider: 'mock' }).first();
    assert.equal((await deliver(`/webhooks/mock/${storage.id}`, request)).status, 404, 'storage connections receive no webhooks');
    const unreadable = await buildMockWebhookRequest({ connectionId: spPay.id, events: [{ ...captured(`evt_${RUN}_y`), type: 'message.received' }] });
    const bad = await deliver(hookPath(spPay), unreadable);
    assert.equal(bad.status, 400);
    const handshake = await fetch(`${base}${hookPath(spPay)}?challenge=hello-${RUN}`);
    assert.equal(handshake.status, 200);
    assert.equal(await handshake.text(), `hello-${RUN}`);
  });

  await t.test('messaging handlers run for provider events; the WhatsApp tool posts to its own source URL', async () => {
    const { buildWhatsappToolRequest } = await import('../../src/modules/messaging/webhooks.js');
    const wa = await db('integration_connections')
      .where({ unit_id: satnpaper.id, kind: 'messaging.whatsapp', provider: 'mock', status: 'active' })
      .whereNull('disconnected_at')
      .orderBy('created_at')
      .first();
    assert.ok(wa, 'a seeded mock WhatsApp connection');
    testConnections.push(wa.id);
    const processedRow = (provider, eventId) =>
      waitFor(
        async () => {
          const row = await db('webhook_events').where({ provider, connection_id: wa.id, external_event_id: eventId }).first();
          return row && ['processed', 'failed'].includes(row.status) && row;
        },
        { what: `${eventId} to finish` },
      );

    // A delivery receipt for a message we never sent: the messaging handler runs and ignores it.
    const receiptId = `evt_${RUN}_wa_receipt`;
    const receipt = await buildMockWebhookRequest({
      connectionId: wa.id,
      events: [{ id: receiptId, type: 'message.status', occurredAt, data: { providerMessageId: `wamid.${RUN}`, status: 'delivered' } }],
    });
    assert.equal((await deliver(`/webhooks/mock/${wa.id}`, receipt)).status, 200);
    const handled = await processedRow('mock', receiptId);
    assert.equal(handled.status, 'processed', handled.last_error);
    assert.deepEqual(handled.completed_handlers, ['messaging/messaging.whatsapp:message.status/0']);

    // A payload the handler can't read is dead-lettered at once instead of retrying.
    const unreadableId = `evt_${RUN}_wa_unreadable`;
    const unreadable = await buildMockWebhookRequest({ connectionId: wa.id, events: [{ id: unreadableId, type: 'message.status', occurredAt, data: { status: 'delivered' } }] });
    assert.equal((await deliver(`/webhooks/mock/${wa.id}`, unreadable)).status, 200);
    const dead = await processedRow('mock', unreadableId);
    assert.equal(dead.status, 'failed');
    assert.equal(dead.attempts, 1, 'no retries for an unreadable payload');

    // The WhatsApp tool signs with its own secret, at /webhooks/whatsapp_tool/:connectionId.
    const toolId = `evt_${RUN}_tool_status`;
    const tool = buildWhatsappToolRequest(wa.id, [{ id: toolId, type: 'message.status', occurredAt, data: { messageId: `wamid.${RUN}`, status: 'read' } }]);
    const toolDelivery = { rawBody: tool.rawBody, headers: tool.headers };
    const accepted = await deliver(`/webhooks/whatsapp_tool/${wa.id}`, toolDelivery);
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.deepEqual(accepted.body.data, { received: 1, accepted: 1, duplicates: 0 });
    const toolRow = await processedRow('whatsapp_tool', toolId);
    assert.equal(toolRow.status, 'processed', toolRow.last_error);
    assert.equal(toolRow.kind, 'messaging.whatsapp');
    assert.deepEqual(toolRow.completed_handlers, ['messaging/whatsapp_tool:message.status/0'], "only the tool's handlers run");

    // Each URL accepts only its own signature scheme, and the tool only WhatsApp connections.
    assert.equal((await deliver(`/webhooks/whatsapp_tool/${wa.id}`, receipt)).status, 401);
    assert.equal((await deliver(`/webhooks/mock/${wa.id}`, toolDelivery)).status, 401);
    assert.equal((await deliver(`/webhooks/whatsapp_tool/${spPay.id}`, toolDelivery)).status, 404);
  });

  let deadId;
  await t.test('a failing handler retries with backoff, then the event is dead-lettered', async () => {
    const eventId = `evt_${RUN}_fail`;
    const request = await buildMockWebhookRequest({
      connectionId: spPay.id,
      events: [{ id: eventId, type: 'payment.failed', occurredAt, reference: `deal-${RUN}`, data: { amountMinor: 1000, currency: 'INR' } }],
    });
    assert.equal((await deliver(hookPath(spPay), request)).body.data.accepted, 1);
    const row = await waitFor(async () => {
      const r = await eventRow(eventId);
      return r?.status === 'failed' ? r : null;
    }, { what: 'the dead letter' });
    deadId = row.id;
    assert.equal(row.attempts, 3);
    assert.equal(row.max_attempts, 3);
    assert.match(row.last_error, /ledger is unavailable/);
    assert.ok(row.failed_at);
    // The first handler succeeded once and was skipped on the retries; the second ran every attempt.
    assert.equal(count(`first:${eventId}`), 1);
    assert.equal(count(`second:${eventId}`), 3);
    assert.deepEqual(row.completed_handlers, ['webhookstest/payments:payment.failed/0']);
  });

  await t.test('dead letters are visible to webhook admins of the owner, and 404 to everyone else', async () => {
    const list = await spAdmin('GET', `/webhook-events?unitId=${satnpaper.id}&status=failed`);
    assert.equal(list.status, 200, list.text);
    const item = list.body.data.find((e) => e.id === deadId);
    assert.ok(item, 'listed as a dead letter');
    assert.equal(item.canReplay, true);
    assert.equal(item.connection.id, spPay.id);
    assert.equal(item.owner.id, satnpaper.id);

    const detail = await spAdmin('GET', `/webhook-events/${deadId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.data.payloadHidden, false);
    assert.equal(detail.body.data.payload.amountMinor, 1000);
    assert.deepEqual(detail.body.data.completedHandlers, ['webhookstest/payments:payment.failed/0']);

    // The group owner sees it at the group and at the company.
    const groupList = await owner('GET', `/webhook-events?unitId=${group.id}&provider=mock&status=failed`);
    assert.ok(groupList.body.data.some((e) => e.id === deadId));
    // Pi Vector's admin: their own company's log doesn't list it, and the event itself is 404.
    const pvList = await pvAdmin('GET', `/webhook-events?unitId=${pivector.id}`);
    assert.equal(pvList.status, 200);
    assert.ok(!pvList.body.data.some((e) => e.id === deadId));
    assert.equal((await pvAdmin('GET', `/webhook-events/${deadId}`)).status, 404);
    assert.equal((await pvAdmin('POST', `/webhook-events/${deadId}/replay`)).status, 404);
    // People without webhooks.view: 403 on the log, 404 on the event.
    assert.equal((await ritika('GET', `/webhook-events?unitId=${satAdmissions.id}`)).status, 403);
    assert.equal((await ritika('GET', `/webhook-events/${deadId}`)).status, 404);
    assert.equal((await kabir('GET', `/webhook-events?unitId=${online.id}`)).status, 403);
    assert.equal((await kabir('POST', `/webhook-events/${deadId}/replay`)).status, 404);

    const summary = await spAdmin('GET', `/webhook-events/summary?unitId=${satnpaper.id}`);
    assert.equal(summary.status, 200);
    assert.ok(summary.body.data.failed >= 1);
    // Keyset pagination over the log.
    const page1 = await spAdmin('GET', `/webhook-events?unitId=${satnpaper.id}&limit=2`);
    assert.equal(page1.body.data.length, 2);
    assert.ok(page1.body.nextCursor);
    const page2 = await spAdmin('GET', `/webhook-events?unitId=${satnpaper.id}&limit=2&cursor=${page1.body.nextCursor}`);
    assert.equal(page2.status, 200);
    assert.ok(!page2.body.data.some((e) => page1.body.data.some((p) => p.id === e.id)));
    assert.equal((await spAdmin('GET', `/webhook-events?unitId=${satnpaper.id}&cursor=nope`)).status, 400);
  });

  await t.test('a dead letter can be replayed once the cause is fixed; finished handlers are skipped', async () => {
    const eventId = `evt_${RUN}_fail`;
    state.brokenEvents = false;
    const res = await spAdmin('POST', `/webhook-events/${deadId}/replay`);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.data.replayCount, 1);
    const row = await waitFor(async () => {
      const r = await eventRow(eventId);
      return r?.status === 'processed' ? r : null;
    }, { what: 'the replayed event' });
    assert.equal(count(`first:${eventId}`), 1, 'the handler that had finished did not run again');
    assert.equal(count(`second:${eventId}`), 4);
    assert.equal(row.replay_count, 1);
    assert.equal(row.last_error, null);
    // Only dead letters can be replayed.
    assert.equal((await spAdmin('POST', `/webhook-events/${deadId}/replay`)).status, 409);
    const audit = await db('audit_logs').where({ action: 'webhook_event.replayed', entity_id: deadId }).first();
    assert.ok(audit, 'the replay is audited');
    const outbox = await db('outbox_events').where({ type: 'webhook_event.replayed', aggregate_id: deadId }).first();
    assert.ok(outbox, 'the replay emits an event');
  });

  await t.test('replay all failed events in scope', async () => {
    state.brokenEvents = true;
    const ids = [`evt_${RUN}_bulk1`, `evt_${RUN}_bulk2`];
    const request = await buildMockWebhookRequest({
      connectionId: spPay.id,
      events: ids.map((id) => ({ id, type: 'payment.failed', occurredAt, data: {} })),
    });
    assert.equal((await deliver(hookPath(spPay), request)).body.data.accepted, 2);
    await waitFor(async () => (await Promise.all(ids.map((id) => eventRow(id)))).every((r) => r?.status === 'failed'), { what: 'two dead letters' });
    state.brokenEvents = false;
    assert.equal((await pvAdmin('POST', '/webhook-events/replay', { unitId: satnpaper.id })).status, 404);
    assert.equal((await ritika('POST', '/webhook-events/replay', { unitId: satAdmissions.id })).status, 403);
    const res = await spAdmin('POST', '/webhook-events/replay', { unitId: satnpaper.id, connectionId: spPay.id });
    assert.equal(res.status, 200, res.text);
    assert.ok(res.body.data.replayed >= 2);
    assert.equal(res.body.data.remaining, 0);
    await waitFor(async () => (await Promise.all(ids.map((id) => eventRow(id)))).every((r) => r?.status === 'processed'), { what: 'the bulk replay' });
  });

  await t.test('a delayed job runs after its delay, not before', async () => {
    const token = `delay-${RUN}`;
    const queuedAt = Date.now();
    const job = await enqueueJob('webhookstest.ping', { token }, { delay: 1500, unitId: satnpaper.id });
    assert.equal(job.tracked, false);
    assert.ok(Date.parse(job.runAt) >= queuedAt + 1500);
    await sleep(600);
    assert.equal(state.ran.has(token), false, 'not yet');
    const ranAt = await waitFor(() => state.ran.get(token), { what: 'the delayed job' });
    assert.ok(ranAt - queuedAt >= 1450, `ran after ${ranAt - queuedAt} ms`);
  });

  await t.test('a job id de-duplicates, and cancelJob removes a delayed job', async () => {
    const token = `cancel-${RUN}`;
    const jobId = `reminder-${RUN}-24h`;
    await enqueueJob('webhookstest.ping', { token }, { delay: 60_000, jobId });
    await enqueueJob('webhookstest.ping', { token }, { delay: 60_000, jobId });
    const queue = getQueue(QUEUES.jobs);
    assert.equal((await queue.getJob(jobId)).name, 'webhookstest.ping');
    assert.equal(await cancelJob(jobId), true);
    assert.equal(await queue.getJob(jobId), undefined);
    assert.equal(await cancelJob(jobId), false);
  });

  let importId;
  await t.test('job progress is visible while it runs, and the result and errors after', async () => {
    const token = `import-${RUN}`;
    let release;
    const promise = new Promise((resolve) => (release = resolve));
    state.gates.set(token, { promise, release });
    const ritikaId = (await ritika('GET', '/auth/me')).body.data.user.id;
    const job = await enqueueJob('webhookstest.import', { token, rows: 4 }, { track: true, unitId: satAdmissions.id, createdBy: ritikaId, label: 'Import 4 test rows' });
    importId = job.id;
    assert.equal(job.tracked, true);

    const running = await waitFor(async () => {
      const res = await ritika('GET', `/jobs/${importId}`);
      return res.body?.data?.status === 'running' && res.body.data.progress?.done >= 2 ? res.body.data : null;
    }, { what: 'progress while running' });
    assert.equal(running.progress.total, 4);
    assert.equal(running.progress.percent, 50);
    assert.equal(running.label, 'Import 4 test rows');
    assert.equal(running.createdBy.id, ritikaId);
    assert.equal(running.unit.id, satAdmissions.id);
    assert.equal(running.errorCount, 1);
    release();

    const done = await waitFor(async () => {
      const res = await ritika('GET', `/jobs/${importId}`);
      return res.body?.data?.status === 'completed' ? res.body.data : null;
    }, { what: 'the import to finish' });
    assert.deepEqual(done.result, { imported: 3, skipped: 1 });
    assert.equal(done.progress.done, 4);
    assert.equal(done.errorCount, 1);
    assert.deepEqual(done.errors, [{ message: 'Row 2 has no phone number', item: { row: 2 } }]);
    assert.deepEqual(done.data, { token, rows: 4 });
    assert.ok(done.startedAt && done.finishedAt);
  });

  await t.test('who sees a job: its creator and jobs.view holders there; everyone else gets 404', async () => {
    assert.equal((await spAdmin('GET', `/jobs/${importId}`)).status, 200);
    assert.equal((await owner('GET', `/jobs/${importId}`)).status, 200);
    assert.equal((await kabir('GET', `/jobs/${importId}`)).status, 404, 'a manager without jobs.view');
    assert.equal((await pvAdmin('GET', `/jobs/${importId}`)).status, 404, 'another company');

    const mineList = await ritika('GET', `/jobs?unitId=${satAdmissions.id}`);
    assert.equal(mineList.status, 200, mineList.text);
    assert.ok(mineList.body.data.some((j) => j.id === importId));
    assert.ok(mineList.body.data.every((j) => j.createdBy?.id === mineList.body.data[0].createdBy?.id), 'only her own jobs');
    const spList = await spAdmin('GET', `/jobs?unitId=${satnpaper.id}&name=webhookstest.import`);
    assert.ok(spList.body.data.some((j) => j.id === importId));
    assert.ok(!(await pvAdmin('GET', `/jobs?unitId=${pivector.id}`)).body.data.some((j) => j.id === importId));
    assert.ok(!(await kabir('GET', `/jobs?unitId=${online.id}`)).body.data.some((j) => j.id === importId));
    // A unit outside the user's scope is 404.
    assert.equal((await pvAdmin('GET', `/jobs?unitId=${satnpaper.id}`)).status, 404);
  });

  await t.test('a failing untracked job is dead-lettered, visible to job admins, and can be retried', async () => {
    const token = `flaky-${RUN}`;
    state.brokenJobs = true;
    await enqueueJob('webhookstest.flaky', { token }, { unitId: satnpaper.id });
    const dead = await waitFor(
      () => db('background_jobs').where({ name: 'webhookstest.flaky', status: 'failed' }).whereRaw("data->>'token' = ?", [token]).first(),
      { what: 'the job dead letter' },
    );
    assert.equal(state.ran.get(token), 2, 'JOB_MAX_ATTEMPTS attempts');
    assert.equal(dead.tracked, false);
    assert.equal(dead.unit_id, satnpaper.id);
    assert.equal(dead.attempts, 2);
    assert.match(dead.last_error, /provider is down/);

    const failed = await spAdmin('GET', `/jobs?unitId=${satnpaper.id}&status=failed`);
    const item = failed.body.data.find((j) => j.id === dead.id);
    assert.ok(item);
    assert.equal(item.canRetry, true);
    assert.equal((await ritika('GET', `/jobs/${dead.id}`)).status, 404);
    assert.equal((await ritika('POST', `/jobs/${dead.id}/retry`)).status, 404);
    assert.equal((await pvAdmin('POST', `/jobs/${dead.id}/retry`)).status, 404);

    state.brokenJobs = false;
    const retried = await spAdmin('POST', `/jobs/${dead.id}/retry`);
    assert.equal(retried.status, 200, retried.text);
    assert.equal(retried.body.data.replayCount, 1);
    const done = await waitFor(async () => {
      const res = await spAdmin('GET', `/jobs/${dead.id}`);
      return res.body.data.status === 'completed' ? res.body.data : null;
    }, { what: 'the retried job' });
    assert.deepEqual(done.result, { ok: true });
    assert.equal(state.ran.get(token), 3);
    assert.equal((await spAdmin('POST', `/jobs/${dead.id}/retry`)).status, 409);
    assert.ok(await db('audit_logs').where({ action: 'background_job.retried', entity_id: dead.id }).first());
  });

  await t.test('the creator cancels a queued job; others cannot', async () => {
    const ritikaId = (await ritika('GET', '/auth/me')).body.data.user.id;
    const job = await enqueueJob('webhookstest.ping', { token: `later-${RUN}` }, { track: true, delay: 60_000, unitId: satAdmissions.id, createdBy: ritikaId });
    assert.equal((await kabir('POST', `/jobs/${job.id}/cancel`)).status, 404);
    const res = await ritika('POST', `/jobs/${job.id}/cancel`);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.data.status, 'cancelled');
    assert.equal((await ritika('POST', `/jobs/${job.id}/cancel`)).status, 409);
    assert.equal(await getQueue(QUEUES.jobs).getJob(job.queueJobId), undefined);
  });

  await t.test('outbound throttling: a token bucket per name and connection', async () => {
    const name = `test_${RUN}`;
    const custom = { [name]: { perSecond: 2, burst: 2 } };
    const connection = `conn-${RUN}`;
    assert.equal((await tryThrottle(name, connection, { limits: custom })).allowed, true);
    assert.equal((await tryThrottle(name, connection, { limits: custom })).allowed, true);
    const third = await tryThrottle(name, connection, { limits: custom });
    assert.equal(third.allowed, false);
    assert.ok(third.retryAfterMs > 0 && third.retryAfterMs <= 500, `${third.retryAfterMs}`);
    // Another connection has its own bucket.
    assert.equal((await tryThrottle(name, `${connection}-b`, { limits: custom })).allowed, true);
    // throttle() waits for the next token...
    const waited = await throttle(name, connection, { limits: custom });
    assert.ok(waited.waitedMs >= 100, `waited ${waited.waitedMs} ms`);
    // ...or gives up with a retryable 429 when that would take too long.
    await assert.rejects(throttle(name, connection, { limits: custom, maxWaitMs: 10 }), (err) => err instanceof ThrottledError && err.status === 429 && err.retryable === true);
    await redis.del(`throttle:${name}:${connection}`, `throttle:${name}:${connection}-b`);
  });
});
