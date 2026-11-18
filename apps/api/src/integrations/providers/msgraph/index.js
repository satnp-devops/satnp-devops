import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { parseMsgraphConfig, redactConfig, secretValues } from './config.js';
import { MsgraphError } from './errors.js';
import { createGraphTransport, defaultSleep, silentLogger } from './http.js';
import {
  normaliseAttendanceRecord,
  normaliseAttendanceReport,
  normaliseEvent,
  normaliseOnlineMeeting,
  normaliseSchedule,
  normaliseSubscription,
  toEpochMs,
  toGraphDateTime,
} from './normalize.js';
import { createTokenProvider } from './token.js';
import { createClientState, parseWebhook, validationResponse, verifyWebhook } from './webhook.js';

/**
 * Microsoft 365 (Microsoft Graph v1.0) client for calendars and Teams meetings, app-only.
 *
 * Wave 2 wraps this in the platform adapter (kind: calendar + meetings). Everything here is
 * dependency-free apart from zod; fetch, clock, logger, sleep and randomness are injectable.
 *
 *   const graph = createMsgraphClient(config, { fetch, now, logger });
 *   const { schedules } = await graph.getSchedule({ mailbox, emails, start, end });
 *   const event = await graph.createEvent(mailbox, { subject, start, end, attendees, idempotencyKey });
 *
 * `mailbox` is the Entra user object ID (preferred) or UPN of the calendar owner / organizer.
 * Online-meeting and attendance calls need the object ID.
 */

export { MsgraphError } from './errors.js';
export { msgraphConfigSchema, parseMsgraphConfig, redactConfig } from './config.js';
export {
  createClientState,
  parseWebhook,
  validationResponse,
  verifyClientState,
  verifyValidationToken,
  verifyWebhook,
  GRAPH_CHANGE_TRACKING_APP_ID,
} from './webhook.js';
export { fromGraphDateTime, fromGraphTimestamp, toGraphDateTime } from './normalize.js';

export const PROVIDER = 'msgraph';

/** What this client can do; the adapter maps these to platform capabilities. */
export const capabilities = Object.freeze({
  kinds: Object.freeze(['calendar', 'meetings']),
  availability: true,
  createEvent: true,
  updateEvent: true,
  cancelEvent: true,
  deleteEvent: true,
  onlineMeetings: Object.freeze(['teamsForBusiness']),
  idempotentCreate: true,
  webhooks: Object.freeze({ subscriptions: true, lifecycle: true, renewRequired: true, maxLifetimeMinutes: 10_080 }),
  attendanceReports: true,
});

/** Application permissions the Entra app needs (admin consent), per operation. */
export const REQUIRED_APP_PERMISSIONS = Object.freeze({
  getSchedule: 'Calendars.ReadBasic',
  events: 'Calendars.ReadWrite',
  subscriptions: 'Calendars.Read',
  onlineMeetingLookup: 'OnlineMeetings.Read.All',
  attendanceReports: 'OnlineMeetingArtifact.Read.All',
});

const MAX_OUTLOOK_EVENT_SUBSCRIPTION_MINUTES = 10_080;
const MAX_PAGES = 50;

