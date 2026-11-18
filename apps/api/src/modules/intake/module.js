import { intakeSettings } from './settings.js';
import { intakeRoutes } from './routes.js';
import { processImportJob } from './imports.js';

// Capture and intake (architecture phase 4): website forms and the checkout hand-off, lead ads,
// call and email leads, partner referral links, CSV imports and manual entry all go through one
// pipeline (service.js ingestEnquiry): routing to a company, de-duplication against the group's
// people, a new, merged or reopened lead, owner assignment and the first-reply SLA.
// Engine: core/intake (docs/platform/INTAKE_CORE.md). Ports to other modules: ports.js.

export default {
  name: 'intake',
  label: 'Capture and intake',
  permissions: [
    { key: 'intake.view', label: 'See intake', description: 'See forms, routing rules, assignment pools and the enquiry log' },
    { key: 'intake.manage', label: 'Set up intake', description: 'Build website forms, register channels, set routing and assignment rules, create referral links' },
    { key: 'intake.review', label: 'Review enquiries', description: 'Decide where uncertain enquiries go and whether possible duplicates are the same person' },
    { key: 'intake.import', label: 'Import leads', description: 'Upload CSV files of leads and see their results' },
  ],
  roleGrants: {
    group_admin: ['intake.view', 'intake.manage', 'intake.review', 'intake.import'],
    company_admin: ['intake.view', 'intake.manage', 'intake.review', 'intake.import'],
    manager: ['intake.view', 'intake.review', 'intake.import'],
    marketing: ['intake.view', 'intake.import'],
    support: ['intake.view', 'intake.review'],
    analyst: ['intake.view'],
  },
  settings: intakeSettings,
  // CRM channels that intake brings in addition to the built-in ones (core/crm/channels.js).
  channels: [
    { key: 'lead_ad_google', label: 'Google lead form', group: 'ads', firstReplySla: true },
    { key: 'sms', label: 'SMS', group: 'messaging', firstReplySla: true },
    { key: 'walk_in', label: 'Walk-in', group: 'other', firstReplySla: false },
    { key: 'event', label: 'Event or fair', group: 'other', firstReplySla: true },
    { key: 'api', label: 'API', group: 'other', firstReplySla: true },
  ],
  eventHandlers: {
    // Development jobs port (ports.js): a queued import runs in the worker. Idempotent: rows
    // already done are skipped and a finished job is left alone.
    'intake.import_queued': async (event, { db, log, registry }) => {
      await processImportJob(event.payload.jobId, { db, log, registry });
    },
  },
  routes: (router) => intakeRoutes(router),
};
