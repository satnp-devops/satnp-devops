import { db, json } from '../../lib/db.js';
import { logger } from '../../lib/logger.js';
import { normalizeName } from '../../core/crm/normalize.js';
import { computeAttendance, mergeIntervals, sessionsFromWebhookEvents } from '../../integrations/providers/zoom/index.js';
import { recordOutcome } from './bookings.js';
import { ACTIVE_STATUSES } from './schemas.js';

// Meeting attendance: who joined an online booking, for how long, and whether the family attended.
//
// Two ways in, one evaluation:
//   1. Webhooks (live): ingestAttendanceEvents({ provider, events }) with events normalised by the
//      provider client: Zoom parseWebhook() output as is; Google Meet and Teams events mapped to the
//      same shape by the integration framework:
//        { id, type: 'participant.joined' | 'participant.left' | 'meeting.started' | 'meeting.ended',
//          occurredAt, meeting: { id, uuid?, hostId?, startTime?, endTime? },
//          participant?: { userId, name, email, zoomUserId?, registrantId?, joinTime?, leaveTime? } }
//      meeting.id is the provider's meeting id (Zoom meeting number, Meet code, Teams meeting id), the
//      `ref` the createOnlineMeeting port returned. Events are stored once (provider event id), so
//      webhook retries change nothing.
//   2. Pull (after the end): the scheduling.attendance_check job asks the fetchAttendance port for
//      the provider's participant report (sessions) and evaluates them with finalize = true.
//
// Evaluation: sessions are grouped into people and their join/leave intervals merged (a person who
// drops and rejoins, or joins on two devices, is never counted twice); the invitee side's time is
// the union of every non-host participant's intervals; it is compared with the threshold copied
// from the event type. Reaching the threshold records booking.attended at once; booking.no_show is
// recorded only once the meeting is over (meeting.ended, or the check after the booked end), so a
// late joiner is never marked absent. Both go through recordOutcome, which acts once per booking.

export const MEETING_PROVIDERS = Object.freeze(['zoom', 'google_meet', 'teams']);

const toMs = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
};

const lower = (value) => (typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null);

/**
 * Classify people and work out the invitee side's attended time (pure).
 * @param {{ attendees: Array<object>, booking: object, hostEmail?: string | null, hostProviderIds?: string[], thresholdMin: number }} input
 */
export function summariseAttendance({ attendees, booking, hostEmail = null, hostProviderIds = [], thresholdMin }) {
  const inviteeEmails = new Set([lower(booking.invitee_email), ...(booking.guests ?? []).map((g) => lower(g.email))].filter(Boolean));
  const inviteeName = normalizeName(booking.invitee_name ?? '');
  const hostIds = new Set(hostProviderIds.filter(Boolean).map(String));
  const host = lower(hostEmail);
  const people = attendees.map((a) => {
    const email = lower(a.email);
    let role = 'guest';
    if ((host && email === host) || (a.zoomUserId && hostIds.has(String(a.zoomUserId)))) role = 'host';
    else if ((email && inviteeEmails.has(email)) || (inviteeName && a.name && normalizeName(a.name) === inviteeName)) role = 'invitee';
    return { ...a, role };
  });
  const inviteeSide = mergeIntervals(
    people.filter((p) => p.role !== 'host').flatMap((p) => p.intervals.map((i) => ({ start: toMs(i.start), end: toMs(i.end) }))),
  );
  const inviteeSeconds = Math.floor(inviteeSide.reduce((sum, i) => sum + (i.end - i.start), 0) / 1000);
  const hostSeconds = people.filter((p) => p.role === 'host').reduce((max, p) => Math.max(max, p.attendedSeconds), 0);
  const thresholdSeconds = Math.max(0, thresholdMin) * 60;
  return {
    people,
    inviteeSeconds,
    hostSeconds,
    thresholdSeconds,
    // Nobody from the family joined → never "attended", even with a zero threshold.
    meetsThreshold: inviteeSeconds > 0 && inviteeSeconds >= thresholdSeconds,
  };
}

/**
 * Decide what a meeting's numbers mean (pure): 'attended' as soon as the threshold is reached,
 * 'no_show' only once the meeting is over, otherwise null (keep waiting).
 */
export function decideOutcome({ meetsThreshold, over }) {
  if (meetsThreshold) return 'attended';
  return over ? 'no_show' : null;
}

