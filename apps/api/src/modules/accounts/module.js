// Institutes: coaching institutes, schools, colleges and independent mentors (B2B accounts),
// stored once per group (accounts, account_companies), with their people and decision makers
// (account_contacts). Built by the accounts slice; see docs/crm/PHASE2_CONTRACT.md.

import { accountRoutes } from './routes.js';

export default {
  name: 'accounts',
  label: 'Institutes',
  permissions: [
    {
      key: 'accounts.view',
      label: 'See institutes',
      description: 'See coaching institutes, schools and mentors, and the people who work there',
      supportsOwn: true,
    },
    {
      key: 'accounts.manage',
      label: 'Manage institutes',
      description: 'Add and edit institutes and their decision makers',
      supportsOwn: true,
    },
  ],
  roleGrants: {
    group_admin: ['accounts.view', 'accounts.manage'],
    company_admin: ['accounts.view', 'accounts.manage'],
    manager: ['accounts.view', 'accounts.manage'],
    account_executive: ['accounts.view', 'accounts.manage'],
    finance: ['accounts.view'],
    marketing: ['accounts.view'],
    support: ['accounts.view'],
    analyst: ['accounts.view'],
  },
  // Endpoints: docs/crm/PHASE2_CONTRACT.md §9.2 (institutes, their people and decision makers).
  routes: (router) => accountRoutes(router),
};
