import { ZoomValidationError } from './errors.js';

/**
 * Attendance from Zoom participant sessions (pure).
 *
 * Zoom reports one row (or one joined/left pair of webhooks) per join session; a person who
 * drops and rejoins appears several times with different meeting-scoped `user_id`s, and a
 * person on two devices has overlapping sessions. computeAttendance():
 *   1. groups sessions into people (see groupKey below),
 *   2. clips each session to the meeting window when one is given,
 *   3. merges overlapping/adjacent intervals so time is never double counted,
 *   4. compares the merged total with the threshold.
 */

/** @typedef {import('./participants.js').ZoomParticipantSession} Session */

/** @param {Date|string|number|null|undefined} value */
function toMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

const iso = (ms) => (ms === null ? null : new Date(ms).toISOString());

/**
 * Sort and merge overlapping or touching intervals. Intervals with end <= start are dropped.
 * @param {Array<{ start: number, end: number }>} intervals  epoch ms
 * @returns {Array<{ start: number, end: number }>}
 */
export function mergeIntervals(intervals) {
  const sorted = intervals.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
    else merged.push({ start: interval.start, end: interval.end });
  }
  return merged;
}

function normalizeName(name) {
  return name ? name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase() : null;
}

/** Identifiers that belong to one person, strongest first. */
function strongIds(session) {
  const ids = [];
  if (session.registrantId) ids.push(`reg:${session.registrantId}`);
  if (session.email) ids.push(`email:${session.email.toLowerCase()}`);
  if (session.zoomUserId) ids.push(`user:${session.zoomUserId}`);
  if (session.customerKey) ids.push(`ck:${session.customerKey}`);
  return ids;
}

/**
 * Default grouping: sessions sharing any strong identifier (registrant ID, email, Zoom user ID,
 * SDK customer key) are one person (union-find, so A-email + A-registrant + registrant-only
 * rows all merge). A session with no strong identifier joins the one group whose display name
 * matches; if no group or several groups share the name, it is grouped by name alone, and as a
 * last resort by its meeting-scoped user_id. Two different guests with the same display name and
 * no email will therefore be merged; pass `keyOf` to override.
 * @param {Session[]} sessions
 * @returns {string[]} group key per session (same order)
 */
export function groupSessions(sessions) {
  const parent = new Map();
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };
  const idsPerSession = sessions.map(strongIds);
  for (const ids of idsPerSession) {
    for (const id of ids) if (!parent.has(id)) parent.set(id, id);
    for (let i = 1; i < ids.length; i += 1) union(ids[0], ids[i]);
  }
  const namesToRoots = new Map();
  idsPerSession.forEach((ids, index) => {
    const name = normalizeName(sessions[index].name);
    if (ids.length === 0 || !name) return;
    if (!namesToRoots.has(name)) namesToRoots.set(name, new Set());
    namesToRoots.get(name).add(find(ids[0]));
  });
  return sessions.map((session, index) => {
    const ids = idsPerSession[index];
    if (ids.length > 0) return find(ids[0]);
    const name = normalizeName(session.name);
    const roots = name ? namesToRoots.get(name) : undefined;
    if (roots && roots.size === 1) return find([...roots][0]);
    if (name) return `name:${name}`;
    return `session:${session.userId ?? session.participantUuid ?? index}`;
  });
}

/**
 * @typedef {object} AttendanceOptions
 * @property {number} [thresholdMinutes]   minimum attended minutes
 * @property {number} [thresholdRatio]     0..1 share of the meeting window (needs meetingStart and meetingEnd)
 * @property {Date|string|number} [meetingStart]  clip sessions to the window (e.g. actual start)
 * @property {Date|string|number} [meetingEnd]    clip sessions; also closes sessions with no leave time
 * @property {Date|string|number} [now]           closes open sessions when meetingEnd is unknown
 * @property {boolean} [includeWaitingRoom]       count rows with status 'in_waiting_room' (default false)
 * @property {(session: Session) => string|null} [keyOf]  custom person key; null skips the session
 */

