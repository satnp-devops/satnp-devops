import { apiKeyRoutes } from './routes.js';

/**
 * API keys for machine access (docs/platform/INTEGRATIONS.md, "API keys"). A key belongs to the
 * group or a company and carries permission scopes; `Authorization: Bearer phx_...` then acts as
 * a service principal with exactly those permissions there (auth.js).
 */
export default {
  name: 'api_keys',
  label: 'API keys',
  permissions: [
    {
      key: 'api_keys.manage',
      label: 'Manage API keys',
      description: 'Create and revoke API keys for websites, scripts and partner systems',
    },
  ],
  roleGrants: {
    group_admin: ['api_keys.manage'],
    company_admin: ['api_keys.manage'],
  },
  routes: (router) => apiKeyRoutes(router),
};
