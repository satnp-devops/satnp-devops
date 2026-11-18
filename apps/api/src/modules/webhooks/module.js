import { pruneOld, sweepStuck } from '../../core/webhooks/maintenance.js';
import { webhookRoutes } from './routes.js';

/**
 * Phase 3: inbound webhooks (docs/platform/WEBHOOKS_AND_JOBS.md). The public endpoint
 * (POST /webhooks/:provider/:connectionId, ingress.js) is mounted by app.js outside the session
 * chain; this module adds the admin API of the delivery log and dead letters, and schedules the
 * housekeeping jobs.
 */
export default {
  name: 'webhooks',
  label: 'Webhooks',
  permissions: [
    {
      key: 'webhooks.view',
      label: 'See webhook deliveries',
      description: 'See the webhook delivery log and dead letters of the connections they can see',
    },
    {
      key: 'webhooks.manage',
      label: 'Replay webhooks',
      description: 'Replay webhook events that failed every attempt',
    },
  ],
  roleGrants: {
    group_admin: ['webhooks.view', 'webhooks.manage'],
    company_admin: ['webhooks.view', 'webhooks.manage'],
  },
  jobs: {
    'webhooks.sweep': {
      label: 'Re-queue lost webhook events and jobs',
      handler: (_data, ctx) => sweepStuck(ctx),
      repeat: { every: 60_000 },
      attempts: 1,
    },
    'webhooks.prune': {
      label: 'Delete old processed webhook events',
      handler: (_data, ctx) => pruneOld(ctx),
      repeat: { pattern: '30 2 * * *' },
      attempts: 3,
    },
  },
  routes: (router) => webhookRoutes(router),
};
