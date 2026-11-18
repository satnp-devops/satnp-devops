import { db } from '../../lib/db.js';
import { checkSlot, generateSlots, toZonedParts } from '../../core/scheduling/index.js';
import { ACTIVE_STATUSES } from './schemas.js';
import { callPort } from './ports.js';

// Glue between the tables and the pure engine (core/scheduling): load hosts, their weekly hours and
// busy time, and turn them into generateSlots / checkSlot input. The pure builders are exported for tests.

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

/** The engine's event type from a scheduling_event_types row. */
export function engineEventType(row) {
  return {
    durationMin: row.duration_min,
    slotIntervalMin: row.slot_interval_min ?? undefined,
    bufferBeforeMin: row.buffer_before_min,
    bufferAfterMin: row.buffer_after_min,
    minNoticeMin: row.min_notice_min,
    maxPerDay: row.max_per_day ?? null,
    horizonDays: row.horizon_days,
    alignTimeZone: row.align_time_zone ?? undefined,
  };
}

/**
 * Active hosts of an event type with their availability and user details, in a stable order
 * (priority, then name). People without saved availability have no hours, so they're left out.
 * 'single' event types use only their first host.
 */
export async function loadHostRows(eventType, trx = db) {
  const rows = await trx('scheduling_event_type_hosts as h')
    .join('users as u', 'u.id', 'h.user_id')
    .join('scheduling_availability as a', 'a.user_id', 'h.user_id')
    .where('h.event_type_id', eventType.id)
    .where('h.active', true)
    .where('u.status', 'active')
    .orderBy([{ column: 'h.priority', order: 'desc' }, { column: 'u.name' }, { column: 'u.id' }])
    .select(
      'h.user_id',
      'h.weight',
      'h.priority',
      'h.languages',
      'u.name',
      'u.email',
      'a.time_zone',
      'a.weekly',
      'a.overrides',
    );
  return eventType.assignment === 'single' ? rows.slice(0, 1) : rows;
}

/**
 * Active bookings of the hosts that could block [fromMs, toMs): any event type, any company, since a
 * person can't be in two meetings. Widened by a day on each side so buffers and local-day counts
 * (daily limits) see everything.
 */
export function loadBusyBookings(hostIds, fromMs, toMs, { excludeBookingId = null, trx = db } = {}) {
  if (hostIds.length === 0) return Promise.resolve([]);
  return trx('bookings')
    .whereIn('host_user_id', hostIds)
    .whereIn('status', ACTIVE_STATUSES)
    .where('start_at', '<', new Date(toMs + DAY_MS))
    .where('end_at', '>', new Date(fromMs - DAY_MS))
    .modify((query) => {
      if (excludeBookingId) query.whereNot('id', excludeBookingId);
    })
    .select('id', 'host_user_id', 'event_type_id', 'start_at', 'end_at', 'buffer_before_min', 'buffer_after_min');
}

/**
 * Engine hosts (pure). bookedCountByDate counts this event type's bookings per host-local date, for
 * maxPerDay. External busy intervals (calendar connectors) block time without counting.
 */
export function buildEngineHosts({ hostRows, bookings, external = [], eventTypeId }) {
  return hostRows.map((host) => {
    const own = bookings.filter((b) => b.host_user_id === host.user_id);
    const bookedCountByDate = {};
    for (const booking of own) {
      if (booking.event_type_id !== eventTypeId) continue;
      const date = toZonedParts(new Date(booking.start_at).getTime(), host.time_zone).date;
      bookedCountByDate[date] = (bookedCountByDate[date] ?? 0) + 1;
    }
    const busy = [
      ...own.map((b) => ({
        start: new Date(b.start_at).getTime(),
        end: new Date(b.end_at).getTime(),
        bufferBeforeMin: b.buffer_before_min ?? 0,
        bufferAfterMin: b.buffer_after_min ?? 0,
      })),
      ...external
        .filter((e) => e.userId === host.user_id)
        .map((e) => ({ start: new Date(e.start).getTime(), end: new Date(e.end).getTime() }))
        .filter((e) => e.end > e.start),
    ];
    return {
      id: host.user_id,
      timeZone: host.time_zone,
      weekly: host.weekly ?? {},
      overrides: host.overrides ?? {},
      busy,
      bookedCountByDate,
    };
  });
}

