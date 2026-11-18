// Due dates are stored in UTC; "today" depends on the viewer's time zone. Pure functions, no
// dependencies: Intl gives the local calendar date of an instant, and a binary search finds the
// first instant of a local day, so DST changes (23- and 25-hour days, midnight gaps) and
// half-hour or 45-minute offsets all work.

const HOUR = 3_600_000;
const formatters = new Map();

function formatter(timeZone) {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    formatters.set(timeZone, format);
  }
  return format;
}

/** Is this an IANA time zone the runtime knows? */
export function isValidTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || timeZone.length === 0 || timeZone.length > 64) return false;
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** The first valid time zone among the candidates (query, user, setting), else the fallback. */
export function resolveTimeZone(candidates, fallback = 'Asia/Kolkata') {
  return candidates.find(isValidTimeZone) ?? fallback;
}

/** The local calendar date of an instant in a time zone, as "YYYY-MM-DD". */
export function localDateKey(instant, timeZone) {
  const parts = formatter(timeZone).formatToParts(new Date(instant));
  const get = (type) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** The first instant (UTC) of the local day that contains `instant`. */
export function startOfLocalDay(instant, timeZone) {
  const ms = new Date(instant).getTime();
  const target = localDateKey(ms, timeZone);
  // A local day lasts at most 25 hours, so 30 hours earlier is always an earlier date.
  let lo = ms - 30 * HOUR;
  let hi = ms;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (localDateKey(mid, timeZone) >= target) hi = mid;
    else lo = mid;
  }
  return new Date(hi);
}

/**
 * Today's bounds in a time zone, as UTC instants: [startOfToday, startOfTomorrow).
 * @returns {{ timeZone: string, startOfToday: Date, startOfTomorrow: Date }}
 */
export function dayBounds(now, timeZone) {
  const startOfToday = startOfLocalDay(now, timeZone);
  // 26 hours after the start of a day (23 to 25 hours long) is always inside the next day.
  const startOfTomorrow = startOfLocalDay(startOfToday.getTime() + 26 * HOUR, timeZone);
  return { timeZone, startOfToday, startOfTomorrow };
}

/**
 * Which "My tasks" group an open task falls in for a viewer:
 *   overdue (due before now), today (later today), upcoming (from tomorrow), none (no due date).
 * Done and cancelled tasks are "done".
 */
export function taskGroup(task, { now, startOfTomorrow }) {
  if (task.status !== 'open') return 'done';
  if (!task.dueAt) return 'none';
  const due = new Date(task.dueAt).getTime();
  if (due < new Date(now).getTime()) return 'overdue';
  if (due < new Date(startOfTomorrow).getTime()) return 'today';
  return 'upcoming';
}
