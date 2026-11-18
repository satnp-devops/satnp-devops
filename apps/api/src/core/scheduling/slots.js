/**
 * Bookable slots for an event type across one or more hosts, each in their own time zone.
 *
 * Rules (each host is evaluated independently, then slots are merged by start instant):
 *  1. Working hours come from the host's weekly ranges, or from an override for that local date
 *     (an override replaces the weekly ranges; an empty list or 'unavailable' blocks the day).
 *     Ranges are wall-clock 'HH:MM' in the host's zone; a range ending at or before its start
 *     runs past midnight into the next day, and '24:00' means the end of the day. A range belongs
 *     to the date it starts on. Touching ranges are merged, so a slot can cross midnight.
 *  2. DST follows tz.localToUtc (RFC 5545 §3.3.5): a range edge inside a spring-forward gap moves
 *     forward, an edge in a repeated hour means its first occurrence. Ranges are real time, so
 *     09:00–17:00 is 8 hours every day while 00:00–04:00 is 3 or 5 hours on change days.
 *  3. Slot starts step by slotIntervalMin from the start of each merged range (or, with
 *     alignTimeZone, from the first multiple of the interval since local midnight in that zone);
 *     a slot must fit entirely inside the range.
 *  4. A slot needs [start − bufferBefore, end + bufferAfter) free of every busy interval
 *     (each busy interval may carry its own bufferBeforeMin/bufferAfterMin). Buffers may extend
 *     outside working hours. Intervals are half-open, so back-to-back meetings are allowed.
 *  5. start ≥ now + minNoticeMin, and start ≤ now + horizonDays (when set).
 *  6. maxPerDay caps a host's bookings per local date (host zone) of the slot start, using
 *     bookedCountByDate supplied by the caller.
 *  7. Slots are returned when their start lies in [range.from, range.to).
 */
import { z } from 'zod';
import { parseInput } from './errors.js';
import {
  DAY_MS,
  MINUTE_MS,
  WEEKDAYS,
  addDays,
  assertTimeZone,
  isLocalDate,
  isValidTimeZone,
  localToUtc,
  offsetMinutesAt,
  parseClock,
  toEpochMs,
  toIso,
  toZonedParts,
  weekdayOf,
} from './tz.js';

/** Longest window one call may scan, to keep public booking pages cheap. */
export const MAX_RANGE_DAYS = 92;
/** Upper bound on generated slots per call. */
export const MAX_SLOTS = 20_000;

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (00:00–23:59)');
const clockOrEnd = z.string().regex(/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/, 'Use HH:MM (00:00–24:00)');

/** A wall-clock range: { start: '09:00', end: '13:00' } or the string '09:00-13:00'. */
export const clockRangeSchema = z.preprocess(
  (value) => {
    if (typeof value !== 'string') return value;
    const [start, end] = value.split('-').map((part) => part.trim());
    return { start, end };
  },
  z
    .object({ start: clock, end: clockOrEnd })
    .strict()
    .refine((r) => r.start !== r.end, { message: 'Start and end must differ (use 00:00-24:00 for a full day)' }),
);

const rangesSchema = z.array(clockRangeSchema).max(48);

export const weeklyHoursSchema = z
  .object(Object.fromEntries(WEEKDAYS.map((key) => [key, rangesSchema.optional()])))
  .strict();

const instantSchema = z.union([z.number(), z.string(), z.date()]).transform((value, ctx) => {
  try {
    return toEpochMs(value);
  } catch (error) {
    ctx.addIssue({ code: 'custom', message: error.message });
    return z.NEVER;
  }
});

const busySchema = z
  .object({
    start: instantSchema,
    end: instantSchema,
    bufferBeforeMin: z.number().int().min(0).max(1440).default(0),
    bufferAfterMin: z.number().int().min(0).max(1440).default(0),
  })
  .refine((b) => b.end > b.start, { message: 'end must be after start' });

const overrideSchema = z.union([z.literal('unavailable'), z.null(), z.literal(false), rangesSchema]);

export const hostSchema = z.object({
  id: z.string().min(1).max(100),
  timeZone: z.string().refine(isValidTimeZone, { message: 'Unknown IANA time zone' }).transform(assertTimeZone),
  weekly: weeklyHoursSchema.default({}),
  overrides: z
    .record(z.string().refine(isLocalDate, { message: 'Use YYYY-MM-DD' }), overrideSchema)
    .default({}),
  busy: z.array(busySchema).max(10_000).default([]),
  bookedCountByDate: z.record(z.string(), z.number().int().min(0)).default({}),
});

