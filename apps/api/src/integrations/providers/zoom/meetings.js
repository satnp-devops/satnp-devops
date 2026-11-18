import { z } from 'zod';
import { ZoomValidationError } from './errors.js';

/**
 * Meeting request building and response normalisation (pure functions; no I/O).
 *
 * Times: callers pass instants (Date or ISO 8601 with offset). We always send Zoom
 * `start_time` as UTC `yyyy-MM-ddTHH:mm:ssZ`; `timezone` only controls how Zoom shows the time
 * in invites and its UI. Normalised responses use UTC ISO strings.
 */

/**
 * Demo-friendly defaults for sales demos (B2B) and admissions counselling (B2C):
 * prospects join from a link without a Zoom account, wait in the waiting room until the
 * host admits them, no auto recording (recording personal data needs consent; see docs).
 * Account-level locked settings in Zoom still win over these.
 */
export const DEMO_MEETING_SETTINGS = Object.freeze({
  host_video: true,
  participant_video: true,
  join_before_host: false,
  waiting_room: true,
  mute_upon_entry: false,
  approval_type: 2, // no registration required
  audio: 'both',
  auto_recording: 'none',
  meeting_authentication: false,
  private_meeting: false,
  email_notification: true,
});

const instant = z.union([z.date(), z.iso.datetime({ offset: true })]).transform((value, ctx) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    ctx.addIssue({ code: 'custom', message: 'invalid date' });
    return z.NEVER;
  }
  return date;
});

const email = z.email().max(320);

const meetingFields = {
  topic: z.string().trim().min(1).max(200),
  startTime: instant,
  durationMinutes: z.number().int().min(1).max(1440),
  timezone: z.string().trim().min(1).max(64),
  agenda: z.string().max(2000),
  password: z.string().min(1).max(10),
  alternativeHosts: z.array(email).max(50),
  invitees: z.array(email).max(300),
  /** Raw Zoom `settings` overrides (escape hatch), merged last. */
  settings: z.record(z.string(), z.unknown()),
  trackingFields: z.array(z.object({ field: z.string().min(1), value: z.string() })).max(20),
};

export const createMeetingInputSchema = z
  .object({
    hostUserId: z.string().trim().min(1).max(320).optional(),
    /** 'instant' starts now (Zoom type 1); 'scheduled' needs startTime (type 2). */
    kind: z.enum(['scheduled', 'instant']).default('scheduled'),
    topic: meetingFields.topic,
    startTime: meetingFields.startTime.optional(),
    durationMinutes: meetingFields.durationMinutes.default(30),
    timezone: meetingFields.timezone.optional(),
    agenda: meetingFields.agenda.optional(),
    password: meetingFields.password.optional(),
    alternativeHosts: meetingFields.alternativeHosts.optional(),
    invitees: meetingFields.invitees.optional(),
    settings: meetingFields.settings.optional(),
    scheduleFor: z.string().trim().min(1).max(320).optional(),
    templateId: z.string().trim().min(1).max(100).optional(),
    trackingFields: meetingFields.trackingFields.optional(),
  })
  .refine((input) => input.kind === 'instant' || input.startTime !== undefined, {
    message: 'startTime is required for scheduled meetings',
    path: ['startTime'],
  });

export const updateMeetingInputSchema = z
  .object({
    topic: meetingFields.topic.optional(),
    startTime: meetingFields.startTime.optional(),
    durationMinutes: meetingFields.durationMinutes.optional(),
    timezone: meetingFields.timezone.optional(),
    agenda: meetingFields.agenda.optional(),
    password: meetingFields.password.optional(),
    alternativeHosts: meetingFields.alternativeHosts.optional(),
    invitees: meetingFields.invitees.optional(),
    settings: meetingFields.settings.optional(),
    trackingFields: meetingFields.trackingFields.optional(),
  })
  .refine((input) => Object.values(input).some((value) => value !== undefined), { message: 'nothing to update' });

/**
 * Validate with zod and throw a ZoomValidationError listing fields (values are not echoed).
 * @template T
 * @param {z.ZodType<T>} schema
 * @param {unknown} input
 * @param {string} what
 * @returns {T}
 */
export function validateInput(schema, input, what) {
  const result = schema.safeParse(input ?? {});
  if (result.success) return result.data;
  const fields = result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
  throw new ZoomValidationError(`Invalid ${what}: ${fields.join('; ')}`, {
    details: result.error.issues.map((issue) => ({ path: issue.path.join('.'), code: issue.code })),
  });
}

