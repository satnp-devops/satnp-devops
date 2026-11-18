import { roleRoutes } from './routes.js';

export default {
  name: 'roles',
  label: 'Roles',
  permissions: [
    { key: 'roles.view', label: 'See roles', description: 'See roles and what each one allows' },
    { key: 'roles.manage', label: 'Manage roles', description: 'Create, edit and delete custom roles' },
  ],
  roleGrants: {
    group_admin: ['roles.view', 'roles.manage'],
    company_admin: ['roles.view'],
  },
  routes: (router) => roleRoutes(router),
};
