/**
 * Time helpers for the automation engine. Pure functions, no I/O.
 *
 * - Instants are UTC: accepted as ISO 8601 strings with an offset (or a plain
 *   YYYY-MM-DD date, read as UTC midnight), epoch milliseconds or Date objects,
 *   and produced as ISO strings.
 * - Durations are written like `3d`, `2h`, `30m`, `45s`, `1w`, `250ms` or
 *   compounds such as `1h30m`. There are no months or years: their length
 *   varies, so flows use days or weeks instead.
 * - Wall-clock times ("10:00 in Asia/Kolkata") use IANA zone names through Intl,
 *   so they follow daylight saving rules where a zone has them.
 */

export const DURATION_UNITS = Object.freeze({
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
});

const DURATION_PART = /(\d+)(ms|s|m|h|d|w)/gy;
const DURATION_WHOLE = /^(?:\d+(?:ms|s|m|h|d|w))+$/;

/** Longest duration a flow may express (about ten years); guards against overflow. */
export const MAX_DURATION_MS = 3650 * DURATION_UNITS.d;

/**
 * Parses `1h30m` into milliseconds. Returns null when the text is not a duration.
 * @param {string} text
 * @returns {number | null}
 */
export function parseDuration(text) {
  if (typeof text !== 'string' || !DURATION_WHOLE.test(text)) return null;
  let total = 0;
  DURATION_PART.lastIndex = 0;
  let match;
  while ((match = DURATION_PART.exec(text)) !== null) total += Number(match[1]) * DURATION_UNITS[match[2]];
  return total <= MAX_DURATION_MS ? total : null;
}

/**
 * Formats milliseconds as the shortest duration text, e.g. 90000 -> "1m30s".
 * @param {number} ms
 */
export function formatDuration(ms) {
  if (!Number.isFinite(ms)) return String(ms);
  if (ms === 0) return '0s';
  const sign = ms < 0 ? '-' : '';
  let rest = Math.abs(Math.round(ms));
  let out = '';
  for (const unit of ['w', 'd', 'h', 'm', 's', 'ms']) {
    const size = DURATION_UNITS[unit];
    if (rest >= size) {
      out += `${Math.floor(rest / size)}${unit}`;
      rest %= size;
    }
  }
  return sign + out;
}

const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2}))?$/i;

/**
 * Reads an instant. Strict: ISO 8601 text must carry an offset (or be a bare date),
 * so "2026-03-01 10:00" with no zone is rejected rather than guessed.
 * @param {unknown} value ISO string, epoch ms or Date
 * @returns {number | null} epoch milliseconds
 */
export function parseInstant(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const match = ISO_INSTANT.exec(value.trim());
  if (!match) return null;
  const [, y, mo, d, h, mi, s, frac, zone] = match;
  if (h !== undefined && zone === undefined) return null;
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(Number(y), month)) return null;
  if (h !== undefined && (Number(h) > 23 || Number(mi) > 59 || Number(s ?? 0) > 59)) return null;
  const ms = frac ? Number(frac.slice(0, 3).padEnd(3, '0')) : 0;
  let utc = Date.UTC(Number(y), month - 1, day, Number(h ?? 0), Number(mi ?? 0), Number(s ?? 0), ms);
  if (zone && zone.toUpperCase() !== 'Z') {
    const sign = zone[0] === '-' ? -1 : 1;
    const digits = zone.slice(1).replace(':', '');
    const offsetMinutes = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2));
    if (offsetMinutes > 18 * 60) return null;
    utc -= sign * offsetMinutes * 60_000;
  }
  return utc;
}

/**
 * Converts anything `parseInstant` accepts to milliseconds, or throws.
 * @param {unknown} value
 * @param {string} [what]
 */
export function toMs(value, what = 'time') {
  const ms = parseInstant(value);
  if (ms === null) throw new TypeError(`Expected ${what} as an ISO 8601 instant or epoch milliseconds`);
  return ms;
}

/** @param {number} ms */
export function toIso(ms) {
  return new Date(ms).toISOString();
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

const formatters = new Map();

function formatterFor(timeZone) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'short',
    });
    if (formatters.size > 200) formatters.clear();
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** @param {unknown} timeZone */
export function isValidTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || timeZone.length === 0 || timeZone.length > 64) return false;
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

const WEEKDAYS = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/**
 * Wall-clock parts of an instant in a zone. weekday is ISO: 1 = Monday ... 7 = Sunday.
 * @param {number} ms
 * @param {string} timeZone IANA name
 */
export function zonedParts(ms, timeZone) {
  const parts = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(ms))) parts[part.type] = part.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS[parts.weekday],
  };
}

function offsetAt(ms, timeZone) {
  const p = zonedParts(ms, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * The UTC instant of a wall-clock time in a zone. A time that falls in a daylight
 * saving gap moves forward by the size of the gap (02:30 becomes 03:30).
 * @param {{ year: number, month: number, day: number, hour?: number, minute?: number }} local
 * @param {string} timeZone
 */
export function zonedTimeToUtc(local, timeZone) {
  const guess = Date.UTC(local.year, local.month - 1, local.day, local.hour ?? 0, local.minute ?? 0);
  const first = guess - offsetAt(guess, timeZone);
  const second = guess - offsetAt(first, timeZone);
  return Math.max(first, second);
}

/**
 * The first instant strictly after `afterMs` whose wall-clock time in `timeZone`
 * is `timeOfDay` (HH:MM), on one of `daysOfWeek` (ISO 1-7) when given.
 * @param {number} afterMs
 * @param {string} timeOfDay
 * @param {string} timeZone
 * @param {number[]} [daysOfWeek]
 * @returns {number}
 */
export function nextTimeOfDay(afterMs, timeOfDay, timeZone, daysOfWeek) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(timeOfDay);
  if (!match) throw new RangeError(`"${timeOfDay}" is not a time of day (use HH:MM, 24-hour)`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const allowed = daysOfWeek && daysOfWeek.length > 0 ? new Set(daysOfWeek) : null;
  const today = zonedParts(afterMs, timeZone);
  for (let offset = 0; offset <= 15; offset += 1) {
    const day = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    const local = { year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate(), hour, minute };
    const weekday = ((day.getUTCDay() + 6) % 7) + 1;
    if (allowed && !allowed.has(weekday)) continue;
    const candidate = zonedTimeToUtc(local, timeZone);
    if (candidate > afterMs) return candidate;
  }
  throw new RangeError('No matching time in the next two weeks');
}
