// The AI service's public API (docs/platform/AI.md). Feature code imports from here.
//
//   import { runAgent, extract, classify, generate, summarise, routingClassifier } from '../../core/ai/index.js';
//   const result = await runAgent({ companyId, agent: 'intake', input: { message }, subject: { dealId }, reference: messageId });
//   if (result.status === 'completed') use(result.finalOutput);
//   // pending_review: wait for the `ai.review_resolved` event, then read the action's final_output.

import { runAgent } from './runner.js';

export { runAgent, runTask, resolveSubject, resultFromRow, ACTION_STATUSES, TRIGGERS } from './runner.js';
export { extract, classify, generate, summarise } from './tasks.js';
export { AGENTS, AGENT_LIST, AGENT_KEYS, getAgent } from './agents/index.js';
export { AI_SETTINGS, DEFAULT_AI_SETTINGS, loadAiSettings } from './settings.js';
export { retrieveArticles } from './knowledge.js';
export { usageFor, periodOf } from './budget.js';
export { preChecks, postChecks, decide } from './guardrails.js';
export { HANDOVER_TOPICS } from './text.js';

/**
 * The `classify` function core/intake/routing.js route() takes, backed by the classifier agent:
 *   const result = await route({ channel, identities, enquiry, classify: routingClassifier({ billingCompanyId }), thresholds });
 * The call is logged (and budgeted) under `billingCompanyId`, default the first company the channel
 * routes to. route() compares the confidence with its own thresholds, so the agent's review queue
 * entry and intake's own review agree on what is low.
 */
export function routingClassifier({ billingCompanyId, trigger = 'feature', reference } = {}) {
  return async ({ enquiry, companyIds }) => {
    const companyId = billingCompanyId ?? companyIds?.[0];
    if (!companyId) throw new Error('routingClassifier needs a company to log the call under');
    const message = [enquiry?.interest?.message, enquiry?.interest?.course, enquiry?.interest?.product].filter(Boolean).join('\n') || enquiry?.contact?.name || '';
    const result = await runAgent({ companyId, agent: 'classifier', input: { message: message || '(no message)', companyIds }, trigger, reference });
    if (!result.output) throw new Error(result.error?.message ?? 'The classifier did not answer');
    return {
      companyId: result.output.companyId,
      productLineId: result.output.productLineId ?? undefined,
      confidence: result.output.confidence,
      rationale: result.output.rationale,
      alternatives: result.output.alternatives,
    };
  };
}
