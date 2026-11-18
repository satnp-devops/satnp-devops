/**
 * Lead owner assignment.
 *
 * Brief: "Owner assigned by round-robin (capacity, language, time zone; partner leads stay with
 * the partner's counsellor)". In order:
 *
 * 1. Partner stickiness: a lead from a partner goes to that partner's counsellor.
 * 2. Existing-owner stickiness: a returning family goes back to the counsellor who had them,
 *    if they were active with the family within `returningWindowDays`.
 *    Sticky assignments skip capacity and working hours (the relationship matters more) but
 *    never go to someone inactive or away; then we fall through to round-robin, saying why.
 * 3. Round-robin among eligible owners. Hard filters: active, available (not away), in scope
 *    (company, product line, org unit), under their open-lead cap. Soft preferences, each applied
 *    only if someone is left after it: speaks the lead's language, is within working hours now,
 *    is in a nearby time zone. `languageMatch: 'require'` / `workingHours: 'require'` make the
 *    first two hard.
 * 4. Fairness: least recently assigned first (a monotonic sequence in the state, so new owners
 *    and owners coming back from leave slot in fairly), then the lighter load, then id.
 *    Sticky assignments don't use up a round-robin turn.
 *
 * Pure: the fairness state goes in and the updated state comes out; the caller persists it
 * per pool (for example per team and product line).
 */

import { isWithin } from '../orgTree.js';
import { isWorkingTime, toMs, zoneOffsetMinutes } from './time.js';

export { isWorkingTime, localTime, zoneOffsetMinutes } from './time.js';

/** @typedef {import('./time.js').WorkingHours} WorkingHours */

/**
 * @typedef {object} Owner
 * @property {string} id
 * @property {boolean} [active]  false, or a status other than 'active', excludes them
 * @property {string} [status]
 * @property {boolean} [available]  false while on leave or out of office
 * @property {{ from: string | number, to: string | number }[]} [away]  leave periods (UTC instants)
 * @property {string[]} [companyIds]
 * @property {string[]} [productLineIds]
 * @property {string[]} [unitPaths]  org units they work in
 * @property {string[]} [languages]  ISO 639-1 codes, e.g. ['hi', 'en']
 * @property {string} [timeZone]  IANA zone
 * @property {WorkingHours} [workingHours]  in their time zone
 * @property {number} [openLeads]
 * @property {number | null} [capacity]  open-lead cap; null or undefined means no cap
 * @property {string[]} [partnerIds]  partners whose leads they look after
 */

/**
 * @typedef {object} Lead
 * @property {string} [id]
 * @property {string} [companyId]
 * @property {string} [productLineId]
 * @property {string} [unitPath]
 * @property {string} [language]
 * @property {string[]} [languages]
 * @property {string} [timeZone]
 * @property {string} [partnerId]
 * @property {string} [partnerOwnerId]  the partner's counsellor, when the caller knows it
 * @property {string} [existingOwnerId]  owner of the family's earlier leads
 * @property {string | number} [existingOwnerLastActivityAt]
 */

/**
 * @typedef {{ version: 1, seq: number, owners: Record<string, { lastSeq: number, assigned: number }> }} FairnessState
 * @typedef {{ code: string, message: string }} Reason
 */

export const DEFAULT_ASSIGN_OPTIONS = Object.freeze({
  languageMatch: /** @type {'prefer' | 'require' | 'ignore'} */ ('prefer'),
  workingHours: /** @type {'prefer' | 'require' | 'ignore'} */ ('prefer'),
  timeZoneMatch: /** @type {'prefer' | 'ignore'} */ ('prefer'),
  /** Owners within this many minutes of the lead's UTC offset count as nearby. */
  maxOffsetMinutes: 180,
  /** How long a family stays with their earlier counsellor after the last activity. */
  returningWindowDays: 365,
  /** Sticky assignments ignore the open-lead cap. */
  stickyIgnoresCapacity: true,
  /** Used when an owner has no time zone. */
  defaultTimeZone: 'Asia/Kolkata',
  defaultWorkingHours: Object.freeze({ days: [1, 2, 3, 4, 5, 6], start: '09:30', end: '18:30' }),
});

