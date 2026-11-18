import { db } from '../../lib/db.js';
import { decodeCursor, pageOf } from '../../lib/pagination.js';
import { errors } from '../../lib/errors.js';
import { unitsIndex } from '../../core/crm/scope.js';
import { applyBookingScope, bookingListScope, loadVisibleBooking } from './access.js';
import { checkStart, loadHostRows } from './availability.js';
import { loadBookingRelations, presentBooking } from './present.js';
import { ACTIVE_STATUSES } from './schemas.js';

// Read side for staff: the bookings list and calendar, one booking, the sidebar counts, and the
// hosts a booking can be given to. Lists are keyset-paginated on (start_at, id).

const MINUTE = 60_000;

/** Order and window per view. "asc" views page forward in time, "desc" views back. */
const VIEWS = {
  upcoming: { order: 'asc', where: (q, now) => q.whereIn('b.status', ACTIVE_STATUSES).where('b.end_at', '>', now) },
  live: { order: 'asc', where: (q, now) => q.whereIn('b.status', ACTIVE_STATUSES).where('b.start_at', '<=', now).where('b.end_at', '>', now) },
  past: { order: 'desc', where: (q, now) => q.where('b.start_at', '<', now) },
  no_shows: { order: 'desc', where: (q) => q.where('b.status', 'no_show') },
  reschedule_requests: { order: 'asc', where: (q) => q.whereIn('b.status', ACTIVE_STATUSES).whereNotNull('b.reschedule_requested_at') },
  cancelled: { order: 'desc', where: (q) => q.where('b.status', 'cancelled') },
  all: { order: 'asc', where: (q) => q },
};

export async function presentBookings(req, rows, trx = db) {
  const [rel, unitsById] = await Promise.all([loadBookingRelations(rows, trx), unitsIndex(req, trx)]);
  const now = Date.now();
  return rows.map((row) => presentBooking(row, rel, { access: req.access, unitsById, userId: req.auth.user.id, now }));
}

export async function listBookings(req, query) {
  const scope = await bookingListScope(req, 'scheduling.view', query.unitId);
  const view = VIEWS[query.view];
  const now = new Date();
  const q = applyBookingScope(db('bookings as b'), scope);
  view.where(q, now);
  if (query.from) q.where('b.end_at', '>', new Date(query.from));
  if (query.to) q.where('b.start_at', '<', new Date(query.to));
  if (query.status) q.whereIn('b.status', query.status);
  if (query.hostUserId) q.where('b.host_user_id', query.hostUserId);
  if (query.eventTypeId) q.where('b.event_type_id', query.eventTypeId);
  if (query.dealId) q.where('b.deal_id', query.dealId);
  if (query.contactId) q.where('b.contact_id', query.contactId);
  const cursor = decodeCursor(query.cursor);
  if (cursor) {
    if (typeof cursor.s !== 'string' || typeof cursor.id !== 'string' || Number.isNaN(Date.parse(cursor.s))) throw errors.badRequest('Invalid cursor');
    const op = view.order === 'asc' ? '>' : '<';
    q.whereRaw(`(b.start_at, b.id) ${op} (?, ?)`, [new Date(cursor.s), cursor.id]);
  }
  const rows = await q
    .orderBy([{ column: 'b.start_at', order: view.order }, { column: 'b.id', order: view.order }])
    .limit(query.limit + 1)
    .select('b.*');
  const { page, nextCursor } = pageOf(rows, query.limit, (row) => ({ s: new Date(row.start_at).toISOString(), id: row.id }));
  return { data: await presentBookings(req, page), nextCursor };
}

export async function getBooking(req, id) {
  const { booking } = await loadVisibleBooking(req, id);
  const [presented] = await presentBookings(req, [booking]);
  return presented;
}

/** Counts for the Bookings page header and sidebar (one query). */
export async function bookingSummary(req, { unitId }) {
  const scope = await bookingListScope(req, 'scheduling.view', unitId);
  const now = new Date();
  const dayAhead = new Date(now.getTime() + 24 * 60 * MINUTE);
  const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * MINUTE);
  const active = `b.status in ('booked', 'rescheduled')`;
  const [row] = await applyBookingScope(db('bookings as b'), scope)
    .where((w) => w.where('b.end_at', '>', monthAgo).orWhereNotNull('b.reschedule_requested_at'))
    .select(
      db.raw(`count(*) filter (where ${active} and b.start_at <= ? and b.end_at > ?)::int as live`, [now, now]),
      db.raw(`count(*) filter (where ${active} and b.start_at > ? and b.start_at <= ?)::int as next24h`, [now, dayAhead]),
      db.raw(`count(*) filter (where ${active} and b.end_at > ?)::int as upcoming`, [now]),
      db.raw(`count(*) filter (where b.status = 'no_show' and b.start_at > ?)::int as "noShows30d"`, [monthAgo]),
      db.raw(`count(*) filter (where ${active} and b.reschedule_requested_at is not null)::int as "rescheduleRequests"`),
      db.raw(`count(*) filter (where ${active} and b.end_at <= ?)::int as "awaitingOutcome"`, [now]),
    );
  return row;
}

/** Hosts of the booking's event type and whether each is free at its time (reassign dialog). */
export async function reassignCandidates(req, id) {
  const { booking } = await loadVisibleBooking(req, id, { permission: 'scheduling.assign' });
  const eventType = await db('scheduling_event_types').where({ id: booking.event_type_id }).first();
  const hostRows = await loadHostRows(eventType);
  const startMs = new Date(booking.start_at).getTime();
  const check = hostRows.length
    ? await checkStart(eventType, startMs, { now: Math.min(Date.now(), startMs - eventType.min_notice_min * MINUTE), excludeBookingId: booking.id, log: req.log })
    : { hostIds: [] };
  const free = new Set(check.hostIds ?? []);
  return hostRows
    .filter((h) => h.user_id !== booking.host_user_id)
    .map((h) => ({ id: h.user_id, name: h.name, timeZone: h.time_zone, available: free.has(h.user_id) }));
}
