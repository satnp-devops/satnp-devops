/**
 * Choose one host for a booking among the hosts free for the chosen slot.
 *
 * Order of decisions:
 *  1. Eligible = candidates (free for the slot) ∩ known, active hosts ∩ filters (language,
 *     time-zone band). With relaxFilters, an empty filtered set falls back to all candidates.
 *  2. Sticky hosts: the first preferredHostIds entry that is eligible wins (for example the
 *     lead's owner, then the partner's counsellor). If none is eligible, fallback 'round_robin'
 *     continues below and fallback 'none' returns no host.
 *  3. Highest priority tier among eligible hosts.
 *  4. Weighted fairness (strategy 'weighted', default): lowest (bookingCount + 1) / weight, the
 *     D'Hondt quotient, so over time each host's share of bookings tends to weight / Σ weights.
 *     Strategy 'least_recent' skips this step.
 *  5. Least recently booked (never booked first), then id ascending, so the result is
 *     deterministic for the same input.
 */
import { z } from 'zod';
import { parseInput } from './errors.js';
import { isValidTimeZone, assertTimeZone, offsetMinutesAt, toEpochMs } from './tz.js';

const optionalInstant = z
  .union([z.number(), z.string(), z.date()])
  .nullable()
  .default(null)
  .transform((value, ctx) => {
    if (value === null) return null;
    try {
      return toEpochMs(value);
    } catch (error) {
      ctx.addIssue({ code: 'custom', message: error.message });
      return z.NEVER;
    }
  });

export const roundRobinHostSchema = z.object({
  id: z.string().min(1).max(100),
  /** Capacity share; 0 means only used when nobody else in the tier can take it. */
  weight: z.number().min(0).max(1000).default(1),
  /** Higher tiers are always tried first. */
  priority: z.number().int().min(-100).max(100).default(0),
  /** Bookings in the fairness window (e.g. this month), including any calibration for new hosts. */
  bookingCount: z.number().int().min(0).default(0),
  lastBookedAt: optionalInstant,
  languages: z.array(z.string().min(2).max(35)).default([]),
  timeZone: z
    .string()
    .refine(isValidTimeZone, { message: 'Unknown IANA time zone' })
    .transform(assertTimeZone)
    .optional(),
  active: z.boolean().default(true),
});

const bandSchema = z
  .object({
    /** Allowed host UTC offsets at the slot, in minutes (IST is 330). */
    minOffsetMin: z.number().min(-840).max(840).optional(),
    maxOffsetMin: z.number().min(-840).max(840).optional(),
    /** Or: hosts whose offset is within maxDifferenceMin of this zone's offset at the slot. */
    aroundTimeZone: z.string().refine(isValidTimeZone, { message: 'Unknown IANA time zone' }).optional(),
    maxDifferenceMin: z.number().min(0).max(1680).optional(),
  })
  .refine((b) => b.aroundTimeZone === undefined || b.maxDifferenceMin !== undefined, {
    message: 'aroundTimeZone needs maxDifferenceMin',
  });

export const chooseHostInputSchema = z.object({
  /** Host ids free for the slot, e.g. slot.hostIds from generateSlots. */
  candidateIds: z.array(z.string()).max(500),
  hosts: z.array(roundRobinHostSchema).max(500),
  slotStart: optionalInstant,
  preferredHostIds: z.array(z.string()).max(10).default([]),
  fallback: z.enum(['round_robin', 'none']).default('round_robin'),
  strategy: z.enum(['weighted', 'least_recent']).default('weighted'),
  filters: z
    .object({
      language: z.string().min(2).max(35).optional(),
      timeZoneBand: bandSchema.optional(),
    })
    .default({}),
  relaxFilters: z.boolean().default(false),
});

/**
 * @typedef {'preferred_host'|'round_robin'|'only_candidate'|'no_candidates'|'no_host_matches_filters'|'preferred_unavailable'} ChoiceReason
 * @typedef {{
 *   hostId: string|null,
 *   reason: ChoiceReason,
 *   explanation: string,
 *   preferredFallback: boolean,
 *   filtersRelaxed: boolean,
 *   ranking: { id: string, priority: number, quotient: number|null, lastBookedAt: string|null }[],
 *   excluded: Record<string, 'unknown'|'inactive'|'language'|'time_zone_band'>,
 * }} HostChoice
 */

/** 'hi' matches 'hi-IN', 'en-IN' matches 'en-in' and 'en'. */
function languageMatches(hostLanguages, wanted) {
  const want = wanted.toLowerCase();
  const wantPrimary = want.split('-')[0];
  return hostLanguages.some((lang) => {
    const have = lang.toLowerCase();
    return have === want || have.split('-')[0] === wantPrimary;
  });
}

function inBand(host, band, slotStart) {
  if (!host.timeZone || slotStart === null) return false;
  const offset = offsetMinutesAt(host.timeZone, slotStart);
  if (band.minOffsetMin !== undefined && offset < band.minOffsetMin) return false;
  if (band.maxOffsetMin !== undefined && offset > band.maxOffsetMin) return false;
  if (band.aroundTimeZone !== undefined) {
    const target = offsetMinutesAt(band.aroundTimeZone, slotStart);
    if (Math.abs(offset - target) > band.maxDifferenceMin) return false;
  }
  return true;
}

