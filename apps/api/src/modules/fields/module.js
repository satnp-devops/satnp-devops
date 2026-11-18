// Custom field definitions per company and entity (deal, contact, account). Values are validated
// with core/crm/customFields.js. Built by the config slice; see docs/crm/PHASE2_CONTRACT.md.

import { fieldRoutes } from './routes.js';

export default {
  name: 'fields',
  label: 'Custom fields',
  permissions: [
    { key: 'fields.view', label: 'See custom fields', description: 'See the extra fields a company keeps on deals, contacts and institutes' },
    { key: 'fields.manage', label: 'Manage custom fields', description: 'Add, edit, reorder and retire custom fields for a company' },
  ],
  roleGrants: {
    group_admin: ['fields.view', 'fields.manage'],
    company_admin: ['fields.view', 'fields.manage'],
    manager: ['fields.view'],
    counsellor: ['fields.view'],
    account_executive: ['fields.view'],
    finance: ['fields.view'],
    marketing: ['fields.view'],
    support: ['fields.view'],
    analyst: ['fields.view'],
  },
  routes: (router) => fieldRoutes(router),
};
