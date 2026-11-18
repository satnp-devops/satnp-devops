// One timeline across channels for every deal, contact and institute: notes, messages, calls,
// emails, meetings, stage changes, tasks and AI actions. Entries are written by their producers
// through core/crm/timeline.js; this module lists them and lets people add notes and log activity.
// Built by the timeline slice; see docs/crm/PHASE2_CONTRACT.md.

import { timelineEventHandlers } from './handlers.js';
import { timelineRoutes } from './routes.js';

export default {
  name: 'timeline',
  label: 'Timeline',
  permissions: [
    {
      key: 'timeline.write',
      label: 'Add notes and activities',
      description: 'Add notes and log calls, meetings and emails on records you can see',
    },
    {
      key: 'timeline.moderate',
      label: 'Remove timeline entries',
      description: 'Delete notes and logged activities added by other people',
    },
  ],
  roleGrants: {
    group_admin: ['timeline.write', 'timeline.moderate'],
    company_admin: ['timeline.write', 'timeline.moderate'],
    manager: ['timeline.write', 'timeline.moderate'],
    counsellor: ['timeline.write'],
    account_executive: ['timeline.write'],
    finance: ['timeline.write'],
    support: ['timeline.write'],
  },
  eventHandlers: timelineEventHandlers,
  routes: (router) => timelineRoutes(router),
};
