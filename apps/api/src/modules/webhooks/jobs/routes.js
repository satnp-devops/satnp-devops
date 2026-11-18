import { z } from 'zod';
import { validate } from '../../../lib/validate.js';
import { idParams } from '../../../lib/schemas.js';
import { requireAuth } from '../../../core/guards.js';
import { describe } from '../../../core/openapi/describe.js';
import { JOB_STATUSES, jobDetailSchema, jobSchema } from '../schemas.js';
import { cancelBackgroundJob, getJob, listJobs, retryJob } from './service.js';

const VIEW = 'jobs.view';
const MANAGE = 'jobs.manage';

const listQuery = z.strictObject({
  unitId: z.uuid().describe('The working unit (group, company or team)'),
  status: z.enum(JOB_STATUSES).optional().describe('failed lists the dead letters'),
  name: z.string().regex(/^[a-z][a-z0-9_.]{0,99}$/).optional().describe('A job name, e.g. deals.bulk'),
  mine: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true')
    .describe('Only the jobs I started'),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export function jobRoutes(router) {
  router.get(
    '/jobs',
    describe({
      summary: 'List background jobs',
      description:
        "Newest first: the jobs you started in scope, plus everyone's where you hold `jobs.view` (bulk actions, imports, and jobs that failed every attempt). `status=failed` lists the dead letters.",
      permission: VIEW,
      list: true,
      responses: { 200: { schema: jobSchema, list: true } },
    }),
    requireAuth(),
    validate({ query: listQuery }),
    async (req, res) => {
      res.json(await listJobs(req, req.valid.query));
    },
  );

  router.get(
    '/jobs/:id',
    describe({
      summary: 'Get a background job',
      description: 'Status, progress, result and the first 200 per-item errors. Visible to the person who started it and to `jobs.view` holders.',
      permission: VIEW,
      responses: { 200: jobDetailSchema },
    }),
    requireAuth(),
    validate({ params: idParams }),
    async (req, res) => {
      res.json({ data: await getJob(req, req.valid.params.id) });
    },
  );

  router.post(
    '/jobs/:id/retry',
    describe({
      summary: 'Retry a failed background job',
      description: 'Only dead letters (status `failed`): queues the job again with fresh attempts and the same data. Emits `background_job.retried`.',
      permission: MANAGE,
      errors: [409],
      responses: { 200: jobDetailSchema },
    }),
    requireAuth(),
    validate({ params: idParams }),
    async (req, res) => {
      res.json({ data: await retryJob(req, req.valid.params.id) });
    },
  );

  router.post(
    '/jobs/:id/cancel',
    describe({
      summary: 'Cancel a background job that has not started',
      description: 'Queued jobs and jobs waiting between attempts; a running job finishes. Emits `background_job.cancelled`.',
      permission: MANAGE,
      errors: [409],
      responses: { 200: jobDetailSchema },
    }),
    requireAuth(),
    validate({ params: idParams }),
    async (req, res) => {
      res.json({ data: await cancelBackgroundJob(req, req.valid.params.id) });
    },
  );
}
