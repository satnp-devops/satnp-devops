import { z } from 'zod';
import { db } from '../../lib/db.js';
import { getEffectiveSettings } from '../settings.js';
import { AGENT_LIST } from './agents/index.js';
import { HANDOVER_TOPICS, HANDOVER_TOPIC_KEYS } from './text.js';

// The AI guardrails each company sets (docs/platform/AI.md "Guardrails"). They are ordinary module
// settings, inherited group → company, so the group can set a default and a company override it.
// The AI module lists them in module.js; the runner reads them with loadAiSettings().

const LEVELS = ['group', 'company'];
const CATEGORY = 'AI agents and guardrails';

export const enabledAgentsSetting = {
  key: 'ai.enabledAgents',
  category: CATEGORY,
  label: 'AI agents switched on',
  description: 'Agents that may run for this company. A switched-off agent is skipped and nothing is sent to the AI model.',
  input: 'multiselect',
  options: AGENT_LIST.map((agent) => ({ value: agent.key, label: agent.label })),
  schema: z.array(z.enum(AGENT_LIST.map((a) => a.key))).max(AGENT_LIST.length),
  default: AGENT_LIST.map((agent) => agent.key),
  levels: LEVELS,
};

export const mayQuoteFeesSetting = {
  key: 'ai.mayQuoteFees',
  category: CATEGORY,
  label: 'AI may quote fees',
  description: 'Off: any amount of money in an AI answer sends it to the review queue. On: amounts are allowed when they come from the approved knowledge base or the record.',
  input: 'boolean',
  schema: z.boolean(),
  default: false,
  levels: LEVELS,
};

export const mayQuoteDiscountsSetting = {
  key: 'ai.mayQuoteDiscounts',
  category: CATEGORY,
  label: 'AI may mention discounts and scholarships',
  description: 'Off: answers that offer a discount, scholarship, waiver or coupon wait for a person.',
  input: 'boolean',
  schema: z.boolean(),
  default: false,
  levels: LEVELS,
};

export const handoverTopicsSetting = {
  key: 'ai.handoverTopics',
  category: CATEGORY,
  label: 'Always hand these to a person',
  description: 'When a message is about one of these, the AI does not answer: the conversation goes to the review queue.',
  input: 'multiselect',
  options: HANDOVER_TOPICS.map((topic) => ({ value: topic.key, label: topic.label })),
  schema: z.array(z.enum(HANDOVER_TOPIC_KEYS)).max(HANDOVER_TOPIC_KEYS.length),
  default: [...HANDOVER_TOPIC_KEYS],
  levels: LEVELS,
};

export const monthlyTokenBudgetSetting = {
  key: 'ai.monthlyTokenBudget',
  category: CATEGORY,
  label: 'Monthly AI budget (tokens)',
  description: 'Input plus output tokens per calendar month (UTC). When it is used up, AI calls fail with "budget exceeded" until next month. 0 switches AI off.',
  input: 'number',
  schema: z.coerce.number().int().min(0).max(1_000_000_000),
  default: 2_000_000,
  levels: LEVELS,
};

/** One confidence threshold per agent: answers below it wait for a person. */
export const thresholdSettings = AGENT_LIST.map((agent) => ({
  key: `ai.threshold.${agent.key}`,
  category: CATEGORY,
  label: `Confidence needed: ${agent.label}`,
  description: `Between 0 and 1. ${agent.label} answers below this go to the review queue.${agent.alwaysReview ? ' This agent always waits for a person anyway.' : ''}`,
  input: 'number',
  schema: z.coerce.number().min(0).max(1),
  default: agent.defaultThreshold,
  levels: LEVELS,
}));

export const AI_SETTINGS = [enabledAgentsSetting, mayQuoteFeesSetting, mayQuoteDiscountsSetting, handoverTopicsSetting, monthlyTokenBudgetSetting, ...thresholdSettings];

/**
 * The effective guardrails for a company (pure, from resolved settings).
 * @returns {AiSettings}
 * @typedef {{ enabledAgents: string[], mayQuoteFees: boolean, mayQuoteDiscounts: boolean, handoverTopics: string[], monthlyTokenBudget: number, thresholds: Record<string, number>, sources: Record<string, string | null> }} AiSettings
 */
export function aiSettingsFrom(resolved) {
  const value = (key) => resolved[key]?.value;
  return {
    enabledAgents: value(enabledAgentsSetting.key),
    mayQuoteFees: value(mayQuoteFeesSetting.key),
    mayQuoteDiscounts: value(mayQuoteDiscountsSetting.key),
    handoverTopics: value(handoverTopicsSetting.key),
    monthlyTokenBudget: value(monthlyTokenBudgetSetting.key),
    thresholds: Object.fromEntries(AGENT_LIST.map((agent) => [agent.key, value(`ai.threshold.${agent.key}`)])),
    sources: Object.fromEntries(AI_SETTINGS.map((d) => [d.key, resolved[d.key]?.sourceUnitId ?? null])),
  };
}

/** The defaults, as if nothing were set (tests, documentation). */
export const DEFAULT_AI_SETTINGS = Object.freeze(
  aiSettingsFrom(Object.fromEntries(AI_SETTINGS.map((d) => [d.key, { value: d.default, sourceUnitId: null }]))),
);

/** Effective AI settings for a company unit (one query). */
export async function loadAiSettings(company, trx = db) {
  return aiSettingsFrom(await getEffectiveSettings(company, AI_SETTINGS, trx));
}
