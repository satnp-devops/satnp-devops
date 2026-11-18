/**
 * Time-zone helpers built on Intl only. No clock reads: every function takes the instant.
 * Instants are epoch milliseconds or ISO strings; zones are IANA names.
 */

const formatters = new Map();
const WEEKDAYS = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

function partsIn(timeZone, ms) {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, format);
  }
  return Object.fromEntries(format.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
}

/** Is this a time zone Intl knows? */
export function isTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Epoch ms from a number, Date or ISO string (NaN when unreadable). */
export const toMs = (value) => (value instanceof Date ? value.getTime() : typeof value === 'number' ? value : new Date(value).getTime());

/** UTC offset of a zone at an instant, in minutes (Asia/Kolkata → 330, America/New_York → -300 or -240). */
export function zoneOffsetMinutes(timeZone, ms) {
  const p = partsIn(timeZone, ms);
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

/** Local ISO weekday (1 = Monday) and minutes after midnight in a zone. */
export function localTime(timeZone, ms) {
  const p = partsIn(timeZone, ms);
  return { isoDay: WEEKDAYS[p.weekday], minutes: (Number(p.hour) % 24) * 60 + Number(p.minute) };
}

/**
 * The UTC instant of a wall-clock time in a zone ("10:30 on 5 Nov 2026 in Asia/Kolkata").
 * For a time skipped by a DST change the result lands just after the gap.
 */
export function zonedTimeToUtc({ year, month, day, hour = 0, minute = 0, second = 0 }, timeZone) {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = wall - zoneOffsetMinutes(timeZone, wall) * 60000;
  const corrected = wall - zoneOffsetMinutes(timeZone, guess) * 60000;
  if (corrected !== guess) guess = corrected;
  return guess;
}

const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + (m || 0);
};

/**
 * @typedef {object} WorkingHours  Same shape as the phase 1 workingHours.* settings.
 * @property {number[]} [days]  ISO weekdays, 1 = Monday … 7 = Sunday (default Mon–Sat)
 * @property {string} [start]  "09:30"
 * @property {string} [end]  "18:30"; earlier than start means the shift runs past midnight
 */

/**
 * Is `ms` inside the working hours, read in `timeZone`? A shift past midnight belongs to the
 * day it started on.
 * @param {WorkingHours} hours
 * @param {string} timeZone
 * @param {number} ms
 */
export function isWorkingTime(hours, timeZone, ms) {
  const { isoDay, minutes } = localTime(timeZone, ms);
  const days = hours.days ?? [1, 2, 3, 4, 5, 6];
  const start = toMinutes(hours.start ?? '00:00');
  const end = toMinutes(hours.end ?? '24:00');
  if (start === end) return days.includes(isoDay);
  if (start < end) return days.includes(isoDay) && minutes >= start && minutes < end;
  const previous = isoDay === 1 ? 7 : isoDay - 1;
  return (days.includes(isoDay) && minutes >= start) || (days.includes(previous) && minutes < end);
}
