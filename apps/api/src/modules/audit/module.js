import { auditRoutes } from './routes.js';

export default {
  name: 'audit',
  label: 'Audit log',
  permissions: [{ key: 'audit.view', label: 'See the audit log', description: 'See who changed what, and when' }],
  roleGrants: {
    group_admin: ['audit.view'],
    company_admin: ['audit.view'],
  },
  routes: (router) => auditRoutes(router),
};
