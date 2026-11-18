import { createTokenManager } from './auth.js';
import { parseZoomConfig } from './config.js';
import { ZoomAuthError, ZoomConfigError, ZoomNotFoundError, ZoomValidationError } from './errors.js';
import { createHttp } from './http.js';
import {
  buildCreateMeetingBody,
  buildUpdateMeetingBody,
  createMeetingInputSchema,
  meetingIdString,
  normalizeMeeting,
  updateMeetingInputSchema,
  validateInput,
} from './meetings.js';
import { encodeMeetingRef, normalizeParticipantRow, normalizePastMeeting } from './participants.js';
import { handleWebhookRequest, verifyWebhook } from './webhooks.js';

/**
 * Zoom Meetings client (Server-to-Server OAuth). Dependency-free apart from zod.
 *
 *   const zoom = createZoomClient(config, { fetch, now, logger });
 *   const meeting = await zoom.createMeeting({ topic, startTime, durationMinutes: 30 });
 *   const { participants } = await zoom.listParticipants(meeting.uuid);
 *   const { attendees } = computeAttendance(participants, { thresholdMinutes: 20 });
 *
 * Wave 2 adapter (kind: meetings) can map 1:1: see docs/providers/zoom.md#adapter-mapping.
 */

export * from './errors.js';
export { parseZoomConfig, zoomConfigSchema } from './config.js';
export { DEMO_MEETING_SETTINGS, createMeetingInputSchema, updateMeetingInputSchema, normalizeMeeting, toZoomUtc } from './meetings.js';
export { encodeMeetingRef, normalizeParticipantRow, normalizePastMeeting } from './participants.js';
export {
  verifyWebhook,
  computeSignature,
  buildUrlValidationResponse,
  parseWebhook,
  handleWebhookRequest,
  deriveEventId,
  getHeader,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  REQUEST_ID_HEADER,
  URL_VALIDATION_EVENT,
} from './webhooks.js';
export { computeAttendance, mergeIntervals, groupSessions, sessionsFromWebhookEvents } from './attendance.js';
export { parseRetryAfter } from './http.js';

export const ZOOM_PROVIDER = 'zoom';
export const ZOOM_CAPABILITIES = Object.freeze([
  'meetings.create',
  'meetings.get',
  'meetings.update',
  'meetings.delete',
  'meetings.participants',
  'meetings.pastMeeting',
  'meetings.instances',
  'attendance.compute',
  'webhooks.verify',
  'webhooks.urlValidation',
  'webhooks.parse',
]);

/** Only send the bearer token to Zoom-owned https hosts, whatever api_url says. */
function isZoomApiUrl(value) {
  return typeof value === 'string' && /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.zoom\.us$/i.test(value);
}

const noopLogger = Object.freeze({ debug() {}, info() {}, warn() {}, error() {} });
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @typedef {object} ZoomDeps
 * @property {typeof fetch} [fetch]   defaults to globalThis.fetch
 * @property {() => number} [now]     epoch ms; defaults to Date.now
 * @property {{ debug?: Function, info?: Function, warn?: Function, error?: Function }} [logger]  pino-compatible
 * @property {(ms: number) => Promise<void>} [sleep]  backoff waits (tests pass a no-op)
 * @property {() => number} [random]  jitter source in [0, 1)
 */

/**
 * @typedef {object} CallOptions
 * @property {AbortSignal} [signal]  cancels the call (the per-attempt timeout still applies)
 */

/**
 * @param {unknown} rawConfig  see zoomConfigSchema
 * @param {ZoomDeps} [deps]
 */
