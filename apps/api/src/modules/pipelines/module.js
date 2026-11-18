// Pipelines per company, their ordered stages (category, probability, SLA, required fields, entry
// rules) and lost reasons. Built by the config slice; see docs/crm/PHASE2_CONTRACT.md.

import { pipelineRoutes } from './routes.js';

export default {
  name: 'pipelines',
  label: 'Pipelines',
  permissions: [
    { key: 'pipelines.view', label: 'See pipelines', description: 'See pipelines, stages and lost reasons' },
    {
      key: 'pipelines.manage',
      label: 'Manage pipelines',
      description: 'Set up pipelines, stages, stage rules and lost reasons for a company',
    },
  ],
  roleGrants: {
    group_admin: ['pipelines.view', 'pipelines.manage'],
    company_admin: ['pipelines.view', 'pipelines.manage'],
    manager: ['pipelines.view'],
    counsellor: ['pipelines.view'],
    account_executive: ['pipelines.view'],
    finance: ['pipelines.view'],
    marketing: ['pipelines.view'],
    support: ['pipelines.view'],
    analyst: ['pipelines.view'],
  },
  routes: (router) => pipelineRoutes(router),
};
