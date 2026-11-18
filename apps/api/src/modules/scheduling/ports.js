import { createHash } from 'node:crypto';
import { enqueueMail } from '../../core/queue.js';
import { logger } from '../../lib/logger.js';

// Ports: what scheduling needs from modules built elsewhere. The integrator connects them with
//   configureSchedulingPorts({ createOnlineMeeting, sendBookingMessage, scheduleJobs, ... })
// at start-up (API and worker). Until then the development defaults below keep everything working
// locally: simulated meeting links, emails through the console mailer, no external calendars, and
// reminder jobs left to the sweep (jobs.js, processDueReminders).
//
// Every port is called AFTER the database transaction commits, and a failing port never undoes a
// booking: errors are logged and the booking keeps going (a missing meeting link can be added later).
//
//   createOnlineMeeting({ booking, eventType, host })      → { provider, url, ref } | null
//       integration framework: getAdapter(companyId, 'meetings').createMeeting(...)
//       (Zoom createMeeting, Google insertEvent({ withMeet: true }), Graph createEvent).
//       Pass booking.id as the idempotency key.
//   updateOnlineMeeting({ booking, eventType, host })      → void (new time or host)
//   cancelOnlineMeeting({ booking })                        → void
//   fetchAttendance({ booking, meeting })                   → null (no connection) |
//       { sessions: [{ name, email, joinTime, leaveTime, ... }], startedAt?, endedAt?, ended: boolean }
//       (Zoom listParticipants, Meet getMeetingAttendance, Graph getMeetingAttendance)
//   getExternalBusy({ companyId, hostUserIds, from, to })  → [{ userId, start, end }] (calendar free/busy)
//   sendBookingMessage({ kind, booking, eventType, company, host, ics, icsMethod, manageUrl, reminder? })
//       kind: confirmation | rescheduled | cancelled | reassigned | reminder. messaging module
//       (email with the .ics attached, WhatsApp template for reminders). Returns { channel, id } | null.
//   sendBookingLink({ link, url, channel, to, contact, deal, message, actorUserId, companyId })
//       messaging module: the SendBookingLinkDialog's "send". Returns { status, channel, id? }.
//   scheduleJobs(jobs)   jobs: [{ name, jobId, runAt, delayMs, data }]   background jobs module
//   cancelJobs(jobIds)                                                     background jobs module

const devMeetingUrl = {
  zoom: (seed) => `https://zoom.us/j/9${seed.replace(/\D/g, '').padEnd(10, '0').slice(0, 10)}`,
  google_meet: (seed) => {
    const letters = seed.replace(/[^a-z]/g, '').padEnd(10, 'x');
    return `https://meet.google.com/${letters.slice(0, 3)}-${letters.slice(3, 7)}-${letters.slice(7, 10)}`;
  },
  teams: (seed) => `https://teams.microsoft.com/l/meetup-join/dev-${seed.slice(0, 24)}`,
};

const providerFor = { zoom: 'zoom', google_meet: 'google_meet', teams: 'teams' };

function seedFor(id) {
  // Deterministic per booking, letters and digits, so a retry gives the same simulated link.
  const hex = createHash('sha256').update(id).digest('hex');
  return hex + hex.replace(/[0-9]/g, (d) => 'ghijklmnop'[Number(d)]);
}

export const developmentPorts = Object.freeze({
  async createOnlineMeeting({ booking }) {
    const make = devMeetingUrl[booking.location_kind];
    if (!make) return null;
    const seed = seedFor(booking.id);
    return { provider: providerFor[booking.location_kind], url: make(seed), ref: `dev-${booking.id}`, simulated: true };
  },
  async updateOnlineMeeting() {},
  async cancelOnlineMeeting() {},
  async fetchAttendance() {
    return null;
  },
  async getExternalBusy() {
    return [];
  },
  async sendBookingMessage({ kind, booking, eventType, host, manageUrl, reminder }) {
    if (!booking.invitee_email) return null;
    const when = new Date(booking.start_at).toLocaleString('en-IN', { timeZone: booking.time_zone, dateStyle: 'full', timeStyle: 'short' });
    const subjects = {
      confirmation: `Booked: ${eventType.name}, ${when}`,
      rescheduled: `New time: ${eventType.name}, ${when}`,
      cancelled: `Cancelled: ${eventType.name}, ${when}`,
      reassigned: `Updated: ${eventType.name}, ${when}`,
      reminder: `Reminder: ${eventType.name}, ${when}`,
    };
    const lines = [
      `Hello ${booking.invitee_name},`,
      '',
      `${eventType.name} on ${when} (${booking.time_zone})${host ? ` with ${host.name}` : ''}.`,
      booking.meeting_url ? `Join: ${booking.meeting_url}` : null,
      booking.location_detail ? `Where: ${booking.location_detail}` : null,
      kind === 'cancelled' ? null : `Reschedule or cancel: ${manageUrl}`,
      reminder ? `(reminder ${reminder.offset_min} minutes before)` : null,
    ].filter((line) => line !== null);
    await enqueueMail({ to: booking.invitee_email, subject: subjects[kind] ?? subjects.confirmation, text: lines.join('\n') });
    return { channel: 'email', id: null };
  },
  async sendBookingLink({ url, channel, to, message }) {
    if (channel === 'email' && to) {
      await enqueueMail({ to, subject: 'Pick a time that suits you', text: `${message ? `${message}\n\n` : ''}${url}` });
      return { status: 'queued', channel };
    }
    logger.info({ scheduling: { channel } }, 'Booking link send (development: not delivered; the messaging module connects this port)');
    return { status: 'logged', channel };
  },
  async scheduleJobs(jobs) {
    logger.debug({ scheduling: { jobs: jobs.map((job) => job.jobId) } }, 'Scheduling jobs (development: left to the reminder sweep)');
  },
  async cancelJobs() {},
});

let current = { ...developmentPorts };

/** Connect real implementations (integrator). Unknown keys are refused so typos don't silently fall back. */
export function configureSchedulingPorts(overrides = {}) {
  for (const key of Object.keys(overrides)) {
    if (!(key in developmentPorts)) throw new Error(`Unknown scheduling port "${key}"`);
    if (typeof overrides[key] !== 'function') throw new Error(`Scheduling port "${key}" must be a function`);
  }
  current = { ...current, ...overrides };
}

/** Back to the development defaults (tests). */
export function resetSchedulingPorts() {
  current = { ...developmentPorts };
}

export const ports = () => current;

/** Run a port after commit; failures are logged, never thrown. */
export async function callPort(name, input, log = logger) {
  try {
    return await current[name](input);
  } catch (err) {
    log.error({ err, port: name }, 'Scheduling port failed');
    return null;
  }
}
