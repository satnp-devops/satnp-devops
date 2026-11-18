import { MsgraphError } from './errors.js';

/**
 * Conversions between Graph shapes and the platform's provider-neutral shapes.
 * All platform times are ISO 8601 UTC strings ending in "Z". The client always asks Graph for
 * UTC (Prefer: outlook.timezone="UTC") and sends dateTimeTimeZone values in UTC.
 */

const UTC_ZONE_NAMES = new Set(['utc', 'etc/utc', 'etc/gmt', 'coordinated universal time', 'tzone://microsoft/utc']);

/**
 * Parse a platform time (Date, epoch ms, or ISO string with Z/offset) to epoch ms.
 * Strings without a zone designator are rejected: a local time is ambiguous.
 * @param {Date | number | string} value
 * @param {string} field
 */
export function toEpochMs(value, field) {
  let ms = Number.NaN;
  if (value instanceof Date) ms = value.getTime();
  else if (typeof value === 'number') ms = value;
  else if (typeof value === 'string' && /(Z|[+-]\d{2}:\d{2})$/i.test(value.trim())) ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new MsgraphError(`${field} must be a Date, epoch ms or ISO 8601 string with Z or an offset`, {
      kind: 'validation',
      code: 'invalid_time',
      details: { field },
    });
  }
  return ms;
}

/**
 * Platform time -> Graph dateTimeTimeZone in UTC.
 * @param {Date | number | string} value
 * @param {string} [field]
 * @returns {{ dateTime: string, timeZone: 'UTC' }}
 */
export function toGraphDateTime(value, field = 'time') {
  const iso = new Date(toEpochMs(value, field)).toISOString();
  return { dateTime: iso.slice(0, 19), timeZone: 'UTC' };
}

/**
 * Graph timestamp ("2017-04-15T03:00:50.7579581Z", 7-digit fractions allowed) -> ISO UTC.
 * @param {string | null | undefined} value
 * @returns {string | null}
 */
export function fromGraphTimestamp(value) {
  if (typeof value !== 'string' || !value) return null;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})?$/i.exec(value.trim());
  if (!match) return null;
  const fraction = (match[2] ?? '').padEnd(3, '0').slice(0, 3);
  const ms = Date.parse(`${match[1]}.${fraction}${match[3] ?? 'Z'}`);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/**
 * Graph dateTimeTimeZone -> ISO UTC. Returns null for non-UTC zones (the client always requests UTC).
 * @param {{ dateTime?: string, timeZone?: string } | null | undefined} value
 */
export function fromGraphDateTime(value) {
  if (!value?.dateTime) return null;
  if (!UTC_ZONE_NAMES.has(String(value.timeZone ?? 'UTC').toLowerCase())) return null;
  return fromGraphTimestamp(value.dateTime.replace(/(Z|[+-]\d{2}:\d{2})$/i, '') + 'Z');
}

/** @param {any} recipient */
function person(recipient) {
  const email = recipient?.emailAddress;
  if (!email) return null;
  return { email: email.address ?? null, name: email.name ?? null };
}

/**
 * @param {any} event Graph event
 */
export function normaliseEvent(event) {
  const online = event.onlineMeeting ?? null;
  return {
    id: event.id,
    iCalUId: event.iCalUId ?? null,
    changeKey: event.changeKey ?? null,
    transactionId: event.transactionId ?? null,
    subject: event.subject ?? '',
    startsAt: fromGraphDateTime(event.start),
    endsAt: fromGraphDateTime(event.end),
    isAllDay: Boolean(event.isAllDay),
    isCancelled: Boolean(event.isCancelled),
    showAs: event.showAs ?? null,
    type: event.type ?? null,
    seriesMasterId: event.seriesMasterId ?? null,
    organizer: person(event.organizer),
    attendees: (event.attendees ?? []).map((/** @type {any} */ a) => ({
      ...person(a),
      type: a.type ?? null,
      response: a.status?.response ?? null,
      respondedAt: a.status?.response && a.status.response !== 'none' ? fromGraphTimestamp(a.status.time) : null,
    })),
    location: event.location?.displayName || null,
    onlineMeeting: online
      ? {
          provider: event.onlineMeetingProvider ?? null,
          joinUrl: online.joinUrl ?? null,
          conferenceId: online.conferenceId ?? null,
          tollNumber: online.tollNumber ?? null,
        }
      : null,
    joinUrl: online?.joinUrl ?? null,
    webLink: event.webLink ?? null,
    createdAt: fromGraphTimestamp(event.createdDateTime),
    updatedAt: fromGraphTimestamp(event.lastModifiedDateTime),
  };
}

