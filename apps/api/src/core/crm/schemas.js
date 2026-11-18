import { z } from 'zod';
import { webUrlSchema } from '../../lib/schemas.js';
import { CONTACT_KINDS, DEAL_COLUMNS, DEAL_KINDS, DEAL_SORTS, DEAL_STATUSES } from './constants.js';
import { MAX_VALUE_MINOR } from './money.js';

// zod schemas shared by several CRM modules. Module-specific bodies live in each module's routes,
// built from these pieces exactly as docs/crm/PHASE2_CONTRACT.md describes.

const trimmed = (value) => (typeof value === 'string' ? value.trim() : value);
/** Empty strings from forms mean "not given". */
const emptyToUndefined = (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value);

export const text = (max = 200) => z.preprocess(trimmed, z.string().max(max));
export const requiredText = (max = 200, message = 'Fill this in') => z.preprocess(trimmed, z.string().min(1, message).max(max));
export const optionalText = (max = 200) => z.preprocess(emptyToUndefined, text(max).optional());
export const nullableText = (max = 200) =>
  z.preprocess((value) => (typeof value === 'string' && value.trim() === '' ? null : value), text(max).nullable());

/** Configuration keys (pipelines, stages, product lines, custom fields): "demo_booked". */
export const keySchema = z.preprocess(
  (value) => (typeof value === 'string' ? value.trim().toLowerCase() : value),
  z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'Use lowercase letters, numbers and underscores, starting with a letter'),
);

/** Tags are trimmed and lower-cased; duplicates are dropped. */
export const tagSchema = z.preprocess(
  (value) => (typeof value === 'string' ? value.trim().toLowerCase().replace(/\s+/g, ' ') : value),
  z
    .string()
    .min(1)
    .max(40, 'Keep tags to 40 characters')
    .regex(/^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u, 'Use letters, numbers, spaces, - and _'),
);
export const tagsSchema = z
  .array(tagSchema)
  .max(20, 'Use at most 20 tags')
  .transform((tags) => [...new Set(tags)]);

export const colourSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #2840D8');
export const dateOnlySchema = z.iso.date({ error: 'Use a date like 2026-11-30' });
export const dateTimeSchema = z.iso.datetime({ offset: true, error: 'Use an ISO date and time with a time zone' });
export const currencySchema = z.preprocess(
  (value) => (typeof value === 'string' ? value.trim().toUpperCase() : value),
  z.string().regex(/^[A-Z]{3}$/, 'Use a 3-letter currency code like INR'),
);
export const valueMinorSchema = z
  .number()
  .int('Send amounts in minor units (paise), as whole numbers')
  .min(0)
  .max(MAX_VALUE_MINOR);
export const percentSchema = z.number().int().min(0).max(100);

export const idsSchema = (max = 100) => z.array(z.uuid()).min(1).max(max);

// ---------- Query strings ----------

/** "a,b,c" (or repeated parameters) → ["a", "b", "c"]. */
export const csvList = (item, max = 50) =>
  z.preprocess((value) => {
    const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : value;
    return Array.isArray(values) ? values.map((v) => (typeof v === 'string' ? v.trim() : v)).filter((v) => v !== '') : values;
  }, z.array(item).max(max));

export const booleanQuery = z.enum(['true', 'false']).transform((value) => value === 'true');

export const pageQuery = {
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
};

// ---------- Sources and messages ----------

export const utmSchema = z
  .strictObject({
    source: text(200),
    medium: text(200),
    campaign: text(200),
    term: text(200),
    content: text(200),
  })
  .partial();

/**
 * Where an enquiry came from. Stored on deals (first_touch / last_touch) and on company links (source).
 * `channel` must be a registered channel key; routes check it against the registry.
 */
export const touchSourceSchema = z.strictObject({
  channel: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/),
  campaign: optionalText(200),
  utm: utmSchema.optional(),
  referrer: optionalText(2000),
  partnerId: optionalText(100),
  landingUrl: optionalText(2000),
  formId: optionalText(100),
  adId: optionalText(100),
  at: dateTimeSchema.optional(),
});

/** The first message of an enquiry, kept as it arrived. */
export const originalMessageSchema = z.strictObject({
  channel: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/),
  text: z.string().max(10_000),
  subject: optionalText(300),
  receivedAt: dateTimeSchema,
  from: z
    .strictObject({ name: optionalText(120), phone: optionalText(40), email: optionalText(254) })
    .partial()
    .optional(),
});

// ---------- People ----------

export const addressSchema = z
  .strictObject({
    line1: text(200),
    line2: text(200),
    city: text(80),
    state: text(80),
    pincode: z.string().regex(/^[0-9A-Za-z -]{3,12}$/, 'Enter a valid PIN or postal code'),
    country: text(80),
  })
  .partial();

