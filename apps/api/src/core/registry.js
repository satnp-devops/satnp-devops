import { assertChannelDefinition } from './crm/channels.js';
import { addWebhookHandlers, addWebhookSources } from './webhooks/handlers.js';
import { normaliseJobDefinition } from './jobs/definitions.js';

/**
 * The module registry is how the platform stays extendable.
 *
 * Every feature lives in a module (src/modules/<name>/module.js) that can contribute:
 *   permissions   [{ key, label, description, supportsOwn }]
 *   roleGrants    { roleKey: [permission keys] }  default grants for system roles
 *   settings      [setting definitions]           inherited down the org tree
 *   unitTypes     [org unit type definitions]     new levels in the hierarchy
 *   channels      [{ key, label, group, firstReplySla }]  enquiry channels for leads (core/crm/channels.js)
 *   eventHandlers { 'event.type' | '*': handler | handler[] }
 *   webhookHandlers { '<kind|provider|source>:<event type|*>': handler | handler[] }   provider webhooks (core/webhooks)
 *   webhookSources { key: { kind, events, verifyWebhook, parseWebhook, webhookChallenge? } }  non-adapter webhook senders
 *   jobs          { 'module.action': handler | { handler, attempts?, backoffMs?, repeat?, label?, data? } }  background jobs (core/jobs)
 *   routes(router, ctx)                           HTTP endpoints under /api/v1
 *
 * Adding a feature = adding a module to src/modules/index.js. Core code never changes.
 */
export function createRegistry(modules) {
  const registry = {
    modules: [],
    permissions: new Map(),
    roleGrants: new Map(),
    settings: new Map(),
    unitTypes: new Map(),
    channels: new Map(),
    eventHandlers: new Map(),
    webhookHandlers: new Map(),
    webhookSources: new Map(),
    jobs: new Map(),
  };

  // Webhook sources first, so a handler in any module can name a source declared by a later one.
  for (const mod of modules) addWebhookSources(registry.webhookSources, mod);

  for (const mod of modules) {
    if (!mod?.name) throw new Error('Every module needs a name');
    registry.modules.push({ name: mod.name, label: mod.label ?? mod.name });

    for (const permission of mod.permissions ?? []) {
      if (registry.permissions.has(permission.key)) throw new Error(`Duplicate permission "${permission.key}"`);
      if (!/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(permission.key)) {
        throw new Error(`Permission "${permission.key}" must look like module.action`);
      }
      registry.permissions.set(permission.key, { supportsOwn: false, ...permission, module: mod.name });
    }

    for (const [roleKey, keys] of Object.entries(mod.roleGrants ?? {})) {
      const set = registry.roleGrants.get(roleKey) ?? new Set();
      for (const key of keys) set.add(key);
      registry.roleGrants.set(roleKey, set);
    }

    for (const setting of mod.settings ?? []) {
      if (registry.settings.has(setting.key)) throw new Error(`Duplicate setting "${setting.key}"`);
      registry.settings.set(setting.key, { ...setting, module: mod.name });
    }

    for (const unitType of mod.unitTypes ?? []) {
      if (registry.unitTypes.has(unitType.key)) throw new Error(`Duplicate unit type "${unitType.key}"`);
      registry.unitTypes.set(unitType.key, unitType);
    }

    for (const channel of mod.channels ?? []) {
      assertChannelDefinition(channel);
      if (registry.channels.has(channel.key)) throw new Error(`Duplicate channel "${channel.key}"`);
      registry.channels.set(channel.key, { ...channel, module: mod.name });
    }

    for (const [eventType, handlers] of Object.entries(mod.eventHandlers ?? {})) {
      const list = registry.eventHandlers.get(eventType) ?? [];
      for (const handler of [handlers].flat()) list.push(Object.assign(handler, { module: mod.name }));
      registry.eventHandlers.set(eventType, list);
    }

    addWebhookHandlers(registry.webhookHandlers, mod, registry.webhookSources);

    for (const [name, definition] of Object.entries(mod.jobs ?? {})) {
      if (registry.jobs.has(name)) throw new Error(`Duplicate job "${name}"`);
      registry.jobs.set(name, normaliseJobDefinition(name, definition, mod.name));
    }
  }

  for (const [roleKey, keys] of registry.roleGrants) {
    for (const key of keys) {
      if (!isKnownPermission(registry, key)) throw new Error(`Role "${roleKey}" is granted unknown permission "${key}"`);
    }
  }

  return registry;
}

/** Accepts exact keys, module wildcards (users.*) and own-scoped keys (leads.view:own). */
export function isKnownPermission(registry, key) {
  if (key === '*') return true;
  const [base, scope] = key.split(':');
  if (scope !== undefined && scope !== 'own') return false;
  const [module, action] = base.split('.');
  if (action === '*') return [...registry.permissions.values()].some((p) => p.module === module);
  const definition = registry.permissions.get(base);
  if (!definition) return false;
  return scope === undefined || definition.supportsOwn === true;
}

/** Permissions grouped by module, for role editors. */
export function permissionCatalog(registry) {
  return registry.modules
    .map((mod) => ({
      module: mod.name,
      label: mod.label,
      permissions: [...registry.permissions.values()]
        .filter((p) => p.module === mod.name)
        .map(({ key, label, description, supportsOwn }) => ({ key, label, description: description ?? null, supportsOwn })),
    }))
    .filter((group) => group.permissions.length > 0);
}
