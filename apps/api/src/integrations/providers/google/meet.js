import { GoogleError } from './errors.js';
import { normalizeConferenceRecord, normalizeParticipant, normalizeSession, toUtcIso, unionSeconds } from './normalize.js';

const MEETING_CODE_RE = /^[a-z]+-[a-z]+-[a-z]+$/i;
const SPACE_NAME_RE = /^spaces\/[A-Za-z0-9_-]{1,128}$/;
const RECORD_NAME_RE = /^conferenceRecords\/[A-Za-z0-9_-]{1,256}$/;
const PARTICIPANT_NAME_RE = /^conferenceRecords\/[A-Za-z0-9_-]{1,256}\/participants\/[A-Za-z0-9_-]{1,256}$/;

/** Page-size caps documented for each list method. */
export const MEET_PAGE_MAX = Object.freeze({ conferenceRecords: 100, participants: 250, participantSessions: 250 });

/**
 * @param {unknown} value
 * @param {RegExp} re
 * @param {string} field
 */
function requireName(value, re, field) {
  if (typeof value !== 'string' || !re.test(value)) throw new GoogleError('bad_request', `${field} is not a valid resource name`, { reason: 'invalid' });
  return value;
}

/**
 * Filter string for conferenceRecords.list (EBNF filter, fields: space.meeting_code,
 * space.name, start_time, end_time). Values are validated, so nothing user-supplied can
 * break out of the quotes.
 * @param {{ meetingCode?: string, spaceName?: string, startTimeFrom?: Date|string|number,
 *   startTimeTo?: Date|string|number, ongoing?: boolean }} input
 */
export function conferenceRecordFilter(input) {
  const parts = [];
  if (input.meetingCode !== undefined) {
    if (!MEETING_CODE_RE.test(input.meetingCode)) throw new GoogleError('bad_request', 'meetingCode must look like abc-mnop-xyz', { reason: 'invalid' });
    parts.push(`space.meeting_code = "${input.meetingCode.toLowerCase()}"`);
  }
  if (input.spaceName !== undefined) parts.push(`space.name = "${requireName(input.spaceName, SPACE_NAME_RE, 'spaceName')}"`);
  if (input.startTimeFrom !== undefined) parts.push(`start_time>="${toUtcIso(input.startTimeFrom, 'startTimeFrom')}"`);
  if (input.startTimeTo !== undefined) parts.push(`start_time<="${toUtcIso(input.startTimeTo, 'startTimeTo')}"`);
  if (input.ongoing) parts.push('end_time IS NULL');
  return parts.length ? parts.join(' AND ') : undefined;
}

/**
 * Meet REST API v2: spaces, conference records, participants and sessions (attendance).
 * Requires user credentials (per-user OAuth, or a service account with a delegation subject).
 * @param {{ config: import('./config.js').GoogleConfig, request: (o: import('./http.js').RequestOptions) => Promise<any>, now: () => number }} ctx
 */