/** Store the people, update the meeting, and record the outcome when there is one. Inside a transaction. */
async function evaluate(trx, { meeting, booking, sessions, startedAt = null, endedAt = null, over, now, source }) {
  const host = booking.host_user_id ? await trx('users').where({ id: booking.host_user_id }).first('id', 'email') : null;
  const { attendees } = computeAttendance(sessions, {
    thresholdMinutes: meeting.threshold_min,
    meetingEnd: over && endedAt ? endedAt : undefined,
    now,
  });
  const hostProviderIds = sessions.map((s) => s.hostProviderId).filter(Boolean);
  const summary = summariseAttendance({ attendees, booking, hostEmail: host?.email, hostProviderIds, thresholdMin: meeting.threshold_min });

  if (summary.people.length) {
    await trx('meeting_participants')
      .insert(
        summary.people.map((p) => ({
          meeting_id: meeting.id,
          key: String(p.key).slice(0, 300),
          role: p.role,
          name: p.name ?? null,
          email: p.email ?? null,
          user_id: p.role === 'host' ? (host?.id ?? null) : null,
          intervals: json(p.intervals),
          attended_seconds: p.attendedSeconds,
          session_count: p.sessionCount,
          first_joined_at: p.firstJoinAt ? new Date(p.firstJoinAt) : null,
          last_left_at: p.lastLeaveAt ? new Date(p.lastLeaveAt) : null,
          still_in_meeting: Boolean(p.stillInMeeting) && !over,
          meets_threshold: p.role !== 'host' && p.attendedSeconds > 0 && p.attendedSeconds >= summary.thresholdSeconds,
        })),
      )
      .onConflict(['meeting_id', 'key'])
      .merge(['role', 'name', 'email', 'user_id', 'intervals', 'attended_seconds', 'session_count', 'first_joined_at', 'last_left_at', 'still_in_meeting', 'meets_threshold', 'updated_at']);
  }

  const firstJoin = summary.people.map((p) => toMs(p.firstJoinAt)).filter((ms) => ms !== null).sort((a, b) => a - b)[0] ?? null;
  const live = !over && summary.people.some((p) => p.stillInMeeting);
  const [updated] = await trx('meetings')
    .where({ id: meeting.id })
    .update({
      status: over ? 'ended' : live || firstJoin ? 'live' : meeting.status,
      started_at: meeting.started_at ?? (toMs(startedAt) ? new Date(toMs(startedAt)) : firstJoin ? new Date(firstJoin) : null),
      ended_at: over ? (toMs(endedAt) ? new Date(toMs(endedAt)) : (meeting.ended_at ?? new Date(now))) : meeting.ended_at,
      invitee_seconds: summary.inviteeSeconds,
      host_seconds: summary.hostSeconds,
      updated_at: trx.fn.now(),
    })
    .returning('*');

  const outcome = decideOutcome({ meetsThreshold: summary.meetsThreshold, over });
  let recorded = null;
  if (outcome && ACTIVE_STATUSES.includes(booking.status)) {
    recorded = await recordOutcome(trx, booking, {
      outcome,
      source,
      inviteeSeconds: summary.inviteeSeconds,
      hostSeconds: summary.hostSeconds,
    });
  }
  return {
    bookingId: booking.id,
    meetingStatus: updated.status,
    inviteeSeconds: summary.inviteeSeconds,
    thresholdSeconds: summary.thresholdSeconds,
    outcome: recorded ? outcome : null,
  };
}

/** Lock and load a meeting with its booking. */
async function lockMeeting(trx, where) {
  const meeting = await trx('meetings').where(where).forUpdate().first();
  if (!meeting) return null;
  const booking = await trx('bookings').where({ id: meeting.booking_id }).forUpdate().first();
  return booking ? { meeting, booking } : null;
}

/** Sessions rebuilt from a meeting's stored webhook events. */
function sessionsFromStored(rows, hostProviderId) {
  const events = rows.map((row) => row.data);
  return sessionsFromWebhookEvents(events).map((s) => ({ ...s, hostProviderId }));
}

/**
 * Ingest normalised meeting webhook events (the handler the webhooks module calls after verifying a
 * Zoom, Meet or Teams notification). Idempotent; never throws for unknown meetings.
 * @param {{ provider: 'zoom' | 'google_meet' | 'teams', events: Array<object>, now?: number, log?: object }} input
 * @returns {Promise<{ stored: number, duplicates: number, unmatched: number, meetings: Array<object> }>}
 */