/** Everything the engine needs for one event type over [fromMs, toMs). */
export async function engineInput(eventType, { fromMs, toMs, excludeBookingId = null, hostRows = null, trx = db, log } = {}) {
  const hosts = hostRows ?? (await loadHostRows(eventType, trx));
  const hostIds = hosts.map((h) => h.user_id);
  const pad = (eventType.buffer_before_min + eventType.buffer_after_min + eventType.duration_min) * MINUTE_MS;
  const [bookings, external] = await Promise.all([
    loadBusyBookings(hostIds, fromMs - pad, toMs + pad, { excludeBookingId, trx }),
    hostIds.length
      ? callPort(
          'getExternalBusy',
          { companyId: eventType.company_id, hostUserIds: hostIds, from: new Date(fromMs - DAY_MS).toISOString(), to: new Date(toMs + DAY_MS).toISOString() },
          log,
        )
      : [],
  ]);
  return {
    hostRows: hosts,
    eventType: engineEventType(eventType),
    hosts: buildEngineHosts({ hostRows: hosts, bookings, external: Array.isArray(external) ? external : [], eventTypeId: eventType.id }),
  };
}

/** Bookable slots in [fromMs, toMs). */
export async function slotsFor(eventType, { fromMs, toMs, now = Date.now(), excludeBookingId = null, trx = db, log } = {}) {
  const input = await engineInput(eventType, { fromMs, toMs, excludeBookingId, trx, log });
  if (input.hosts.length === 0) return { slots: [], hostRows: input.hostRows };
  const slots = generateSlots({ eventType: input.eventType, hosts: input.hosts, range: { from: fromMs, to: toMs }, now, mode: 'any' });
  return { slots, hostRows: input.hostRows };
}

/** Re-check one start with fresh busy data (inside the booking transaction, after the host locks). */
export async function checkStart(eventType, startMs, { now = Date.now(), excludeBookingId = null, onlyHostIds = null, trx = db, log } = {}) {
  let hostRows = await loadHostRows(eventType, trx);
  if (onlyHostIds) hostRows = hostRows.filter((h) => onlyHostIds.includes(h.user_id));
  const durationMs = eventType.duration_min * MINUTE_MS;
  const input = await engineInput(eventType, { fromMs: startMs, toMs: startMs + durationMs, excludeBookingId, hostRows, trx, log });
  if (input.hosts.length === 0) return { available: false, hostIds: [], hostRows };
  const result = checkSlot({ eventType: input.eventType, hosts: input.hosts, now, start: startMs, mode: 'any' });
  return { ...result, hostRows };
}

/**
 * Serialise bookings per host: a transaction-scoped advisory lock for each host, taken in id order
 * so two bookings never wait on each other in opposite orders.
 */
export async function lockHosts(trx, hostIds) {
  for (const id of [...new Set(hostIds)].sort()) {
    await trx.raw('select pg_advisory_xact_lock(hashtextextended(?, 0))', [`scheduling.host:${id}`]);
  }
}

/**
 * Round-robin fairness inputs: confirmed (not cancelled) bookings of this event type per host in the
 * window, and when each host was last booked.
 */
export async function fairnessStats(eventTypeId, hostIds, { windowDays, now = Date.now(), trx = db }) {
  if (hostIds.length === 0) return new Map();
  const rows = await trx('bookings')
    .where('event_type_id', eventTypeId)
    .whereIn('host_user_id', hostIds)
    .whereNot('status', 'cancelled')
    .where('created_at', '>=', new Date(now - windowDays * DAY_MS))
    .groupBy('host_user_id')
    .select('host_user_id', trx.raw('count(*)::int as count'), trx.raw('max(created_at) as last_at'));
  return new Map(rows.map((row) => [row.host_user_id, { count: row.count, lastAt: row.last_at }]));
}
