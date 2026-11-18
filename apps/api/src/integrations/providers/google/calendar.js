import { randomUUID } from 'node:crypto';
import { FullSyncRequiredError, GoogleError } from './errors.js';
import {
  buildEventBody,
  conferenceRequestIdFromKey,
  eventIdFromKey,
  isValidEventId,
  normalizeEvent,
  normalizeFreeBusy,
  toUtcIso,
} from './normalize.js';
import { createChannelToken, MAX_CHANNEL_ID_LENGTH } from './webhook.js';

/** Google caps calendarExpansionMax at 50, so larger freeBusy queries are split. */
export const FREEBUSY_MAX_CALENDARS = 50;
/** Query parameters Google rejects in combination with syncToken. */
const SYNC_INCOMPATIBLE = ['iCalUID', 'orderBy', 'privateExtendedProperty', 'q', 'sharedExtendedProperty', 'timeMin', 'timeMax', 'updatedMin'];
const SEND_UPDATES = new Set(['all', 'externalOnly', 'none']);

/**
 * Calendar v3 operations.
 * @param {{ config: import('./config.js').GoogleConfig, request: (o: import('./http.js').RequestOptions) => Promise<any>,
 *   now: () => number, sleep: (ms: number) => Promise<void> }} ctx
 */
export function createCalendarApi({ config, request, now, sleep }) {
  const base = config.endpoints.calendarBaseUrl;
  const eventsUrl = (calendarId) => `${base}/calendars/${encodeURIComponent(calendarId)}/events`;
  const eventUrl = (calendarId, eventId) => `${eventsUrl(calendarId)}/${encodeURIComponent(eventId)}`;
  const cal = (calendarId) => calendarId ?? config.calendarId;

  /** @param {string|undefined} value */
  function sendUpdates(value) {
    const v = value ?? 'none';
    if (!SEND_UPDATES.has(v)) throw new GoogleError('bad_request', 'sendUpdates must be all, externalOnly or none', { reason: 'invalid' });
    return v;
  }

  /**
   * Busy intervals for up to any number of calendars (split into batches of 50).
   * @param {{ calendarIds: string[], timeMin: Date|string|number, timeMax: Date|string|number, signal?: AbortSignal }} input
   */
  async function freeBusy(input) {
    if (!input.calendarIds?.length) throw new GoogleError('bad_request', 'calendarIds is required', { reason: 'required' });
    const timeMin = toUtcIso(input.timeMin, 'timeMin');
    const timeMax = toUtcIso(input.timeMax, 'timeMax');
    if (Date.parse(timeMax) <= Date.parse(timeMin)) {
      throw new GoogleError('bad_request', 'timeMax must be after timeMin', { reason: 'timeRangeEmpty' });
    }
    const merged = { timeMin, timeMax, calendars: {}, groups: {} };
    for (let i = 0; i < input.calendarIds.length; i += FREEBUSY_MAX_CALENDARS) {
      const ids = input.calendarIds.slice(i, i + FREEBUSY_MAX_CALENDARS);
      const raw = await request({
        operation: 'freebusy.query',
        method: 'POST',
        url: `${base}/freeBusy`,
        json: { timeMin, timeMax, timeZone: 'UTC', calendarExpansionMax: ids.length, items: ids.map((id) => ({ id })) },
        idempotent: true, // read-only query
        signal: input.signal,
      });
      const part = normalizeFreeBusy(raw);
      Object.assign(merged.calendars, part.calendars);
      Object.assign(merged.groups, part.groups);
    }
    return merged;
  }

  /**
   * @param {{ calendarId?: string, eventId: string, signal?: AbortSignal }} input
   */
  async function getEvent(input) {
    const calendarId = cal(input.calendarId);
    const raw = await request({ operation: 'events.get', method: 'GET', url: eventUrl(calendarId, input.eventId), idempotent: true, signal: input.signal });
    return normalizeEvent(raw, calendarId);
  }

  /**
   * Create an event, optionally with a Google Meet conference.
   *
   * With `idempotencyKey`, the event ID and the conference requestId are derived from the key,
   * the call is retried on transient failures, and a 409 duplicate (the event already exists
   * from an earlier attempt) returns that event with `deduplicated: true`.
   * @param {import('./normalize.js').EventInput & { calendarId?: string, idempotencyKey?: string,
   *   eventId?: string, sendUpdates?: 'all'|'externalOnly'|'none', signal?: AbortSignal }} input
   */
  async function insertEvent(input) {
    const calendarId = cal(input.calendarId);
    if (input.start === undefined || input.end === undefined) {
      throw new GoogleError('bad_request', 'start and end are required', { reason: 'required' });
    }
    const eventId = input.eventId ?? (input.idempotencyKey ? eventIdFromKey(input.idempotencyKey) : undefined);
    if (eventId !== undefined && !isValidEventId(eventId)) {
      throw new GoogleError('bad_request', 'eventId must be 5-1024 characters of a-v and 0-9', { reason: 'invalid' });
    }
    const body = buildEventBody(input, {
      timeZone: config.defaultTimeZone,
      conferenceRequestId: input.idempotencyKey ? conferenceRequestIdFromKey(input.idempotencyKey) : randomUUID(),
    });
    if (eventId) body.id = eventId;
    try {
      const raw = await request({
        operation: 'events.insert',
        method: 'POST',
        url: eventsUrl(calendarId),
        query: { conferenceDataVersion: input.withMeet ? 1 : 0, sendUpdates: sendUpdates(input.sendUpdates) },
        json: body,
        idempotent: Boolean(eventId), // a client-chosen ID turns a repeat into a 409, not a second event
        signal: input.signal,
      });
      return { ...normalizeEvent(raw, calendarId), deduplicated: false };
    } catch (error) {
      if (eventId && error instanceof GoogleError && error.code === 'duplicate') {
        const existing = await getEvent({ calendarId, eventId, signal: input.signal });
        return { ...existing, deduplicated: true };
      }
      throw error;
    }
  }

  /**
   * Partial update. Arrays (attendees, reminders) replace the stored arrays entirely.
   * conferenceDataVersion=1 is sent only when adding Meet, so existing conferences are never
   * dropped by a client that did not read them.
   * @param {{ calendarId?: string, eventId: string, changes: import('./normalize.js').EventInput,
   *   sendUpdates?: 'all'|'externalOnly'|'none', signal?: AbortSignal }} input
   */
  async function patchEvent(input) {
    const calendarId = cal(input.calendarId);
    const body = buildEventBody(input.changes, { timeZone: config.defaultTimeZone, conferenceRequestId: randomUUID() });
    const raw = await request({
      operation: 'events.patch',
      method: 'PATCH',
      url: eventUrl(calendarId, input.eventId),
      query: { conferenceDataVersion: input.changes.withMeet ? 1 : 0, sendUpdates: sendUpdates(input.sendUpdates) },
      json: body,
      idempotent: false, // a repeat could re-send guest notifications
      signal: input.signal,
    });
    return normalizeEvent(raw, calendarId);
  }

  /**
   * Delete (cancel) an event. Deleting an already-deleted event (410) counts as success.
   * @param {{ calendarId?: string, eventId: string, sendUpdates?: 'all'|'externalOnly'|'none', signal?: AbortSignal }} input
   */
  async function deleteEvent(input) {
    const calendarId = cal(input.calendarId);
    try {
      await request({
        operation: 'events.delete',
        method: 'DELETE',
        url: eventUrl(calendarId, input.eventId),
        query: { sendUpdates: sendUpdates(input.sendUpdates) },
        idempotent: true,
        signal: input.signal,
      });
      return { deleted: true, alreadyDeleted: false };
    } catch (error) {
      if (error instanceof GoogleError && error.status === 410) return { deleted: true, alreadyDeleted: true };
      throw error;
    }
  }

  /**
   * Poll until Google finishes creating the Meet conference (createRequest status leaves "pending").
   * @param {{ calendarId?: string, eventId: string, attempts?: number, intervalMs?: number, signal?: AbortSignal }} input
   */
  async function waitForConference(input) {
    const attempts = input.attempts ?? 5;
    let event = await getEvent(input);
    for (let i = 1; i < attempts && event.meet?.status === 'pending'; i += 1) {
      await sleep(input.intervalMs ?? 1000);
      event = await getEvent(input);
    }
    return event;
  }

  /**
   * One page of events. Pass `syncToken` for incremental changes (deleted events included as
   * status "cancelled"); a 410 throws FullSyncRequiredError.
   * @param {{ calendarId?: string, syncToken?: string, pageToken?: string, timeMin?: Date|string|number,
   *   timeMax?: Date|string|number, updatedMin?: Date|string|number, singleEvents?: boolean, showDeleted?: boolean,
   *   orderBy?: 'startTime'|'updated', maxResults?: number, q?: string, privateExtendedProperty?: string[],
   *   signal?: AbortSignal }} input
   */
  async function listEvents(input = {}) {
    const calendarId = cal(input.calendarId);
    if (input.syncToken) {
      const clash = SYNC_INCOMPATIBLE.filter((k) => input[k] !== undefined);
      if (clash.length) {
        throw new GoogleError('bad_request', `syncToken cannot be combined with ${clash.join(', ')}`, { reason: 'invalid' });
      }
    }
    const query = {
      syncToken: input.syncToken,
      pageToken: input.pageToken,
      timeMin: input.timeMin === undefined ? undefined : toUtcIso(input.timeMin, 'timeMin'),
      timeMax: input.timeMax === undefined ? undefined : toUtcIso(input.timeMax, 'timeMax'),
      updatedMin: input.updatedMin === undefined ? undefined : toUtcIso(input.updatedMin, 'updatedMin'),
      singleEvents: input.singleEvents,
      showDeleted: input.showDeleted,
      orderBy: input.orderBy,
      maxResults: input.maxResults === undefined ? undefined : Math.min(Math.max(1, input.maxResults), 2500),
      q: input.q,
      privateExtendedProperty: input.privateExtendedProperty,
    };
    try {
      const raw = await request({ operation: 'events.list', method: 'GET', url: eventsUrl(calendarId), query, idempotent: true, signal: input.signal });
      return {
        events: (raw?.items ?? []).map((item) => normalizeEvent(item, calendarId)),
        nextPageToken: raw?.nextPageToken ?? null,
        nextSyncToken: raw?.nextSyncToken ?? null,
        timeZone: raw?.timeZone ?? null,
      };
    } catch (error) {
      if (input.syncToken && error instanceof GoogleError && error.status === 410 && !(error instanceof FullSyncRequiredError)) {
        throw new FullSyncRequiredError(error.message, { status: 410, reason: error.reason ?? undefined, operation: 'events.list' });
      }
      throw error;
    }
  }

  /**
   * Follow every page of a full or incremental sync and return the new sync token. Run this
   * after each "calendar.events.changed" push notification.
   * @param {{ calendarId?: string, syncToken?: string|null, timeMin?: Date|string|number, maxPages?: number, signal?: AbortSignal }} input
   */
  async function syncEvents(input = {}) {
    const maxPages = input.maxPages ?? 100;
    const events = [];
    let pageToken;
    for (let page = 0; page < maxPages; page += 1) {
      const result = await listEvents({
        calendarId: input.calendarId,
        syncToken: input.syncToken ?? undefined,
        timeMin: input.syncToken ? undefined : input.timeMin,
        pageToken,
        maxResults: 2500,
        signal: input.signal,
      });
      events.push(...result.events);
      if (result.nextSyncToken) return { events, nextSyncToken: result.nextSyncToken, fullSync: !input.syncToken };
      if (!result.nextPageToken) break;
      pageToken = result.nextPageToken;
    }
    throw new GoogleError('invalid_response', `events sync did not finish within ${maxPages} pages`, { operation: 'events.list' });
  }

  /**
   * Open a push channel for a calendar's events. The channel token is an HMAC bound to the
   * channel ID and expiry (see webhook.js). Channels do not renew: call again before
   * `expiresAt` with a new channel ID and stop the old one.
   * @param {{ calendarId?: string, channelId?: string, ttlSeconds?: number, address?: string,
   *   eventTypes?: string[], signal?: AbortSignal }} input
   */
  async function watchEvents(input = {}) {
    const webhook = config.webhook;
    if (!webhook) throw new GoogleError('config_invalid', 'webhook config is required to create push channels');
    const calendarId = cal(input.calendarId);
    const channelId = input.channelId ?? randomUUID();
    if (channelId.length > MAX_CHANNEL_ID_LENGTH) throw new GoogleError('bad_request', 'channelId must be at most 64 characters', { reason: 'invalid' });
    const ttlSeconds = input.ttlSeconds ?? webhook.ttlSeconds;
    const requestedExpiryMs = now() + ttlSeconds * 1000;
    const raw = await request({
      operation: 'events.watch',
      method: 'POST',
      url: `${eventsUrl(calendarId)}/watch`,
      query: { eventTypes: input.eventTypes },
      json: {
        id: channelId,
        type: 'web_hook',
        address: input.address ?? webhook.address,
        token: createChannelToken(webhook.channelSecret, channelId, requestedExpiryMs),
        params: { ttl: String(ttlSeconds) },
      },
      idempotent: false, // a repeat with the same channel ID is rejected by Google
      signal: input.signal,
    });
    const expirationMs = raw?.expiration !== undefined ? Number(raw.expiration) : requestedExpiryMs;
    return {
      channelId: raw?.id ?? channelId,
      resourceId: raw?.resourceId ?? null,
      resourceUri: raw?.resourceUri ?? null,
      calendarId,
      expiresAt: new Date(Math.min(expirationMs, requestedExpiryMs)).toISOString(),
    };
  }

  /**
   * Stop a push channel. Needs both IDs from watchEvents. A 404 (already stopped or expired)
   * counts as success.
   * @param {{ channelId: string, resourceId: string, signal?: AbortSignal }} input
   */
  async function stopChannel(input) {
    if (!input.channelId || !input.resourceId) throw new GoogleError('bad_request', 'channelId and resourceId are required', { reason: 'required' });
    try {
      await request({
        operation: 'channels.stop',
        method: 'POST',
        url: `${base}/channels/stop`,
        json: { id: input.channelId, resourceId: input.resourceId },
        idempotent: true,
        signal: input.signal,
      });
      return { stopped: true, alreadyStopped: false };
    } catch (error) {
      if (error instanceof GoogleError && error.status === 404) return { stopped: true, alreadyStopped: true };
      throw error;
    }
  }

  return { freeBusy, getEvent, insertEvent, patchEvent, deleteEvent, waitForConference, listEvents, syncEvents, watchEvents, stopChannel };
}
