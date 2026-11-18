/**
 * Intake routing: which company (and product line) an enquiry belongs to.
 *
 * Rules (from the phase 4 brief):
 * 1. An enquiry goes to the company that owns the channel it arrived on (a company's own
 *    WhatsApp number, inbox, form or landing page).
 * 2. On a shared channel (the group's main number, a group-wide fair, an unbranded form) an AI
 *    classifier picks the company and product line. Below the company's confidence threshold,
 *    or when two companies are too close to call, the enquiry goes to the review queue.
 * 3. Anything we can't place (unknown channel, no classifier, classifier error or an answer
 *    outside the channel's companies) goes to review too. Review never loses an enquiry.
 *
 * The classifier is injected (`classify`), so this module stays free of I/O. route() is async
 * only because classifiers are; decideRoute() is the synchronous core for a known classification.
 */

import { z } from 'zod';
import { PHONE_CHANNELS, WEB_CHANNELS } from './enquiry.js';
import { resolveNormalizers } from './normalize.js';

/**
 * @typedef {object} ChannelIdentity  A registered channel: who owns this number / inbox / form.
 * @property {string} [id]
 * @property {string} type  one of CHANNEL_TYPES
 * @property {string} identity  number, inbox, form id, URL or host
 * @property {string} [companyId]  the owning company (owned channels)
 * @property {string} [productLineId]  fixes the product line too (e.g. a JEE-only landing page)
 * @property {boolean} [shared]  shared between companies: the classifier decides
 * @property {string[]} [companyIds]  for shared channels, the companies it may route to
 */

/**
 * @typedef {object} Classification
 * @property {string} companyId
 * @property {string} [productLineId]
 * @property {number} confidence  0..1
 * @property {string} [rationale]
 * @property {{ companyId: string, productLineId?: string, confidence: number }[]} [alternatives]
 */

/**
 * @typedef {object} RouteResult
 * @property {'route' | 'review'} decision
 * @property {string | null} companyId  the company, or the best guess when sent to review
 * @property {string} [productLineId]
 * @property {number} confidence
 * @property {string} reason  machine code, see REASONS
 * @property {string} message  a sentence for the review queue and the timeline
 * @property {boolean} shared  arrived on a shared channel
 * @property {string} [identityId]
 * @property {number} [threshold]  the threshold the classification was held to
 * @property {Classification} [classification]
 * @property {string[]} warnings
 */

export const REASONS = Object.freeze({
  owned_channel: 'The channel belongs to this company',
  classified: 'Shared channel; the classifier placed it with enough confidence',
  low_confidence: 'Shared channel; the classifier was not confident enough',
  ambiguous: 'Shared channel; two companies scored too close to call',
  unknown_channel: 'No company has registered this channel',
  no_classifier: 'Shared channel and no classifier is configured',
  classifier_error: 'Shared channel; the classifier failed',
  classifier_invalid: 'Shared channel; the classifier returned an unusable answer',
  out_of_scope: 'Shared channel; the classifier picked a company this channel does not serve',
  misconfigured_identity: 'The channel is registered without a company',
});

/** Default confidence a classification must reach. */
export const DEFAULT_THRESHOLD = 0.75;
/** Default gap required between the top company and the next one. */
export const DEFAULT_MIN_MARGIN = 0.1;

const classificationSchema = z.object({
  companyId: z.string().min(1),
  productLineId: z.string().min(1).optional().nullable(),
  confidence: z.number().min(0).max(1),
  rationale: z.string().max(2000).optional(),
  alternatives: z
    .array(z.object({ companyId: z.string().min(1), productLineId: z.string().optional().nullable(), confidence: z.number().min(0).max(1) }))
    .max(20)
    .optional(),
});

/**
 * Normalise a channel identity for comparison: phones to E.164, inboxes to lower case,
 * URLs to host + path without "www.", a trailing slash, query or fragment; anything else trimmed
 * and lower-cased.
 * @param {string} type
 * @param {unknown} identity
 * @param {Partial<import('./normalize.js').Normalizers>} [normalizers]
 */
export function normalizeIdentity(type, identity, normalizers) {
  if (identity === null || identity === undefined) return '';
  const raw = String(identity).trim();
  if (!raw) return '';
  const norm = resolveNormalizers(normalizers);
  if (PHONE_CHANNELS.has(type)) return norm.phone(raw) ?? raw.toLowerCase();
  if (type === 'email') return norm.email(raw) ?? raw.toLowerCase();
  if (WEB_CHANNELS.has(type) && looksLikeUrl(raw)) return urlKey(raw);
  return raw.toLowerCase();
}

const looksLikeUrl = (value) => /^https?:\/\//i.test(value) || /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/|$)/i.test(value);

function urlKey(value) {
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const path = url.pathname.replace(/\/+$/, '');
    return `${host}${path}`;
  } catch {
    return value.toLowerCase();
  }
}

