import { settingDefinitions } from './definitions.js';
import { settingsRoutes } from './routes.js';

export default {
  name: 'settings',
  label: 'Settings',
  settings: settingDefinitions,
  permissions: [
    { key: 'settings.view', label: 'See settings', description: 'See settings for a unit' },
    { key: 'settings.manage', label: 'Change settings', description: 'Change settings for a unit and everything under it' },
  ],
  roleGrants: {
    group_admin: ['settings.view', 'settings.manage'],
    company_admin: ['settings.view', 'settings.manage'],
    manager: ['settings.view'],
    finance: ['settings.view'],
  },
  routes: (router) => settingsRoutes(router),
};