/** Zoom's UTC format: yyyy-MM-ddTHH:mm:ssZ (no milliseconds). */
export function toZoomUtc(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Any Zoom timestamp (ISO string or epoch ms) -> ISO UTC string, or null. */
export function toUtcIso(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Meeting IDs are int64 numbers (9-12 digits in practice). Returned as a digit string. */
export function meetingIdString(meetingId) {
  const id = String(meetingId ?? '').trim();
  if (!/^\d{1,20}$/.test(id)) throw new ZoomValidationError('Invalid Zoom meeting ID: expected digits');
  return id;
}

function settingsFor(input, baseSettings) {
  const settings = { ...baseSettings };
  if (input.alternativeHosts) settings.alternative_hosts = input.alternativeHosts.join(';');
  if (input.invitees) settings.meeting_invitees = input.invitees.map((address) => ({ email: address }));
  return { ...settings, ...(input.settings ?? {}) };
}

/**
 * Build the POST /users/{userId}/meetings body.
 * @param {z.infer<typeof createMeetingInputSchema>} input  validated input
 * @param {{ defaultTimezone: string, meetingSettings: Record<string, unknown>, nowMs: number }} options
 */
export function buildCreateMeetingBody(input, { defaultTimezone, meetingSettings, nowMs }) {
  const body = {
    topic: input.topic,
    type: input.kind === 'instant' ? 1 : 2,
    duration: input.durationMinutes,
    timezone: input.timezone ?? defaultTimezone,
    settings: settingsFor(input, { ...DEMO_MEETING_SETTINGS, ...meetingSettings }),
  };
  if (input.kind === 'scheduled') {
    // Zoom silently moves a past start_time to "now"; for a booking that is a bug upstream.
    if (input.startTime.getTime() < nowMs - 5 * 60_000) {
      throw new ZoomValidationError('Invalid meeting: startTime is in the past');
    }
    body.start_time = toZoomUtc(input.startTime);
  }
  if (input.agenda !== undefined) body.agenda = input.agenda;
  if (input.password !== undefined) body.password = input.password;
  if (input.scheduleFor !== undefined) body.schedule_for = input.scheduleFor;
  if (input.templateId !== undefined) body.template_id = input.templateId;
  if (input.trackingFields !== undefined) body.tracking_fields = input.trackingFields;
  return body;
}

/**
 * Build the PATCH /meetings/{meetingId} body with only the fields being changed.
 * @param {z.infer<typeof updateMeetingInputSchema>} input
 */
export function buildUpdateMeetingBody(input) {
  const body = {};
  if (input.topic !== undefined) body.topic = input.topic;
  if (input.startTime !== undefined) body.start_time = toZoomUtc(input.startTime);
  if (input.durationMinutes !== undefined) body.duration = input.durationMinutes;
  if (input.timezone !== undefined) body.timezone = input.timezone;
  if (input.agenda !== undefined) body.agenda = input.agenda;
  if (input.password !== undefined) body.password = input.password;
  if (input.trackingFields !== undefined) body.tracking_fields = input.trackingFields;
  if (input.alternativeHosts || input.invitees || input.settings) body.settings = settingsFor(input, {});
  return body;
}

/**
 * @typedef {object} ZoomMeeting
 * @property {'zoom'} provider
 * @property {string} id           meeting number as digits
 * @property {string|null} uuid    current instance UUID
 * @property {number|null} type
 * @property {string|null} status
 * @property {string|null} topic
 * @property {string|null} startTime   UTC ISO
 * @property {number|null} durationMinutes
 * @property {string|null} timezone
 * @property {string|null} joinUrl     share with attendees
 * @property {string|null} startUrl    HOST-ONLY credential (expires in ~2h); never send to attendees or logs
 * @property {string|null} password
 * @property {string|null} hostId
 * @property {string|null} hostEmail
 * @property {string|null} agenda
 * @property {string|null} createdAt   UTC ISO
 * @property {Record<string, unknown>} raw
 */

/** @returns {ZoomMeeting} */
export function normalizeMeeting(raw) {
  const m = raw ?? {};
  return {
    provider: 'zoom',
    id: m.id === undefined || m.id === null ? '' : String(m.id),
    uuid: m.uuid ?? null,
    type: m.type ?? null,
    status: m.status ?? null,
    topic: m.topic ?? null,
    startTime: toUtcIso(m.start_time),
    durationMinutes: typeof m.duration === 'number' ? m.duration : null,
    timezone: m.timezone ?? null,
    joinUrl: m.join_url ?? null,
    startUrl: m.start_url ?? null,
    password: m.password ?? null,
    hostId: m.host_id ?? null,
    hostEmail: m.host_email ?? null,
    agenda: m.agenda ?? null,
    createdAt: toUtcIso(m.created_at),
    raw: m,
  };
}