export function createZoomClient(rawConfig, deps = {}) {
  const config = parseZoomConfig(rawConfig);
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new ZoomConfigError('No fetch implementation available');
  const now = deps.now ?? Date.now;
  const logger = deps.logger ?? noopLogger;

  /** Values scrubbed from every error message. */
  let tokens;
  const secrets = () => [config.clientSecret, config.webhookSecretToken, tokens?.currentSecret()];
  const http = createHttp({
    fetch: fetchImpl,
    now,
    sleep: deps.sleep ?? defaultSleep,
    random: deps.random ?? Math.random,
    logger,
    options: config,
    secrets,
  });
  tokens = createTokenManager({ config, http, now });

  /**
   * Authenticated API call. A 401 (expired/revoked token) drops the cached token and is
   * retried once with a fresh one; that is safe for any method because Zoom rejected it.
   * @param {{ method: string, path: string, query?: Record<string, string|number|boolean|undefined>, body?: unknown, idempotent: boolean, signal?: AbortSignal }} req
   */
  async function api(req) {
    for (let authAttempt = 0; ; authAttempt += 1) {
      const token = await tokens.getToken({ forceRefresh: authAttempt > 0 });
      const base = config.useTokenApiUrl && isZoomApiUrl(token.apiUrl) ? `${token.apiUrl}/v2` : config.apiBaseUrl;
      const url = new URL(base + req.path);
      for (const [key, value] of Object.entries(req.query ?? {})) {
        if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
      }
      const headers = { authorization: `Bearer ${token.accessToken}`, accept: 'application/json' };
      if (req.body !== undefined) headers['content-type'] = 'application/json';
      try {
        return await http.send({
          method: req.method,
          url: url.toString(),
          path: req.path,
          headers,
          body: req.body === undefined ? undefined : JSON.stringify(req.body),
          idempotent: req.idempotent,
          signal: req.signal,
        });
      } catch (error) {
        if (error instanceof ZoomAuthError && error.status === 401 && authAttempt === 0) {
          tokens.invalidate(token.accessToken);
          continue;
        }
        throw error;
      }
    }
  }

  /**
   * Create a scheduled (or instant) meeting with demo-friendly settings.
   * Not retried automatically (Zoom has no idempotency keys): on an error with
   * `ambiguous: true` the meeting may exist; reconcile before creating again.
   * @param {import('zod').input<typeof createMeetingInputSchema>} input
   * @param {CallOptions} [options]
   * @returns {Promise<import('./meetings.js').ZoomMeeting>}
   */
  async function createMeeting(input, options = {}) {
    const parsed = validateInput(createMeetingInputSchema, input, 'meeting');
    const body = buildCreateMeetingBody(parsed, { defaultTimezone: config.defaultTimezone, meetingSettings: config.meetingSettings, nowMs: now() });
    const host = parsed.hostUserId ?? config.defaultHostUserId;
    const result = await api({ method: 'POST', path: `/users/${encodeURIComponent(host)}/meetings`, body, idempotent: false, signal: options.signal });
    return normalizeMeeting(result.body);
  }

  /**
   * @param {string|number} meetingId
   * @param {CallOptions & { occurrenceId?: string }} [options]
   */
  async function getMeeting(meetingId, options = {}) {
    const id = meetingIdString(meetingId);
    const result = await api({ method: 'GET', path: `/meetings/${id}`, query: { occurrence_id: options.occurrenceId }, idempotent: true, signal: options.signal });
    return normalizeMeeting(result.body);
  }

  /**
   * Change only the given fields (PATCH). Zoom answers 204 with no body; call getMeeting for the new state.
   * Retried on transient errors: repeating the same PATCH yields the same meeting.
   * @param {string|number} meetingId
   * @param {import('zod').input<typeof updateMeetingInputSchema>} patch
   * @param {CallOptions & { occurrenceId?: string }} [options]
   * @returns {Promise<{ updated: true }>}
   */
  async function updateMeeting(meetingId, patch, options = {}) {
    const id = meetingIdString(meetingId);
    const parsed = validateInput(updateMeetingInputSchema, patch, 'meeting update');
    if (parsed.startTime && parsed.startTime.getTime() < now() - 5 * 60_000) {
      throw new ZoomValidationError('Invalid meeting update: startTime is in the past');
    }
    await api({
      method: 'PATCH',
      path: `/meetings/${id}`,
      query: { occurrence_id: options.occurrenceId },
      body: buildUpdateMeetingBody(parsed),
      idempotent: true,
      signal: options.signal,
    });
    return { updated: true };
  }

  /**
   * Delete a meeting (or one occurrence). A meeting that is already gone counts as deleted,
   * which also makes a retried delete safe.
   * @param {string|number} meetingId
   * @param {CallOptions & { occurrenceId?: string, notifyHosts?: boolean, notifyRegistrants?: boolean }} [options]
   * @returns {Promise<{ deleted: true, alreadyDeleted: boolean }>}
   */
  async function deleteMeeting(meetingId, options = {}) {
    const id = meetingIdString(meetingId);
    try {
      await api({
        method: 'DELETE',
        path: `/meetings/${id}`,
        query: {
          occurrence_id: options.occurrenceId,
          schedule_for_reminder: options.notifyHosts ?? false,
          cancel_meeting_reminder: options.notifyRegistrants ?? false,
        },
        idempotent: true,
        signal: options.signal,
      });
      return { deleted: true, alreadyDeleted: false };
    } catch (error) {
      if (error instanceof ZoomNotFoundError) return { deleted: true, alreadyDeleted: true };
      throw error;
    }
  }

  /**
   * Page through past-meeting participants (one row per join session).
   * Pass the instance UUID (from meeting.ended or listPastInstances) for a specific
   * occurrence; a numeric meeting ID means "latest instance".
   * @param {string|number} meetingIdOrUuid
   * @param {CallOptions & { source?: 'report'|'past', pageSize?: number, maxPages?: number }} [options]
   * @returns {AsyncGenerator<import('./participants.js').ZoomParticipantSession>}
   */
  async function* iterateParticipants(meetingIdOrUuid, options = {}) {
    const source = options.source ?? 'report';
    const ref = encodeMeetingRef(meetingIdOrUuid);
    const path = source === 'report' ? `/report/meetings/${ref}/participants` : `/past_meetings/${ref}/participants`;
    const pageSize = Math.min(300, Math.max(1, options.pageSize ?? 300));
    const maxPages = options.maxPages ?? 100;
    let nextPageToken;
    for (let page = 0; page < maxPages; page += 1) {
      const result = await api({
        method: 'GET',
        path,
        query: {
          page_size: pageSize,
          next_page_token: nextPageToken,
          include_fields: source === 'report' ? 'registrant_id' : undefined,
        },
        idempotent: true,
        signal: options.signal,
      });
      for (const row of result.body?.participants ?? []) yield normalizeParticipantRow(row);
      nextPageToken = result.body?.next_page_token;
      if (!nextPageToken) return;
    }
    logger.warn?.({ zoom: { path, maxPages } }, 'zoom participant pagination stopped at maxPages');
  }

  /**
   * All participant sessions for a past meeting instance.
   * @param {string|number} meetingIdOrUuid
   * @param {CallOptions & { source?: 'report'|'past', pageSize?: number, maxPages?: number }} [options]
   */
  async function listParticipants(meetingIdOrUuid, options = {}) {
    const participants = [];
    for await (const participant of iterateParticipants(meetingIdOrUuid, options)) participants.push(participant);
    return { participants };
  }

  /**
   * Details of a finished meeting instance (actual start/end, for attendance windows).
   * @param {string|number} meetingIdOrUuid
   * @param {CallOptions} [options]
   */
  async function getPastMeeting(meetingIdOrUuid, options = {}) {
    const result = await api({ method: 'GET', path: `/past_meetings/${encodeMeetingRef(meetingIdOrUuid)}`, idempotent: true, signal: options.signal });
    return normalizePastMeeting(result.body);
  }

  /**
   * Instance UUIDs of a (recurring) meeting that has ended.
   * @param {string|number} meetingId
   * @param {CallOptions} [options]
   * @returns {Promise<Array<{ uuid: string, startTime: string|null }>>}
   */
  async function listPastInstances(meetingId, options = {}) {
    const id = meetingIdString(meetingId);
    const result = await api({ method: 'GET', path: `/past_meetings/${id}/instances`, idempotent: true, signal: options.signal });
    return (result.body?.meetings ?? []).map((m) => ({ uuid: m.uuid, startTime: m.start_time ? new Date(m.start_time).toISOString() : null }));
  }

  function requireWebhookSecret() {
    if (!config.webhookSecretToken) throw new ZoomConfigError('webhookSecretToken is not configured');
    return config.webhookSecretToken;
  }

  return Object.freeze({
    provider: ZOOM_PROVIDER,
    capabilities: ZOOM_CAPABILITIES,
    /** Fetch (or reuse) the S2S access token; mainly for health checks ("test connection"). */
    async getAccessToken(options = {}) {
      const token = await tokens.getToken(options);
      return { expiresAt: new Date(token.expiresAt).toISOString(), scopes: token.scopes, apiUrl: token.apiUrl };
    },
    createMeeting,
    getMeeting,
    updateMeeting,
    deleteMeeting,
    iterateParticipants,
    listParticipants,
    getPastMeeting,
    listPastInstances,
    webhooks: Object.freeze({
      /** @param {string|Buffer} rawBody @param {Headers|Record<string, any>} headers */
      verify: (rawBody, headers) =>
        verifyWebhook(rawBody, headers, requireWebhookSecret(), { now: now(), toleranceSeconds: config.webhookToleranceSeconds }),
      /** @param {{ rawBody: string|Buffer, headers: Headers|Record<string, any> }} request */
      handle: (request) =>
        handleWebhookRequest(request, { secret: requireWebhookSecret(), now: now(), toleranceSeconds: config.webhookToleranceSeconds }),
    }),
  });
}
