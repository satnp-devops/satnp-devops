import { automationRegistryFromModules } from '../../core/automation/index.js';
import { modules } from '../index.js';

/**
 * The automation registry (triggers, actions, agents) built from every installed module's
 * `automation` declarations, after the engine's built-ins (core/automation/catalog.js):
 *
 *   automation: {
 *     triggers:  [{ key, label, events, subject, config?, match?, sample? }],
 *     actions:   [{ key, label, params, sideEffect, output?, sampleOutput?, requires?: ['perm'] }],
 *     agents:    [{ key, label, input, output, requiresApproval, sampleOutput? }],
 *     executors: { 'action.key': async (effect, ctx) => output },   // performs an action (actions.js)
 *   }
 *
 * Built lazily on first use: modules/index.js imports this module, so reading `modules` while the
 * module graph is still loading would see an unfinished list. The integrator may instead build it
 * once at start-up next to createRegistry(modules) and pass it in with setAutomationRegistry().
 */
let cached = null;

export function getAutomationRegistry() {
  if (!cached) cached = automationRegistryFromModules(modules);
  return cached;
}

/** Replace the registry (tests, or an integrator-built one). Pass null to rebuild from modules. */
export function setAutomationRegistry(registry) {
  cached = registry;
}

/** Executors declared by modules: `automation.executors` maps action keys to functions. */
export function moduleExecutors() {
  const out = new Map();
  for (const mod of modules) {
    for (const [key, execute] of Object.entries(mod.automation?.executors ?? {})) {
      if (typeof execute !== 'function') throw new Error(`Automation executor for "${key}" in module ${mod.name} must be a function`);
      if (out.has(key)) throw new Error(`Two modules perform the automation action "${key}"`);
      out.set(key, { module: mod.name, execute });
    }
  }
  return out;
}