/** Does a registered web identity (host, or host + path prefix) cover an incoming URL key? */
function webCovers(registered, incoming) {
  if (registered === incoming) return true;
  const [regHost, ...regPath] = registered.split('/');
  const [inHost, ...inPath] = incoming.split('/');
  const hostMatches = inHost === regHost || inHost.endsWith(`.${regHost}`);
  if (!hostMatches) return false;
  if (regPath.length === 0) return true;
  return regPath.every((segment, i) => inPath[i] === segment);
}

/**
 * Find the registered identities for a channel. Exact matches win; for web channels a host or
 * path prefix covers deeper pages, and the most specific registration wins.
 * @param {{ type: string, identity?: string }} channel
 * @param {ChannelIdentity[]} identities
 * @param {Partial<import('./normalize.js').Normalizers>} [normalizers]
 * @returns {ChannelIdentity[]}
 */
export function matchIdentities(channel, identities, normalizers) {
  const key = normalizeIdentity(channel.type, channel.identity, normalizers);
  if (!key) return [];
  const sameType = identities.filter((entry) => entry.type === channel.type);
  const exact = sameType.filter((entry) => normalizeIdentity(entry.type, entry.identity, normalizers) === key);
  if (exact.length || !WEB_CHANNELS.has(channel.type)) return exact;
  const covering = sameType
    .map((entry) => ({ entry, regKey: normalizeIdentity(entry.type, entry.identity, normalizers) }))
    .filter(({ regKey }) => regKey && looksLikeUrl(regKey) && webCovers(regKey, key));
  if (!covering.length) return [];
  const longest = Math.max(...covering.map(({ regKey }) => regKey.length));
  return covering.filter(({ regKey }) => regKey.length === longest).map(({ entry }) => entry);
}

/**
 * @param {number | { default?: number, byCompany?: Record<string, number> } | undefined} thresholds
 * @param {string} companyId
 */
export function thresholdFor(thresholds, companyId) {
  if (typeof thresholds === 'number') return thresholds;
  return thresholds?.byCompany?.[companyId] ?? thresholds?.default ?? DEFAULT_THRESHOLD;
}

/**
 * Work out what the channel alone tells us.
 * @returns {{ kind: 'owned', identity: ChannelIdentity, companyId: string, warnings: string[] }
 *   | { kind: 'shared', identity?: ChannelIdentity, companyIds?: string[], warnings: string[] }
 *   | { kind: 'unknown' | 'misconfigured', identity?: ChannelIdentity, warnings: string[] }}
 */
export function resolveChannel(channel, identities, normalizers) {
  const matches = matchIdentities(channel, identities ?? [], normalizers);
  if (!matches.length) return { kind: 'unknown', warnings: [] };
  const shared = matches.filter((m) => m.shared);
  const owned = matches.filter((m) => !m.shared && m.companyId);
  const owners = [...new Set(owned.map((m) => m.companyId))];
  if (!shared.length && owners.length === 1) {
    // Prefer a registration that also fixes the product line.
    const best = owned.find((m) => m.productLineId) ?? owned[0];
    const productLines = new Set(owned.map((m) => m.productLineId ?? null));
    const warnings = productLines.size > 1 ? ['conflicting_product_lines'] : [];
    const identity = productLines.size > 1 ? { ...best, productLineId: undefined } : best;
    return { kind: 'owned', identity, companyId: owners[0], warnings };
  }
  if (shared.length) {
    const scoped = shared.flatMap((m) => m.companyIds ?? []);
    const companyIds = scoped.length || owners.length ? [...new Set([...scoped, ...owners])] : undefined;
    return { kind: 'shared', identity: shared[0], companyIds, warnings: owners.length ? ['owned_and_shared'] : [] };
  }
  if (owners.length > 1) {
    // The same number registered by two companies: let the classifier choose between them.
    return { kind: 'shared', identity: owned[0], companyIds: owners, warnings: ['conflicting_identities'] };
  }
  return { kind: 'misconfigured', identity: matches[0], warnings: [] };
}

/**
 * Decide the route from the channel and, for shared channels, a classification already made.
 * Synchronous and pure; route() wraps it with the classifier call.
 *
 * @param {object} input
 * @param {{ type: string, identity?: string }} input.channel
 * @param {ChannelIdentity[]} input.identities
 * @param {unknown} [input.classification]  the classifier's raw answer (validated here)
 * @param {unknown} [input.classifierError]  set when the classifier threw
 * @param {boolean} [input.classifierMissing]
 * @param {number | { default?: number, byCompany?: Record<string, number> }} [input.thresholds]
 * @param {number} [input.minMargin]
 * @param {Partial<import('./normalize.js').Normalizers>} [input.normalizers]
 * @returns {RouteResult}
 */
