import { userRoutes } from './routes.js';

export default {
  name: 'users',
  label: 'People',
  permissions: [
    { key: 'users.view', label: 'See people', description: 'See who works in a unit and their roles' },
    { key: 'users.manage', label: 'Manage people', description: 'Invite people, change roles, disable accounts' },
  ],
  roleGrants: {
    group_admin: ['users.view', 'users.manage'],
    company_admin: ['users.view', 'users.manage'],
    manager: ['users.view'],
  },
  routes: (router) => userRoutes(router),
};