/** @returns {FairnessState} */
export function initialState() {
  return { version: 1, seq: 0, owners: {} };
}

/** @param {unknown} state @returns {FairnessState} */
function readState(state) {
  const s = /** @type {any} */ (state);
  if (!s || typeof s !== 'object' || !Number.isFinite(s.seq)) return initialState();
  const owners = {};
  for (const [id, entry] of Object.entries(s.owners ?? {})) {
    owners[id] = { lastSeq: Number(entry?.lastSeq) || 0, assigned: Number(entry?.assigned) || 0 };
  }
  return { version: 1, seq: s.seq, owners };
}

// ---------------------------------------------------------------------------------------------
// Eligibility

/** Why an owner can't take any lead right now, or null. */
function unavailableReason(owner, nowMs) {
  if (owner.active === false || (owner.status && owner.status !== 'active')) return 'inactive';
  if (owner.available === false) return 'unavailable';
  if ((owner.away ?? []).some((period) => toMs(period.from) <= nowMs && nowMs < toMs(period.to))) return 'away';
  return null;
}

/** Why an owner can't take this lead (scope), or null. */
function scopeReason(owner, lead) {
  if (lead.companyId && owner.companyIds?.length && !owner.companyIds.includes(lead.companyId)) return 'out_of_scope';
  if (lead.productLineId && owner.productLineIds?.length && !owner.productLineIds.includes(lead.productLineId)) return 'product_line';
  if (lead.unitPath && owner.unitPaths?.length) {
    const covers = owner.unitPaths.some((path) => isWithin(path, lead.unitPath) || isWithin(lead.unitPath, path));
    if (!covers) return 'out_of_scope';
  }
  return null;
}

const atCapacity = (owner) => owner.capacity !== undefined && owner.capacity !== null && (owner.openLeads ?? 0) >= owner.capacity;

const MESSAGES = {
  inactive: 'not active',
  unavailable: 'marked unavailable',
  away: 'on leave',
  out_of_scope: 'does not work on this company or unit',
  product_line: 'does not handle this product line',
  at_capacity: 'at their open-lead cap',
  language: 'does not speak the lead’s language',
  outside_hours: 'outside working hours',
};

const leadLanguages = (lead) => [...new Set([...(lead.languages ?? []), ...(lead.language ? [lead.language] : [])].map((l) => l.toLowerCase()))];

/**
 * Assign an owner to one lead.
 *
 * @param {object} input
 * @param {Lead} input.lead
 * @param {Owner[]} input.owners  the pool (callers pass the counsellors of the right team)
 * @param {unknown} [input.state]  fairness state from the previous call (or nothing)
 * @param {number | string | Date} input.now
 * @param {Partial<typeof DEFAULT_ASSIGN_OPTIONS>} [input.options]
 * @returns {{
 *   decision: 'assigned' | 'unassigned',
 *   ownerId: string | null,
 *   method: 'partner' | 'existing_owner' | 'round_robin' | null,
 *   reasons: Reason[],
 *   excluded: { ownerId: string, code: string }[],
 *   state: FairnessState,
 * }}
 */
