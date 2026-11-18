import { envelopeOf, JOB_RETENTION } from './queue.js';
import { RETRY_POLICY, retryOptions } from './policy.js';

/**
 * Repeating (cron) jobs: every job a module declares with `repeat` gets a BullMQ job scheduler on
 * the jobs queue, keyed by the job name, so several workers starting at once still create one.
 * Schedulers for jobs no module declares any more are removed. Cron patterns run in UTC unless
 * the definition names a `tz`.
 */
export async function syncSchedules(queue, registry, log) {
  const declared = [...registry.jobs.values()].filter((definition) => definition.repeat);
  for (const definition of declared) {
    const { pattern, every, tz } = definition.repeat;
    await queue.upsertJobScheduler(definition.name, pattern ? { pattern, ...(tz ? { tz } : { tz: 'UTC' }) } : { every }, {
      name: definition.name,
      data: envelopeOf({ data: definition.data ?? {} }),
      opts: {
        ...retryOptions(RETRY_POLICY.jobs, { attempts: definition.attempts ?? 1, backoffMs: definition.backoffMs ?? undefined }),
        ...JOB_RETENTION,
      },
    });
  }
  const names = new Set(declared.map((definition) => definition.name));
  const existing = await queue.getJobSchedulers(0, -1);
  for (const scheduler of existing) {
    const key = scheduler.key ?? scheduler.id;
    if (key && !names.has(key)) {
      await queue.removeJobScheduler(key);
      log?.info({ scheduler: key }, 'Removed the schedule of a job no module declares');
    }
  }
  return declared.map((definition) => definition.name);
}
