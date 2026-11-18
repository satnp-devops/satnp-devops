// Product lines and products per company (group batches, 1:1 mentorship, crash courses, test
// series, programs, test platform and ERP software). Plans, price lists and taxes arrive with the
// money phase. Built by the config slice; see docs/crm/PHASE2_CONTRACT.md.

import { catalogRoutes } from './routes.js';

export default {
  name: 'catalog',
  label: 'Products',
  permissions: [
    { key: 'catalog.view', label: 'See products', description: 'See product lines and products' },
    { key: 'catalog.manage', label: 'Manage products', description: 'Add and edit product lines and products for a company' },
  ],
  roleGrants: {
    group_admin: ['catalog.view', 'catalog.manage'],
    company_admin: ['catalog.view', 'catalog.manage'],
    manager: ['catalog.view'],
    counsellor: ['catalog.view'],
    account_executive: ['catalog.view'],
    finance: ['catalog.view'],
    marketing: ['catalog.view'],
    support: ['catalog.view'],
    analyst: ['catalog.view'],
  },
  routes: (router) => catalogRoutes(router),
};
