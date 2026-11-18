// Tasks and follow-ups with due times (UTC), assignees, priorities and reminders, optionally on a
// deal, contact or institute. "Own" tasks are those assigned to or created by the user.
// Built by the timeline slice; see docs/crm/PHASE2_CONTRACT.md.

import { processDueTaskReminders } from './reminders.js';
import { taskRoutes } from './routes.js';

export default {
  name: 'tasks',
  label: 'Tasks',
  permissions: [
    {
      key: 'tasks.view',
      label: 'See tasks',
      description: 'See tasks and follow-ups (own: the ones assigned to or created by you)',
      supportsOwn: true,
    },
    {
      key: 'tasks.manage',
      label: 'Manage tasks',
      description: 'Create, edit, complete and reassign tasks',
      supportsOwn: true,
    },
  ],
  roleGrants: {
    group_admin: ['tasks.view', 'tasks.manage'],
    company_admin: ['tasks.view', 'tasks.manage'],
    manager: ['tasks.view', 'tasks.manage'],
    counsellor: ['tasks.view:own', 'tasks.manage:own'],
    account_executive: ['tasks.view:own', 'tasks.manage:own'],
    finance: ['tasks.view:own', 'tasks.manage:own'],
    marketing: ['tasks.view:own', 'tasks.manage:own'],
    support: ['tasks.view:own', 'tasks.manage:own'],
    analyst: ['tasks.view'],
  },
  jobs: {
    // Emits task.reminder_due for open tasks whose reminder time has come (notifications are a later phase).
    'tasks.reminders': {
      label: 'Send due task reminders',
      handler: (_data, { db }) => processDueTaskReminders({ db }),
      repeat: { every: 60_000 },
      attempts: 1,
    },
  },
  routes: (router) => taskRoutes(router),
};