/** Facts about a student, shared across the group (contacts.student_profile). */
export const studentProfileSchema = z
  .strictObject({
    grade: text(40),
    school: text(200),
    board: text(40),
    targetExam: text(60),
    targetDate: dateOnlySchema,
    graduationYear: z.number().int().min(1990).max(2100),
    stream: text(60),
  })
  .partial();

export const phoneInputSchema = z.union([
  z.string().trim().min(3).max(40),
  z.strictObject({
    value: z.string().trim().min(3).max(40),
    kind: z.enum(['phone', 'whatsapp']).optional(),
    label: optionalText(40),
    isPrimary: z.boolean().optional(),
  }),
]);

export const emailInputSchema = z.union([
  z.string().trim().min(3).max(254),
  z.strictObject({
    value: z.string().trim().min(3).max(254),
    label: optionalText(40),
    isPrimary: z.boolean().optional(),
  }),
]);

export const countryCodeSchema = z.preprocess(
  (value) => (typeof value === 'string' ? value.trim().toUpperCase() : value),
  z.string().regex(/^[A-Z]{2}$/, 'Use a 2-letter country code like IN'),
);

export const languageSchema = z.string().regex(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/, 'Use a language code like en or hi');

/**
 * A person given inline (when creating a deal, an institute contact or through intake).
 * The server runs findOrCreateContact on it, so an existing person is reused.
 */
export const contactInputSchema = z
  .strictObject({
    kind: z.enum(CONTACT_KINDS).optional(),
    firstName: optionalText(80),
    lastName: optionalText(80),
    phones: z.array(phoneInputSchema).max(5).optional(),
    emails: z.array(emailInputSchema).max(5).optional(),
    city: optionalText(80),
    countryCode: countryCodeSchema.optional(),
    timeZone: optionalText(60),
    language: languageSchema.optional(),
    studentProfile: studentProfileSchema.optional(),
  })
  .refine((value) => Boolean(value.firstName || value.phones?.length || value.emails?.length), {
    message: 'Give a name, a phone number or an email',
  });

// ---------- Deal list filters (GET /deals and saved views) ----------

/** A channel key; routes also check it is registered (core/crm/channels.js isKnownChannel). */
export const channelKeySchema = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/, 'Unknown channel');

/** An owner filter value: a user id, "me" (the signed-in user) or "none" (no owner). */
export const ownerFilterSchema = z.union([z.uuid(), z.literal('me'), z.literal('none')]);

/**
 * Filters of the Leads list, as stored in saved_views.filters (JSON arrays). GET /deals takes the
 * same keys as query parameters, lists comma-separated (dealListQuerySchema). Contract §9.6.
 */
export const dealFiltersSchema = z
  .strictObject({
    pipelineId: z.uuid(),
    stageId: z.array(z.uuid()).max(50),
    status: z.array(z.enum(DEAL_STATUSES)).max(3),
    kind: z.enum(DEAL_KINDS),
    channel: z.array(channelKeySchema).max(20),
    owner: z.array(ownerFilterSchema).max(50),
    productLineId: z.array(z.uuid()).max(50),
    tag: z.array(tagSchema).max(10),
    q: text(100),
    nurture: z.boolean(),
    slaBreached: z.boolean(),
    firstReplyOverdue: z.boolean(),
    createdFrom: dateTimeSchema,
    createdTo: dateTimeSchema,
  })
  .partial();

/** The same filters as a query string, plus scope, sort and paging. */
export const dealListQuerySchema = z.strictObject({
  unitId: z.uuid(),
  pipelineId: z.uuid().optional(),
  stageId: csvList(z.uuid(), 50).optional(),
  status: csvList(z.enum(DEAL_STATUSES), 3).optional(),
  kind: z.enum(DEAL_KINDS).optional(),
  channel: csvList(channelKeySchema, 20).optional(),
  owner: csvList(ownerFilterSchema, 50).optional(),
  productLineId: csvList(z.uuid(), 50).optional(),
  tag: csvList(tagSchema, 10).optional(),
  q: z.string().trim().min(1).max(100).optional(),
  nurture: booleanQuery.optional(),
  slaBreached: booleanQuery.optional(),
  firstReplyOverdue: booleanQuery.optional(),
  createdFrom: dateTimeSchema.optional(),
  createdTo: dateTimeSchema.optional(),
  contactId: z.uuid().optional(),
  accountId: z.uuid().optional(),
  householdId: z.uuid().optional(),
  archived: booleanQuery.default(false),
  sort: z.enum(DEAL_SORTS).default('-updatedAt'),
  ...pageQuery,
});

/** A column of a saved view: a built-in column or "custom.<key>". */
export const dealColumnSchema = z.union([z.enum(DEAL_COLUMNS), z.string().regex(/^custom\.[a-z][a-z0-9_]{0,39}$/)]);

export const dealSortSchema = z.enum(DEAL_SORTS);

export { webUrlSchema };
