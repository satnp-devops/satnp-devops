import { db } from '../../lib/db.js';
import { AI_SETTINGS } from '../../core/ai/settings.js';
import { eraseContactAiActions, moveContactAiActions } from '../../core/ai/privacy.js';
import { aiRoutes } from './routes.js';

/**
 * Phase 9 foundations: the AI service (docs/platform/AI.md). Agents, guardrails per company, the
 * ai_actions log and review queue, the knowledge base, and the agent test panel. The runner lives
 * in core/ai so feature modules and background jobs can call it; this module is its API.
 */
export default {
  name: 'ai',
  label: 'AI',
  permissions: [
    {
      key: 'ai.view',
      label: 'See AI activity',
      description: 'See the AI log, guardrails, usage and the knowledge base',
      supportsOwn: true,
    },
    {
      key: 'ai.review',
      label: 'Review AI outputs',
      description: 'Approve, edit or reject AI outputs waiting in the review queue',
      supportsOwn: true,
    },
    {
      key: 'ai.knowledge',
      label: 'Manage the knowledge base',
      description: 'Write, approve and archive the articles the reply assistant answers from',
    },
    {
      key: 'ai.manage',
      label: 'Test AI agents',
      description: 'Run agents in the test panel (uses the AI budget)',
    },
  ],
  roleGrants: {
    group_admin: ['ai.view', 'ai.review', 'ai.knowledge', 'ai.manage'],
    company_admin: ['ai.view', 'ai.review', 'ai.knowledge', 'ai.manage'],
    manager: ['ai.view', 'ai.review', 'ai.knowledge'],
    counsellor: ['ai.view:own', 'ai.review:own'],
    account_executive: ['ai.view:own', 'ai.review:own'],
    support: ['ai.view', 'ai.knowledge'],
    analyst: ['ai.view'],
  },
  settings: AI_SETTINGS,
  // Keep the AI log with the person when the contacts module merges or erases them (DPDP erasure
  // also covers what the AI read and wrote about them).
  eventHandlers: {
    'contact.merged': async (event) => {
      const { targetId, sourceId } = event.payload ?? {};
      if (targetId && sourceId) await db.transaction((trx) => moveContactAiActions(trx, { sourceId, targetId }));
    },
    'contact.erased': async (event) => {
      const { contactId } = event.payload ?? {};
      if (contactId) await db.transaction((trx) => eraseContactAiActions(trx, contactId));
    },
  },
  routes: (router) => aiRoutes(router),
};
