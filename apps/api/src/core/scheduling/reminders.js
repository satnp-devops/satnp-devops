/**
 * When to send booking reminders.
 *
 * Rules:
 *  1. One reminder per offset before the start (default 24 h and 1 h: [1440, 60] minutes).
 *  2. A reminder whose time has already passed (≤ now) is skipped ('past'), e.g. the 24 h
 *     reminder for a booking made 3 hours ahead.
 *  3. Optional quiet hours in the attendee's zone, e.g. 21:00–08:00 (a window may cross midnight;
 *     its boundary minutes are allowed). A reminder inside the window moves:
 *       'auto' (default): to the window's end if that is still ≥ minLeadMin before the start,
 *                         otherwise to the window's start (the last moment before quiet time);
 *       'later' / 'earlier': only that direction.
 *     If the moved time is past, or not before the start, the reminder is skipped ('quiet_hours').
 *  4. Reminders closer together than minGapMin collapse into one (the one whose offset best
 *     matches its actual lead time is kept); the other is skipped ('duplicate').
 * Results are sorted by send time. Times are UTC ISO strings.
 */
import { z } from 'zod';
import { parseInput } from './errors.js';
import { MINUTE_MS, addDays, assertTimeZone, isValidTimeZone, localToUtc, toEpochMs, toIso, toZonedParts } from './tz.js';

export const DEFAULT_REMINDER_OFFSETS_MIN = Object.freeze([1440, 60]);

const instantSchema = z.union([z.number(), z.string(), z.date()]).transform((value, ctx) => {
  try {
    return toEpochMs(value);
  } catch (error) {
    ctx.addIssue({ code: 'custom', message: error.message });
    return z.NEVER;
  }
});

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (00:00–23:59)');

export const quietHoursSchema = z
  .object({ start: clock, end: clock, shift: z.enum(['auto', 'later', 'earlier']).default('auto') })
  .refine((q) => q.start !== q.end, { message: 'Quiet hours need a start and end that differ' });

export const remindersInputSchema = z
  .object({
    start: instantSchema,
    now: instantSchema,
    offsetsMin: z.array(z.number().int().min(0).max(60 * 24 * 60)).max(10).default([...DEFAULT_REMINDER_OFFSETS_MIN]),
    /** Attendee's IANA zone; required with quietHours. */
    timeZone: z.string().refine(isValidTimeZone, { message: 'Unknown IANA time zone' }).transform(assertTimeZone).optional(),
    quietHours: quietHoursSchema.optional(),
    /** A reminder moved later must still arrive this long before the start. */
    minLeadMin: z.number().int().min(0).max(1440).default(15),
    minGapMin: z.number().int().min(0).max(1440).default(15),
  })
  .refine((input) => !input.quietHours || input.timeZone, { message: 'quietHours needs the attendee timeZone', path: ['timeZone'] });

/**
 * @typedef {{ offsetMin: number, at: string, shifted: 'later'|'earlier'|null }} Reminder
 * @typedef {{ offsetMin: number, reason: 'past'|'quiet_hours'|'duplicate' }} SkippedReminder
 */

/**
 * The quiet window containing an instant, as [startMs, endMs], or null. Boundaries are allowed.
 * @param {number} atMs
 * @param {{ start: string, end: string }} quiet
 * @param {string} timeZone
 */
export function quietWindowAt(atMs, quiet, timeZone) {
  const zone = assertTimeZone(timeZone);
  const today = toZonedParts(atMs, zone).date;
  const overnight = quiet.end < quiet.start;
  // A window that crosses midnight may have started yesterday.
  for (const date of overnight ? [addDays(today, -1), today] : [today]) {
    const startMs = localToUtc(date, quiet.start, zone);
    const endMs = localToUtc(overnight ? addDays(date, 1) : date, quiet.end, zone);
    if (atMs > startMs && atMs < endMs) return [startMs, endMs];
  }
  return null;
}

/**
 * Reminder send times for a booking.
 * @param {z.input<typeof remindersInputSchema>} input
 * @returns {{ reminders: Reminder[], skipped: SkippedReminder[] }}
 */
export function computeReminders(input) {
  const options = parseInput(remindersInputSchema, input, 'reminders');
  const { start, now, quietHours, timeZone } = options;
  const minLeadMs = options.minLeadMin * MINUTE_MS;
  /** @type {SkippedReminder[]} */
  const skipped = [];
  /** @type {{ offsetMin: number, atMs: number, shifted: 'later'|'earlier'|null }[]} */
  const planned = [];

  for (const offsetMin of [...new Set(options.offsetsMin)].sort((a, b) => b - a)) {
    let atMs = start - offsetMin * MINUTE_MS;
    let shifted = null;
    if (atMs <= now) {
      skipped.push({ offsetMin, reason: 'past' });
      continue;
    }
    if (quietHours && timeZone) {
      const window = quietWindowAt(atMs, quietHours, timeZone);
      if (window) {
        const [quietStart, quietEnd] = window;
        const laterOk = quietEnd <= start - minLeadMs;
        const earlierOk = quietStart > now && quietStart < start;
        if (quietHours.shift !== 'earlier' && laterOk) {
          atMs = quietEnd;
          shifted = 'later';
        } else if (quietHours.shift !== 'later' && earlierOk) {
          atMs = quietStart;
          shifted = 'earlier';
        } else {
          skipped.push({ offsetMin, reason: 'quiet_hours' });
          continue;
        }
      }
    }
    planned.push({ offsetMin, atMs, shifted });
  }

  planned.sort((a, b) => a.atMs - b.atMs || b.offsetMin - a.offsetMin);
  const kept = [];
  const misfit = (r) => Math.abs((start - r.atMs) / MINUTE_MS - r.offsetMin);
  for (const reminder of planned) {
    const previous = kept[kept.length - 1];
    if (previous && reminder.atMs - previous.atMs < options.minGapMin * MINUTE_MS) {
      if (misfit(reminder) < misfit(previous)) {
        skipped.push({ offsetMin: previous.offsetMin, reason: 'duplicate' });
        kept[kept.length - 1] = reminder;
      } else {
        skipped.push({ offsetMin: reminder.offsetMin, reason: 'duplicate' });
      }
      continue;
    }
    kept.push(reminder);
  }

  return {
    reminders: kept.map((r) => ({ offsetMin: r.offsetMin, at: toIso(r.atMs), shifted: r.shifted })),
    skipped,
  };
}

/**
 * A stable BullMQ job id for a reminder (BullMQ refuses ":" in custom ids), so a reschedule (new sequence) never collides with an old
 * job and a retried enqueue is deduplicated by the queue.
 * @param {string} bookingId
 * @param {number} offsetMin
 * @param {number} [sequence]
 */
export const reminderJobId = (bookingId, offsetMin, sequence = 0) => `reminder-${bookingId}-s${sequence}-m${offsetMin}`;
