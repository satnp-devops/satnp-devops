import { ZoomValidationError } from './errors.js';
import { toUtcIso } from './meetings.js';

/**
 * Past-meeting participant helpers (pure).
 *
 * Two Zoom endpoints list who attended a finished meeting:
 * - 'report': GET /report/meetings/{id}/participants  (scope report:read:admin, HEAVY, Pro+;
 *   can include registrant_id via include_fields=registrant_id)
 * - 'past':   GET /past_meetings/{id}/participants    (scope meeting:read(:admin), MEDIUM)
 * Both return one row per join session: a participant who leaves and rejoins gets a new
 * `user_id` and a new row. Merge rows with computeAttendance() in attendance.js.
 */

/**
 * Path segment for a meeting ID or meeting-instance UUID.
 *
 * Zoom's double-encoding rule: a UUID that begins with "/" or contains "//" must be URL-encoded
 * twice (report endpoints); the past_meetings docs say any "/" needs it. We double-encode
 * whenever the UUID contains "/", which satisfies both statements; other UUIDs are encoded once
 * (base64 "+" and "=" must still be escaped). Numeric meeting IDs are used as is.
 * @param {string|number} meetingIdOrUuid
 */
export function encodeMeetingRef(meetingIdOrUuid) {
  const ref = String(meetingIdOrUuid ?? '').trim();
  if (!ref) throw new ZoomValidationError('Meeting ID or UUID is required');
  if (/^\d{1,20}$/.test(ref)) return ref;
  if (ref.length > 200) throw new ZoomValidationError('Meeting UUID is too long');
  return ref.includes('/') ? encodeURIComponent(encodeURIComponent(ref)) : encodeURIComponent(ref);
}

/**
 * @typedef {object} ZoomParticipantSession
 * @property {string|null} userId        meeting-scoped user_id (changes on every rejoin)
 * @property {string|null} zoomUserId    persistent Zoom user ID when signed in (id / participant_user_id)
 * @property {string|null} participantUuid  webhook participant_uuid, when known
 * @property {string|null} registrantId
 * @property {string|null} name
 * @property {string|null} email         lower-cased; Zoom blanks emails of external users in many cases
 * @property {string|null} customerKey
 * @property {string|null} phoneNumber
 * @property {string|null} joinTime      UTC ISO
 * @property {string|null} leaveTime     UTC ISO (null while still in the meeting)
 * @property {number|null} durationSeconds  as reported by Zoom for this session
 * @property {string|null} status        'in_meeting' | 'in_waiting_room' | null
 * @property {string|null} leaveReason
 * @property {boolean|null} internalUser
 */

function emptyToNull(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

/** @returns {ZoomParticipantSession} */
export function normalizeParticipantRow(row) {
  const r = row ?? {};
  const email = emptyToNull(r.user_email ?? r.email);
  return {
    userId: emptyToNull(r.user_id),
    zoomUserId: emptyToNull(r.participant_user_id ?? r.id),
    participantUuid: emptyToNull(r.participant_uuid),
    registrantId: emptyToNull(r.registrant_id),
    name: emptyToNull(r.name ?? r.user_name),
    email: email ? email.toLowerCase() : null,
    customerKey: emptyToNull(r.customer_key),
    phoneNumber: emptyToNull(r.phone_number),
    joinTime: toUtcIso(r.join_time ?? r.date_time),
    leaveTime: toUtcIso(r.leave_time),
    durationSeconds: typeof r.duration === 'number' ? r.duration : null,
    status: emptyToNull(r.status),
    leaveReason: emptyToNull(r.leave_reason),
    internalUser: typeof r.internal_user === 'boolean' ? r.internal_user : null,
  };
}

/**
 * @typedef {object} ZoomPastMeeting
 * @property {string} id
 * @property {string|null} uuid
 * @property {string|null} topic
 * @property {string|null} startTime  UTC ISO
 * @property {string|null} endTime    UTC ISO
 * @property {number|null} durationMinutes
 * @property {number|null} participantsCount
 * @property {number|null} totalMinutes
 * @property {string|null} hostId
 */

/** @returns {ZoomPastMeeting} */
export function normalizePastMeeting(raw) {
  const m = raw ?? {};
  return {
    id: m.id === undefined || m.id === null ? '' : String(m.id),
    uuid: m.uuid ?? null,
    topic: m.topic ?? null,
    startTime: toUtcIso(m.start_time),
    endTime: toUtcIso(m.end_time),
    durationMinutes: typeof m.duration === 'number' ? m.duration : null,
    participantsCount: typeof m.participants_count === 'number' ? m.participants_count : null,
    totalMinutes: typeof m.total_minutes === 'number' ? m.total_minutes : null,
    hostId: m.host_id ?? null,
  };
}
