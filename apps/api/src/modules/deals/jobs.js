import { PermanentJobError } from '../../core/jobs/runner.js';
import { bulkActorFor, runDealBulk } from './bulk.js';
import { bulkBody } from './schemas.js';
import { sweepSlaBreaches } from './sla.js';

// Background jobs of the deals module (core/jobs, docs/platform/WEBHOOKS_AND_JOBS.md).
//
//   deals.bulk       a bulk action run in the worker as the user who asked for it. Enqueue it
//                    after the request with enqueueJob('deals.bulk', { userId, input }, { track: true,
//                    unitId, createdBy: userId, label }); GET /jobs/:id shows progress and the result.
//                    POST /deals/bulk still runs inline (up to 1000 leads, chunks of 100).
//   deals.sla_sweep  every minute: marks open leads whose first-reply or stage SLA has passed.

/** @param {{ userId: string, input: unknown }} data */
async function runBulkJob(data, ctx) {
  const parsed = bulkBody.safeParse(data?.input);
  if (!data?.userId || !parsed.success) throw new PermanentJobError('The bulk action is not valid');
  const actor = await bulkActorFor(data.userId, ctx.registry);
  actor.log = ctx.log;
  const result = await runDealBulk(actor, parsed.data, { onProgress: (progress) => ctx.progress(progress) });
  for (const failure of result.failed) ctx.addError({ message: failure.message, item: { id: failure.id, code: failure.code } });
  return { total: result.total, updated: result.updated.length, unchanged: result.unchanged.length, failed: result.failed.length };
}

export const dealJobs = {
  'deals.bulk': { label: 'Bulk change leads', handler: runBulkJob, attempts: 3 },
  'deals.sla_sweep': {
    label: 'Mark leads past their SLA',
    handler: (_data, { db }) => sweepSlaBreaches({ db }),
    repeat: { every: 60_000 },
    attempts: 1,
  },
};