export function assignOwner({ lead, owners, state, now, options = {} }) {
  const opts = { ...DEFAULT_ASSIGN_OPTIONS, ...options };
  const nowMs = toMs(now);
  if (!Number.isFinite(nowMs)) throw new Error('assignOwner needs `now`');
  const current = readState(state);
  /** @type {Reason[]} */
  const reasons = [];
  const byId = new Map(owners.map((o) => [o.id, o]));
  const note = (code, message) => reasons.push({ code, message });

  const sticky = (owner, method) => {
    const nextState = structuredClone(current);
    const entry = nextState.owners[owner.id] ?? { lastSeq: 0, assigned: 0 };
    nextState.owners[owner.id] = { ...entry, assigned: entry.assigned + 1 };
    return { decision: /** @type {const} */ ('assigned'), ownerId: owner.id, method, reasons, excluded: [], state: nextState };
  };
  const stickyBlock = (owner) => {
    const blocked = unavailableReason(owner, nowMs) ?? scopeReason(owner, lead);
    if (blocked) return blocked;
    if (!opts.stickyIgnoresCapacity && atCapacity(owner)) return 'at_capacity';
    return null;
  };

  // 1. Partner leads stay with the partner's counsellor.
  if (lead.partnerId) {
    const partnerOwner = lead.partnerOwnerId ? byId.get(lead.partnerOwnerId) : owners.find((o) => o.partnerIds?.includes(lead.partnerId));
    if (!partnerOwner) {
      note('partner_owner_missing', `No counsellor in this pool looks after partner ${lead.partnerId}; using round-robin`);
    } else {
      const blocked = stickyBlock(partnerOwner);
      if (!blocked) {
        note('partner', `Partner ${lead.partnerId} lead stays with their counsellor ${partnerOwner.id}`);
        return sticky(partnerOwner, 'partner');
      }
      note('partner_owner_unavailable', `Partner counsellor ${partnerOwner.id} is ${MESSAGES[blocked]}; using round-robin`);
    }
  }

  // 2. Returning families go back to their counsellor.
  if (lead.existingOwnerId) {
    const previous = byId.get(lead.existingOwnerId);
    const last = lead.existingOwnerLastActivityAt === undefined ? null : toMs(lead.existingOwnerLastActivityAt);
    const expired = last !== null && nowMs - last > opts.returningWindowDays * 86_400_000;
    if (!previous) {
      note('existing_owner_not_in_pool', `Earlier counsellor ${lead.existingOwnerId} is not in this pool; using round-robin`);
    } else if (expired) {
      note('existing_owner_expired', `Last activity with ${previous.id} was over ${opts.returningWindowDays} days ago; using round-robin`);
    } else {
      const blocked = stickyBlock(previous);
      if (!blocked) {
        note('existing_owner', `Returning family stays with their counsellor ${previous.id}`);
        return sticky(previous, 'existing_owner');
      }
      note('existing_owner_unavailable', `Earlier counsellor ${previous.id} is ${MESSAGES[blocked]}; using round-robin`);
    }
  }

  // 3. Round-robin: hard filters.
  /** @type {{ ownerId: string, code: string }[]} */
  const excluded = [];
  let pool = [];
  for (const owner of owners) {
    const code = unavailableReason(owner, nowMs) ?? scopeReason(owner, lead) ?? (atCapacity(owner) ? 'at_capacity' : null);
    if (code) excluded.push({ ownerId: owner.id, code });
    else pool.push(owner);
  }

  const languages = leadLanguages(lead);
  const speaks = (owner) => (owner.languages ?? []).some((l) => languages.includes(l.toLowerCase()));
  const zoneOf = (owner) => owner.timeZone ?? opts.defaultTimeZone;
  const working = (owner) => isWorkingTime(owner.workingHours ?? opts.defaultWorkingHours, zoneOf(owner), nowMs);

  if (languages.length && opts.languageMatch === 'require') {
    for (const owner of pool.filter((o) => !speaks(o))) excluded.push({ ownerId: owner.id, code: 'language' });
    pool = pool.filter(speaks);
  }
  if (opts.workingHours === 'require') {
    for (const owner of pool.filter((o) => !working(o))) excluded.push({ ownerId: owner.id, code: 'outside_hours' });
    pool = pool.filter(working);
  }

  if (!pool.length) {
    note('no_eligible_owner', summariseExclusions(excluded));
    return { decision: 'unassigned', ownerId: null, method: null, reasons, excluded, state: current };
  }

  // Soft preferences, narrowing only when someone is left.
  const prefer = (label, predicate, applies, fallbackCode, fallbackMessage) => {
    if (!applies) return;
    const narrowed = pool.filter(predicate);
    if (narrowed.length) {
      if (narrowed.length < pool.length) note(`prefer_${label}`, `Preferred ${narrowed.length} of ${pool.length} owners by ${label.replace('_', ' ')}`);
      pool = narrowed;
    } else note(fallbackCode, fallbackMessage);
  };
  prefer('language', speaks, languages.length > 0 && opts.languageMatch === 'prefer', 'no_language_match', `Nobody available speaks ${languages.join('/')}; ignoring language`);
  prefer('working_hours', working, opts.workingHours === 'prefer', 'outside_hours_fallback', 'Nobody eligible is within working hours; assigning anyway');
  if (lead.timeZone && opts.timeZoneMatch === 'prefer') {
    const leadOffset = zoneOffsetMinutes(lead.timeZone, nowMs);
    prefer(
      'time_zone',
      (owner) => Math.abs(zoneOffsetMinutes(zoneOf(owner), nowMs) - leadOffset) <= opts.maxOffsetMinutes,
      true,
      'no_time_zone_match',
      `Nobody eligible is within ${opts.maxOffsetMinutes / 60} hours of ${lead.timeZone}; ignoring time zone`,
    );
  }

  // 4. Fairness: least recently assigned, then lightest load, then id.
  const load = (owner) => (owner.capacity ? (owner.openLeads ?? 0) / owner.capacity : 0);
  const lastSeq = (owner) => current.owners[owner.id]?.lastSeq ?? 0;
  const chosen = [...pool].sort(
    (a, b) => lastSeq(a) - lastSeq(b) || load(a) - load(b) || (a.openLeads ?? 0) - (b.openLeads ?? 0) || a.id.localeCompare(b.id),
  )[0];

  const nextState = structuredClone(current);
  nextState.seq = current.seq + 1;
  const entry = nextState.owners[chosen.id] ?? { lastSeq: 0, assigned: 0 };
  nextState.owners[chosen.id] = { lastSeq: nextState.seq, assigned: entry.assigned + 1 };
  note('round_robin', `Round-robin picked ${chosen.id} from ${pool.length} eligible owner${pool.length === 1 ? '' : 's'}`);
  return { decision: 'assigned', ownerId: chosen.id, method: 'round_robin', reasons, excluded, state: nextState };
}

