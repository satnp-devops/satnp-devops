import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { emitEvent } from '../../core/events.js';
import * as devDeals from './dev/deals.js';
import * as devPeople from './dev/people.js';

/**
 * What intake needs from modules that are built elsewhere. Each port has a development
 * implementation so the module works on its own; the integrator connects the real services with
 * connectIntakePorts({...}) at start-up (server.js and worker.js), e.g.
 *
 *   import { connectIntakePorts } from './modules/intake/ports.js';
 *   connectIntakePorts({
 *     classifier: aiService.classifyEnquiry,                 // AI slice: shared-channel routing
 *     deals: { createDeal, reopenDeal, touchDeal },          // deals slice (modules/deals/service.js)
 *     accounts: { findOrCreateAccount },                     // accounts slice
 *     contacts: { mergeContacts, recordConsent },            // contacts slice
 *     captcha: { verify },                                   // integration framework: getAdapter('captcha', ...)
 *     files: { put, get },                                   // integration framework: blob storage adapter
 *     jobs: { enqueueImport },                               // jobs framework: a keyed BullMQ job
 *   });
 *
 * Ports that write other modules' tables (deals, accounts, contacts) refuse to run their
 * development implementation in production: there they insert nothing until connected.
 */

const OWNED_ELSEWHERE = new Set(['deals', 'accounts', 'contacts']);

/** Development storage: the file body in intake_files. */
const devFiles = {
  async put(trx, { groupId, name, contentType, body, createdBy = null }) {
    const id = randomUUID();
    await trx('intake_files').insert({ id, group_id: groupId, name, content_type: contentType, size: Buffer.byteLength(body), body, created_by: createdBy });
    return `intake-file:${id}`;
  },
  async get(trx, ref) {
    const id = String(ref ?? '').replace(/^intake-file:/, '');
    if (!/^[0-9a-f-]{36}$/.test(id)) return null;
    const row = await trx('intake_files').where({ id }).first();
    return row ? { name: row.name, contentType: row.content_type, body: row.body } : null;
  },
};

/**
 * Development captcha: forms without a captcha pass; with one, the token "dev-pass" passes in
 * development and tests. Production fails closed until a provider adapter is connected.
 */
const devCaptcha = {
  async verify({ provider, token }) {
    if (!provider || provider === 'none') return { ok: true };
    if (env.isProd) return { ok: false, reason: 'captcha_not_connected' };
    return token === 'dev-pass' ? { ok: true } : { ok: false, reason: 'captcha_failed' };
  },
};

/**
 * Background imports through the outbox: the event reaches this module's own handler in the
 * worker (module.js eventHandlers['intake.import_queued']), which runs processImportJob. The jobs
 * framework can replace this with a dedicated, keyed queue.
 */
const devJobs = {
  async enqueueImport(trx, { job, actorUserId = null }) {
    await emitEvent(trx, {
      type: 'intake.import_queued',
      groupId: job.group_id,
      unitId: job.unit_id,
      aggregateType: 'intake_import',
      aggregateId: job.id,
      actorUserId,
      payload: { jobId: job.id, companyId: job.company_id },
    });
  },
};

/** Partner referral codes, until the partners module (phase 10) owns partners. */
const devPartners = {
  async resolveReferral(trx, { groupId, code }) {
    if (!code) return null;
    const link = await trx('intake_partner_links').where({ group_id: groupId, code, active: true }).first();
    if (!link) return null;
    return {
      linkId: link.id,
      partnerId: link.partner_id,
      partnerName: link.partner_name,
      companyId: link.company_id,
      ownerUserId: link.owner_user_id,
      productLineId: link.product_line_id,
    };
  },
};

const defaults = () => ({
  /** AI classifier for shared channels; null = the engine's deterministic fallback (review queue). */
  classifier: null,
  deals: { createDeal: devDeals.createDeal, reopenDeal: devDeals.reopenDeal, touchDeal: devDeals.touchDeal },
  accounts: { findOrCreateAccount: devPeople.findOrCreateAccount },
  contacts: { mergeContacts: devPeople.mergeContacts, recordConsent: devPeople.recordConsent },
  captcha: devCaptcha,
  files: devFiles,
  jobs: devJobs,
  partners: devPartners,
});

let ports = defaults();
const connected = new Set();

/** Connect real implementations (merged over the current ones). */
export function connectIntakePorts(overrides = {}) {
  for (const [name, value] of Object.entries(overrides)) {
    if (!(name in ports)) throw new Error(`Unknown intake port "${name}"`);
    ports[name] = name === 'classifier' || typeof value === 'function' ? value : { ...ports[name], ...value };
    connected.add(name);
  }
}

/** Back to the development implementations (tests). */
export function resetIntakePorts() {
  ports = defaults();
  connected.clear();
}

/** A port by name. Ports owned by other slices throw in production until connected. */
export function port(name) {
  if (env.isProd && OWNED_ELSEWHERE.has(name) && !connected.has(name)) {
    throw new Error(`The intake "${name}" port is not connected: call connectIntakePorts({ ${name}: ... }) at start-up`);
  }
  return ports[name];
}

/** Which ports run their development implementation (GET /intake/status). */
export function portStatus() {
  return Object.fromEntries(Object.keys(ports).map((name) => [name, connected.has(name) ? 'connected' : name === 'classifier' ? 'fallback' : 'development']));
}