export function createMeetApi({ config, request, now }) {
  const base = config.endpoints.meetBaseUrl;

  function assertUserAuth() {
    if (config.auth.type === 'service_account' && !config.auth.subject) {
      throw new GoogleError('config_invalid', 'The Meet REST API needs user credentials: set auth.subject (domain-wide delegation) or use oauth_user auth');
    }
  }

  /**
   * @param {{ operation: string, path: string, query?: Record<string, any>, signal?: AbortSignal }} input
   */
  function get(input) {
    assertUserAuth();
    return request({ operation: input.operation, method: 'GET', url: `${base}/${input.path}`, query: input.query, idempotent: true, signal: input.signal });
  }

  /**
   * Follow nextPageToken up to maxPages.
   * @template T
   * @param {(pageToken: string|undefined) => Promise<{ items: T[], nextPageToken: string|null }>} fetchPage
   * @param {number} maxPages
   */
  async function collect(fetchPage, maxPages) {
    const all = [];
    let pageToken;
    for (let page = 0; page < maxPages; page += 1) {
      const { items, nextPageToken } = await fetchPage(pageToken);
      all.push(...items);
      if (!nextPageToken) return all;
      pageToken = nextPageToken;
    }
    throw new GoogleError('invalid_response', `Meet listing did not finish within ${maxPages} pages`);
  }

  /**
   * Look up a meeting space by resource name ("spaces/abc") or meeting code ("abc-mnop-xyz").
   * Meeting codes can be reassigned later; store the returned `name` instead.
   * @param {{ space: string, signal?: AbortSignal }} input
   */
  async function getSpace(input) {
    const name = MEETING_CODE_RE.test(input.space) ? `spaces/${input.space.toLowerCase()}` : requireName(input.space, SPACE_NAME_RE, 'space');
    const raw = await get({ operation: 'spaces.get', path: name, signal: input.signal });
    return {
      name: raw?.name ?? null,
      meetingUri: raw?.meetingUri ?? null,
      meetingCode: raw?.meetingCode ?? null,
      activeConferenceRecord: raw?.activeConference?.conferenceRecord ?? null,
      config: raw?.config ?? null,
    };
  }

  /**
   * One page of conference records (newest first). Only conferences the authenticated user
   * organised are returned. Records are deleted by Google 30 days after the conference ends.
   * @param {Parameters<typeof conferenceRecordFilter>[0] & { pageSize?: number, pageToken?: string, signal?: AbortSignal }} [input]
   */
  async function listConferenceRecords(input = {}) {
    const raw = await get({
      operation: 'conferenceRecords.list',
      path: 'conferenceRecords',
      query: {
        filter: conferenceRecordFilter(input),
        pageSize: input.pageSize === undefined ? undefined : Math.min(input.pageSize, MEET_PAGE_MAX.conferenceRecords),
        pageToken: input.pageToken,
      },
      signal: input.signal,
    });
    return { items: (raw?.conferenceRecords ?? []).map(normalizeConferenceRecord), nextPageToken: raw?.nextPageToken ?? null };
  }

  /**
   * One page of participants of a conference record (latest joiners first).
   * @param {{ conferenceRecord: string, activeOnly?: boolean, pageSize?: number, pageToken?: string, signal?: AbortSignal }} input
   */
  async function listParticipants(input) {
    const record = requireName(input.conferenceRecord, RECORD_NAME_RE, 'conferenceRecord');
    const raw = await get({
      operation: 'participants.list',
      path: `${record}/participants`,
      query: {
        filter: input.activeOnly ? 'latest_end_time IS NULL' : undefined,
        pageSize: Math.min(input.pageSize ?? MEET_PAGE_MAX.participants, MEET_PAGE_MAX.participants),
        pageToken: input.pageToken,
      },
      signal: input.signal,
    });
    return { items: (raw?.participants ?? []).map(normalizeParticipant), nextPageToken: raw?.nextPageToken ?? null };
  }

  /**
   * One page of a participant's join/leave sessions.
   * @param {{ participant: string, pageSize?: number, pageToken?: string, signal?: AbortSignal }} input
   */
  async function listParticipantSessions(input) {
    const participant = requireName(input.participant, PARTICIPANT_NAME_RE, 'participant');
    const raw = await get({
      operation: 'participantSessions.list',
      path: `${participant}/participantSessions`,
      query: {
        pageSize: Math.min(input.pageSize ?? MEET_PAGE_MAX.participantSessions, MEET_PAGE_MAX.participantSessions),
        pageToken: input.pageToken,
      },
      signal: input.signal,
    });
    return { items: (raw?.participantSessions ?? []).map(normalizeSession), nextPageToken: raw?.nextPageToken ?? null };
  }

  /**
   * Attendance for one conference record: every participant with sessions and attended
   * seconds (overlapping sessions counted once; open sessions counted up to now).
   * @param {{ conferenceRecord: string, maxPages?: number, signal?: AbortSignal }} input
   */
  async function getConferenceAttendance(input) {
    const maxPages = input.maxPages ?? 20;
    const participants = await collect(
      (pageToken) => listParticipants({ conferenceRecord: input.conferenceRecord, pageToken, signal: input.signal }),
      maxPages,
    );
    const nowMs = now();
    const out = [];
    for (const p of participants) {
      const sessions = await collect(
        (pageToken) => listParticipantSessions({ participant: p.name, pageToken, signal: input.signal }),
        maxPages,
      );
      sessions.sort((a, b) => Date.parse(a.start ?? '') - Date.parse(b.start ?? ''));
      out.push({ ...p, sessions, attendedSeconds: unionSeconds(sessions, nowMs), active: sessions.some((s) => !s.end) });
    }
    return out;
  }

  /**
   * Attendance for every conference held in a space (one Calendar event's Meet link can be
   * used several times). Identify the space by meetingCode (from the event's Meet link) or
   * spaceName.
   * @param {{ meetingCode?: string, spaceName?: string, startTimeFrom?: Date|string|number,
   *   startTimeTo?: Date|string|number, maxPages?: number, signal?: AbortSignal }} input
   */
  async function getMeetingAttendance(input) {
    if (!input.meetingCode && !input.spaceName) throw new GoogleError('bad_request', 'meetingCode or spaceName is required', { reason: 'required' });
    const maxPages = input.maxPages ?? 20;
    const records = await collect(
      (pageToken) =>
        listConferenceRecords({
          meetingCode: input.meetingCode,
          spaceName: input.spaceName,
          startTimeFrom: input.startTimeFrom,
          startTimeTo: input.startTimeTo,
          pageSize: MEET_PAGE_MAX.conferenceRecords,
          pageToken,
          signal: input.signal,
        }),
      maxPages,
    );
    const conferences = [];
    for (const record of records) {
      conferences.push({ ...record, participants: await getConferenceAttendance({ conferenceRecord: record.name, maxPages, signal: input.signal }) });
    }
    return { conferences };
  }

  return { getSpace, listConferenceRecords, listParticipants, listParticipantSessions, getConferenceAttendance, getMeetingAttendance };
}
