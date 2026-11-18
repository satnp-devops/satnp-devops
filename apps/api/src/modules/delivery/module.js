import { enrollmentSettings } from './settings.js';
import { enrollmentRoutes } from './enrollmentRoutes.js';
import { checkoutRoutes } from './checkout.js';
import { enrollmentHandlers } from './handlers.js';

// Enrollments (phase 8, admissions and delivery): batches with capacity and a first-come
// waitlist, enrollments created idempotently from payments and the website checkout, pause,
// withdrawal with a pro-rata refund request. docs/delivery/DELIVERY.md.
// Its sibling module `onboarding` (onboardingModule.js) holds checklists, implementation
// projects and renewals.

export default {
  name: 'enrollments',
  label: 'Enrollments',
  permissions: [
    { key: 'enrollments.view', label: 'See enrollments', description: 'See enrollments, batches and waitlists', supportsOwn: true },
    { key: 'enrollments.manage', label: 'Manage enrollments', description: 'Enroll students, assign batches, pause, resume and complete', supportsOwn: true },
    { key: 'enrollments.withdraw', label: 'Withdraw students', description: 'Record a withdrawal and request its pro-rata refund', supportsOwn: true },
    { key: 'enrollments.manage_batches', label: 'Manage batches', description: 'Create batches and change capacity, schedule, fee and waitlist' },
  ],
  roleGrants: {
    group_admin: ['enrollments.view', 'enrollments.manage', 'enrollments.withdraw', 'enrollments.manage_batches'],
    company_admin: ['enrollments.view', 'enrollments.manage', 'enrollments.withdraw', 'enrollments.manage_batches'],
    manager: ['enrollments.view', 'enrollments.manage', 'enrollments.withdraw', 'enrollments.manage_batches'],
    counsellor: ['enrollments.view:own', 'enrollments.manage:own'],
    finance: ['enrollments.view', 'enrollments.withdraw'],
    support: ['enrollments.view', 'enrollments.manage'],
    analyst: ['enrollments.view'],
  },
  settings: enrollmentSettings,
  eventHandlers: enrollmentHandlers,
  routes(router) {
    enrollmentRoutes(router);
    checkoutRoutes(router);
  },
};