export const eventTypeSchema = z.object({
  durationMin: z.number().int().min(5).max(1440),
  slotIntervalMin: z.number().int().min(5).max(1440).optional(),
  bufferBeforeMin: z.number().int().min(0).max(1440).default(0),
  bufferAfterMin: z.number().int().min(0).max(1440).default(0),
  minNoticeMin: z.number().int().min(0).default(0),
  maxPerDay: z.number().int().min(1).nullable().default(null),
  horizonDays: z.number().int().min(1).max(3650).nullable().default(null),
  /**
   * Put every host on one wall-clock grid in this zone (starts at multiples of slotIntervalMin
   * from local midnight). Without it, each host's grid starts at their own range start, so a
   * team mixing +05:30 and +05:45 hosts would never share a slot.
   */
  alignTimeZone: z
    .string()
    .refine(isValidTimeZone, { message: 'Unknown IANA time zone' })
    .transform(assertTimeZone)
    .optional(),
});

const rangeSchema = z
  .object({ from: instantSchema, to: instantSchema })
  .refine((r) => r.to > r.from, { message: 'to must be after from' })
  .refine((r) => r.to - r.from <= MAX_RANGE_DAYS * DAY_MS, { message: `Ask for at most ${MAX_RANGE_DAYS} days` });

export const generateSlotsInputSchema = z.object({
  eventType: eventTypeSchema,
  hosts: z.array(hostSchema).min(1).max(200),
  range: rangeSchema,
  now: instantSchema,
  /** any: a slot is offered when at least one host is free; all: every host must be free (panel). */
  mode: z.enum(['any', 'all']).default('any'),
});

/**
 * @typedef {{ start: string, end: string, hostIds: string[] }} Slot  start/end are UTC ISO strings
 * @typedef {z.input<typeof generateSlotsInputSchema>} GenerateSlotsInput
 */

/** Ranges for one local date: the override when present, otherwise the weekly ranges. */
function rangesForDate(host, date, weekday) {
  if (Object.hasOwn(host.overrides, date)) {
    const override = host.overrides[date];
    return Array.isArray(override) ? override : [];
  }
  return host.weekly[WEEKDAYS[weekday]] ?? [];
}

