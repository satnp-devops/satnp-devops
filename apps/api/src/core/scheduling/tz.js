/**
 * Time zones without a library: everything is derived from Intl.DateTimeFormat, which ships the
 * IANA database with Node (process.versions.tz). Instants are UTC (epoch ms or ISO strings with
 * Z or an offset); wall-clock values are a local date 'YYYY-MM-DD' plus a clock 'HH:MM[:SS]' in
 * a named IANA zone.
 *
 * Local times that do not exist (spring-forward gap) or occur twice (fall-back overlap) follow
 * RFC 5545 §3.3.5 by default: a time in a gap is read with the UTC offset from before the gap
 * (so it moves forward by the gap's length), and a repeated time means its first occurrence.
 */

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** Every weekday key, indexed like Date#getUTCDay (0 = Sunday). */
export const WEEKDAYS = /** @type {const} */ (['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']);

/** Largest instant a JS Date can hold. */
const MAX_EPOCH_MS = 8.64e15;

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/i;
const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const CLOCK = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * Old spellings that ICU still reports as canonical, mapped to their current IANA names
 * (tzdata `backward`, renamed entries only; merged zones such as Europe/Amsterdam keep their name).
 */
const RENAMED_ZONES = Object.freeze({
  'Africa/Asmera': 'Africa/Asmara',
  'America/Buenos_Aires': 'America/Argentina/Buenos_Aires',
  'America/Catamarca': 'America/Argentina/Catamarca',
  'America/Coral_Harbour': 'America/Atikokan',
  'America/Cordoba': 'America/Argentina/Cordoba',
  'America/Godthab': 'America/Nuuk',
  'America/Indianapolis': 'America/Indiana/Indianapolis',
  'America/Jujuy': 'America/Argentina/Jujuy',
  'America/Louisville': 'America/Kentucky/Louisville',
  'America/Mendoza': 'America/Argentina/Mendoza',
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Rangoon': 'Asia/Yangon',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Atlantic/Faeroe': 'Atlantic/Faroe',
  'Europe/Kiev': 'Europe/Kyiv',
  'Pacific/Enderbury': 'Pacific/Kanton',
  'Pacific/Ponape': 'Pacific/Pohnpei',
  'Pacific/Truk': 'Pacific/Chuuk',
});

/** Single-word names that are real IANA zones for UTC. Abbreviations like IST or EST are refused. */
const UTC_ALIASES = new Set(['utc', 'gmt', 'uct', 'universal', 'zulu', 'greenwich']);

const ZONE_SHAPE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,3}$/;

/** @type {Map<string, Intl.DateTimeFormat>} */
const partsFormatters = new Map();
/** @type {Map<string, string|null>} */
const normalizedZones = new Map();

// ---------------------------------------------------------------------------------------------
// Instants

/**
 * Epoch milliseconds from an instant: a number (epoch ms), a Date, or an ISO 8601 string that
 * carries Z or an explicit offset. A string without an offset is refused because it is not an
 * instant (use localToUtc for wall-clock values).
 * @param {number|string|Date} value
 * @returns {number}
 */
export function toEpochMs(value) {
  let ms;
  if (typeof value === 'number') ms = value;
  else if (value instanceof Date) ms = value.getTime();
  else if (typeof value === 'string') {
    if (!ISO_INSTANT.test(value.trim())) {
      throw new RangeError(`Not a UTC instant (needs Z or an offset): ${JSON.stringify(value)}`);
    }
    ms = Date.parse(value.trim());
  } else {
    throw new TypeError('An instant must be epoch milliseconds, a Date or an ISO string');
  }
  if (!Number.isFinite(ms) || Math.abs(ms) > MAX_EPOCH_MS) throw new RangeError(`Invalid instant: ${String(value)}`);
  return ms;
}

/** ISO 8601 UTC string ('2026-11-05T10:00:00.000Z') for an instant. */
export const toIso = (instant) => new Date(toEpochMs(instant)).toISOString();

// ---------------------------------------------------------------------------------------------
// Zones

/**
 * The current IANA name for a zone, or null when it is not a usable IANA zone.
 * Accepts any case and old aliases ('asia/calcutta' → 'Asia/Kolkata', 'US/Eastern' →
 * 'America/New_York', 'Etc/UTC' → 'UTC'); refuses offsets ('+05:30') and abbreviations ('IST',
 * which is ambiguous between India, Ireland and Israel).
 * @param {unknown} name
 * @returns {string|null}
 */
