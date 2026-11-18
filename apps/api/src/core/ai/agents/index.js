import { b2bQualifierAgent } from './b2bQualifier.js';
import { classifierAgent } from './classifier.js';
import { intakeAgent } from './intake.js';
import { meetingSummaryAgent } from './meetingSummary.js';
import { replyAgent } from './reply.js';
import { followUpAgent, paymentChaserAgent } from './writers.js';

// The agent registry. Adding an agent: write its definition (agents/common.js lists the fields),
// add it here, and it gets a setting to switch it on, a threshold setting, a place in the test
// panel and the review queue. No migration and no frontend change.

export const AGENT_LIST = Object.freeze([
  intakeAgent,
  classifierAgent,
  replyAgent,
  meetingSummaryAgent,
  followUpAgent,
  paymentChaserAgent,
  b2bQualifierAgent,
]);

export const AGENTS = Object.freeze(Object.fromEntries(AGENT_LIST.map((agent) => [agent.key, agent])));
export const AGENT_KEYS = AGENT_LIST.map((agent) => agent.key);

export const getAgent = (key) => AGENTS[key] ?? null;
