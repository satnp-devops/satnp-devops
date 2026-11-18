import { BUILT_IN_CHANNELS } from '../../core/crm/channels.js';
import { dealSettings } from '../../core/crm/settings.js';
import { dealJobs } from './jobs.js';
import { dealRoutes } from './routes.js';

// Leads and deals (one record), stage moves with the stage-rule evaluator, SLAs, assignment,
// won / lost / reopen, saved views, bulk actions and the duplicate pre-check.
// Built by the deals slice; see docs/crm/PHASE2_CONTRACT.md.

export default {
  name: 'deals',
  label: 'Leads and deals',
  permissions: [
    {
      key: 'deals.view',
      label: 'See leads and deals',
      description: 'See enquiries and deals, their stages, value and history',
      supportsOwn: true,
    },
    {
      key: 'deals.manage',
      label: 'Work leads and deals',
      description: 'Create and edit deals, move stages, mark them won or lost and reopen them',
      supportsOwn: true,
    },
    { key: 'deals.assign', label: 'Assign deals', description: 'Change who owns a deal' },
    { key: 'deals.archive', label: 'Archive deals', description: 'Archive (soft delete) and restore deals' },
    { key: 'deals.share_views', label: 'Share saved views', description: 'Save list views for everyone in a team or company' },
  ],
  roleGrants: {
    group_admin: ['deals.view', 'deals.manage', 'deals.assign', 'deals.archive', 'deals.share_views'],
    company_admin: ['deals.view', 'deals.manage', 'deals.assign', 'deals.archive', 'deals.share_views'],
    manager: ['deals.view', 'deals.manage', 'deals.assign', 'deals.archive', 'deals.share_views'],
    counsellor: ['deals.view:own', 'deals.manage:own'],
    account_executive: ['deals.view:own', 'deals.manage:own'],
    finance: ['deals.view'],
    marketing: ['deals.view'],
    support: ['deals.view'],
    analyst: ['deals.view'],
  },
  settings: dealSettings,
  // Enquiry channels for leads; other modules can add their own the same way.
  channels: BUILT_IN_CHANNELS,
  jobs: dealJobs,
  routes: (router) => dealRoutes(router),
};
