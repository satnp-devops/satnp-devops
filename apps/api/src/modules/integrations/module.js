import { integrationRoutes } from './routes.js';

/**
 * Phase 3: the integration framework (docs/platform/INTEGRATIONS.md). Connections to providers
 * per company, channel identities, the sandbox outbox of the mock adapters. API keys are the
 * separate `api_keys` module next to this one (apiKeys/module.js) so `api_keys.*` stays a module.
 */
export default {
  name: 'integrations',
  label: 'Integrations',
  permissions: [
    {
      key: 'integrations.view',
      label: 'See integrations',
      description: 'See connected providers, channel identities and the sandbox outbox',
    },
    {
      key: 'integrations.manage',
      label: 'Manage integrations',
      description: 'Connect and disconnect providers, change their credentials and register channels',
    },
  ],
  roleGrants: {
    group_admin: ['integrations.view', 'integrations.manage'],
    company_admin: ['integrations.view', 'integrations.manage'],
    marketing: ['integrations.view'],
  },
  routes: (router) => integrationRoutes(router),
};