export function normalizeTimeZone(name) {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (normalizedZones.has(trimmed)) return normalizedZones.get(trimmed) ?? null;
  let result = null;
  if (trimmed.length > 0 && trimmed.length <= 64 && ZONE_SHAPE.test(trimmed)) {
    const isUtcWord = UTC_ALIASES.has(trimmed.toLowerCase());
    if (trimmed.includes('/') || isUtcWord) {
      try {
        const resolved = new Intl.DateTimeFormat('en-US', { timeZone: trimmed }).resolvedOptions().timeZone;
        const lower = resolved.toLowerCase();
        if (lower === 'etc/utc' || lower === 'etc/gmt' || UTC_ALIASES.has(lower)) result = 'UTC';
        else result = RENAMED_ZONES[resolved] ?? resolved;
      } catch {
        result = null;
      }
    }
  }
  if (normalizedZones.size < 2000) normalizedZones.set(trimmed, result);
  return result;
}

/** Is this a usable IANA zone name (see normalizeTimeZone)? */
export const isValidTimeZone = (name) => normalizeTimeZone(name) !== null;

/**
 * The normalised zone name, or a RangeError for anything that is not an IANA zone.
 * @param {unknown} name
 * @returns {string}
 */
export function assertTimeZone(name) {
  const zone = normalizeTimeZone(name);
  if (!zone) throw new RangeError(`Unknown time zone: ${JSON.stringify(name)}`);
  return zone;
}

function formatterFor(timeZone) {
  let formatter = partsFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      era: 'short',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'short',
    });
    partsFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/** Epoch ms for calendar fields read as UTC (years 0–99 are not shifted to 1900s as Date.UTC does). */
function utcFromFields(year, month, day, hour = 0, minute = 0, second = 0, millisecond = 0) {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millisecond);
  return date.getTime();
}

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Raw wall-clock fields of an instant in a zone (zone already validated). */
function fieldsAt(timeZone, ms) {
  const parts = formatterFor(timeZone).formatToParts(new Date(ms));
  const map = {};
  for (const part of parts) map[part.type] = part.value;
  let year = Number(map.year);
  if (map.era === 'BC' || map.era === 'B') year = 1 - year;
  return {
    year,
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour) % 24,
    minute: Number(map.minute),
    second: Number(map.second),
    weekday: WEEKDAY_INDEX[map.weekday],
  };
}

/** Offset of a zone at an instant in milliseconds (local − UTC). */
function offsetMsAt(timeZone, ms) {
  const wholeSecond = Math.floor(ms / 1000) * 1000;
  const f = fieldsAt(timeZone, wholeSecond);
  return utcFromFields(f.year, f.month, f.day, f.hour, f.minute, f.second) - wholeSecond;
}

/**
 * UTC offset of a zone at an instant, in minutes east of UTC (Asia/Kolkata → 330,
 * America/New_York in winter → −300). Historical local mean times can be fractional.
 * @param {string} timeZone
 * @param {number|string|Date} instant
 * @returns {number}
 */
export function offsetMinutesAt(timeZone, instant) {
  return offsetMsAt(assertTimeZone(timeZone), toEpochMs(instant)) / MINUTE_MS;
}

/**
 * Wall-clock parts of an instant in a zone.
 * @param {number|string|Date} instant
 * @param {string} timeZone
 * @returns {{ year: number, month: number, day: number, hour: number, minute: number, second: number,
 *   millisecond: number, weekday: number, weekdayKey: string, offsetMinutes: number, date: string,
 *   time: string, timeZone: string }}
 */
export function toZonedParts(instant, timeZone) {
  const zone = assertTimeZone(timeZone);
  const ms = toEpochMs(instant);
  const wholeSecond = Math.floor(ms / 1000) * 1000;
  const f = fieldsAt(zone, wholeSecond);
  const offsetMs = utcFromFields(f.year, f.month, f.day, f.hour, f.minute, f.second) - wholeSecond;
  return {
    ...f,
    millisecond: ms - wholeSecond,
    weekdayKey: WEEKDAYS[f.weekday],
    offsetMinutes: offsetMs / MINUTE_MS,
    date: formatLocalDate(f.year, f.month, f.day),
    time: `${pad2(f.hour)}:${pad2(f.minute)}`,
    timeZone: zone,
  };
}

// ---------------------------------------------------------------------------------------------
// Local dates and clocks

const pad2 = (n) => String(n).padStart(2, '0');

function formatLocalDate(year, month, day) {
  const y = year >= 0 && year <= 9999 ? String(year).padStart(4, '0') : String(year);
  return `${y}-${pad2(month)}-${pad2(day)}`;
}

/**
 * Parse a calendar date 'YYYY-MM-DD' and check it exists (no 2026-02-30).
 * @param {string} value
 * @returns {{ year: number, month: number, day: number }}
 */
