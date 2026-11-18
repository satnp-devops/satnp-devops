import { automationRoutes } from './routes.js';
import { handleEvent, tick } from './runner.js';
import { automationSettings } from './settings.js';

// Phase 9, automations: flows with versions, the event router and runner around the engine in
// core/automation, the action registry and executors, the approvals queue and the test panel.
// docs/automations/AUTOMATIONS.md; engine: docs/platform/AUTOMATION_CORE.md.

export default {
  name: 'automations',
  label: 'Automations',
  permissions: [
    { key: 'automations.view', label: 'See automations', description: 'See flows, their versions and runs, and test flows' },
    { key: 'automations.manage', label: 'Manage automations', description: 'Create, edit, turn on, pause and archive flows; cancel runs' },
    {
      key: 'automations.webhooks',
      label: 'Use webhooks in flows',
      description: 'Add "Call webhook" steps, which send record data to outside systems',
    },
    {
      key: 'automations.approve',
      label: 'Approve automation steps',
      description: 'Approve, edit or reject what a flow wants to do (such as an AI-written follow-up) before it happens',
      supportsOwn: true,
    },
  ],
  roleGrants: {
    group_admin: ['automations.view', 'automations.manage', 'automations.webhooks', 'automations.approve'],
    company_admin: ['automations.view', 'automations.manage', 'automations.webhooks', 'automations.approve'],
    manager: ['automations.view', 'automations.approve'],
    counsellor: ['automations.approve:own'],
    account_executive: ['automations.approve:own'],
    marketing: ['automations.view'],
    analyst: ['automations.view'],
  },
  settings: automationSettings,
  // The event router: starts runs of matching active flows, resumes runs waiting on the event and
  // routes `automation.effect_result` reports from other modules' executors. Idempotent.
  eventHandlers: {
    '*': (event, { db, log }) => handleEvent(event, { db, log }),
  },
  // Background jobs (core/jobs): 'automations.tick' every minute advances due waits, fires schedule
  // triggers, scans for quiet deals and re-sends stuck effects.
  jobs: {
    'automations.tick': {
      label: 'Advance automation runs',
      handler: (_data, { db, log }) => tick(db, { log }),
      repeat: { every: 60_000 },
      attempts: 1,
    },
  },
  // Engine declarations (triggers, actions, agents) beyond core/automation/catalog.js: none yet.
  // Other modules add theirs (and `executors`) in their own module.js; see registry.js.
  automation: {},
  routes(router) {
    automationRoutes(router);
  },
};
