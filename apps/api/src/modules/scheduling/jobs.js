import { db } from '../../lib/db.js';
import { logger } from '../../lib/logger.js';
import { evaluateBookingAttendance } from './attendance.js';
import { reminderJobs } from './bookings.js';
import { buildInviteFor } from './invites.js';
import { ports } from './ports.js';
import { ACTIVE_STATUSES } from './schemas.js';
import { managePageUrl, manageTokenFor } from './tokens.js';

// Background work for scheduling. The jobs module (platform) wires these processors to its queue:
//
//   'scheduling.reminder'          data { bookingId, sequence, offsetMin }   at booking_reminders.run_at
//   'scheduling.attendance_check'  data { bookingId, sequence }              booked end + attendanceCheckMinutes
//
// Jobs are handed over through the scheduleJobs / cancelJobs ports after each commit (job ids are
// deterministic: reminder-<booking>-s<sequence>-m<offset>, attendance-<booking>-s<sequence>), and
// pendingJobs() lists everything still due, for a start-up reconcile. Until the jobs module lands,
// the worker can run sweepDueReminders() every minute: it claims due rows with SKIP LOCKED, so it
// is safe next to queued jobs and in several workers.
//
// Every processor is idempotent: a reminder row is sent once (status scheduled → sent, row locked),
// a stale job (older sequence, cancelled booking) is skipped, and outcomes are recorded once.

/**
 * Send one reminder. Throws when the message port fails so the jobs module retries it.
 * @returns {Promise<'sent' | 'skipped' | 'gone'>}
 */
export async function processReminderJob({ data }, { now = Date.now(), log = logger } = {}) {
  const { bookingId, sequence, offsetMin } = data ?? {};
  if (!bookingId) return 'gone';
  return db.transaction(async (trx) => {
    const reminder = await trx('booking_reminders')
      .where({ booking_id: bookingId, sequence, offset_min: offsetMin })
      .forUpdate()
      .skipLocked()
      .first();
    if (!reminder || reminder.status !== 'scheduled') return 'gone';
    const booking = await trx('bookings').where({ id: bookingId }).first();
    const stale = !booking || !ACTIVE_STATUSES.includes(booking.status) || booking.ics_sequence !== reminder.sequence;
    const late = new Date(booking?.start_at ?? 0).getTime() <= now;
    if (stale || late) {
      await trx('booking_reminders')
        .where({ id: reminder.id })
        .update({ status: stale ? 'cancelled' : 'skipped', skip_reason: stale ? 'stale' : 'started', updated_at: trx.fn.now() });
      return 'skipped';
    }
    // One query at a time: a transaction is one connection.
    const eventType = await trx('scheduling_event_types').where({ id: booking.event_type_id }).first();
    const host = booking.host_user_id ? await trx('users').where({ id: booking.host_user_id }).first('id', 'name', 'email') : null;
    const company = await trx('org_units').where({ id: booking.company_id }).first();
    const { ics, method } = buildInviteFor({ booking, eventType, host, company, now });
    // Called directly (not callPort) so a failure rolls back and the job is retried.
    await ports().sendBookingMessage({
      kind: 'reminder',
      booking,
      eventType,
      company,
      host,
      ics,
      icsMethod: method,
      manageUrl: managePageUrl(manageTokenFor(booking)),
      reminder: { offset_min: reminder.offset_min, run_at: reminder.run_at },
    });
    await trx('booking_reminders').where({ id: reminder.id }).update({ status: 'sent', sent_at: new Date(now), updated_at: trx.fn.now() });
    log.debug({ scheduling: { bookingId, offsetMin } }, 'Booking reminder sent');
    return 'sent';
  });
}

/**
 * After the booked end: fetch the provider's attendance report (fetchAttendance port) and decide
 * attended / no-show. Without a report, decides from stored webhook events; with neither, leaves
 * the outcome to the host.
 */
export async function processAttendanceCheckJob({ data }, { now = Date.now(), log = logger } = {}) {
  const { bookingId, sequence } = data ?? {};
  const booking = bookingId ? await db('bookings').where({ id: bookingId }).first() : null;
  if (!booking || !ACTIVE_STATUSES.includes(booking.status)) return { status: 'gone' };
  if (sequence !== undefined && booking.ics_sequence !== sequence) return { status: 'stale' };
  if (new Date(booking.end_at).getTime() > now) return { status: 'early' };
  const meeting = await db('meetings').where({ booking_id: bookingId }).first();
  let report = null;
  try {
    report = await ports().fetchAttendance({ booking, meeting });
  } catch (err) {
    log.warn({ err, bookingId }, 'Attendance report unavailable; using webhook data');
  }
  const result = await evaluateBookingAttendance({ bookingId, report, finalize: true, now, source: report ? 'provider_report' : 'attendance_check' });
  return { status: 'checked', ...result };
}

export const jobProcessors = Object.freeze({
  'scheduling.reminder': processReminderJob,
  'scheduling.attendance_check': processAttendanceCheckJob,
});

/**
 * Due reminders, claimed and sent (development fallback and safety net). Returns how many were sent.
 */
export async function sweepDueReminders({ now = Date.now(), limit = 200, log = logger } = {}) {
  const due = await db('booking_reminders')
    .where('status', 'scheduled')
    .where('run_at', '<=', new Date(now))
    .orderBy('run_at')
    .limit(limit)
    .select('booking_id', 'sequence', 'offset_min');
  let sent = 0;
  for (const row of due) {
    try {
      const outcome = await processReminderJob({ data: { bookingId: row.booking_id, sequence: row.sequence, offsetMin: row.offset_min } }, { now, log });
      if (outcome === 'sent') sent += 1;
    } catch (err) {
      log.error({ err, bookingId: row.booking_id }, 'Booking reminder failed; will retry');
    }
  }
  return { due: due.length, sent };
}

/** Attendance checks that are due (bookings that ended a while ago and still have no outcome). */
export async function sweepAttendanceChecks({ now = Date.now(), minutesAfterEnd = 30, limit = 100, log = logger } = {}) {
  const rows = await db('bookings')
    .whereIn('status', ACTIVE_STATUSES)
    .whereIn('location_kind', ['zoom', 'google_meet', 'teams'])
    .where('end_at', '<=', new Date(now - minutesAfterEnd * 60_000))
    .where('end_at', '>', new Date(now - 7 * 86_400_000))
    .orderBy('end_at')
    .limit(limit)
    .select('id', 'ics_sequence');
  const results = [];
  for (const row of rows) {
    try {
      results.push(await processAttendanceCheckJob({ data: { bookingId: row.id, sequence: row.ics_sequence } }, { now, log }));
    } catch (err) {
      log.error({ err, bookingId: row.id }, 'Attendance check failed');
    }
  }
  return results;
}

/**
 * Every reminder job still to run (for the jobs module to enqueue at start-up or after an outage;
 * job ids are deterministic, so enqueueing twice is harmless).
 */
export async function pendingJobs({ now = Date.now(), limit = 5000 } = {}) {
  const rows = await db('booking_reminders as r')
    .join('bookings as b', 'b.id', 'r.booking_id')
    .where('r.status', 'scheduled')
    .whereIn('b.status', ACTIVE_STATUSES)
    .whereRaw('r.sequence = b.ics_sequence')
    .orderBy('r.run_at')
    .limit(limit)
    .select('r.*');
  return reminderJobs(rows, now);
}
