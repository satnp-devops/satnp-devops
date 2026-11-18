import { z } from 'zod';
import { clockRangeSchema, isLocalDate, normalizeTimeZone } from '../../core/scheduling/index.js';
import { colourSchema, csvList, dateTimeSchema, nullableText, optionalText, pageQuery, requiredText } from '../../core/crm/schemas.js';
import { emailSchema, webUrlSchema } from '../../lib/schemas.js';

// Input schemas for the scheduling module (routes validate with these; services trust them).

export const LOCATION_KINDS = Object.freeze(['zoom', 'google_meet', 'teams', 'phone', 'in_person']);
export const ONLINE_LOCATIONS = Object.freeze(['zoom', 'google_meet', 'teams']);
export const ASSIGNMENTS = Object.freeze(['round_robin', 'single']);
export const BOOKING_STATUSES = Object.freeze(['booked', 'rescheduled', 'cancelled', 'completed', 'no_show']);
export const ACTIVE_STATUSES = Object.freeze(['booked', 'rescheduled']);
export const QUESTION_TYPES = Object.freeze(['text', 'textarea', 'select', 'phone', 'email']);

/** An IANA zone, stored in its current spelling (asia/calcutta → Asia/Kolkata). Offsets and abbreviations are refused. */
export const zoneSchema = z
  .string()
  .max(64)
  .transform((value, ctx) => {
    const zone = normalizeTimeZone(value);
    if (!zone) {
      ctx.addIssue({ code: 'custom', message: 'Pick a time zone like Asia/Kolkata' });
      return z.NEVER;
    }
    return zone;
  });

const optionSchema = z.strictObject({ value: requiredText(60), label: requiredText(120) });

export const questionSchema = z
  .strictObject({
    key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'Use lower-case letters, digits and underscores'),
    label: requiredText(200),
    type: z.enum(QUESTION_TYPES),
    required: z.boolean().default(false),
    options: z.array(optionSchema).min(1).max(30).optional(),
    help: optionalText(300),
  })
  .refine((q) => q.type !== 'select' || (q.options && q.options.length > 0), { message: 'Add the choices', path: ['options'] });

export const DEFAULT_ATTENDEE_OPTIONS = Object.freeze([
  { value: 'parent', label: 'Parent' },
  { value: 'student', label: 'Student' },
  { value: 'both', label: 'Parent and student' },
]);

export const attendeesSchema = z.strictObject({
  /** Ask "Who will attend?" on the booking page. */
  ask: z.boolean().default(false),
  label: optionalText(120),
  options: z.array(optionSchema).min(1).max(6).default([...DEFAULT_ATTENDEE_OPTIONS]),
  /** Extra people the visitor may add (name and optional email). */
  maxGuests: z.number().int().min(0).max(10).default(0),
});

export const brandingSchema = z.strictObject({
  color: colourSchema.optional(),
  logoUrl: webUrlSchema.optional(),
  headline: optionalText(120),
  confirmationMessage: optionalText(500),
});

const hostInputSchema = z.strictObject({
  userId: z.uuid(),
  weight: z.number().int().min(0).max(100).default(1),
  priority: z.number().int().min(-10).max(10).default(0),
  languages: z.array(z.string().regex(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/, 'Use a language code like hi or en')).max(10).default([]),
  active: z.boolean().default(true),
});

export const hostsSchema = z
  .array(hostInputSchema)
  .max(50)
  .refine((hosts) => new Set(hosts.map((h) => h.userId)).size === hosts.length, { message: 'Each person once' });

const eventTypeFields = {
  name: requiredText(120),
  slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Use lower-case words joined by dashes').max(60),
  description: nullableText(2000).optional(),
  durationMin: z.number().int().min(5).max(480),
  slotIntervalMin: z.number().int().min(5).max(480).nullable().optional(),
  bufferBeforeMin: z.number().int().min(0).max(240).optional(),
  bufferAfterMin: z.number().int().min(0).max(240).optional(),
  minNoticeMin: z.number().int().min(0).max(43_200).optional(),
  maxPerDay: z.number().int().min(1).max(100).nullable().optional(),
  horizonDays: z.number().int().min(1).max(365).optional(),
  alignTimeZone: zoneSchema.nullable().optional(),
  locationKind: z.enum(LOCATION_KINDS),
  locationDetail: nullableText(500).optional(),
  assignment: z.enum(ASSIGNMENTS).optional(),
  attendanceThresholdMin: z.number().int().min(0).max(480).optional(),
  reminderOffsetsMin: z
    .array(z.number().int().min(5).max(20_160))
    .max(5)
    .refine((list) => new Set(list).size === list.length, { message: 'Each reminder once' })
    .optional(),
  questions: z
    .array(questionSchema)
    .max(20)
    .refine((list) => new Set(list.map((q) => q.key)).size === list.length, { message: 'Question keys must differ' })
    .optional(),
  attendees: attendeesSchema.optional(),
  branding: brandingSchema.optional(),
  dealKind: z.enum(['b2c', 'b2b']).nullable().optional(),
  active: z.boolean().optional(),
};

export const createEventTypeBody = z.strictObject({ unitId: z.uuid(), ...eventTypeFields, hosts: hostsSchema.optional() });
export const updateEventTypeBody = z
  .strictObject(Object.fromEntries(Object.entries(eventTypeFields).map(([key, schema]) => [key, schema.optional()])))
  .refine((body) => Object.keys(body).length > 0, { message: 'Change at least one field' });

