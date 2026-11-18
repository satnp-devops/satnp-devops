import { env } from '../../config/env.js';
import { AI_RUN, REQUEST_APPROVAL } from '../../core/automation/index.js';
import { ActionError } from './errors.js';
import { ports } from './ports.js';
import { getAutomationRegistry, moduleExecutors } from './registry.js';
import { callWebhook } from './webhook.js';

/**
 * The action registry's execution side. The engine's registry (registry.js) says what an action
 * is (key, params schema, output); this file says who performs it.
 *
 * An executor is `async (effect, ctx) => output`:
 *   effect  { id, idempotencyKey, action, params (resolved, validated, defaults applied), awaited,
 *             runId, stepId, flowId, companyId, unitId, subject: { type, id } | null }
 *   ctx     { db, log, record }   record: the run's subject as the runner loads it (no personal data)
 * Return the output (awaited steps read it as steps.<id>.output; it is checked against the action's
 * output schema by the engine for AI agents). Throw ActionError(code, message, { retryable }) to fail.
 * Executors must be idempotent on effect.idempotencyKey (the runner never hands out a key twice, but
 * a job retry can).
 *
 * Executors come from, in order: registerActionExecutor() (integrator), a module's
 * `automation.executors` (module.js), then the built-ins below. Anything else runs on the
 * development executor, which records the effect (status `recorded`) with the action's sample
 * output so flows can be tried end to end. In production an unbound action fails with NO_EXECUTOR.
 */

/** Permissions a person needs at the flow's company to put an action in a flow (no escalation through flows). */
export const ACTION_PERMISSIONS = Object.freeze({
  'messaging.send_template': ['deals.manage'],
  'tasks.create': ['tasks.manage'],
  'deals.change_stage': ['deals.manage'],
  'records.assign': ['deals.assign'],
  'records.update_field': ['deals.manage'],
  'http.call_webhook': ['automations.webhooks'],
});

/** Actions other modules perform; their executors are connected at integration. */
export const INTEGRATION_ACTIONS = Object.freeze([
  { key: 'messaging.send_template', owner: 'messaging', does: 'Send an approved WhatsApp, email or SMS template to the contact, guardian or owner (consent, opt-outs, quiet hours); output { messageId }' },
  { key: 'tasks.create', owner: 'tasks', does: 'Create a task on the subject deal for its owner or a person; output { taskId }' },
  { key: 'deals.change_stage', owner: 'deals', does: "Move the subject deal to a stage (by key) with the stage rules; output { stageId }" },
  { key: 'records.assign', owner: 'deals', does: 'Assign the subject deal to a person, or round robin / least loaded in a team; output { userId }' },
  { key: 'records.update_field', owner: 'deals', does: 'Set a field or custom.<key> on the subject deal (validated like the API); output {}' },
  { key: AI_RUN, owner: 'AI platform', does: "Run an agent ({ agent, input }) and return output matching the agent's schema" },
]);

const registered = new Map();
let fromModules = null;

/**
 * Connect the executor of an action (integrator). Throws on a second registration for the same key.
 * @param {string} key action key, or 'ai.run'
 * @param {(effect: any, ctx: any) => Promise<unknown>} execute
 * @param {{ module?: string, replace?: boolean }} [options]
 */
export function registerActionExecutor(key, execute, { module = 'integration', replace = false } = {}) {
  if (typeof execute !== 'function') throw new Error(`The executor for "${key}" must be a function`);
  if (registered.has(key) && !replace) throw new Error(`An executor for "${key}" is already registered`);
  registered.set(key, { module, execute });
}

/** Tests: forget registered executors. */
export function clearActionExecutors() {
  registered.clear();
  fromModules = null;
}

async function webhookExecutor(effect) {
  const { connectionId } = effect.params;
  const secret = connectionId ? await ports.getConnectionSecret({ companyId: effect.companyId, connectionId }) : null;
  if (connectionId && !secret && env.isProd) throw new ActionError('CONNECTION_NOT_FOUND', 'The connection that signs this webhook was not found');
  const result = await callWebhook(effect.params, { resolveHost: ports.resolveHost, secret, idempotencyKey: effect.idempotencyKey });
  return { status: result.status, body: result.body };
}

const BUILT_IN = new Map([
  ['http.call_webhook', { module: 'automations', execute: webhookExecutor }],
  // Approval requests are handled by the runner in the same transaction (approvals.js).
  [REQUEST_APPROVAL, { module: 'automations', internal: true }],
]);

/** @returns {{ module: string, execute?: Function, internal?: boolean } | null} */
export function executorFor(key) {
  if (registered.has(key)) return registered.get(key);
  fromModules ??= moduleExecutors();
  return fromModules.get(key) ?? BUILT_IN.get(key) ?? null;
}

/** The development executor: what the action would have returned (its sample output). */
export function developmentOutput(effect) {
  if (env.isProd) throw new ActionError('NO_EXECUTOR', `Nothing performs "${effect.action}" in this installation yet`);
  const registry = getAutomationRegistry();
  const sample = effect.action === AI_RUN ? registry.agent(effect.params?.agent)?.sampleOutput : registry.action(effect.action)?.sampleOutput;
  return structuredClone(sample ?? {});
}

/** Where each action runs, for the catalog endpoint and the editor ("Recorded in development"). */
export function executorSummary() {
  const registry = getAutomationRegistry();
  const keys = [...registry.actions.keys(), AI_RUN];
  return Object.fromEntries(
    keys.map((key) => {
      const binding = executorFor(key);
      return [key, binding ? binding.module : env.isProd ? 'none' : 'development'];
    }),
  );
}

/**
 * Permissions an author needs for a flow definition: those of each action step (ACTION_PERMISSIONS,
 * or `requires` on a module-declared action). Unknown permissions (modules not installed) are skipped.
 * @param {any} definition
 * @param {{ permissions: Map<string, unknown> }} coreRegistry
 */
export function requiredPermissions(definition, coreRegistry) {
  const automation = getAutomationRegistry();
  const out = new Map();
  for (const step of definition?.steps ?? []) {
    if (step.type !== 'action') continue;
    const perms = ACTION_PERMISSIONS[step.action] ?? automation.action(step.action)?.requires ?? [];
    for (const permission of perms) {
      if (!coreRegistry.permissions.has(permission)) continue;
      out.set(permission, [...(out.get(permission) ?? []), step.id]);
    }
  }
  return out;
}