const timeInput = z.union([z.date(), z.number(), z.string()]);
const attendeeInput = z.object({
  email: z.email(),
  name: z.string().max(256).optional(),
  type: z.enum(['required', 'optional', 'resource']).default('required'),
});
const bodyInput = z.union([
  z.object({ html: z.string().max(1_000_000) }),
  z.object({ text: z.string().max(1_000_000) }),
]);
const eventFields = {
  subject: z.string().max(255),
  start: timeInput,
  end: timeInput,
  attendees: z.array(attendeeInput).max(500),
  body: bodyInput,
  location: z.string().max(255),
  showAs: z.enum(['free', 'tentative', 'busy', 'oof', 'workingElsewhere', 'unknown']),
  categories: z.array(z.string().max(255)).max(25),
  reminderMinutesBeforeStart: z.number().int().min(0).max(40_320),
  allowNewTimeProposals: z.boolean(),
  responseRequested: z.boolean(),
  hideAttendees: z.boolean(),
};
const createEventInput = z.object({
  ...eventFields,
  attendees: eventFields.attendees.default([]),
  body: eventFields.body.optional(),
  location: eventFields.location.optional(),
  showAs: eventFields.showAs.optional(),
  categories: eventFields.categories.optional(),
  reminderMinutesBeforeStart: eventFields.reminderMinutesBeforeStart.optional(),
  allowNewTimeProposals: eventFields.allowNewTimeProposals.optional(),
  responseRequested: eventFields.responseRequested.optional(),
  hideAttendees: eventFields.hideAttendees.optional(),
  /** Create a Teams meeting for the event (default true). */
  onlineMeeting: z.boolean().default(true),
  /** Sent as Graph's transactionId so a retried create doesn't make a second event. */
  idempotencyKey: z.string().min(1).max(255).optional(),
  calendarId: z.string().min(1).optional(),
});
const updateEventInput = z.object(eventFields).partial().strict();
const scheduleInput = z.object({
  mailbox: z.string().min(1),
  emails: z.array(z.email()).min(1),
  start: timeInput,
  end: timeInput,
  intervalMinutes: z.number().int().min(5).max(1440).default(30),
});
const subscriptionInput = z.object({
  mailbox: z.string().min(1).optional(),
  resource: z.string().min(1).optional(),
  changeTypes: z.array(z.enum(['created', 'updated', 'deleted'])).min(1).default(['created', 'updated', 'deleted']),
  expiresAt: timeInput.optional(),
  notificationUrl: z.url({ protocol: /^https$/ }).optional(),
  lifecycleNotificationUrl: z.url({ protocol: /^https$/ }).optional(),
});

/**
 * @template {z.ZodType} S
 * @param {S} schema
 * @param {unknown} input
 * @param {string} operation
 * @returns {z.output<S>}
 */
function parseInput(schema, input, operation) {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const issues = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
  throw new MsgraphError(`${operation}: invalid input (${issues.map((i) => `${i.path || '(root)'}: ${i.message}`).join('; ')})`, {
    kind: 'validation',
    code: 'invalid_input',
    operation,
    details: { issues },
  });
}

/** @param {unknown} value @param {string} name */
function segment(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new MsgraphError(`${name} is required`, { kind: 'validation', code: 'invalid_input', details: { field: name } });
  }
  return encodeURIComponent(value);
}