export const eventTypeListQuery = z.strictObject({ unitId: z.uuid(), includeArchived: z.enum(['true', 'false']).optional() });

// ---------- Availability ----------

/** Stored in one spelling, 'HH:MM-HH:MM', whichever form came in ('09:00-13:00' or { start, end }). */
export const rangeText = (r) => (typeof r === 'string' ? r : `${r.start}-${r.end}`);
const rangesSchema = z
  .array(clockRangeSchema)
  .max(12)
  .transform((list) => list.map(rangeText));
const overrideSchema = z.union([z.literal('unavailable'), rangesSchema]);

export const availabilityBody = z.strictObject({
  timeZone: zoneSchema,
  weekly: z.strictObject({
    sun: rangesSchema.optional(),
    mon: rangesSchema.optional(),
    tue: rangesSchema.optional(),
    wed: rangesSchema.optional(),
    thu: rangesSchema.optional(),
    fri: rangesSchema.optional(),
    sat: rangesSchema.optional(),
  }),
  overrides: z
    .record(z.string().refine(isLocalDate, { message: 'Use a date like 2026-11-30' }), overrideSchema)
    .refine((value) => Object.keys(value).length <= 400, { message: 'At most 400 dates' })
    .default({}),
});

export const userParams = z.strictObject({ userId: z.union([z.uuid(), z.literal('me')]) });

// ---------- Slots and bookings ----------

export const slotsQuery = z
  .strictObject({
    from: z.iso.date(),
    to: z.iso.date(),
    timeZone: zoneSchema,
  })
  .refine((q) => q.to >= q.from, { message: 'to must not be before from', path: ['to'] })
  .refine((q) => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 <= 41, { message: 'Ask for at most 42 days', path: ['to'] });

const guestSchema = z.strictObject({ name: requiredText(120), email: emailSchema.optional() });

export const publicBookBody = z.strictObject({
  start: dateTimeSchema,
  timeZone: zoneSchema,
  name: requiredText(120, 'Enter your name'),
  email: emailSchema,
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9 ()\-.]{6,24}$/, 'Enter a phone number like +91 98765 43210')
    .optional(),
  attending: optionalText(60),
  guests: z.array(guestSchema).max(10).default([]),
  answers: z
    .record(z.string().max(40), z.string().max(2000))
    .refine((value) => Object.keys(value).length <= 30, { message: 'Too many answers' })
    .default({}),
  notes: optionalText(2000),
  /** Sent again on retry (double tap, flaky network) so one booking is made. */
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).optional(),
});

export const publicRescheduleBody = z.strictObject({ start: dateTimeSchema, timeZone: zoneSchema });
export const publicCancelBody = z.strictObject({ reason: optionalText(500) });
export const rescheduleRequestBody = z.strictObject({ note: optionalText(1000) });
export const tokenParams = z.strictObject({ token: z.string().min(10).max(100) });

export const BOOKING_VIEWS = Object.freeze(['upcoming', 'past', 'live', 'no_shows', 'reschedule_requests', 'cancelled', 'all']);

export const bookingListQuery = z
  .strictObject({
    unitId: z.uuid(),
    view: z.enum(BOOKING_VIEWS).default('upcoming'),
    from: dateTimeSchema.optional(),
    to: dateTimeSchema.optional(),
    status: csvList(z.enum(BOOKING_STATUSES), 5).optional(),
    hostUserId: z.uuid().optional(),
    eventTypeId: z.uuid().optional(),
    dealId: z.uuid().optional(),
    contactId: z.uuid().optional(),
    ...pageQuery,
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .refine((q) => !q.from || !q.to || q.to > q.from, { message: 'to must be after from', path: ['to'] })
  .refine((q) => !q.from || !q.to || Date.parse(q.to) - Date.parse(q.from) <= 62 * 86_400_000, {
    message: 'Ask for at most 62 days',
    path: ['to'],
  });

export const summaryQuery = z.strictObject({ unitId: z.uuid() });

export const staffRescheduleBody = z.strictObject({ start: dateTimeSchema, notify: z.boolean().default(true) });
export const staffCancelBody = z.strictObject({ reason: optionalText(500), notify: z.boolean().default(true) });
export const reassignBody = z.strictObject({ hostUserId: z.uuid(), notify: z.boolean().default(true) });
export const outcomeBody = z.strictObject({ note: optionalText(500) });

export const createLinkBody = z
  .strictObject({
    eventTypeId: z.uuid(),
    dealId: z.uuid().optional(),
    contactId: z.uuid().optional(),
    expiresInDays: z.number().int().min(1).max(90).optional(),
    maxUses: z.number().int().min(1).max(20).nullable().optional(),
    attending: optionalText(60),
  })
  .refine((body) => body.dealId || body.contactId, { message: 'Pick a deal or a contact', path: ['dealId'] });

export const linkListQuery = z
  .strictObject({ dealId: z.uuid().optional(), contactId: z.uuid().optional() })
  .refine((q) => q.dealId || q.contactId, { message: 'Pass dealId or contactId', path: ['dealId'] });

export const sendLinkBody = z.strictObject({
  channel: z.enum(['whatsapp', 'email', 'sms']),
  message: optionalText(1000),
});
