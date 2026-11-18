import { Queue } from 'bullmq';
import { createQueueConnection } from '../lib/redis.js';

export const QUEUES = Object.freeze({
  events: 'events',
  mail: 'mail',
  // Phase 3 (docs/platform/WEBHOOKS_AND_JOBS.md): provider webhook events (job id = webhook_events.id)
  // and module background jobs (bulk actions, imports, reminders, AI calls, schedules).
  webhooks: 'webhooks',
  jobs: 'jobs',
});

// BullMQ doesn't close connections it was handed, so we keep each queue's connection
// and close both on shutdown.
const queues = new Map();

export function getQueue(name) {
  if (!queues.has(name)) {
    const connection = createQueueConnection();
    const queue = new Queue(name, {
      connection,
      defaultJobOptions: {
        attempts: 8,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: { count: 5000 },
        removeOnFail: { count: 10000 },
      },
    });
    queues.set(name, { queue, connection });
  }
  return queues.get(name).queue;
}

/** Emails can carry one-time links, so they never go through the persistent outbox. */
export async function enqueueMail(message) {
  await getQueue(QUEUES.mail).add('send', message, { removeOnComplete: true, attempts: 5 });
}

export async function closeQueues() {
  const entries = [...queues.values()];
  queues.clear();
  await Promise.allSettled(entries.map(({ queue }) => queue.close()));
  await Promise.allSettled(entries.map(({ connection }) => connection.quit()));
}
