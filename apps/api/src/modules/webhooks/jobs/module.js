import { jobRoutes } from './routes.js';

/**
 * Phase 3: background job records (docs/platform/WEBHOOKS_AND_JOBS.md). The queue and runner are in
 * core/jobs; this module is the API people use to follow bulk actions and imports, and to retry or
 * cancel jobs. A separate module from `webhooks` so `jobs.*` stays a module of its own.
 */
export default {
  name: 'jobs',
  label: 'Background jobs',
  permissions: [
    {
      key: 'jobs.view',
      label: 'See background jobs',
      description: "See everyone's bulk actions, imports and failed jobs. People always see the jobs they started.",
    },
    {
      key: 'jobs.manage',
      label: 'Retry and cancel background jobs',
      description: 'Retry jobs that failed every attempt and cancel jobs that have not started',
    },
  ],
  roleGrants: {
    group_admin: ['jobs.view', 'jobs.manage'],
    company_admin: ['jobs.view', 'jobs.manage'],
  },
  routes: (router) => jobRoutes(router),
};