/**
 * @typedef {object} AttendeeAttendance
 * @property {string} key
 * @property {string|null} name
 * @property {string|null} email
 * @property {string|null} registrantId
 * @property {string|null} zoomUserId
 * @property {number} attendedSeconds    merged, clipped total
 * @property {number} attendedMinutes    floor(attendedSeconds / 60)
 * @property {number|null} attendedRatio attendedSeconds / window (when the window is known)
 * @property {number} sessionCount       raw join sessions (rejoins = sessionCount - 1)
 * @property {Array<{ start: string, end: string }>} intervals  merged, UTC ISO
 * @property {string|null} firstJoinAt
 * @property {string|null} lastLeaveAt
 * @property {boolean} stillInMeeting    a session had no leave time and was closed by meetingEnd/now
 * @property {boolean} meetsThreshold
 */

/**
 * @param {Session[]} sessions  from listParticipants() or sessionsFromWebhookEvents()
 * @param {AttendanceOptions} options
 * @returns {{ thresholdSeconds: number, windowSeconds: number|null, attendees: AttendeeAttendance[] }}
 */
export function computeAttendance(sessions, options = {}) {
  const windowStart = toMs(options.meetingStart);
  const windowEnd = toMs(options.meetingEnd);
  if (windowStart !== null && windowEnd !== null && windowEnd < windowStart) {
    throw new ZoomValidationError('meetingEnd is before meetingStart');
  }
  const windowSeconds = windowStart !== null && windowEnd !== null ? Math.floor((windowEnd - windowStart) / 1000) : null;
  const thresholdSeconds = resolveThreshold(options, windowSeconds);
  const openEnd = windowEnd ?? toMs(options.now);

  const usable = sessions.filter((s) => s && (options.includeWaitingRoom || s.status !== 'in_waiting_room'));
  const keys = options.keyOf ? usable.map((s) => options.keyOf(s)) : groupSessions(usable);

  /** @type {Map<string, { sessions: Session[], intervals: Array<{start:number,end:number}>, open: boolean }>} */
  const people = new Map();
  usable.forEach((session, index) => {
    const key = keys[index];
    if (key === null || key === undefined) return;
    if (!people.has(key)) people.set(key, { sessions: [], intervals: [], open: false });
    const person = people.get(key);
    person.sessions.push(session);
    let start = toMs(session.joinTime);
    let end = toMs(session.leaveTime);
    if (start === null) return;
    if (end === null) {
      if (openEnd === null) return;
      end = openEnd;
      person.open = true;
    }
    if (windowStart !== null) start = Math.max(start, windowStart);
    if (windowEnd !== null) end = Math.min(end, windowEnd);
    person.intervals.push({ start, end });
  });

  const attendees = [...people.entries()].map(([key, person]) => {
    const merged = mergeIntervals(person.intervals);
    const attendedMs = merged.reduce((sum, i) => sum + (i.end - i.start), 0);
    const attendedSeconds = Math.floor(attendedMs / 1000);
    const pick = (field) => person.sessions.find((s) => s[field])?.[field] ?? null;
    return {
      key,
      name: pick('name'),
      email: pick('email'),
      registrantId: pick('registrantId'),
      zoomUserId: pick('zoomUserId'),
      attendedSeconds,
      attendedMinutes: Math.floor(attendedSeconds / 60),
      attendedRatio: windowSeconds ? Math.min(1, attendedSeconds / windowSeconds) : null,
      sessionCount: person.sessions.length,
      intervals: merged.map((i) => ({ start: iso(i.start), end: iso(i.end) })),
      firstJoinAt: merged.length ? iso(merged[0].start) : null,
      lastLeaveAt: merged.length ? iso(merged[merged.length - 1].end) : null,
      stillInMeeting: person.open,
      meetsThreshold: merged.length > 0 && attendedSeconds >= thresholdSeconds,
    };
  });
  attendees.sort((a, b) => (a.firstJoinAt ?? '').localeCompare(b.firstJoinAt ?? '') || a.key.localeCompare(b.key));
  return { thresholdSeconds, windowSeconds, attendees };
}

