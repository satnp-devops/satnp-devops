import { z } from 'zod';
import { ACCOUNT_CONTACT_ROLES, ACCOUNT_KINDS, LINK_STATUSES } from '../../core/crm/constants.js';
import {
  addressSchema,
  booleanQuery,
  contactInputSchema,
  countryCodeSchema,
  csvList,
  nullableText,
  optionalText,
  ownerFilterSchema,
  pageQuery,
  requiredText,
  tagSchema,
  tagsSchema,
  text,
  touchSourceSchema,
  webUrlSchema,
} from '../../core/crm/schemas.js';

// Request schemas of the institutes API (docs/crm/PHASE2_CONTRACT.md §9.2).

export const ACCOUNT_KIND_KEYS = ACCOUNT_KINDS.map((kind) => kind.key);
export const ACCOUNT_SORTS = ['-updatedAt', '-createdAt', 'name'];

const branchCountSchema = z.number().int().min(0).max(100_000);
const studentCountSchema = z.number().int().min(0).max(10_000_000);

/** India's GST number: 2-digit state code, PAN, entity number, "Z", checksum ("27AAPFU0939F1ZV"). */
export const gstinSchema = z.preprocess(
  (value) => (typeof value === 'string' ? value.trim().toUpperCase() : value),
  z.string().regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'Enter a 15-character GSTIN like 27AAPFU0939F1ZV'),
);

/** Facts about an institute that are too varied for columns (accounts.profile). */
export const accountProfileSchema = z
  .strictObject({
    boards: z.array(text(40)).max(10),
    exams: z.array(text(60)).max(20),
    budgetBand: text(40),
    decisionTimeline: text(40),
    notes: text(2000),
    gstin: gstinSchema,
  })
  .partial();

/** A person at an institute: an existing contact, or one given inline (found or created). */
const accountContactFields = {
  contactId: z.uuid().optional(),
  contact: contactInputSchema.optional(),
  title: optionalText(80),
  role: z.enum(ACCOUNT_CONTACT_ROLES).default('other'),
  isPrimary: z.boolean().default(false),
};

const exactlyOnePerson = (value) => Boolean(value.contactId) !== Boolean(value.contact);
const exactlyOneMessage = { message: 'Pick an existing person or enter a new one', path: ['contactId'] };

export const accountContactBody = z.strictObject(accountContactFields).refine(exactlyOnePerson, exactlyOneMessage);

export const accountCreateBody = z.strictObject({
  unitId: z.uuid(),
  kind: z.enum(ACCOUNT_KIND_KEYS),
  name: requiredText(200),
  legalName: optionalText(200),
  website: z.preprocess((value) => (value === '' ? undefined : value), webUrlSchema.optional()),
  phone: optionalText(40),
  email: optionalText(254),
  city: optionalText(80),
  state: optionalText(80),
  countryCode: countryCodeSchema.optional(),
  address: addressSchema.optional(),
  branchCount: branchCountSchema.optional(),
  studentCount: studentCountSchema.optional(),
  currentSoftware: optionalText(200),
  profile: accountProfileSchema.optional(),
  ownerUserId: z.uuid().nullable().optional(),
  status: z.enum(LINK_STATUSES).optional(),
  tags: tagsSchema.optional(),
  custom: z.record(z.string(), z.unknown()).optional(),
  source: touchSourceSchema.optional(),
  contacts: z.array(z.strictObject(accountContactFields).refine(exactlyOnePerson, exactlyOneMessage)).max(10).default([]),
  mode: z.enum(['link', 'create']).default('link'),
});

/** The institute's own details; everything optional, nullable except kind and name. */
export const accountPatchBody = z
  .strictObject({
    kind: z.enum(ACCOUNT_KIND_KEYS),
    name: requiredText(200),
    legalName: nullableText(200),
    website: z.preprocess((value) => (value === '' ? null : value), webUrlSchema.nullable()),
    phone: nullableText(40),
    email: nullableText(254),
    city: nullableText(80),
    state: nullableText(80),
    countryCode: countryCodeSchema.nullable(),
    address: addressSchema.nullable(),
    branchCount: branchCountSchema.nullable(),
    studentCount: studentCountSchema.nullable(),
    currentSoftware: nullableText(200),
    profile: accountProfileSchema.nullable(),
  })
  .partial();

/** A company's relationship with the institute (account_companies). */
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

export const accountContactPatchBody = z
  .strictObject({
    title: nullableText(80),
    role: z.enum(ACCOUNT_CONTACT_ROLES),
    isPrimary: z.boolean(),
  })
  .partial();

/**
 * GET /accounts. The contract's filters plus a few institute facts (city, state, current software,
 * student count range), which are plain predicates on the group's institutes.
 */
export const accountListQuery = z
  .strictObject({
    unitId: z.uuid(),
    q: z.string().trim().min(1).max(100).optional(),
    kind: csvList(z.enum(ACCOUNT_KIND_KEYS), 10).optional(),
    status: csvList(z.enum(LINK_STATUSES), 3).optional(),
    owner: csvList(ownerFilterSchema, 50).optional(),
    tag: csvList(tagSchema, 10).optional(),
    city: csvList(text(80), 20).optional(),
    state: csvList(text(80), 20).optional(),
    currentSoftware: z.string().trim().min(1).max(100).optional(),
    studentCountMin: z.coerce.number().int().min(0).max(10_000_000).optional(),
    studentCountMax: z.coerce.number().int().min(0).max(10_000_000).optional(),
    includeArchived: booleanQuery.default(false),
    sort: z.enum(ACCOUNT_SORTS).default('-updatedAt'),
    ...pageQuery,
  })
  .refine((value) => value.studentCountMin === undefined || value.studentCountMax === undefined || value.studentCountMin <= value.studentCountMax, {
    message: 'The minimum is above the maximum',
    path: ['studentCountMax'],
  });

export const accountParams = z.strictObject({ id: z.uuid() });
export const accountLinkParams = z.strictObject({ id: z.uuid(), companyId: z.uuid() });
export const accountContactParams = z.strictObject({ id: z.uuid(), contactId: z.uuid() });