/** D'Hondt quotient: lower is more deserving. Weight 0 sorts after every positive weight. */
const quotientOf = (host) => (host.weight > 0 ? (host.bookingCount + 1) / host.weight : Infinity);

function compareHosts(strategy) {
  return (a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    if (strategy === 'weighted') {
      const qa = quotientOf(a);
      const qb = quotientOf(b);
      if (qa !== qb) return qa < qb ? -1 : 1;
    }
    const la = a.lastBookedAt ?? -Infinity;
    const lb = b.lastBookedAt ?? -Infinity;
    if (la !== lb) return la < lb ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
}

/**
 * Pick a host for a slot.
 * @param {z.input<typeof chooseHostInputSchema>} input
 * @returns {HostChoice}
 */
export function chooseHost(input) {
  const options = parseInput(chooseHostInputSchema, input, 'roundRobin');
  const byId = new Map(options.hosts.map((host) => [host.id, host]));
  const candidates = [...new Set(options.candidateIds)];
  /** @type {HostChoice['excluded']} */
  const excluded = {};

  const available = [];
  for (const id of candidates) {
    const host = byId.get(id);
    if (!host) excluded[id] = 'unknown';
    else if (!host.active) excluded[id] = 'inactive';
    else available.push(host);
  }

  const { language, timeZoneBand } = options.filters;
  const filtered = available.filter((host) => {
    if (language !== undefined && !languageMatches(host.languages, language)) {
      excluded[host.id] = 'language';
      return false;
    }
    if (timeZoneBand !== undefined && !inBand(host, timeZoneBand, options.slotStart)) {
      excluded[host.id] = 'time_zone_band';
      return false;
    }
    return true;
  });

  let eligible = filtered;
  let filtersRelaxed = false;
  if (filtered.length === 0 && available.length > 0 && options.relaxFilters) {
    eligible = available;
    filtersRelaxed = true;
  }

  const compare = compareHosts(options.strategy);
  const ranking = [...eligible].sort(compare).map((host) => ({
    id: host.id,
    priority: host.priority,
    quotient: options.strategy === 'weighted' ? quotientOf(host) : null,
    lastBookedAt: host.lastBookedAt === null ? null : new Date(host.lastBookedAt).toISOString(),
  }));
  const base = { ranking, excluded, filtersRelaxed, preferredFallback: false };

  if (eligible.length === 0) {
    const reason = available.length === 0 ? 'no_candidates' : 'no_host_matches_filters';
    const explanation =
      reason === 'no_candidates' ? 'No host is free for this slot' : 'No free host matches the filters';
    return { hostId: null, reason, explanation, ...base };
  }

  const eligibleIds = new Set(eligible.map((host) => host.id));
  const preferred = options.preferredHostIds.find((id) => eligibleIds.has(id));
  if (preferred !== undefined) {
    const rank = options.preferredHostIds.indexOf(preferred);
    const explanation =
      rank === 0
        ? `Preferred host ${preferred} is free`
        : `Preferred host ${options.preferredHostIds[0]} is not available; next preferred host ${preferred} is free`;
    return { hostId: preferred, reason: 'preferred_host', explanation, ...base, preferredFallback: rank > 0 };
  }

  const hadPreference = options.preferredHostIds.length > 0;
  if (hadPreference && options.fallback === 'none') {
    return {
      hostId: null,
      reason: 'preferred_unavailable',
      explanation: `Preferred host ${options.preferredHostIds[0]} is not available and fallback is off`,
      ...base,
    };
  }

  const winner = ranking[0];
  const why =
    eligible.length === 1
      ? 'the only free host'
      : options.strategy === 'weighted'
        ? 'fewest bookings for their weight, then least recently booked'
        : 'least recently booked';
  const prefix = hadPreference ? `Preferred host ${options.preferredHostIds[0]} is not available; ` : '';
  return {
    hostId: winner.id,
    reason: eligible.length === 1 ? 'only_candidate' : 'round_robin',
    explanation: `${prefix}chose ${winner.id}: ${why}${filtersRelaxed ? ' (filters relaxed)' : ''}`,
    ...base,
    preferredFallback: hadPreference,
  };
}

/**
 * The host list after a booking, for callers that keep fairness state in memory (and tests).
 * Persisted callers instead re-read counts from the bookings table.
 * @template {{ id: string, bookingCount?: number, lastBookedAt?: unknown }} H
 * @param {H[]} hosts
 * @param {string} hostId
 * @param {number|string|Date} at
 * @returns {H[]}
 */
export function recordAssignment(hosts, hostId, at) {
  const atMs = toEpochMs(at);
  return hosts.map((host) =>
    host.id === hostId ? { ...host, bookingCount: (host.bookingCount ?? 0) + 1, lastBookedAt: atMs } : host,
  );
}
