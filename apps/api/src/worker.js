import { setTimeout as sleep } from 'node:timers/promises';
import { Worker } from 'bullmq';
import { db } from './lib/db.js';
import { redis, createQueueConnection } from './lib/redis.js';
import { logger } from './lib/logger.js';
import { QUEUES, closeQueues, getQueue } from './core/queue.js';
import { dispatchEvent, relayOutbox } from './core/events.js';
import { getMailer } from './integrations/mail/index.js';
import { buildRegistry } from './registry.js';
import { createWebhookProcessor } from './core/webhooks/processor.js';
import { createJobProcessor } from './core/jobs/runner.js';
import { backoffStrategy } from './core/jobs/policy.js';
import { syncSchedules } from './core/jobs/schedules.js';

// Background worker:
//   1. relays the transactional outbox to the events queue
//   2. runs module event handlers for each domain event
//   3. sends queued email through the configured mail adapter
//   4. processes provider webhook events and module background jobs, with retries and dead letters
//      (docs/platform/WEBHOOKS_AND_JOBS.md), and keeps the repeating (cron) jobs scheduled
// Run as many workers as you like; the relay and the queues are safe to share.

const registry = buildRegistry();
const eventsQueue = getQueue(QUEUES.events);

const eventsWorker = new Worker(
  QUEUES.events,
  async (job) => {
    const log = logger.child({ eventId: job.data.id, eventType: job.data.type });
    const handled = await dispatchEvent(registry, job.data, { db, redis, log, registry });
    return { handled };
  },
  { connection: createQueueConnection(), concurrency: 10 },
);

const mailer = getMailer();
const mailWorker = new Worker(QUEUES.mail, async (job) => mailer.send(job.data), {
  connection: createQueueConnection(),
  concurrency: 5,
});

// Phase 3: webhook events and background jobs retry with our capped exponential backoff.
const webhooksWorker = new Worker(QUEUES.webhooks, createWebhookProcessor({ registry, db, redis, log: logger }), {
  connection: createQueueConnection(),
  concurrency: 10,
  settings: { backoffStrategy },
});
const jobsWorker = new Worker(QUEUES.jobs, createJobProcessor({ registry, db, redis, log: logger }), {
  connection: createQueueConnection(),
  concurrency: 5,
  settings: { backoffStrategy },
});
syncSchedules(getQueue(QUEUES.jobs), registry, logger).catch((err) => logger.error({ err }, 'Could not schedule the repeating jobs'));

for (const worker of [eventsWorker, mailWorker, webhooksWorker, jobsWorker]) {
  worker.on('failed', (job, err) => logger.error({ err, queue: worker.name, jobId: job?.id }, 'Job failed'));
}

let running = true;
async function relayLoop() {
  while (running) {
    try {
      const relayed = await relayOutbox(db, eventsQueue);
      if (relayed === 0) await sleep(500);
    } catch (err) {
      logger.error({ err }, 'Outbox relay failed');
      await sleep(2000);
    }
  }
}

logger.info({ queues: Object.values(QUEUES), mail: mailer.name }, 'Worker started');
const relay = relayLoop();

async function shutdown(signal) {
  if (!running) return;
  running = false;
  logger.info({ signal }, 'Shutting down worker');
  await relay;
  await Promise.allSettled([eventsWorker.close(), mailWorker.close(), webhooksWorker.close(), jobsWorker.close()]);
  await Promise.allSettled([closeQueues(), db.destroy(), redis.quit()]);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
