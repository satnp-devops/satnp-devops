import { db } from '../../lib/db.js';
import { normalizeReferralCode } from './rules.js';

// Turning what an enquiry carries (a referral code, a partner code typed into a form or CSV, a
// `ref=` on the landing page) into a partner. This is the function the intake module calls when it
// builds a lead (docs/partners/PARTNERS.md, "Intake"), and the attribution sync uses the same rules.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIVE_LINK_STATUSES = ['active'];

/**
 * @typedef {{
 *   partnerId: string, partnerName: string, groupId: string, companyId: string, unitId: string,
 *   partnerOwnerId: string | null, referralLinkId: string | null, code: string,
 *   productLineId: string | null, landingUrl: string | null, utm: object,
 *   source: 'referral_link' | 'partner_code'
 * }} ResolvedReferral
 */

/**
 * Resolve a referral code (or a partner id) to the partner who should get credit for a lead.
 *
 *   const ref = await resolveReferralCode('SP-7KQ2MX', { companyId });
 *   // → { partnerId, partnerOwnerId, referralLinkId, productLineId, ... } or null
 *
 * - A referral link code matches when the link is active and the partner's link with the link's
 *   company is active. With `companyId`, a code of another company doesn't match (null).
 * - Otherwise a partner's own code (partners.code, the "agent code" forms and CSV imports carry
 *   as source.partnerId) or a partner id matches when the partner has an active link with
 *   `companyId` (required in that case, since one partner works with several companies).
 * - Codes are case-insensitive; surrounding spaces are ignored. Anything else returns null.
 *
 * Intake uses `partnerId` and `partnerOwnerId` for owner assignment (core/intake/assign.js,
 * "partner stickiness") and should store `partnerId` in the deal's touch source
 * (`first_touch.partnerId`) and `?ref=<code>` in `landingUrl`; the attribution sync on
 * `deal.created` reads both.
 *
 * @param {string} code
 * @param {{ companyId?: string, groupId?: string, trx?: import('knex').Knex }} [options]
 * @returns {Promise<ResolvedReferral | null>}
 */
export async function resolveReferralCode(code, { companyId, groupId, trx = db } = {}) {
  if (typeof code !== 'string') return null;
  const value = code.trim();
  if (UUID.test(value)) return companyId ? resolvePartner({ id: value }, value, { companyId, groupId, trx }) : null;
  const normalized = normalizeReferralCode(value);
  if (!normalized) return null;
  const row = await trx('partner_referral_links as rl')
    .join('partners as p', 'p.id', 'rl.partner_id')
    .join('partner_companies as pc', function joinLink() {
      this.on('pc.partner_id', '=', 'rl.partner_id').andOn('pc.company_id', '=', 'rl.company_id');
    })
    .where('rl.code', normalized) // citext: case-insensitive
    .where('rl.active', true)
    .whereIn('pc.status', ACTIVE_LINK_STATUSES)
    .modify((q) => {
      if (companyId) q.where('rl.company_id', companyId);
      if (groupId) q.where('rl.group_id', groupId);
    })
    .first(
      'rl.id as link_id',
      'rl.code',
      'rl.company_id',
      'rl.group_id',
      'rl.product_line_id',
      'rl.landing_url',
      'rl.utm',
      'p.id as partner_id',
      'p.name as partner_name',
      'pc.unit_id',
      'pc.owner_user_id',
    );
  if (!row) return companyId ? resolvePartner({ code: normalized }, normalized, { companyId, groupId, trx }) : null;
  return {
    partnerId: row.partner_id,
    partnerName: row.partner_name,
    groupId: row.group_id,
    companyId: row.company_id,
    unitId: row.unit_id,
    partnerOwnerId: row.owner_user_id ?? null,
    referralLinkId: row.link_id,
    code: row.code,
    productLineId: row.product_line_id ?? null,
    landingUrl: row.landing_url ?? null,
    utm: row.utm ?? {},
    source: 'referral_link',
  };
}

/** A partner by id or by their group-level code, when they have an active partnership with the company. */
async function resolvePartner(match, given, { companyId, groupId, trx }) {
  const row = await trx('partner_companies as pc')
    .join('partners as p', 'p.id', 'pc.partner_id')
    .where('pc.company_id', companyId)
    .where(match.id ? { 'p.id': match.id } : { 'p.code': match.code }) // citext
    .whereIn('pc.status', ACTIVE_LINK_STATUSES)
    .modify((q) => {
      if (groupId) q.where('pc.group_id', groupId);
    })
    .first('p.id', 'p.name', 'pc.group_id', 'pc.company_id', 'pc.unit_id', 'pc.owner_user_id');
  if (!row) return null;
  return {
    partnerId: row.id,
    partnerName: row.name,
    groupId: row.group_id,
    companyId: row.company_id,
    unitId: row.unit_id,
    partnerOwnerId: row.owner_user_id ?? null,
    referralLinkId: null,
    code: given,
    productLineId: null,
    landingUrl: null,
    utm: {},
    source: 'partner_code',
  };
}

/** The `ref` (or `referral`, `partner`) query parameter of a landing URL, if any. Pure. */
export function refFromLandingUrl(landingUrl) {
  if (typeof landingUrl !== 'string' || !landingUrl) return null;
  try {
    const url = new URL(landingUrl);
    for (const key of ['ref', 'referral', 'partner']) {
      const value = url.searchParams.get(key);
      if (value) return value;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * The partner reference a deal touch carries, in order of trust: `partnerId` (a partner id or a
 * code typed in), then `?ref=` on the landing page. Pure.
 * @param {{ partnerId?: string, landingUrl?: string } | null | undefined} touch
 * @returns {string[]} candidates to try
 */
export function touchReferences(touch) {
  if (!touch || typeof touch !== 'object') return [];
  const candidates = [];
  if (typeof touch.partnerId === 'string' && touch.partnerId.trim()) candidates.push(touch.partnerId.trim());
  const ref = refFromLandingUrl(touch.landingUrl);
  if (ref && !candidates.includes(ref)) candidates.push(ref);
  return candidates;
}

/** Resolve the first candidate of a touch that matches a partner of the company. */
export async function resolveTouch(touch, { companyId, groupId, trx = db }) {
  for (const candidate of touchReferences(touch)) {
    const resolved = await resolveReferralCode(candidate, { companyId, groupId, trx });
    if (resolved) return resolved;
  }
  return null;
}

/**
 * For intake's owner pool (`owners[].partnerIds`): which partners each counsellor looks after in a
 * company, from the partner links' owners.
 * @returns {Promise<Map<string, string[]>>} owner user id → partner ids
 */
export async function partnerIdsByOwner(companyId, trx = db) {
  const rows = await trx('partner_companies')
    .where({ company_id: companyId })
    .whereIn('status', ACTIVE_LINK_STATUSES)
    .whereNotNull('owner_user_id')
    .select('owner_user_id', 'partner_id');
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.owner_user_id)) map.set(row.owner_user_id, []);
    map.get(row.owner_user_id).push(row.partner_id);
  }
  return map;
}
