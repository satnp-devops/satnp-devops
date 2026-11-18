/**
 * The automation registry: what flows can react to (triggers), do (actions) and
 * ask AI agents for (agents). Modules declare these next to their permissions:
 *
 *   // src/modules/payments/module.js
 *   export default {
 *     name: 'payments',
 *     automation: {
 *       actions: [{ key: 'payments.send_link', label: 'Send payment link', sideEffect: true,
 *                   params: z.strictObject({ amountMinor: z.int().min(1), currency: z.string().length(3) }) }],
 *       triggers: [{ key: 'payments.mandate_failed', label: 'Mandate failed', events: ['mandate.failed'] }],
 *     },
 *   };
 *
 * The engine never performs actions. The executor (wave 2) maps each action key to a
 * handler and runs effects with their idempotency key.
 *
 * Definitions:
 *   action  { key, label, description?, params: zod, sideEffect: boolean, internal?, output?: zod, sampleOutput?, module?,
 *             staticParams?: string[] }  params that must be written out (text with {{ }} allowed), never a whole { $expr };
 *             schema issues raised with params.static = true are reported at save time even for {{ }} text
 *   trigger { key, label, description?, events: string[], subject?: string | null, config?: zod,
 *             match?: (config, event) => boolean, sample?: { type, subject, payload } }
 *   agent   { key, label, description?, input: zod, output: zod, requiresApproval: boolean, sampleOutput? }
 */
import { z } from 'zod';
import { CORE_ACTIONS, CORE_AGENTS, CORE_TRIGGERS } from './catalog.js';
import { FUNCTION_DOCS } from './expr.js';

const ACTION_KEY = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const TRIGGER_KEY = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;
const AGENT_KEY = /^[a-z][a-z0-9_]{1,47}$/;
const EVENT_TYPE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;

const isSchema = (value) => value !== null && typeof value === 'object' && typeof value.safeParse === 'function';

function requireLabel(kind, def) {
  if (typeof def.label !== 'string' || def.label.trim() === '') throw new Error(`Automation ${kind} "${def.key}" needs a label`);
}

/** @param {any} def */
function checkAction(def) {
  if (!ACTION_KEY.test(def?.key ?? '')) throw new Error(`Automation action key "${def?.key}" must look like module.action`);
  requireLabel('action', def);
  if (!isSchema(def.params)) throw new Error(`Automation action "${def.key}" needs a zod params schema`);
  if (typeof def.sideEffect !== 'boolean') throw new Error(`Automation action "${def.key}" must say whether it has side effects (sideEffect)`);
  if (def.output !== undefined && !isSchema(def.output)) throw new Error(`Automation action "${def.key}" output must be a zod schema`);
  if (def.staticParams !== undefined && !(Array.isArray(def.staticParams) && def.staticParams.every((p) => typeof p === 'string'))) {
    throw new Error(`Automation action "${def.key}" staticParams must list param names`);
  }
  return Object.freeze({ internal: false, ...def });
}

/** @param {any} def */
function checkTrigger(def) {
  if (!TRIGGER_KEY.test(def?.key ?? '')) throw new Error(`Automation trigger key "${def?.key}" is not valid`);
  requireLabel('trigger', def);
  if (!Array.isArray(def.events) || def.events.length === 0 || !def.events.every((e) => EVENT_TYPE.test(e))) {
    throw new Error(`Automation trigger "${def.key}" needs the domain event types it listens to (events)`);
  }
  if (def.config !== undefined && !isSchema(def.config)) throw new Error(`Automation trigger "${def.key}" config must be a zod schema`);
  if (def.match !== undefined && typeof def.match !== 'function') throw new Error(`Automation trigger "${def.key}" match must be a function`);
  return Object.freeze({ subject: null, config: z.strictObject({}), match: () => true, ...def });
}

/** @param {any} def */
function checkAgent(def) {
  if (!AGENT_KEY.test(def?.key ?? '')) throw new Error(`Automation agent key "${def?.key}" is not valid`);
  requireLabel('agent', def);
  if (!isSchema(def.input) || !isSchema(def.output)) throw new Error(`Automation agent "${def.key}" needs zod input and output schemas`);
  if (typeof def.requiresApproval !== 'boolean') throw new Error(`Automation agent "${def.key}" must say whether it requires approval`);
  return Object.freeze({ ...def });
}

