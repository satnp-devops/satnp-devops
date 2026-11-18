import { z } from 'zod';
import { timeZoneSchema } from '../../lib/schemas.js';
import {
  CONSENT_CHANNELS,
  CONSENT_PURPOSES,
  CONSENT_SOURCES,
  CONSENT_STATUSES,
  CONTACT_KINDS,
  CONTACT_METHOD_KINDS,
  HOUSEHOLD_ROLES,
  LINK_STATUSES,
} from '../../core/crm/constants.js';
import {
  addressSchema,
  booleanQuery,
  contactInputSchema,
  countryCodeSchema,
  csvList,
  dateOnlySchema,
  dateTimeSchema,
  emailInputSchema,
  languageSchema,
  nullableText,
  optionalText,
  ownerFilterSchema,
  pageQuery,
  phoneInputSchema,
  requiredText,
  studentProfileSchema,
  tagSchema,
  tagsSchema,
  text,
  touchSourceSchema,
} from '../../core/crm/schemas.js';

// Request schemas of the contacts module, exactly as docs/crm/PHASE2_CONTRACT.md §9.1 writes them.

const hasNameOrMethod = (value) => Boolean(value.firstName || value.phones?.length || value.emails?.length);
const nameOrMethod = { message: 'Give a name, a phone number or an email' };

export const CONTACT_SORTS = ['-updatedAt', '-createdAt', 'name'];

export const contactListQuery = z.strictObject({
  unitId: z.uuid(),
  q: text(100).optional(),
  kind: csvList(z.enum(CONTACT_KINDS), 4).optional(),
  status: csvList(z.enum(LINK_STATUSES), 3).optional(),
  owner: csvList(ownerFilterSchema, 50).optional(),
  tag: csvList(tagSchema, 10).optional(),
  householdId: z.uuid().optional(),
  accountId: z.uuid().optional(),
  includeArchived: booleanQuery.default(false),
  sort: z.enum(CONTACT_SORTS).default('-updatedAt'),
  ...pageQuery,
});

export const householdMemberBody = z.strictObject({
  contactId: z.uuid(),
  role: z.enum(HOUSEHOLD_ROLES),
  relation: optionalText(40),
  isPrimary: z.boolean().default(false),
});

export const contactCreateBody = z
  .strictObject({
    ...contactInputSchema.shape,
    unitId: z.uuid(),
    dateOfBirth: dateOnlySchema.optional(),
    address: addressSchema.optional(),
    ownerUserId: z.uuid().nullable().optional(),
    status: z.enum(LINK_STATUSES).optional(),
    tags: tagsSchema.optional(),
    custom: z.record(z.string(), z.unknown()).optional(),
    source: touchSourceSchema.optional(),
    household: z
      .strictObject({ householdId: z.uuid(), role: z.enum(HOUSEHOLD_ROLES), relation: optionalText(40) })
      .optional(),
    mode: z.enum(['link', 'create']).default('link'),
  })
  .refine(hasNameOrMethod, nameOrMethod);

export const contactCheckBody = z.strictObject({
  unitId: z.uuid(),
  kind: z.enum(CONTACT_KINDS).optional(),
  firstName: optionalText(80),
  lastName: optionalText(80),
  phones: z.array(phoneInputSchema).max(5).optional(),
  emails: z.array(emailInputSchema).max(5).optional(),
});

const nullableProfile = z
  .strictObject(Object.fromEntries(Object.entries(studentProfileSchema.shape).map(([key, schema]) => [key, schema.unwrap().nullable()])))
  .partial();

export const contactPatchBody = z
  .strictObject({
    kind: z.enum(CONTACT_KINDS),
    firstName: nullableText(80),
    lastName: nullableText(80),
    dateOfBirth: dateOnlySchema.nullable(),
    address: addressSchema.nullable(),
    city: nullableText(80),
    countryCode: countryCodeSchema.nullable(),
    timeZone: timeZoneSchema.nullable(),
    language: languageSchema.nullable(),
    studentProfile: nullableProfile,
  })
  .partial();

export const linkPatchBody = z
  .strictObject({
    unitId: z.uuid(),
    ownerUserId: z.uuid().nullable(),
    status: z.enum(LINK_STATUSES),
    tags: tagsSchema,
    custom: z.record(z.string(), z.unknown()),
    archived: z.boolean(),
  })
  .partial();

export const methodBody = z.strictObject({
  kind: z.enum(CONTACT_METHOD_KINDS),
  value: z.string().trim().min(3).max(254),
  label: optionalText(40),
  isPrimary: z.boolean().default(false),
});

export const methodPatchBody = z
  .strictObject({ label: nullableText(40), isPrimary: z.literal(true), verified: z.boolean(), optedOut: z.boolean() })
  .partial();

export const mergeBody = z.strictObject({ sourceId: z.uuid() });

export const eraseBody = z.strictObject({ reason: requiredText(500), confirm: z.literal(true) });

/** Five minutes of clock skew between the browser and the server are fine; later times are not. */
const FUTURE_SKEW_MS = 5 * 60_000;

export const consentBody = z.strictObject({
  companyId: z.uuid().nullable(),
  channel: z.enum(CONSENT_CHANNELS),
  purpose: z.enum(CONSENT_PURPOSES),
  status: z.enum(CONSENT_STATUSES),
  source: z.enum(CONSENT_SOURCES).default('manual'),
  evidence: z
    .record(z.string().max(40), z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]))
    .refine((value) => Object.keys(value).length <= 20, 'Keep evidence to at most 20 entries')
    .default({}),
  capturedAt: dateTimeSchema
    .refine((value) => new Date(value).getTime() <= Date.now() + FUTURE_SKEW_MS, 'This time is in the future')
    .optional(),
});

export const householdListQuery = z.strictObject({
  unitId: z.uuid(),
  q: text(100).optional(),
  ...pageQuery,
});

export const householdCreateBody = z.strictObject({
  unitId: z.uuid(),
  name: requiredText(120),
  city: optionalText(80),
  members: z.array(householdMemberBody).min(1, 'Add at least one member').max(20),
});

export const householdPatchBody = z
  .strictObject({ name: requiredText(120), city: nullableText(80), archived: z.boolean() })
  .partial();

export const householdMemberPatchBody = z
  .strictObject({ role: z.enum(HOUSEHOLD_ROLES), relation: nullableText(40), isPrimary: z.boolean() })
  .partial();

export const contactParams = z.strictObject({ id: z.uuid() });
export const linkParams = z.strictObject({ id: z.uuid(), companyId: z.uuid() });
export const methodParams = z.strictObject({ id: z.uuid(), methodId: z.uuid() });
export const memberParams = z.strictObject({ id: z.uuid(), contactId: z.uuid() });