function resolveThreshold(options, windowSeconds) {
  const { thresholdMinutes, thresholdRatio } = options;
  if (thresholdMinutes === undefined && thresholdRatio === undefined) {
    throw new ZoomValidationError('computeAttendance needs thresholdMinutes or thresholdRatio');
  }
  let seconds = 0;
  if (thresholdMinutes !== undefined) {
    if (!(Number.isFinite(thresholdMinutes) && thresholdMinutes >= 0)) throw new ZoomValidationError('thresholdMinutes must be >= 0');
    seconds = Math.ceil(thresholdMinutes * 60);
  }
  if (thresholdRatio !== undefined) {
    if (!(Number.isFinite(thresholdRatio) && thresholdRatio >= 0 && thresholdRatio <= 1)) {
      throw new ZoomValidationError('thresholdRatio must be between 0 and 1');
    }
    if (windowSeconds === null) throw new ZoomValidationError('thresholdRatio needs meetingStart and meetingEnd');
    seconds = Math.max(seconds, Math.ceil(thresholdRatio * windowSeconds));
  }
  return seconds;
}

/**
 * Rebuild join sessions from participant_joined / participant_left webhooks (live attendance,
 * before Zoom's reports are ready). Events are de-duplicated by id and paired by the
 * meeting-scoped user_id (falling back to participant_uuid). A "left" with no matching "joined"
 * opens at the meeting start when known. Sessions still open stay open (leaveTime null) unless a
 * meeting.ended event or `endAt` closes them.
 * @param {import('./webhooks.js').ZoomWebhookEvent[]} events  for one meeting instance
 * @param {{ endAt?: Date|string|number }} [options]
 * @returns {Session[]}
 */
export function sessionsFromWebhookEvents(events, options = {}) {
  const seen = new Set();
  const unique = events.filter((e) => e && !seen.has(e.id) && seen.add(e.id));
  const eventTime = (e) =>
    toMs(e.type === 'participant.joined' ? e.participant?.joinTime : e.type === 'participant.left' ? e.participant?.leaveTime : null) ??
    toMs(e.occurredAt) ??
    0;
  unique.sort((a, b) => eventTime(a) - eventTime(b));

  const ended = unique.find((e) => e.type === 'meeting.ended');
  const closeAt = toMs(options.endAt) ?? toMs(ended?.meeting?.endTime) ?? toMs(ended?.occurredAt);
  const meetingStart = unique.map((e) => toMs(e.meeting?.startTime)).find((ms) => ms !== null) ?? null;

  /** @type {Map<string, Session>} */
  const open = new Map();
  /** @type {Session[]} */
  const sessions = [];
  for (const event of unique) {
    const p = event.participant;
    if (!p || (event.type !== 'participant.joined' && event.type !== 'participant.left')) continue;
    const sessionKey = p.userId ?? p.participantUuid ?? p.zoomUserId ?? p.name ?? '';
    if (event.type === 'participant.joined') {
      if (open.has(sessionKey)) continue; // duplicate join without leave: keep the earliest
      const session = { ...p, joinTime: p.joinTime ?? iso(toMs(event.occurredAt)), leaveTime: null };
      open.set(sessionKey, session);
      sessions.push(session);
    } else {
      const leaveTime = p.leaveTime ?? iso(toMs(event.occurredAt));
      const session = open.get(sessionKey);
      if (session) {
        session.leaveTime = leaveTime;
        session.leaveReason = p.leaveReason;
        open.delete(sessionKey);
      } else if (meetingStart !== null) {
        sessions.push({ ...p, joinTime: iso(meetingStart), leaveTime });
      }
    }
  }
  if (closeAt !== null) for (const session of open.values()) session.leaveTime = iso(Math.max(closeAt, toMs(session.joinTime) ?? closeAt));
  return sessions;
}