export function decideRoute({
  channel,
  identities,
  classification,
  classifierError,
  classifierMissing,
  thresholds,
  minMargin = DEFAULT_MIN_MARGIN,
  normalizers,
}) {
  const resolved = resolveChannel(channel, identities, normalizers);
  const base = { ...(resolved.identity?.id ? { identityId: resolved.identity.id } : {}), warnings: resolved.warnings };

  if (resolved.kind === 'owned') {
    const out = {
      ...base,
      decision: /** @type {const} */ ('route'),
      companyId: resolved.companyId,
      confidence: 1,
      reason: 'owned_channel',
      message: REASONS.owned_channel,
      shared: false,
    };
    if (resolved.identity.productLineId) return { ...out, productLineId: resolved.identity.productLineId };
    // An owned channel may still use the classifier for the product line, never for the company.
    const parsed = classification ? classificationSchema.safeParse(classification) : null;
    if (parsed?.success && parsed.data.companyId === resolved.companyId && parsed.data.productLineId) {
      if (parsed.data.confidence >= thresholdFor(thresholds, resolved.companyId)) {
        return { ...out, productLineId: parsed.data.productLineId, classification: clean(parsed.data) };
      }
      return { ...out, warnings: [...out.warnings, 'product_line_low_confidence'], classification: clean(parsed.data) };
    }
    return out;
  }

  const review = (reason, extra = {}) => ({
    ...base,
    decision: /** @type {const} */ ('review'),
    companyId: null,
    confidence: 0,
    reason,
    message: REASONS[reason],
    shared: resolved.kind === 'shared',
    ...extra,
  });

  if (resolved.kind === 'unknown') return review('unknown_channel');
  if (resolved.kind === 'misconfigured') return review('misconfigured_identity');
  if (classifierError) return review('classifier_error');
  if (classifierMissing || classification === undefined || classification === null) return review('no_classifier');

  const parsed = classificationSchema.safeParse(classification);
  if (!parsed.success) return review('classifier_invalid');
  const result = clean(parsed.data);
  const allowed = resolved.companyIds;
  if (allowed && !allowed.includes(result.companyId)) return review('out_of_scope', { classification: result });

  const threshold = thresholdFor(thresholds, result.companyId);
  const guess = {
    companyId: result.companyId,
    confidence: result.confidence,
    threshold,
    classification: result,
    ...(result.productLineId ? { productLineId: result.productLineId } : {}),
  };
  if (result.confidence < threshold) return review('low_confidence', guess);
  const runnerUp = (result.alternatives ?? [])
    .filter((alt) => alt.companyId !== result.companyId && (!allowed || allowed.includes(alt.companyId)))
    .reduce((best, alt) => Math.max(best, alt.confidence), 0);
  if (result.confidence - runnerUp < minMargin) return review('ambiguous', guess);

  return { ...base, ...guess, decision: 'route', reason: 'classified', message: REASONS.classified, shared: true };
}

/** Drop nulls the classifier may send for optional fields. */
function clean(classification) {
  const out = { ...classification };
  if (out.productLineId === null || out.productLineId === undefined) delete out.productLineId;
  if (out.alternatives) {
    out.alternatives = out.alternatives.map((alt) => {
      const copy = { ...alt };
      if (copy.productLineId === null || copy.productLineId === undefined) delete copy.productLineId;
      return copy;
    });
  }
  return out;
}

/**
 * Route an enquiry. Calls `classify` only when the channel is shared (or, with
 * `classifyOwned`, to pick the product line on an owned channel that doesn't fix one).
 *
 * @param {object} input
 * @param {{ type: string, identity?: string }} input.channel
 * @param {ChannelIdentity[]} input.identities
 * @param {(request: { enquiry?: unknown, channel: object, companyIds?: string[] }) => Classification | Promise<Classification>} [input.classify]
 * @param {unknown} [input.enquiry]  passed to the classifier
 * @param {number | { default?: number, byCompany?: Record<string, number> }} [input.thresholds]
 * @param {number} [input.minMargin]
 * @param {boolean} [input.classifyOwned]
 * @param {Partial<import('./normalize.js').Normalizers>} [input.normalizers]
 * @returns {Promise<RouteResult>}
 */
export async function route(input) {
  const { channel, identities, classify, enquiry, classifyOwned = false, normalizers } = input;
  const resolved = resolveChannel(channel, identities, normalizers);
  const needsClassifier =
    resolved.kind === 'shared' || (resolved.kind === 'owned' && classifyOwned && !resolved.identity.productLineId);
  if (!needsClassifier) return decideRoute(input);
  if (!classify) return decideRoute({ ...input, classifierMissing: resolved.kind === 'shared' });

  const companyIds = resolved.kind === 'owned' ? [resolved.companyId] : resolved.companyIds;
  try {
    const classification = await classify({ enquiry, channel, companyIds });
    return decideRoute({ ...input, classification });
  } catch (error) {
    if (resolved.kind === 'owned') return { ...decideRoute(input), warnings: [...resolved.warnings, 'classifier_error'] };
    return decideRoute({ ...input, classifierError: error ?? true });
  }
}