function summariseExclusions(excluded) {
  if (!excluded.length) return 'Nobody is in the pool';
  const counts = {};
  for (const { code } of excluded) counts[code] = (counts[code] ?? 0) + 1;
  return `No eligible owner: ${Object.entries(counts)
    .map(([code, n]) => `${n} ${MESSAGES[code] ?? code}`)
    .join(', ')}`;
}

/**
 * Assign many leads in order (an import, or a backlog after a counsellor leaves), carrying the
 * fairness state and each owner's open-lead count forward so caps hold across the batch.
 *
 * @param {object} input
 * @param {Lead[]} input.leads
 * @param {Owner[]} input.owners
 * @param {unknown} [input.state]
 * @param {number | string | Date} input.now
 * @param {Partial<typeof DEFAULT_ASSIGN_OPTIONS>} [input.options]
 */
export function assignBatch({ leads, owners, state, now, options }) {
  const loads = new Map(owners.map((o) => [o.id, o.openLeads ?? 0]));
  let current = readState(state);
  const results = [];
  for (const lead of leads) {
    const pool = owners.map((o) => ({ ...o, openLeads: loads.get(o.id) }));
    const { state: next, ...result } = assignOwner({ lead, owners: pool, state: current, now, options });
    current = next;
    if (result.ownerId) loads.set(result.ownerId, (loads.get(result.ownerId) ?? 0) + 1);
    results.push({ leadId: lead.id, ...result });
  }
  return { results, state: current, openLeads: Object.fromEntries(loads) };
}

/** Alias matching the module name. */
export const assign = assignOwner;