export async function ingestAttendanceEvents({ provider, events, now = Date.now(), log = logger }) {
  if (!MEETING_PROVIDERS.includes(provider)) throw new TypeError(`Unknown meeting provider "${provider}"`);
  const relevant = (events ?? []).filter(
    (e) => e && e.id && ['participant.joined', 'participant.left', 'meeting.started', 'meeting.ended'].includes(e.type) && e.meeting?.id != null,
  );
  const byMeeting = new Map();
  for (const event of relevant) {
    const ref = String(event.meeting.id);
    if (!byMeeting.has(ref)) byMeeting.set(ref, []);
    byMeeting.get(ref).push(event);
  }
  const out = { stored: 0, duplicates: 0, unmatched: 0, meetings: [] };
  for (const [ref, list] of byMeeting) {
    // Recurring/reused rooms: the latest booking on this meeting id that has started or starts soon.
    const candidate = await db('meetings as m')
      .join('bookings as b', 'b.id', 'm.booking_id')
      .where('m.provider', provider)
      .where('m.provider_meeting_id', ref)
      .where('b.start_at', '<=', new Date(now + 60 * 60_000))
      .orderBy('b.start_at', 'desc')
      .first('m.id');
    if (!candidate) {
      out.unmatched += list.length;
      continue;
    }
    const result = await db.transaction(async (trx) => {
      const locked = await lockMeeting(trx, { id: candidate.id });
      if (!locked) return null;
      const inserted = await trx('meeting_events')
        .insert(
          list.map((e) => ({
            meeting_id: locked.meeting.id,
            provider_event_id: `${provider}:${e.id}`.slice(0, 200),
            type: e.type,
            occurred_at: new Date(toMs(e.occurredAt) ?? now),
            data: json({ id: e.id, type: e.type, occurredAt: e.occurredAt ?? null, meeting: e.meeting ?? null, participant: e.participant ?? null }),
          })),
        )
        .onConflict('provider_event_id')
        .ignore()
        .returning('id');
      out.stored += inserted.length;
      out.duplicates += list.length - inserted.length;
      if (inserted.length === 0 && locked.meeting.evaluated_at) return null;

      const rows = await trx('meeting_events').where({ meeting_id: locked.meeting.id }).orderBy([{ column: 'occurred_at' }, { column: 'id' }]);
      const ended = rows.find((r) => r.type === 'meeting.ended');
      const started = rows.find((r) => r.type === 'meeting.started');
      const hostProviderId = rows.map((r) => r.data?.meeting?.hostId).find(Boolean) ?? null;
      if (locked.meeting.provider_meeting_uuid == null) {
        const uuid = rows.map((r) => r.data?.meeting?.uuid).find(Boolean);
        if (uuid) await trx('meetings').where({ id: locked.meeting.id }).update({ provider_meeting_uuid: String(uuid).slice(0, 200) });
      }
      return evaluate(trx, {
        meeting: locked.meeting,
        booking: locked.booking,
        sessions: sessionsFromStored(rows, hostProviderId),
        startedAt: started?.data?.meeting?.startTime ?? started?.occurred_at ?? null,
        endedAt: ended?.data?.meeting?.endTime ?? ended?.occurred_at ?? null,
        over: Boolean(ended),
        now,
        source: `${provider}_webhook`,
      });
    });
    if (result) out.meetings.push(result);
  }
  if (out.unmatched) log.debug({ scheduling: { provider, unmatched: out.unmatched } }, 'Meeting events for unknown meetings ignored');
  return out;
}

/**
 * Evaluate a booking from the provider's participant report (pull), or from the webhook events
 * already stored when no report is available. Used by the attendance check after the booked end.
 * @param {{ bookingId: string, report?: { sessions: object[], startedAt?: string, endedAt?: string, ended?: boolean, hostProviderId?: string } | null, finalize?: boolean, now?: number }} input
 */
export async function evaluateBookingAttendance({ bookingId, report = null, finalize = true, now = Date.now(), source = 'attendance_check' }) {
  return db.transaction(async (trx) => {
    const locked = await lockMeeting(trx, { booking_id: bookingId });
    if (!locked) return null;
    const { meeting, booking } = locked;
    if (report && Array.isArray(report.sessions)) {
      return evaluate(trx, {
        meeting,
        booking,
        sessions: report.sessions.map((s) => ({ ...s, hostProviderId: report.hostProviderId ?? null })),
        startedAt: report.startedAt ?? null,
        endedAt: report.endedAt ?? null,
        over: finalize || Boolean(report.ended),
        now,
        source,
      });
    }
    const rows = await trx('meeting_events').where({ meeting_id: meeting.id }).orderBy([{ column: 'occurred_at' }, { column: 'id' }]);
    // No report and no webhook data: nothing is known, so leave the outcome to the host.
    if (rows.length === 0) return { bookingId, meetingStatus: meeting.status, inviteeSeconds: 0, thresholdSeconds: meeting.threshold_min * 60, outcome: null, noData: true };
    const ended = rows.find((r) => r.type === 'meeting.ended');
    const hostProviderId = rows.map((r) => r.data?.meeting?.hostId).find(Boolean) ?? null;
    return evaluate(trx, {
      meeting,
      booking,
      sessions: sessionsFromStored(rows, hostProviderId),
      endedAt: ended?.data?.meeting?.endTime ?? ended?.occurred_at ?? booking.end_at,
      over: finalize || Boolean(ended),
      now,
      source,
    });
  });
}
