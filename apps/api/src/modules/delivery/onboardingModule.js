import { onboardingSettings } from './settings.js';
import { onboardingRoutes } from './onboardingRoutes.js';
import { onboardingHandlers } from './handlers.js';

// Onboarding (phase 8): B2C onboarding checklists per enrollment, B2B implementation projects
// (kickoff, data import, training, go-live) and the renewals list with churn risk and upsell
// flags. docs/delivery/DELIVERY.md.

export default {
  name: 'onboarding',
  label: 'Onboarding and renewals',
  permissions: [
    { key: 'onboarding.view', label: 'See onboarding', description: 'See onboarding checklists and implementation projects', supportsOwn: true },
    { key: 'onboarding.manage', label: 'Work on onboarding', description: 'Tick off checklist items, run implementation projects and their tasks', supportsOwn: true },
    { key: 'onboarding.configure', label: 'Set up onboarding', description: 'Edit checklist and implementation templates' },
    { key: 'onboarding.view_renewals', label: 'See renewals', description: 'See subscriptions coming up for renewal, churn risk and upsell flags', supportsOwn: true },
  ],
  roleGrants: {
    group_admin: ['onboarding.view', 'onboarding.manage', 'onboarding.configure', 'onboarding.view_renewals'],
    company_admin: ['onboarding.view', 'onboarding.manage', 'onboarding.configure', 'onboarding.view_renewals'],
    manager: ['onboarding.view', 'onboarding.manage', 'onboarding.view_renewals'],
    counsellor: ['onboarding.view:own', 'onboarding.manage:own'],
    account_executive: ['onboarding.view:own', 'onboarding.manage:own', 'onboarding.view_renewals:own'],
    finance: ['onboarding.view_renewals'],
    support: ['onboarding.view', 'onboarding.manage'],
    analyst: ['onboarding.view', 'onboarding.view_renewals'],
  },
  settings: onboardingSettings,
  eventHandlers: onboardingHandlers,
  routes(router) {
    onboardingRoutes(router);
  },
};