/**
 * @typedef {ReturnType<typeof createAutomationRegistry>} AutomationRegistry
 */

/**
 * Builds a registry. Core declarations come first unless `includeCore` is false;
 * duplicates throw, so modules can't silently replace each other's actions.
 * @param {{ actions?: any[], triggers?: any[], agents?: any[] }} [definitions]
 * @param {{ includeCore?: boolean }} [options]
 */
export function createAutomationRegistry(definitions = {}, { includeCore = true } = {}) {
  const actions = new Map();
  const triggers = new Map();
  const agents = new Map();
  const add = (map, kind, def, check) => {
    const checked = check(def);
    if (map.has(checked.key)) throw new Error(`Duplicate automation ${kind} "${checked.key}"`);
    map.set(checked.key, checked);
  };
  for (const def of [...(includeCore ? CORE_ACTIONS : []), ...(definitions.actions ?? [])]) add(actions, 'action', def, checkAction);
  for (const def of [...(includeCore ? CORE_TRIGGERS : []), ...(definitions.triggers ?? [])]) add(triggers, 'trigger', def, checkTrigger);
  for (const def of [...(includeCore ? CORE_AGENTS : []), ...(definitions.agents ?? [])]) add(agents, 'agent', def, checkAgent);

  const byEvent = new Map();
  for (const trigger of triggers.values()) {
    for (const type of trigger.events) byEvent.set(type, [...(byEvent.get(type) ?? []), trigger]);
  }

  return Object.freeze({
    actions,
    triggers,
    agents,
    /** @param {string} key */
    action: (key) => actions.get(key) ?? null,
    /** @param {string} key */
    trigger: (key) => triggers.get(key) ?? null,
    /** @param {string} key */
    agent: (key) => agents.get(key) ?? null,
    /** Triggers that listen to a domain event type, for the event router. @param {string} type */
    triggersForEvent: (type) => byEvent.get(type) ?? [],
    /** Every domain event type some trigger listens to. */
    eventTypes: () => [...byEvent.keys()],
    catalog: () => catalogOf({ actions, triggers, agents }),
  });
}

/**
 * Collects `automation` declarations from platform modules (src/modules/<name>/module.js).
 * @param {{ name: string, automation?: { actions?: any[], triggers?: any[], agents?: any[] } }[]} modules
 * @param {{ includeCore?: boolean }} [options]
 */
export function automationRegistryFromModules(modules, options) {
  const definitions = { actions: [], triggers: [], agents: [] };
  for (const mod of modules) {
    for (const kind of /** @type {const} */ (['actions', 'triggers', 'agents'])) {
      for (const def of mod.automation?.[kind] ?? []) definitions[kind].push({ module: mod.name, ...def });
    }
  }
  return createAutomationRegistry(definitions, options);
}

function jsonSchema(schema) {
  try {
    return z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' });
  } catch {
    return null;
  }
}

/** JSON for the flow editor: labels, JSON Schemas for forms, samples and expression functions. */
function catalogOf({ actions, triggers, agents }) {
  return {
    triggers: [...triggers.values()].map((t) => ({
      key: t.key,
      label: t.label,
      description: t.description ?? null,
      events: t.events,
      subject: t.subject ?? null,
      configSchema: jsonSchema(t.config),
      sample: t.sample ?? null,
      module: t.module ?? 'automation',
    })),
    actions: [...actions.values()]
      .filter((a) => !a.internal)
      .map((a) => ({
        key: a.key,
        label: a.label,
        description: a.description ?? null,
        sideEffect: a.sideEffect,
        paramsSchema: jsonSchema(a.params),
        outputSchema: a.output ? jsonSchema(a.output) : null,
        module: a.module ?? 'automation',
      })),
    agents: [...agents.values()].map((a) => ({
      key: a.key,
      label: a.label,
      description: a.description ?? null,
      requiresApproval: a.requiresApproval,
      inputSchema: jsonSchema(a.input),
      outputSchema: jsonSchema(a.output),
      module: a.module ?? 'automation',
    })),
    functions: FUNCTION_DOCS,
  };
}