/** OData string literal: single quotes are escaped by doubling. @param {string} value */
function odataString(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

/** @param {{ html?: string, text?: string } | undefined} body */
function graphBody(body) {
  if (!body) return undefined;
  return 'html' in body ? { contentType: 'HTML', content: body.html } : { contentType: 'Text', content: body.text };
}

/** @param {Partial<z.output<typeof updateEventInput>>} input */
function graphEventFields(input) {
  /** @type {Record<string, unknown>} */
  const out = {};
  if (input.subject !== undefined) out.subject = input.subject;
  if (input.body !== undefined) out.body = graphBody(input.body);
  if (input.start !== undefined) out.start = toGraphDateTime(input.start, 'start');
  if (input.end !== undefined) out.end = toGraphDateTime(input.end, 'end');
  if (input.attendees !== undefined) {
    out.attendees = input.attendees.map((a) => ({
      emailAddress: a.name ? { address: a.email, name: a.name } : { address: a.email },
      type: a.type,
    }));
  }
  if (input.location !== undefined) out.location = { displayName: input.location };
  for (const key of /** @type {const} */ ([
    'showAs',
    'categories',
    'reminderMinutesBeforeStart',
    'allowNewTimeProposals',
    'responseRequested',
    'hideAttendees',
  ])) {
    if (input[key] !== undefined) out[key] = input[key];
  }
  return out;
}

/** @param {unknown} start @param {unknown} end @param {string} operation */
function assertOrdered(start, end, operation) {
  if (toEpochMs(/** @type {any} */ (end), 'end') <= toEpochMs(/** @type {any} */ (start), 'start')) {
    throw new MsgraphError(`${operation}: end must be after start`, { kind: 'validation', code: 'invalid_range', operation });
  }
}

/**
 * @param {import('./config.js').MsgraphConfigInput} configInput
 * @param {{
 *   fetch?: import('./http.js').FetchLike,
 *   now?: () => number,
 *   logger?: import('./http.js').Logger,
 *   sleep?: (ms: number, signal?: AbortSignal) => Promise<unknown>,
 *   random?: () => number,
 *   randomUUID?: () => string,
 * }} [deps]
 */
export function createMsgraphClient(configInput, deps = {}) {
  const config = parseMsgraphConfig(configInput);
  const fetch = deps.fetch ?? globalThis.fetch;
  if (typeof fetch !== 'function') throw new MsgraphError('No fetch implementation available', { kind: 'config', code: 'no_fetch' });
  const now = deps.now ?? Date.now;
  const logger = deps.logger ?? silentLogger;
  const sleep = deps.sleep ?? defaultSleep;
  const random = deps.random ?? Math.random;
  const uuid = deps.randomUUID ?? randomUUID;
  const secrets = secretValues(config);
  const tokens = createTokenProvider({ config, fetch, now, sleep, random, logger, secrets });
  const transport = createGraphTransport({ config, fetch, now, sleep, random, randomUUID: uuid, logger, tokens, secrets });
  const immutable = config.useImmutableIds ? ['IdType="ImmutableId"'] : [];
  const calendarPrefer = ['outlook.timezone="UTC"', ...immutable];

  /**
   * Follow @odata.nextLink pages (same origin only) and return all items.
   * @param {import('./http.js').GraphRequest} first
   */
  async function collect(first) {
    const items = [];
    /** @type {string | undefined} */
    let next = first.path;
    let query = first.query;
    for (let page = 0; next && page < MAX_PAGES; page += 1) {
      const res = await transport.request({ ...first, path: next, query });
      items.push(...(res.body?.value ?? []));
      next = res.body?.['@odata.nextLink'];
      query = undefined;
    }
    return items;
  }

  /** @param {string} mailbox @param {string | undefined} calendarId */
  function eventsPath(mailbox, calendarId) {
    const user = `/users/${segment(mailbox, 'mailbox')}`;
    return calendarId ? `${user}/calendars/${segment(calendarId, 'calendarId')}/events` : `${user}/events`;
  }

  /** @param {string} mailbox @param {string} eventId */
  function eventPath(mailbox, eventId) {
    return `/users/${segment(mailbox, 'mailbox')}/events/${segment(eventId, 'eventId')}`;
  }

  /** @param {Date | number | string | undefined} expiresAt */
  function subscriptionExpiry(expiresAt) {
    const at = expiresAt === undefined ? now() + config.subscriptionLifetimeMinutes * 60_000 : toEpochMs(expiresAt, 'expiresAt');
    if (at > now() + MAX_OUTLOOK_EVENT_SUBSCRIPTION_MINUTES * 60_000) {
      throw new MsgraphError('expiresAt is beyond the 10,080-minute limit for Outlook event subscriptions', {
        kind: 'validation',
        code: 'invalid_expiry',
      });
    }
    return new Date(at).toISOString();
  }

  const client = {
    provider: PROVIDER,
    capabilities,
    /** Config without secrets, for logs and admin screens. */
    describe: () => redactConfig(config),

    /** App-only access token (cached). Exposed for diagnostics such as a "test connection" button. */
    getAccessToken: () => tokens.getToken(),

    /**
     * Free/busy for up to a handful of people. Read-only, so retried on transient failures.
     * @param {z.input<typeof scheduleInput>} input
     * @param {{ signal?: AbortSignal }} [options]
     */
    async getSchedule(input, { signal } = {}) {
      const args = parseInput(scheduleInput, input, 'getSchedule');
      assertOrdered(args.start, args.end, 'getSchedule');
      const res = await transport.request({
        operation: 'getSchedule',
        method: 'POST',
        path: `/users/${segment(args.mailbox, 'mailbox')}/calendar/getSchedule`,
        body: {
          schedules: args.emails,
          startTime: toGraphDateTime(args.start, 'start'),
          endTime: toGraphDateTime(args.end, 'end'),
          availabilityViewInterval: args.intervalMinutes,
        },
        prefer: ['outlook.timezone="UTC"'],
        idempotent: true,
        mailbox: args.mailbox,
        signal,
      });
      return { intervalMinutes: args.intervalMinutes, schedules: (res.body?.value ?? []).map(normaliseSchedule) };
    },

    /**
     * Create an event (with a Teams meeting by default). The idempotency key is sent as Graph's
     * transactionId, which makes the create safe to retry.
     * @param {string} mailbox organizer
     * @param {z.input<typeof createEventInput>} input
     * @param {{ signal?: AbortSignal }} [options]
     */
    async createEvent(mailbox, input, { signal } = {}) {
      const args = parseInput(createEventInput, input, 'createEvent');
      assertOrdered(args.start, args.end, 'createEvent');
      const body = {
        ...graphEventFields(args),
        ...(args.onlineMeeting ? { isOnlineMeeting: true, onlineMeetingProvider: 'teamsForBusiness' } : {}),
        transactionId: args.idempotencyKey ?? uuid(),
      };
      const res = await transport.request({
        operation: 'createEvent',
        method: 'POST',
        path: eventsPath(mailbox, args.calendarId),
        body,
        prefer: calendarPrefer,
        idempotent: true,
        mailbox,
        signal,
      });
      return normaliseEvent(res.body);
    },

    /**
     * @param {string} mailbox
     * @param {string} eventId
     * @param {{ signal?: AbortSignal }} [options]
     */
    async getEvent(mailbox, eventId, { signal } = {}) {
      const res = await transport.request({
        operation: 'getEvent',
        method: 'GET',
        path: eventPath(mailbox, eventId),
        prefer: calendarPrefer,
        idempotent: true,
        mailbox,
        signal,
      });
      return normaliseEvent(res.body);
    },

    /**
     * Update fields of an event. Graph sends meeting updates to attendees.
     * @param {string} mailbox
     * @param {string} eventId
     * @param {z.input<typeof updateEventInput>} patch
     * @param {{ signal?: AbortSignal }} [options]
     */
    async updateEvent(mailbox, eventId, patch, { signal } = {}) {
      const args = parseInput(updateEventInput, patch, 'updateEvent');
      if (Object.keys(args).length === 0) {
        throw new MsgraphError('updateEvent: nothing to update', { kind: 'validation', code: 'invalid_input', operation: 'updateEvent' });
      }
      if (args.start !== undefined && args.end !== undefined) assertOrdered(args.start, args.end, 'updateEvent');
      const res = await transport.request({
        operation: 'updateEvent',
        method: 'PATCH',
        path: eventPath(mailbox, eventId),
        body: graphEventFields(args),
        prefer: calendarPrefer,
        idempotent: true,
        mailbox,
        signal,
      });
      return normaliseEvent(res.body);
    },

    /**
     * Organizer cancels a meeting and Graph emails attendees. Not retried automatically.
     * @param {string} mailbox organizer
     * @param {string} eventId
     * @param {{ comment?: string, signal?: AbortSignal }} [options]
     */
    async cancelEvent(mailbox, eventId, { comment, signal } = {}) {
      await transport.request({
        operation: 'cancelEvent',
        method: 'POST',
        path: `${eventPath(mailbox, eventId)}/cancel`,
        body: comment ? { comment: String(comment).slice(0, 4000) } : {},
        idempotent: false,
        mailbox,
        signal,
      });
      return { cancelled: true };
    },

    /**
     * Delete an event from the mailbox (no cancellation email from the organizer). 404 counts as done.
     * @param {string} mailbox
     * @param {string} eventId
     * @param {{ signal?: AbortSignal }} [options]
     */
    async deleteEvent(mailbox, eventId, { signal } = {}) {
      const res = await transport.request({
        operation: 'deleteEvent',
        method: 'DELETE',
        path: eventPath(mailbox, eventId),
        idempotent: true,
        notFoundOk: true,
        mailbox,
        signal,
      });
      return { deleted: true, alreadyDeleted: res.status === 404 };
    },

    /**
     * Subscribe to a mailbox's event changes. Graph validates notificationUrl (and the lifecycle URL)
     * synchronously, so the webhook route must already answer validation requests.
     * A duplicate (same resource + changeType) fails with kind 'conflict' and details.existingSubscriptionId.
     * @param {z.input<typeof subscriptionInput>} input
     * @param {{ signal?: AbortSignal }} [options]
     */
    async createSubscription(input, { signal } = {}) {
      const args = parseInput(subscriptionInput, input, 'createSubscription');
      const notificationUrl = args.notificationUrl ?? config.notificationUrl;
      if (!notificationUrl) {
        throw new MsgraphError('createSubscription: notificationUrl is not configured', { kind: 'config', code: 'missing_notification_url' });
      }
      if (!args.resource && !args.mailbox) {
        throw new MsgraphError('createSubscription: mailbox or resource is required', { kind: 'validation', code: 'invalid_input' });
      }
      const lifecycleNotificationUrl = args.lifecycleNotificationUrl ?? config.lifecycleNotificationUrl;
      const res = await transport.request({
        operation: 'createSubscription',
        method: 'POST',
        path: '/subscriptions',
        body: {
          changeType: args.changeTypes.join(','),
          notificationUrl,
          ...(lifecycleNotificationUrl ? { lifecycleNotificationUrl } : {}),
          resource: args.resource ?? `users/${args.mailbox}/events`,
          expirationDateTime: subscriptionExpiry(args.expiresAt),
          clientState: createClientState(config.webhookSecret),
          latestSupportedTlsVersion: 'v1_2',
        },
        prefer: immutable,
        idempotent: false,
        signal,
      });
      return normaliseSubscription(res.body);
    },

    /**
     * Extend a subscription (also reauthorizes it). Safe to retry.
     * @param {string} subscriptionId
     * @param {{ expiresAt?: Date | number | string, signal?: AbortSignal }} [options]
     */
    async renewSubscription(subscriptionId, { expiresAt, signal } = {}) {
      const res = await transport.request({
        operation: 'renewSubscription',
        method: 'PATCH',
        path: `/subscriptions/${segment(subscriptionId, 'subscriptionId')}`,
        body: { expirationDateTime: subscriptionExpiry(expiresAt) },
        idempotent: true,
        signal,
      });
      return normaliseSubscription(res.body);
    },

    /**
     * Answer a reauthorizationRequired lifecycle event without extending expiry.
     * Don't call this and renewSubscription for the same subscription within 10 minutes.
     * @param {string} subscriptionId
     * @param {{ signal?: AbortSignal }} [options]
     */
    async reauthorizeSubscription(subscriptionId, { signal } = {}) {
      await transport.request({
        operation: 'reauthorizeSubscription',
        method: 'POST',
        path: `/subscriptions/${segment(subscriptionId, 'subscriptionId')}/reauthorize`,
        idempotent: true,
        signal,
      });
      return { reauthorized: true };
    },

    /**
     * @param {string} subscriptionId
     * @param {{ signal?: AbortSignal }} [options]
     */
    async deleteSubscription(subscriptionId, { signal } = {}) {
      const res = await transport.request({
        operation: 'deleteSubscription',
        method: 'DELETE',
        path: `/subscriptions/${segment(subscriptionId, 'subscriptionId')}`,
        idempotent: true,
        notFoundOk: true,
        signal,
      });
      return { deleted: true, alreadyDeleted: res.status === 404 };
    },

    /** Active subscriptions this app created in the tenant. @param {{ signal?: AbortSignal }} [options] */
    async listSubscriptions({ signal } = {}) {
      const items = await collect({ operation: 'listSubscriptions', method: 'GET', path: '/subscriptions', idempotent: true, signal });
      return items.map(normaliseSubscription);
    },

    /**
     * Resolve a Teams join URL (event.onlineMeeting.joinUrl) to the onlineMeeting ID.
     * @param {string} mailbox organizer's Entra object ID
     * @param {string} joinUrl
     * @param {{ signal?: AbortSignal }} [options]
     */
    async findOnlineMeeting(mailbox, joinUrl, { signal } = {}) {
      if (typeof joinUrl !== 'string' || !/^https:\/\//i.test(joinUrl)) {
        throw new MsgraphError('joinUrl must be an https URL', { kind: 'validation', code: 'invalid_input', operation: 'findOnlineMeeting' });
      }
      const res = await transport.request({
        operation: 'findOnlineMeeting',
        method: 'GET',
        path: `/users/${segment(mailbox, 'mailbox')}/onlineMeetings`,
        query: { $filter: `JoinWebUrl eq ${odataString(joinUrl)}` },
        idempotent: true,
        signal,
      });
      const meeting = res.body?.value?.[0];
      return meeting ? normaliseOnlineMeeting(meeting) : null;
    },

    /**
     * @param {string} mailbox organizer's Entra object ID
     * @param {string} meetingId onlineMeeting ID
     * @param {{ signal?: AbortSignal }} [options]
     */
    async listAttendanceReports(mailbox, meetingId, { signal } = {}) {
      const items = await collect({
        operation: 'listAttendanceReports',
        method: 'GET',
        path: `/users/${segment(mailbox, 'mailbox')}/onlineMeetings/${segment(meetingId, 'meetingId')}/attendanceReports`,
        idempotent: true,
        signal,
      });
      return items.map(normaliseAttendanceReport);
    },

    /**
     * @param {string} mailbox organizer's Entra object ID
     * @param {string} meetingId
     * @param {string} reportId
     * @param {{ signal?: AbortSignal }} [options]
     */
    async listAttendanceRecords(mailbox, meetingId, reportId, { signal } = {}) {
      const items = await collect({
        operation: 'listAttendanceRecords',
        method: 'GET',
        path: `/users/${segment(mailbox, 'mailbox')}/onlineMeetings/${segment(meetingId, 'meetingId')}/attendanceReports/${segment(reportId, 'reportId')}/attendanceRecords`,
        idempotent: true,
        signal,
      });
      return items.map(normaliseAttendanceRecord);
    },

    /**
     * Attendance for a meeting, by onlineMeeting ID or Teams join URL: every report with its records.
     * Returns { meeting: null, reports: [] } when the join URL doesn't resolve.
     * @param {string} mailbox organizer's Entra object ID
     * @param {{ meetingId?: string, joinUrl?: string, signal?: AbortSignal }} target
     */
    async getMeetingAttendance(mailbox, { meetingId, joinUrl, signal } = {}) {
      let meeting = meetingId ? { id: meetingId, joinUrl: joinUrl ?? null } : null;
      if (!meeting && joinUrl) {
        const found = await client.findOnlineMeeting(mailbox, joinUrl, { signal });
        meeting = found ? { id: found.id, joinUrl: found.joinUrl } : null;
      }
      if (!meeting && !joinUrl) {
        throw new MsgraphError('meetingId or joinUrl is required', { kind: 'validation', code: 'invalid_input', operation: 'getMeetingAttendance' });
      }
      if (!meeting) return { meeting: null, reports: [] };
      const reports = await client.listAttendanceReports(mailbox, meeting.id, { signal });
      const withRecords = [];
      for (const report of reports) {
        withRecords.push({ ...report, records: await client.listAttendanceRecords(mailbox, meeting.id, report.id, { signal }) });
      }
      return { meeting, reports: withRecords };
    },

    /**
     * Answer Graph's validation handshake; null when the request is a real notification.
     * @param {URLSearchParams | string | Record<string, unknown>} query
     */
    validationResponse,

    /**
     * verifyWebhook bound to this connection's secrets and tenant.
     * @param {Buffer | Uint8Array | string} rawBody
     * @param {Record<string, unknown> | Headers} headers
     * @param {Omit<import('./webhook.js').VerifyOptions, 'tenantId'>} [options]
     */
    verifyNotification(rawBody, headers, options = {}) {
      return verifyWebhook(rawBody, headers, [config.webhookSecret, ...config.previousWebhookSecrets], {
        now: now(),
        clientId: config.clientId,
        ...options,
        tenantId: GUID_TENANT.test(config.tenantId) ? config.tenantId : undefined,
      });
    },

    parseWebhook,
  };
  return client;
}

const GUID_TENANT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