/** Statuses that block a booking slot. Graph also returns free and workingElsewhere items. */
const BLOCKING = new Set(['busy', 'tentative', 'oof']);

/**
 * @param {any} info Graph scheduleInformation
 */
export function normaliseSchedule(info) {
  const items = (info.scheduleItems ?? [])
    .map((/** @type {any} */ item) => ({
      status: item.status ?? 'unknown',
      startsAt: fromGraphDateTime(item.start),
      endsAt: fromGraphDateTime(item.end),
      isPrivate: Boolean(item.isPrivate),
    }))
    .sort((/** @type {any} */ a, /** @type {any} */ b) => String(a.startsAt).localeCompare(String(b.startsAt)));
  return {
    email: info.scheduleId,
    availabilityView: info.availabilityView ?? null,
    items,
    busy: mergeIntervals(items.filter((/** @type {any} */ i) => BLOCKING.has(i.status) && i.startsAt && i.endsAt)),
    workingHours: info.workingHours
      ? {
          daysOfWeek: info.workingHours.daysOfWeek ?? [],
          startTime: info.workingHours.startTime ?? null,
          endTime: info.workingHours.endTime ?? null,
          timeZone: info.workingHours.timeZone?.name ?? null,
        }
      : null,
    error: info.error ? { message: info.error.message ?? null, responseCode: info.error.responseCode ?? null } : null,
  };
}

/**
 * Merge overlapping or touching [startsAt, endsAt) intervals (ISO UTC strings sort lexically).
 * @param {Array<{ startsAt: string, endsAt: string }>} intervals
 */
export function mergeIntervals(intervals) {
  const sorted = [...intervals].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  /** @type {Array<{ startsAt: string, endsAt: string }>} */
  const out = [];
  for (const { startsAt, endsAt } of sorted) {
    const last = out[out.length - 1];
    if (last && startsAt <= last.endsAt) {
      if (endsAt > last.endsAt) last.endsAt = endsAt;
    } else {
      out.push({ startsAt, endsAt });
    }
  }
  return out;
}

/** @param {any} sub Graph subscription (clientState is deliberately dropped). */
export function normaliseSubscription(sub) {
  return {
    id: sub.id,
    resource: sub.resource,
    changeTypes: String(sub.changeType ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    expiresAt: fromGraphTimestamp(sub.expirationDateTime),
    notificationUrl: sub.notificationUrl ?? null,
    lifecycleNotificationUrl: sub.lifecycleNotificationUrl ?? null,
    applicationId: sub.applicationId ?? null,
    creatorId: sub.creatorId ?? null,
    latestSupportedTlsVersion: sub.latestSupportedTlsVersion ?? null,
  };
}

/** @param {any} meeting Graph onlineMeeting */
export function normaliseOnlineMeeting(meeting) {
  return {
    id: meeting.id,
    joinUrl: meeting.joinWebUrl ?? meeting.joinUrl ?? null,
    subject: meeting.subject ?? null,
    startsAt: fromGraphTimestamp(meeting.startDateTime),
    endsAt: fromGraphTimestamp(meeting.endDateTime),
    joinMeetingId: meeting.joinMeetingIdSettings?.joinMeetingId ?? null,
  };
}

/** @param {any} report Graph meetingAttendanceReport */
export function normaliseAttendanceReport(report) {
  return {
    id: report.id,
    totalParticipantCount: Number.isInteger(report.totalParticipantCount) ? report.totalParticipantCount : null,
    meetingStartedAt: fromGraphTimestamp(report.meetingStartDateTime),
    meetingEndedAt: fromGraphTimestamp(report.meetingEndDateTime),
  };
}

/** @param {any} record Graph attendanceRecord */
export function normaliseAttendanceRecord(record) {
  return {
    email: record.emailAddress || null,
    name: record.identity?.displayName ?? null,
    participantId: record.identity?.id ?? null,
    tenantId: record.identity?.tenantId ?? null,
    role: record.role ?? null,
    totalSeconds: Number.isInteger(record.totalAttendanceInSeconds) ? record.totalAttendanceInSeconds : 0,
    intervals: (record.attendanceIntervals ?? []).map((/** @type {any} */ i) => ({
      joinedAt: fromGraphTimestamp(i.joinDateTime),
      leftAt: fromGraphTimestamp(i.leaveDateTime),
      durationSeconds: Number.isInteger(i.durationInSeconds) ? i.durationInSeconds : null,
    })),
  };
}
