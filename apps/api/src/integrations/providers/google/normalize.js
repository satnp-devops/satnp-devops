import { createHash } from 'node:crypto';
import { GoogleError } from './errors.js';

/**
 * Pure conversions between Phoenix shapes and Google Calendar / Meet resources.
 * All instants leave this module as UTC ISO-8601 strings ("2026-11-10T04:30:00.000Z").
 */

const OFFSET_RE = /(Z|[+-]\d{2}:\d{2})$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MEET_CODE_RE = /^[a-z]+-[a-z]+-[a-z]+$/i;

/**
 * Deterministic Calendar event ID for an idempotency key. Google event IDs allow base32hex
 * characters (a-v, 0-9), 5-1024 long; a lowercase SHA-256 hex digest (a-f, 0-9, 64 chars)
 * fits. Re-sending an insert with the same key hits HTTP 409 "duplicate" instead of creating
 * a second event.
 * @param {string} key e.g. "booking:7f1c...:v1"
 * @param {string} [namespace] keeps keys from different products apart
 */
export function eventIdFromKey(key, namespace = 'phoenix') {
  if (!key) throw new RangeError('idempotency key is required');
  return createHash('sha256').update(`${namespace}:event:${key}`, 'utf8').digest('hex');
}

/** `requestId` for conferenceData.createRequest, stable per idempotency key. */
export function conferenceRequestIdFromKey(key, namespace = 'phoenix') {
  return createHash('sha256').update(`${namespace}:meet:${key}`, 'utf8').digest('hex').slice(0, 32);
}

/** @param {string} id */
export function isValidEventId(id) {
  return typeof id === 'string' && /^[a-v0-9]{5,1024}$/.test(id);
}

/**
 * Convert an instant to UTC ISO. Strings must carry an explicit offset so local wall-clock
 * times are never silently interpreted in the server's zone.
 * @param {Date|string|number} value
 * @param {string} field for error messages
 */
export function toUtcIso(value, field = 'time') {
  let ms;
  if (value instanceof Date) ms = value.getTime();
  else if (typeof value === 'number') ms = value;
  else if (typeof value === 'string' && OFFSET_RE.test(value.trim())) ms = Date.parse(value);
  else ms = Number.NaN;
  if (!Number.isFinite(ms)) {
    throw new GoogleError('bad_request', `${field} must be a Date, epoch ms, or ISO-8601 string with an offset`, {
      reason: 'invalid_time',
    });
  }
  return new Date(ms).toISOString();
}

