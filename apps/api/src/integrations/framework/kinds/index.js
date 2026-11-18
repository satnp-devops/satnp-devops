import { WEBHOOK_METHODS, healthResult } from './common.js';
import { emailKind, sms, whatsapp } from './messaging.js';
import { calendar, calling, meetings } from './scheduling.js';
import { esign, payments } from './money.js';
import { ai, storage } from './platform.js';

/**
 * Adapter kinds, in the order the Integrations screen lists them. A kind is the interface;
 * providers (catalog.js) implement it. Adding a kind is a new file here plus its mock adapter.
 */
export const KIND_LIST = Object.freeze([whatsapp, emailKind, sms, calling, meetings, calendar, payments, esign, ai, storage]);

export const KINDS = Object.freeze(Object.fromEntries(KIND_LIST.map((kind) => [kind.key, kind])));

export const KIND_KEYS = Object.freeze(KIND_LIST.map((kind) => kind.key));

export function getKind(key) {
  return KINDS[key] ?? null;
}

/** Every method an adapter of this kind must have: the kind's own, healthCheck, and the webhook trio when the provider calls us. */
export function requiredMethods(kind) {
  return {
    healthCheck: { description: 'Check the credentials work without side effects.', input: null, output: healthResult },
    ...kind.methods,
    ...(kind.webhooks ? WEBHOOK_METHODS : {}),
  };
}

export { WEBHOOK_METHODS };
