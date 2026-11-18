/**
 * Automation engine: flow definitions, a safe expression language, validation,
 * a pure interpreter and a simulator. No I/O; see docs/platform/AUTOMATION_CORE.md.
 */
export { flowSchema, stepSchema, triggerSchema, expressionSchema, stepEdges, isPausingStep, FLOW_LIMITS, STEP_TYPES } from './schema.js';
export { parse, compile, evaluate, run as evaluateSource, test as testCondition, collectPaths, explainError, truthy, toPlain, ExprError, FUNCTION_DOCS } from './expr.js';
export { parseTemplate, renderTemplate, resolveParams, collectDynamic } from './template.js';
export { validateFlow, assertValidFlow, RUN_ROOTS, FILTER_ROOTS, VALIDATION_LIMITS } from './validate.js';
export {
  advance,
  startRun,
  cancelRun,
  matchTrigger,
  canStartRun,
  AutomationError,
  RUN_LIMITS,
  TERMINAL_STATUSES,
  EFFECT_RESULT,
  APPROVAL_DECIDED,
  AI_RUN,
  REQUEST_APPROVAL,
} from './interpreter.js';
export { simulate } from './simulate.js';
export { createAutomationRegistry, automationRegistryFromModules } from './registry.js';
export { CORE_ACTIONS, CORE_TRIGGERS, CORE_AGENTS, nextScheduleFire, noActivityCutoff, noActivityEventId } from './catalog.js';
export { checkWebhookUrl, checkWebhookUrlTemplate, checkResolvedAddresses, checkIp, isBlockedIp } from './url-safety.js';
export { parseDuration, formatDuration, parseInstant, nextTimeOfDay, zonedTimeToUtc, isValidTimeZone } from './time.js';