/** @param {string|null|undefined} value */
function isoOrNull(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Event start/end in Google's shape.
 * @param {Date|string|number|{ date: string }} value an instant, or { date: 'YYYY-MM-DD' } for all-day
 * @param {string} timeZone IANA zone
 * @param {string} field
 */
export function toEventDateTime(value, timeZone, field) {
  if (value && typeof value === 'object' && !(value instanceof Date) && 'date' in value) {
    if (!DATE_RE.test(value.date)) throw new GoogleError('bad_request', `${field}.date must be YYYY-MM-DD`, { reason: 'invalid_time' });
    return { date: value.date };
  }
  return { dateTime: toUtcIso(/** @type {Date|string|number} */ (value), field), timeZone };
}

/**
 * @typedef {object} EventInput
 * @property {string} [summary]
 * @property {string} [description]
 * @property {string} [location]
 * @property {Date|string|number|{date: string}} [start]
 * @property {Date|string|number|{date: string}} [end]
 * @property {string} [timeZone] IANA zone; defaults to config.defaultTimeZone
 * @property {Array<{ email: string, displayName?: string, optional?: boolean }>} [attendees]
 * @property {boolean} [withMeet] ask Google to create a Meet conference
 * @property {Array<{ method: 'email'|'popup', minutes: number }>} [reminders] max 5; omit to use calendar defaults
 * @property {{ private?: Record<string,string>, shared?: Record<string,string> }} [extendedProperties]
 * @property {'default'|'public'|'private'|'confidential'} [visibility]
 * @property {'opaque'|'transparent'} [transparency]
 * @property {boolean} [guestsCanModify]
 * @property {boolean} [guestsCanInviteOthers]
 * @property {boolean} [guestsCanSeeOtherGuests]
 * @property {'confirmed'|'tentative'|'cancelled'} [status]
 */

/**
 * Build an Event resource body from Phoenix input. Only fields present in `input` are set,
 * so the same function serves insert and patch.
 * @param {EventInput} input
 * @param {{ timeZone: string, conferenceRequestId?: string }} options
 */
export function buildEventBody(input, options) {
  const tz = input.timeZone ?? options.timeZone;
  /** @type {Record<string, unknown>} */
  const body = {};
  for (const key of ['summary', 'description', 'location', 'visibility', 'transparency', 'status', 'guestsCanModify', 'guestsCanInviteOthers', 'guestsCanSeeOtherGuests']) {
    if (input[key] !== undefined) body[key] = input[key];
  }
  if (input.start !== undefined) body.start = toEventDateTime(input.start, tz, 'start');
  if (input.end !== undefined) body.end = toEventDateTime(input.end, tz, 'end');
  if (body.start?.dateTime && body.end?.dateTime && Date.parse(body.end.dateTime) <= Date.parse(body.start.dateTime)) {
    throw new GoogleError('bad_request', 'end must be after start', { reason: 'timeRangeEmpty' });
  }
  if (input.attendees !== undefined) {
    body.attendees = input.attendees.map((a) => ({
      email: a.email,
      ...(a.displayName ? { displayName: a.displayName } : {}),
      ...(a.optional ? { optional: true } : {}),
    }));
  }
  if (input.reminders !== undefined) {
    if (input.reminders.length > 5) throw new GoogleError('bad_request', 'at most 5 reminder overrides', { reason: 'invalid' });
    body.reminders = { useDefault: false, overrides: input.reminders.map((r) => ({ method: r.method, minutes: r.minutes })) };
  }
  if (input.extendedProperties !== undefined) body.extendedProperties = input.extendedProperties;
  if (input.withMeet) {
    body.conferenceData = {
      createRequest: { requestId: options.conferenceRequestId, conferenceSolutionKey: { type: 'hangoutsMeet' } },
    };
  }
  return body;
}

/** @param {string|null|undefined} url */
export function meetingCodeFromUrl(url) {
  if (!url) return null;
  const match = /^https:\/\/meet\.google\.com\/([a-z]+-[a-z]+-[a-z]+)(?:[/?#]|$)/i.exec(url);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Meet details from an event's conferenceData / hangoutLink.
 * @param {any} raw Google Event resource
 */
export function extractMeet(raw) {
  const data = raw?.conferenceData;
  if (!data && !raw?.hangoutLink) return null;
  const solutionType = data?.conferenceSolution?.key?.type ?? data?.createRequest?.conferenceSolutionKey?.type ?? null;
  if (solutionType && solutionType !== 'hangoutsMeet') return null;
  const entryPoints = Array.isArray(data?.entryPoints) ? data.entryPoints : [];
  const video = entryPoints.find((e) => e.entryPointType === 'video');
  const url = video?.uri ?? raw?.hangoutLink ?? null;
  const conferenceId = data?.conferenceId ?? null;
  const codeFromId = conferenceId && MEET_CODE_RE.test(conferenceId) ? conferenceId.toLowerCase() : null;
  return {
    url,
    meetingCode: codeFromId ?? meetingCodeFromUrl(url),
    conferenceId,
    status: data?.createRequest?.status?.statusCode ?? (url ? 'success' : null),
    phone: entryPoints
      .filter((e) => e.entryPointType === 'phone')
      .map((e) => ({ uri: e.uri, label: e.label ?? null, pin: e.pin ?? null, regionCode: e.regionCode ?? null })),
    moreUri: entryPoints.find((e) => e.entryPointType === 'more')?.uri ?? null,
  };
}

/** @param {any} value Google EventDateTime */
function normalizeWhen(value) {
  if (!value) return { at: null, date: null, timeZone: null };
  return { at: isoOrNull(value.dateTime), date: value.date ?? null, timeZone: value.timeZone ?? null };
}

/**
 * @typedef {ReturnType<typeof normalizeEvent>} NormalizedEvent
 */

/**
 * Normalise a Google Event resource.
 * @param {any} raw
 * @param {string} calendarId the calendar it was read from
 */
export function normalizeEvent(raw, calendarId) {
  const start = normalizeWhen(raw.start);
  return {
    provider: /** @type {const} */ ('google'),
    id: raw.id,
    calendarId,
    status: raw.status ?? 'confirmed',
    summary: raw.summary ?? null,
    description: raw.description ?? null,
    location: raw.location ?? null,
    start,
    end: normalizeWhen(raw.end),
    allDay: Boolean(start.date && !start.at),
    attendees: (raw.attendees ?? []).map((a) => ({
      email: a.email ?? null,
      displayName: a.displayName ?? null,
      responseStatus: a.responseStatus ?? 'needsAction',
      optional: Boolean(a.optional),
      organizer: Boolean(a.organizer),
      self: Boolean(a.self),
      resource: Boolean(a.resource),
    })),
    organizer: raw.organizer ? { email: raw.organizer.email ?? null, displayName: raw.organizer.displayName ?? null, self: Boolean(raw.organizer.self) } : null,
    meet: extractMeet(raw),
    htmlLink: raw.htmlLink ?? null,
    iCalUID: raw.iCalUID ?? null,
    sequence: raw.sequence ?? 0,
    recurringEventId: raw.recurringEventId ?? null,
    created: isoOrNull(raw.created),
    updated: isoOrNull(raw.updated),
    extendedProperties: { private: raw.extendedProperties?.private ?? {}, shared: raw.extendedProperties?.shared ?? {} },
    raw,
  };
}

/**
 * Normalise a freeBusy response; busy intervals become UTC ISO.
 * @param {any} raw
 */
export function normalizeFreeBusy(raw) {
  /** @type {Record<string, { busy: Array<{ start: string, end: string }>, errors: Array<{ domain: string, reason: string }> }>} */
  const calendars = {};
  for (const [id, entry] of Object.entries(raw?.calendars ?? {})) {
    calendars[id] = {
      busy: (/** @type {any} */ (entry).busy ?? []).map((b) => ({ start: isoOrNull(b.start), end: isoOrNull(b.end) })),
      errors: (/** @type {any} */ (entry).errors ?? []).map((e) => ({ domain: e.domain, reason: e.reason })),
    };
  }
  return { timeMin: isoOrNull(raw?.timeMin), timeMax: isoOrNull(raw?.timeMax), calendars, groups: raw?.groups ?? {} };
}

/**
 * Union length of [start, end) intervals in seconds; open intervals end at `nowMs`.
 * Overlapping sessions (same person on two devices) are counted once.
 * @param {Array<{ start: string|null, end: string|null }>} intervals
 * @param {number} nowMs
 */
export function unionSeconds(intervals, nowMs) {
  const spans = intervals
    .map((i) => [Date.parse(i.start ?? ''), i.end ? Date.parse(i.end) : nowMs])
    .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e > s)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curStart = null;
  let curEnd = null;
  for (const [s, e] of spans) {
    if (curEnd === null || s > curEnd) {
      if (curEnd !== null) total += curEnd - curStart;
      curStart = s;
      curEnd = e;
    } else if (e > curEnd) curEnd = e;
  }
  if (curEnd !== null) total += curEnd - curStart;
  return Math.floor(total / 1000);
}

/** @param {any} p Meet Participant resource */
export function normalizeParticipant(p) {
  const kind = p.signedinUser ? 'signed_in' : p.anonymousUser ? 'anonymous' : p.phoneUser ? 'phone' : 'unknown';
  const who = p.signedinUser ?? p.anonymousUser ?? p.phoneUser ?? {};
  return {
    name: p.name,
    participantId: String(p.name ?? '').split('/').pop() ?? null,
    kind,
    userId: p.signedinUser?.user ?? null,
    displayName: who.displayName ?? null,
    firstJoinedAt: isoOrNull(p.earliestStartTime),
    lastLeftAt: isoOrNull(p.latestEndTime),
  };
}

/** @param {any} s Meet ParticipantSession resource */
export function normalizeSession(s) {
  return { name: s.name, start: isoOrNull(s.startTime), end: isoOrNull(s.endTime) };
}

/** @param {any} r Meet ConferenceRecord resource */
export function normalizeConferenceRecord(r) {
  return {
    name: r.name,
    conferenceRecordId: String(r.name ?? '').split('/').pop() ?? null,
    spaceName: r.space ?? null,
    startTime: isoOrNull(r.startTime),
    endTime: isoOrNull(r.endTime),
    expireTime: isoOrNull(r.expireTime),
    active: !r.endTime,
  };
}