export function parseLocalDate(value) {
  const match = typeof value === 'string' ? LOCAL_DATE.exec(value) : null;
  if (!match) throw new RangeError(`Not a date (YYYY-MM-DD): ${JSON.stringify(value)}`);
  const [year, month, day] = match.slice(1).map(Number);
  const check = new Date(utcFromFields(year, month, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() + 1 !== month || check.getUTCDate() !== day) {
    throw new RangeError(`No such date: ${value}`);
  }
  return { year, month, day };
}

export function isLocalDate(value) {
  try {
    parseLocalDate(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Minutes since midnight for a clock 'HH:MM' or 'HH:MM:SS' (seconds become a fraction).
 * '24:00' is accepted only with allowEndOfDay, meaning the end of the day.
 * @param {string} value
 * @param {{ allowEndOfDay?: boolean }} [options]
 * @returns {number}
 */
export function parseClock(value, { allowEndOfDay = false } = {}) {
  const match = typeof value === 'string' ? CLOCK.exec(value) : null;
  if (!match) throw new RangeError(`Not a time (HH:MM): ${JSON.stringify(value)}`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] ?? 0);
  if (hour === 24 && minute === 0 && second === 0 && allowEndOfDay) return 1440;
  if (hour > 23 || minute > 59 || second > 59) throw new RangeError(`No such time: ${value}`);
  return hour * 60 + minute + second / 60;
}

/** 'HH:MM' for minutes since midnight (1440 → '24:00'). */
export function formatClock(minutes) {
  const whole = Math.round(minutes);
  return `${pad2(Math.floor(whole / 60))}:${pad2(whole % 60)}`;
}

/** The calendar date n days after (or before) a local date. */
export function addDays(date, days) {
  const { year, month, day } = parseLocalDate(date);
  const shifted = new Date(utcFromFields(year, month, day) + days * DAY_MS);
  return formatLocalDate(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

/** Weekday of a local date, 0 = Sunday … 6 = Saturday. */
export function weekdayOf(date) {
  const { year, month, day } = parseLocalDate(date);
  return new Date(utcFromFields(year, month, day)).getUTCDay();
}

/** Whole days from one local date to another (positive when `to` is later). */
export function daysBetween(from, to) {
  const a = parseLocalDate(from);
  const b = parseLocalDate(to);
  return Math.round((utcFromFields(b.year, b.month, b.day) - utcFromFields(a.year, a.month, a.day)) / DAY_MS);
}

// ---------------------------------------------------------------------------------------------
// Wall clock → UTC

/**
 * @typedef {'compatible'|'earlier'|'later'|'reject'} Disambiguation
 * compatible (default, RFC 5545 §3.3.5): gap → shift forward, overlap → first occurrence.
 * earlier: gap → the instant just before the gap's length (shift back), overlap → first.
 * later: gap → shift forward, overlap → second occurrence.
 * reject: throw a RangeError for gaps and overlaps.
 */

/**
 * Classify a wall-clock time in a zone: 'valid', 'gap' (skipped by a forward transition) or
 * 'overlap' (repeated by a backward transition), with every instant it can mean.
 * @param {string} date 'YYYY-MM-DD'
 * @param {string} time 'HH:MM' or 'HH:MM:SS'
 * @param {string} timeZone
 * @returns {{ status: 'valid'|'gap'|'overlap', instants: number[], offsetBeforeMinutes: number,
 *   offsetAfterMinutes: number, gapMinutes: number }}
 */
export function inspectLocalTime(date, time, timeZone) {
  const zone = assertTimeZone(timeZone);
  const { year, month, day } = parseLocalDate(date);
  const minutes = parseClock(time);
  const localMs = utcFromFields(year, month, day) + Math.round(minutes * MINUTE_MS);
  return inspectLocalMs(localMs, zone);
}

/** Core of the conversion: localMs is the wall-clock reading expressed as if it were UTC. */
function inspectLocalMs(localMs, zone) {
  const before = offsetMsAt(zone, localMs - DAY_MS);
  const after = offsetMsAt(zone, localMs + DAY_MS);
  // The offset at the naive guess catches zones with two transitions close together.
  const middle = offsetMsAt(zone, localMs - before);
  const instants = [];
  for (const offset of new Set([before, after, middle])) {
    const utc = localMs - offset;
    if (offsetMsAt(zone, utc) === offset && !instants.includes(utc)) instants.push(utc);
  }
  instants.sort((a, b) => a - b);
  const status = instants.length === 0 ? 'gap' : instants.length > 1 ? 'overlap' : 'valid';
  return {
    status,
    instants,
    offsetBeforeMinutes: before / MINUTE_MS,
    offsetAfterMinutes: after / MINUTE_MS,
    gapMinutes: status === 'gap' ? (after - before) / MINUTE_MS : 0,
    localMs,
  };
}

function resolveLocalMs(localMs, zone, disambiguation) {
  const info = inspectLocalMs(localMs, zone);
  if (info.status === 'valid') return info.instants[0];
  if (disambiguation === 'reject') {
    throw new RangeError(`Local time ${new Date(localMs).toISOString().slice(0, 19)} is ${info.status === 'gap' ? 'skipped' : 'repeated'} in ${zone}`);
  }
  if (info.status === 'overlap') {
    return disambiguation === 'later' ? info.instants[info.instants.length - 1] : info.instants[0];
  }
  // Gap: reading the time with the offset from before the gap moves it forward by the gap.
  const offsetBefore = info.offsetBeforeMinutes * MINUTE_MS;
  const offsetAfter = info.offsetAfterMinutes * MINUTE_MS;
  return disambiguation === 'earlier' ? localMs - offsetAfter : localMs - offsetBefore;
}

/**
 * The UTC instant (epoch ms) for a wall-clock time in a zone.
 * @param {string} date 'YYYY-MM-DD'
 * @param {string} time 'HH:MM' or 'HH:MM:SS'; '24:00' means midnight at the end of the date
 * @param {string} timeZone IANA zone
 * @param {{ disambiguation?: Disambiguation }} [options]
 * @returns {number}
 */
export function localToUtc(date, time, timeZone, { disambiguation = 'compatible' } = {}) {
  const zone = assertTimeZone(timeZone);
  const { year, month, day } = parseLocalDate(date);
  const minutes = parseClock(time, { allowEndOfDay: true });
  const localMs = utcFromFields(year, month, day) + Math.round(minutes * MINUTE_MS);
  return resolveLocalMs(localMs, zone, disambiguation);
}

/** localToUtc as an ISO string. */
export const localToUtcIso = (date, time, timeZone, options) =>
  new Date(localToUtc(date, time, timeZone, options)).toISOString();

/** The first instant of a local date in a zone (the day may start at 01:00 where DST begins at midnight). */
export const startOfLocalDay = (date, timeZone) => localToUtc(date, '00:00', timeZone);

/** Real length of a local date in a zone, in minutes (1380 or 1500 on DST change days). */
export const localDayLengthMinutes = (date, timeZone) =>
  (startOfLocalDay(addDays(date, 1), timeZone) - startOfLocalDay(date, timeZone)) / MINUTE_MS;

// ---------------------------------------------------------------------------------------------
// Formatting

/**
 * '+05:30', '-04:00', '+00:00' for an offset in minutes.
 * @param {number} minutes
 */
export function formatOffset(minutes) {
  const sign = minutes < 0 ? '-' : '+';
  const whole = Math.round(Math.abs(minutes));
  return `${sign}${pad2(Math.floor(whole / 60))}:${pad2(whole % 60)}`;
}

/**
 * ISO 8601 with the zone's offset: '2026-11-05T17:30:00+05:30'.
 * @param {number|string|Date} instant
 * @param {string} timeZone
 */
export function toZonedIsoString(instant, timeZone) {
  const p = toZonedParts(instant, timeZone);
  return `${p.date}T${p.time}:${pad2(p.second)}${formatOffset(p.offsetMinutes)}`;
}

/**
 * Human formatting in a zone through Intl (default: medium date, short time, en-IN).
 * @param {number|string|Date} instant
 * @param {string} timeZone
 * @param {{ locale?: string } & Intl.DateTimeFormatOptions} [options]
 */
export function formatInZone(instant, timeZone, { locale = 'en-IN', ...intlOptions } = {}) {
  const zone = assertTimeZone(timeZone);
  const hasFields = Object.keys(intlOptions).length > 0;
  const options = hasFields ? intlOptions : { dateStyle: 'medium', timeStyle: 'short' };
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: zone }).format(new Date(toEpochMs(instant)));
}

/**
 * The zone's name at an instant in a locale: style 'long' → 'India Standard Time',
 * 'short' → 'EST' / 'GMT+5:30', 'longOffset' → 'GMT+05:30'.
 * @param {string} timeZone
 * @param {number|string|Date} instant
 * @param {{ locale?: string, style?: 'long'|'short'|'longOffset'|'shortOffset'|'longGeneric'|'shortGeneric' }} [options]
 */
export function zoneDisplayName(timeZone, instant, { locale = 'en-IN', style = 'long' } = {}) {
  const zone = assertTimeZone(timeZone);
  const parts = new Intl.DateTimeFormat(locale, { timeZone: zone, timeZoneName: style }).formatToParts(
    new Date(toEpochMs(instant)),
  );
  return parts.find((part) => part.type === 'timeZoneName')?.value ?? zone;
}

/**
 * A label for zone pickers: '(GMT+05:30) Asia/Kolkata'.
 * @param {string} timeZone
 * @param {number|string|Date} instant
 */
export function zoneLabel(timeZone, instant) {
  const zone = assertTimeZone(timeZone);
  return `(GMT${formatOffset(offsetMinutesAt(zone, instant))}) ${zone}`;
}
