import { orgRoutes } from './routes.js';
import { unitTypes } from './unitTypes.js';

export default {
  name: 'org',
  label: 'Organisation',
  unitTypes,
  permissions: [
    { key: 'org.view', label: 'See the organisation', description: 'See companies, branches and teams' },
    { key: 'org.manage', label: 'Manage the organisation', description: 'Add, edit, move and archive units' },
  ],
  roleGrants: {
    group_admin: ['org.view', 'org.manage'],
    company_admin: ['org.view', 'org.manage'],
    manager: ['org.view'],
    counsellor: ['org.view'],
    account_executive: ['org.view'],
    finance: ['org.view'],
    marketing: ['org.view'],
    support: ['org.view'],
    analyst: ['org.view'],
  },
  routes: (router) => orgRoutes(router),
};
