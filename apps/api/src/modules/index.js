import system from './system/module.js';
import auth from './auth/module.js';
import org from './org/module.js';
import users from './users/module.js';
import roles from './roles/module.js';
import settings from './settings/module.js';
import audit from './audit/module.js';
import contacts from './contacts/module.js';
import accounts from './accounts/module.js';
import deals from './deals/module.js';
import pipelines from './pipelines/module.js';
import catalog from './catalog/module.js';
import fields from './fields/module.js';
import timeline from './timeline/module.js';
import tasks from './tasks/module.js';
import search from './search/module.js';
// Phase 3: the integration framework and API keys (docs/platform/INTEGRATIONS.md).
import integrations from './integrations/module.js';
import apiKeys from './integrations/apiKeys/module.js';
// Phase 3: inbound webhooks and background job records (docs/platform/WEBHOOKS_AND_JOBS.md).
import webhooks from './webhooks/module.js';
import jobs from './webhooks/jobs/module.js';
import intake from './intake/module.js';
// Phase 5 foundations: messaging (docs/platform/MESSAGING.md).
import messaging from './messaging/module.js';
import scheduling from './scheduling/module.js';
import money from './money/module.js';
import enrollments from './delivery/module.js';
import onboarding from './delivery/onboardingModule.js';
import automations from './automations/module.js';
// Phase 9 foundations: the AI service (docs/platform/AI.md).
import ai from './ai/module.js';
import partners from './partners/module.js';

/**
 * Installed modules, in load order (the role editor lists permissions in this order). Each later
 * phase adds its modules here: integrations (phase 3), capture (phase 4), messaging (phase 5),
 * scheduling (phase 6), billing (phase 7), admissions (phase 8)...
 *
 * Phase 2, core CRM: docs/crm/PHASE2_CONTRACT.md.
 */
export const modules = [
  system,
  auth,
  org,
  users,
  roles,
  settings,
  audit,
  contacts,
  accounts,
  deals,
  pipelines,
  catalog,
  fields,
  timeline,
  tasks,
  search,
  integrations,
  apiKeys,
  webhooks,
  jobs,
  // Phase 4, capture and intake.
  intake,
  // Phase 5, communication: docs/platform/MESSAGING.md.
  messaging,
  // Phase 6, scheduling: docs/scheduling/SCHEDULING.md.
  scheduling,
  // Phase 7, money: apps/api/src/modules/money/README.md.
  money,
  // Phase 8, admissions and delivery: docs/delivery/DELIVERY.md.
  enrollments,
  onboarding,
  // Phase 9, automations and the AI service: docs/automations/AUTOMATIONS.md, docs/platform/AI.md.
  automations,
  ai,
  partners, // phase 10: docs/partners/PARTNERS.md
];
