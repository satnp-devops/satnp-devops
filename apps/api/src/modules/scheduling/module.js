import { schedulingSettings } from './settings.js';
import { schedulingRoutes } from './routes.js';
import { schedulingPublicRoutes } from './publicRoutes.js';
import { schedulingEventHandlers } from './handlers.js';

// Scheduling (architecture phase 6): event types, availability, the public booking page, bookings
// with reminders, personal booking links, and meeting attendance. See docs/scheduling/SCHEDULING.md.
// What the integrator connects (ports, job processors, the attendance webhook handler) is exported
// from ./index.js.

export default {
  name: 'scheduling',
  label: 'Bookings and scheduling',
  permissions: [
    {
      key: 'scheduling.view',
      label: 'See bookings',
      description: 'See bookings and the booking calendar, event types and availability',
      supportsOwn: true,
    },
    {
      key: 'scheduling.manage',
      label: 'Work bookings',
      description: 'Host bookings, send booking links, reschedule, cancel and record attendance or no-shows',
      supportsOwn: true,
    },
    { key: 'scheduling.assign', label: 'Reassign bookings', description: 'Give a booking to another host' },
    {
      key: 'scheduling.configure',
      label: 'Set up booking pages',
      description: "Create and change event types, their hosts and booking pages, and other people's availability",
    },
  ],
  roleGrants: {
    group_admin: ['scheduling.view', 'scheduling.manage', 'scheduling.assign', 'scheduling.configure'],
    company_admin: ['scheduling.view', 'scheduling.manage', 'scheduling.assign', 'scheduling.configure'],
    manager: ['scheduling.view', 'scheduling.manage', 'scheduling.assign', 'scheduling.configure'],
    counsellor: ['scheduling.view:own', 'scheduling.manage:own'],
    account_executive: ['scheduling.view:own', 'scheduling.manage:own'],
    support: ['scheduling.view'],
    finance: ['scheduling.view'],
    marketing: ['scheduling.view'],
    analyst: ['scheduling.view'],
  },
  settings: schedulingSettings,
  eventHandlers: schedulingEventHandlers,
  routes(router) {
    schedulingRoutes(router);
    schedulingPublicRoutes(router);
  },
};
