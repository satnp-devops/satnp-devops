import { createHash } from 'node:crypto';
import { env } from '../../config/env.js';

/**
 * Retry policy for webhook events and background jobs (docs/platform/WEBHOOKS_AND_JOBS.md).
 *
 * Delays grow exponentially from `baseMs` (10 s by default), are capped at `maxMs` (1 hour) and get
 * a ±20 % jitter so a burst of failures doesn't retry in lockstep. The jitter is derived from the
 * job id and attempt, so the delay shown in the admin screen is the delay the queue really uses.
 * After the last attempt the event or job is dead-lettered (status `failed`), visible and replayable.
 */

/** The custom BullMQ backoff type: workers resolve it with backoffStrategy() below. */
export const BACKOFF_TYPE = 'phoenix';

export const RETRY_POLICY = Object.freeze({
  webhooks: Object.freeze({ attempts: env.WEBHOOK_MAX_ATTEMPTS, baseMs: env.RETRY_BASE_DELAY_MS, maxMs: env.RETRY_MAX_DELAY_MS }),
  jobs: Object.freeze({ attempts: env.JOB_MAX_ATTEMPTS, baseMs: env.RETRY_BASE_DELAY_MS, maxMs: env.RETRY_MAX_DELAY_MS }),
});

/** A stable number in [0, 1) for a seed. */
function unitHash(seed) {
  return createHash('sha256').update(String(seed)).digest().readUInt32BE(0) / 2 ** 32;
}

/**
 * The wait before the next attempt after `failures` failed attempts (1 after the first failure).
 * Pure: unit-tested in test/jobs/policy.test.js.
 */
export function retryDelay(failures, { baseMs, maxMs }, seed = '') {
  const n = Math.max(1, Math.floor(failures));
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.min(n - 1, 40));
  const jitter = 0.8 + 0.4 * unitHash(`${seed}:${n}`);
  return Math.max(1, Math.round(Math.min(maxMs, exponential * jitter)));
}

/** BullMQ job options for a policy: attempts and our backoff type. */
export function retryOptions(policy, overrides = {}) {
  return {
    attempts: overrides.attempts ?? policy.attempts,
    backoff: { type: BACKOFF_TYPE, delay: overrides.backoffMs ?? policy.baseMs },
  };
}

/**
 * The Worker `settings.backoffStrategy` for our queues. BullMQ calls it with the number of failed
 * attempts so far (including the one that just failed). Unknown types never retry (-1).
 */
export function backoffStrategy(attemptsMade, type, _err, job) {
  if (type !== BACKOFF_TYPE) return -1;
  const policy = job?.queueName === 'webhooks' ? RETRY_POLICY.webhooks : RETRY_POLICY.jobs;
  const baseMs = Number(job?.opts?.backoff?.delay) || policy.baseMs;
  return retryDelay(attemptsMade, { baseMs, maxMs: Math.max(baseMs, policy.maxMs) }, job?.id ?? '');
}

/** When the next attempt runs, for the admin screens (null after the last attempt). */
export function nextAttemptAt({ failures, maxAttempts, baseMs, maxMs, seed, now = Date.now() }) {
  if (failures >= maxAttempts) return null;
  return new Date(now + retryDelay(failures, { baseMs, maxMs: Math.max(baseMs, maxMs) }, seed));
}
