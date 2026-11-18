import { KIND_LIST } from '../../integrations/framework/kinds/index.js';
import { PROVIDER_LIST } from '../../integrations/framework/catalog.js';

/**
 * Webhook handlers, as modules declare them in module.js, keyed by "<source>:<event type>":
 *
 *   webhookHandlers: {
 *     'payments:payment.captured': async (event, deps) => { ... },        // any payments provider
 *     'messaging.whatsapp:message.received': [handlerA, handlerB],
 *     'razorpay:refund.processed': async (event, deps) => { ... },       // one provider only
 *     'meetings:*': async (event, deps) => { ... },                     // every meetings event
 *   }
 *
 * The source is an adapter kind or a provider key (or * for any); the event type is one of that
 * kind's webhook events (integrations/framework/kinds) or *. The registry rejects anything else at
 * start-up, so a misspelt topic can't silently never fire.
 *
 * A module can also declare its own webhook source, for a sender that isn't a provider adapter but
 * posts signed events about one of a connection's kinds (the separate WhatsApp tool):
 *
 *   webhookSources: {
 *     whatsapp_tool: { kind: 'messaging.whatsapp', events: ['message.in', ...],
 *                      verifyWebhook(request, { connection }), parseWebhook(request, { connection }),
 *                      webhookChallenge?(request) },
 *   }
 *
 * Its URL is POST /api/v1/webhooks/<source key>/:connectionId for any active connection of that
 * kind; events are stored with provider = the source key, and only "<source key>:<event>" handlers run.
 */

/** Event types per kind that receives webhooks. */
export const KIND_EVENTS = new Map(KIND_LIST.filter((kind) => kind.webhooks).map((kind) => [kind.key, new Set(Object.keys(kind.webhooks.events))]));

/** Event types per provider key (a provider may serve several kinds: mock serves them all). */
export const PROVIDER_EVENTS = (() => {
  const map = new Map();
  for (const provider of PROVIDER_LIST) {
    const events = KIND_EVENTS.get(provider.kind);
    if (!events) continue;
    const set = map.get(provider.key) ?? new Set();
    for (const type of events) set.add(type);
    map.set(provider.key, set);
  }
  return map;
})();

const ALL_EVENTS = new Set([...KIND_EVENTS.values()].flatMap((set) => [...set]));

const SOURCE_KEY = /^[a-z][a-z0-9_]{1,39}$/;

/** Add a module's webhookSources to the registry map (checked first, so any module's handlers can use them). */
export function addWebhookSources(map, mod) {
  for (const [key, source] of Object.entries(mod?.webhookSources ?? {})) {
    if (!SOURCE_KEY.test(key)) throw new Error(`Webhook source "${key}" in module "${mod.name}" must be lower case letters, digits and _`);
    if (PROVIDER_EVENTS.has(key) || KIND_EVENTS.has(key) || map.has(key)) throw new Error(`Duplicate webhook source "${key}"`);
    if (!KIND_EVENTS.has(source?.kind)) throw new Error(`Webhook source "${key}": "${source?.kind}" is not a kind that receives webhooks`);
    if (typeof source.verifyWebhook !== 'function' || typeof source.parseWebhook !== 'function') {
      throw new Error(`Webhook source "${key}" needs verifyWebhook(request, ctx) and parseWebhook(request, ctx)`);
    }
    const events = new Set(source.events ?? []);
    if (events.size === 0) throw new Error(`Webhook source "${key}" lists no events`);
    map.set(key, Object.freeze({ ...source, key, events, module: mod.name }));
  }
}

/** Split and check a handler key. Returns { source, topic } or throws a sentence explaining why. */
export function parseHandlerKey(key, sources = new Map()) {
  const parts = typeof key === 'string' ? key.split(':') : [];
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Webhook handler key "${key}" must look like "<kind or provider>:<event type>", e.g. "payments:payment.captured"`);
  }
  const [source, topic] = parts;
  const events = source === '*' ? ALL_EVENTS : (KIND_EVENTS.get(source) ?? PROVIDER_EVENTS.get(source) ?? sources.get(source)?.events);
  if (!events) {
    throw new Error(`Webhook handler key "${key}": "${source}" is not a kind or provider that receives webhooks`);
  }
  if (topic !== '*' && !events.has(topic)) {
    throw new Error(`Webhook handler key "${key}": "${source}" has no "${topic}" event`);
  }
  return { source, topic };
}

/**
 * Add a module's webhookHandlers to the registry map. Each handler gets a stable id
 * ("<module>/<key>/<index>"): an event records the ids that finished, so a retry skips them.
 */
export function addWebhookHandlers(map, mod, sources) {
  for (const [key, value] of Object.entries(mod.webhookHandlers ?? {})) {
    parseHandlerKey(key, sources);
    const handlers = [value].flat();
    if (handlers.length === 0) throw new Error(`Webhook handler key "${key}" in module "${mod.name}" has no handlers`);
    const list = map.get(key) ?? [];
    handlers.forEach((handle, index) => {
      if (typeof handle !== 'function') throw new Error(`Webhook handler "${key}" in module "${mod.name}" must be a function (event, deps) => {}`);
      list.push(Object.freeze({ id: `${mod.name}/${key}/${index}`, module: mod.name, key, handle }));
    });
    map.set(key, list);
  }
}

/**
 * The handlers for an event, most specific first: kind, then provider, then catch-alls. No duplicates.
 * Events of a module's own webhook source (provider = source key) go only to that source's handlers.
 */
export function handlersFor(registry, { kind, provider, type }) {
  const keys = registry.webhookSources?.has(provider)
    ? [`${provider}:${type}`, `${provider}:*`]
    : [`${kind}:${type}`, `${kind}:*`, `${provider}:${type}`, `${provider}:*`, `*:${type}`, '*:*'];
  const seen = new Set();
  const out = [];
  for (const key of keys) {
    for (const handler of registry.webhookHandlers?.get(key) ?? []) {
      if (seen.has(handler.id)) continue;
      seen.add(handler.id);
      out.push(handler);
    }
  }
  return out;
}
