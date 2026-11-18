import dns from 'node:dns/promises';
import { logger } from '../../lib/logger.js';

/**
 * Ports: the few things this module needs from modules being built elsewhere. Each has a
 * development implementation that works on its own; the integrator connects the real one with
 * connectPorts({ ... }) at start-up (API and worker). Nothing else in this module reaches into
 * another module.
 *
 * | Port                | Real implementation (owner)                                   | Development behaviour                           |
 * | ------------------- | ------------------------------------------------------------- | ----------------------------------------------- |
 * | dispatchEffects     | jobs framework: one BullMQ job per effect, jobId = effect id,  | performs the effects in-process, one by one,    |
 * |                     | attempts + backoff, calling performEffect(db, id)              | right after the transaction commits             |
 * | getConnectionSecret | integration framework: the signing secret of a company's       | null (webhooks go out unsigned)                 |
 * |                     | connection ({ companyId, connectionId }) → string | null      |                                                 |
 * | resolveHost         | (none; tests swap it) DNS lookup for webhook hosts             | dns.lookup(host, { all: true, verbatim: true }) |
 *
 * Action executors (send a template, create a task, move a stage, assign, update a field, run an
 * AI agent) are registered separately: see actions.js (registerActionExecutor) or a module's
 * `automation.executors` in module.js.
 */

/** @typedef {(effectIds: string[], deps: { performEffect: (id: string) => Promise<unknown> }) => Promise<void>} DispatchEffects */

const defaults = Object.freeze({
  /** @type {DispatchEffects} */
  async dispatchEffects(effectIds, { performEffect }) {
    for (const id of effectIds) {
      try {
        await performEffect(id);
      } catch (err) {
        logger.error({ err, effectId: id }, 'Automation effect failed');
      }
    }
  },
  /** @param {{ companyId: string, connectionId: string }} _input @returns {Promise<string | null>} */
  async getConnectionSecret(_input) {
    return null;
  },
  /** @param {string} host */
  resolveHost(host) {
    return dns.lookup(host, { all: true, verbatim: true });
  },
});

const current = { ...defaults };

/** The connected ports (read at call time, so connectPorts() can run after import). */
export const ports = new Proxy(current, {
  set() {
    throw new Error('Use connectPorts() to change an automation port');
  },
});

/**
 * Connect real implementations. Unknown names throw, so a typo can't silently keep a stub.
 * @param {Partial<typeof defaults>} overrides
 */
export function connectPorts(overrides) {
  for (const [name, fn] of Object.entries(overrides)) {
    if (!(name in defaults)) throw new Error(`Unknown automation port "${name}"`);
    if (typeof fn !== 'function') throw new Error(`Automation port "${name}" must be a function`);
    current[name] = fn;
  }
}

/** Back to the development implementations (tests). */
export function resetPorts() {
  Object.assign(current, defaults);
}