/** Merge overlapping or touching [start, end) intervals; input need not be sorted. */
export function mergeIntervals(intervals) {
  const sorted = intervals.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const [start, end] of sorted) {
    const last = out[out.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

/** Does [start, end) overlap any interval of a merged, sorted list? Binary search. */
function overlapsAny(merged, start, end) {
  let lo = 0;
  let hi = merged.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (merged[mid][1] <= start) lo = mid + 1;
    else hi = mid;
  }
  return lo < merged.length && merged[lo][0] < end;
}

/**
 * A host's working time as merged UTC intervals covering [fromMs, toMs).
 * @param {z.output<typeof hostSchema>} host
 * @param {number} fromMs
 * @param {number} toMs
 * @returns {[number, number][]}
 */
export function workingIntervals(host, fromMs, toMs) {
  // Start a day early so overnight ranges from the previous date are included.
  let date = addDays(toZonedParts(fromMs, host.timeZone).date, -1);
  const lastDate = toZonedParts(toMs, host.timeZone).date;
  const intervals = [];
  for (let guard = 0; date <= lastDate && guard < MAX_RANGE_DAYS + 3; guard += 1) {
    for (const range of rangesForDate(host, date, weekdayOf(date))) {
      const startMin = parseClock(range.start);
      const endMin = parseClock(range.end, { allowEndOfDay: true });
      const endDate = endMin <= startMin || range.end === '24:00' ? addDays(date, 1) : date;
      const endClock = range.end === '24:00' ? '00:00' : range.end;
      const start = localToUtc(date, range.start, host.timeZone);
      const end = localToUtc(endDate, endClock, host.timeZone);
      if (end > fromMs - DAY_MS && start < toMs + DAY_MS) intervals.push([start, end]);
    }
    date = addDays(date, 1);
  }
  return mergeIntervals(intervals);
}

/** The first instant ≥ ms whose wall clock in `zone` is a multiple of stepMs since local midnight. */
function alignUp(ms, stepMs, zone) {
  const offsetMs = offsetMinutesAt(zone, ms) * MINUTE_MS;
  const timeOfDay = (((ms + offsetMs) % DAY_MS) + DAY_MS) % DAY_MS;
  const remainder = timeOfDay % stepMs;
  return remainder === 0 ? ms : ms + (stepMs - remainder);
}

/**
 * Candidate starts for one host after every rule, as a Map of start ms → end ms.
 * @param {z.output<typeof eventTypeSchema>} eventType
 * @param {z.output<typeof hostSchema>} host
 * @param {{ fromMs: number, toMs: number, nowMs: number }} window
 */
function hostSlots(eventType, host, { fromMs, toMs, nowMs }) {
  const durationMs = eventType.durationMin * MINUTE_MS;
  const stepMs = (eventType.slotIntervalMin ?? eventType.durationMin) * MINUTE_MS;
  const earliest = Math.max(fromMs, nowMs + eventType.minNoticeMin * MINUTE_MS);
  const latest = eventType.horizonDays === null ? Infinity : nowMs + eventType.horizonDays * DAY_MS;
  const beforeMs = eventType.bufferBeforeMin * MINUTE_MS;
  const afterMs = eventType.bufferAfterMin * MINUTE_MS;
  const busy = mergeIntervals(
    host.busy.map((b) => [b.start - b.bufferBeforeMin * MINUTE_MS, b.end + b.bufferAfterMin * MINUTE_MS]),
  );
  /** @type {Map<number, number>} */
  const out = new Map();
  for (const [rangeStart, rangeEnd] of workingIntervals(host, fromMs, toMs)) {
    const gridStart = eventType.alignTimeZone ? alignUp(rangeStart, stepMs, eventType.alignTimeZone) : rangeStart;
    // Jump straight to the first step at or after `earliest` instead of walking from the range start.
    const skip = earliest > gridStart ? Math.ceil((earliest - gridStart) / stepMs) : 0;
    for (let start = gridStart + skip * stepMs; start + durationMs <= rangeEnd; start += stepMs) {
      if (start >= toMs || start > latest) break;
      const end = start + durationMs;
      if (overlapsAny(busy, start - beforeMs, end + afterMs)) continue;
      if (eventType.maxPerDay !== null) {
        const day = toZonedParts(start, host.timeZone).date;
        if ((host.bookedCountByDate[day] ?? 0) >= eventType.maxPerDay) continue;
      }
      out.set(start, end);
      if (out.size > MAX_SLOTS) throw new RangeError('Too many slots; ask for a shorter range');
    }
  }
  return out;
}

/**
 * Bookable slots across hosts.
 * @param {GenerateSlotsInput} input
 * @returns {Slot[]} sorted by start; hostIds keep the order hosts were given in
 */
export function generateSlots(input) {
  const { eventType, hosts, range, now, mode } = parseInput(generateSlotsInputSchema, input, 'slots');
  const window = { fromMs: range.from, toMs: range.to, nowMs: now };
  /** @type {Map<number, { end: number, hostIds: string[] }>} */
  const merged = new Map();
  for (const host of hosts) {
    for (const [start, end] of hostSlots(eventType, host, window)) {
      const slot = merged.get(start);
      if (slot) slot.hostIds.push(host.id);
      else merged.set(start, { end, hostIds: [host.id] });
    }
  }
  const required = mode === 'all' ? new Set(hosts.map((h) => h.id)).size : 1;
  return [...merged.entries()]
    .filter(([, slot]) => new Set(slot.hostIds).size >= required)
    .sort((a, b) => a[0] - b[0])
    .map(([start, slot]) => ({ start: toIso(start), end: toIso(slot.end), hostIds: [...new Set(slot.hostIds)] }));
}

/**
 * Re-check one start before writing a booking (the slot list may be stale).
 * @param {Omit<GenerateSlotsInput, 'range'> & { start: number|string|Date }} input
 * @returns {{ available: boolean, start: string, end: string, hostIds: string[] }}
 */
export function checkSlot({ start, ...rest }) {
  const startMs = toEpochMs(start);
  const [slot] = generateSlots({ ...rest, range: { from: startMs, to: startMs + 1 } });
  const durationMs = (rest.eventType?.durationMin ?? 0) * MINUTE_MS;
  if (slot && toEpochMs(slot.start) === startMs) return { available: true, ...slot };
  return { available: false, start: toIso(startMs), end: toIso(startMs + durationMs), hostIds: [] };
}

/**
 * Group slots by local date in the viewer's zone, for a booking page calendar.
 * @param {Slot[]} slots
 * @param {string} timeZone viewer's zone
 * @returns {{ date: string, slots: (Slot & { localTime: string })[] }[]}
 */
export function groupSlotsByLocalDate(slots, timeZone) {
  const zone = assertTimeZone(timeZone);
  /** @type {Map<string, (Slot & { localTime: string })[]>} */
  const days = new Map();
  for (const slot of slots) {
    const parts = toZonedParts(slot.start, zone);
    if (!days.has(parts.date)) days.set(parts.date, []);
    days.get(parts.date).push({ ...slot, localTime: parts.time });
  }
  return [...days.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, list]) => ({ date, slots: list }));
}
