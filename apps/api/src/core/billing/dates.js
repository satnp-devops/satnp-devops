/**
 * Calendar-date helpers for billing.
 *
 * Due dates, invoice dates and subscription terms are calendar dates ("2026-04-01"), not instants:
 * an instalment is due on a day in the company's time zone. Instants (UTC ISO strings or epoch
 * milliseconds) are turned into calendar dates with an IANA zone, and back again for reminders.
 * All arithmetic runs on UTC midnights, so it never depends on the server's own zone.
 */
import { errors } from '../../lib/errors.js';

export const DEFAULT_TIME_ZONE = 'Asia/Kolkata';
const DAY_MS = 86_400_000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * @typedef {string} CalendarDate an ISO calendar date, "YYYY-MM-DD"
 * @typedef {string | number | Date} Instant a UTC ISO string, epoch milliseconds or a Date
 */

/** @param {number} year @param {number} month 1-12 */
export const daysInMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** @param {unknown} value */
export const isCalendarDate = (value) => {
  if (typeof value !== 'string') return false;
  const match = DATE_RE.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
};

/**
 * @param {unknown} value
 * @param {string} [path]
 * @returns {{ year: number, month: number, day: number }}
 */
export function parseDate(value, path = 'date') {
  if (!isCalendarDate(value)) throw errors.validation([{ path, message: 'Enter a date as YYYY-MM-DD' }]);
  const [year, month, day] = String(value).split('-').map(Number);
  return { year, month, day };
}

const pad = (n, width = 2) => String(n).padStart(width, '0');

/** @param {number} year @param {number} month @param {number} day @returns {CalendarDate} */
export const formatDate = (year, month, day) => `${pad(year, 4)}-${pad(month)}-${pad(day)}`;

/** Days since 1970-01-01 for a calendar date. @param {CalendarDate} date */
export function toEpochDay(date, path) {
  const { year, month, day } = parseDate(date, path);
  return Date.UTC(year, month - 1, day) / DAY_MS;
}

/** @param {number} epochDay @returns {CalendarDate} */
export function fromEpochDay(epochDay) {
  const d = new Date(epochDay * DAY_MS);
  return formatDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** @param {CalendarDate} date @param {number} days */
export const addDays = (date, days) => fromEpochDay(toEpochDay(date) + days);

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export const daysBetween = (from, to) => toEpochDay(to) - toEpochDay(from);

/** -1, 0 or 1. @param {CalendarDate} a @param {CalendarDate} b */
export const compareDates = (a, b) => Math.sign(daysBetween(b, a));

/**
 * Add calendar months, keeping the anchor day where the month allows and clamping to the month's
 * last day otherwise: 2026-01-31 + 1 month = 2026-02-28, + 2 months = 2026-03-31.
 * @param {CalendarDate} date
 * @param {number} months
 * @param {number} [anchorDay] day of month to aim for (defaults to the date's own day)
 * @returns {CalendarDate}
 */
export function addMonths(date, months, anchorDay) {
  const { year, month, day } = parseDate(date);
  const index = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(index / 12);
  const targetMonth = (index % 12) + 1;
  const wanted = anchorDay ?? day;
  return formatDate(targetYear, targetMonth, Math.min(wanted, daysInMonth(targetYear, targetMonth)));
}

/**
 * @param {Instant} value
 * @param {string} [path]
 * @returns {number} epoch milliseconds
 */
export function toEpochMs(value, path = 'at') {
  const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(String(value));
  if (!Number.isFinite(ms)) throw errors.validation([{ path, message: 'Enter a valid date and time' }]);
  return ms;
}

/** @param {string} timeZone */
function formatterFor(timeZone) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    throw errors.validation([{ path: 'timeZone', message: 'Unknown time zone' }]);
  }
}

/** Wall-clock parts of an instant in a zone. */
function zonedParts(ms, timeZone) {
  /** @type {Record<string, number>} */
  const parts = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return parts;
}

/**
 * The calendar date of an instant in a time zone.
 * @param {Instant} instant
 * @param {string} [timeZone] IANA zone, India by default
 * @returns {CalendarDate}
 */
export function localDate(instant, timeZone = DEFAULT_TIME_ZONE) {
  const p = zonedParts(toEpochMs(instant), timeZone);
  return formatDate(p.year, p.month, p.day);
}

/**
 * Accept either a calendar date (kept as is) or an instant (read in the zone).
 * @param {CalendarDate | Instant} value
 * @param {string} [timeZone]
 * @param {string} [path]
 * @returns {CalendarDate}
 */
export function toCalendarDate(value, timeZone = DEFAULT_TIME_ZONE, path = 'date') {
  if (typeof value === 'string' && DATE_RE.test(value)) {
    parseDate(value, path);
    return value;
  }
  return localDate(toEpochMs(value, path), timeZone);
}

/**
 * The UTC instant at which a wall-clock time on a calendar date happens in a zone
 * (e.g. the end of a due date in India for overdue checks). Handles DST zones too.
 * @param {CalendarDate} date
 * @param {string} [timeZone]
 * @param {string} [time] "HH:MM" or "HH:MM:SS", midnight by default
 * @returns {string} ISO instant
 */
export function zonedDateTimeToInstant(date, timeZone = DEFAULT_TIME_ZONE, time = '00:00:00') {
  const { year, month, day } = parseDate(date);
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time);
  if (!match) throw errors.validation([{ path: 'time', message: 'Enter a time as HH:MM or HH:MM:SS' }]);
  const wall = Date.UTC(year, month - 1, day, Number(match[1]), Number(match[2]), Number(match[3] ?? 0));
  const offsetAt = (ms) => {
    const p = zonedParts(ms, timeZone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
  };
  let guess = wall - offsetAt(wall);
  guess = wall - offsetAt(guess);
  return new Date(guess).toISOString();
}
