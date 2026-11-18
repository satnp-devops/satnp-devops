import { z } from 'zod';
import { CHANNEL_TYPES } from '../../core/intake/index.js';
import { channelKeySchema, optionalText, pageQuery, requiredText, utmSchema } from '../../core/crm/schemas.js';
import { timeZoneSchema } from '../../lib/schemas.js';
import { formConsentSchema, formFieldSchema, formSpamSchema, formThankYouSchema } from './forms.js';

// Request schemas of the intake module (zod; strict unless noted).

const uuid = z.uuid();
export const idParams = z.strictObject({ id: uuid });
export const keyParams = z.strictObject({ key: z.string().regex(/^[A-Za-z0-9_-]{6,64}$/) });

export const scopeQuery = z.strictObject({ unitId: uuid });
export const configQuery = z
  .strictObject({ unitId: uuid.optional(), companyId: uuid.optional() })
  .refine((q) => Boolean(q.unitId) !== Boolean(q.companyId), { message: 'Pass unitId or companyId', path: ['unitId'] });

// ---------- Public forms ----------

export const publicFormQuery = z.strictObject({ ref: z.string().trim().max(64).optional() });

export const submissionBody = z.strictObject({
  fields: z.record(z.string().max(40), z.union([z.string().max(5000), z.boolean(), z.number()])).refine((v) => Object.keys(v).length <= 60, 'Too many fields'),
  consent: z.boolean().optional(),
  token: z.string().max(200).optional(),
  hp: z.string().max(500).optional(),
  captchaToken: z.string().max(4000).optional(),
  pageUrl: z.string().max(2000).optional(),
  referrer: z.string().max(2000).optional(),
  ref: z.string().trim().max(64).optional(),
  utm: utmSchema.optional(),
});

export const checkoutBody = z.strictObject({
  payload: z.string().min(2).max(20_000),
  timestamp: z.number().int(),
  signature: z.string().min(16).max(200),
});

// ---------- Enquiries ----------

export const enquiryListQuery = z.strictObject({
  unitId: uuid,
  status: z.enum(['pending', 'needs_review', 'processed', 'discarded', 'failed']).optional(),
  channel: channelKeySchema.optional(),
  ...pageQuery,
});

const personSchema = z.strictObject({
  name: optionalText(200),
  phone: optionalText(40),
  email: optionalText(254),
  city: optionalText(120),
  language: optionalText(3),
  timeZone: timeZoneSchema.optional(),
  relation: z.enum(['self', 'parent', 'guardian', 'sibling', 'staff', 'other']).optional(),
});

/** Manual entry through the intake pipeline (dedup, reopen, assignment). */
export const manualEnquiryBody = z.strictObject({
  unitId: uuid,
  channel: channelKeySchema.default('manual'),
  audience: z.enum(['b2c', 'b2b']).default('b2c'),
  contact: personSchema,
  student: z.strictObject({ name: optionalText(200), grade: optionalText(40), board: optionalText(60), school: optionalText(200), targetExam: optionalText(100) }).optional(),
  institute: z.strictObject({ name: optionalText(200), city: optionalText(120), studentCount: z.number().int().min(0).max(10_000_000).optional() }).optional(),
  productLineId: uuid.optional(),
  message: optionalText(5000),
  campaign: optionalText(200),
  assign: z.enum(['me', 'auto']).default('me'),
});

// ---------- Review queue ----------

export const reviewListQuery = z.strictObject({
  unitId: uuid,
  kind: z.enum(['routing', 'duplicate', 'extraction']).optional(),
  status: z.enum(['open', 'resolved']).default('open'),
  ...pageQuery,
});

export const resolveBody = z.strictObject({
  action: z.enum(['approve', 'override', 'discard', 'merge', 'keep_separate', 'dismiss']),
  companyId: uuid.optional(),
  productLineId: uuid.nullable().optional(),
  note: optionalText(500),
});

// ---------- Imports ----------

export const importUploadQuery = z.strictObject({
  unitId: uuid,
  fileName: z.string().trim().min(1).max(200).regex(/\.(csv|txt|tsv)$/i, 'Upload a .csv file'),
});

export const importStartBody = z.strictObject({
  mapping: z.record(z.string().regex(/^\d{1,3}$/), z.string().max(60)).refine((m) => Object.keys(m).length <= 200, 'Too many columns'),
  defaults: z
    .strictObject({
      audience: z.enum(['b2c', 'b2b']).default('b2c'),
      productLineId: uuid.optional(),
      campaign: optionalText(200),
      dateOrder: z.enum(['DMY', 'MDY']).default('DMY'),
    })
    .default({ audience: 'b2c', dateOrder: 'DMY' }),
});

export const importRowsQuery = z.strictObject({
  status: z.enum(['created', 'merged', 'reopened', 'review', 'error', 'skipped']).optional(),
  cursor: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// ---------- Forms ----------

const formBase = {
  name: requiredText(120),
  audience: z.enum(['b2c', 'b2b']),
  unitId: uuid.optional(),
  productLineId: uuid.nullable().optional(),
  fields: z.array(formFieldSchema).max(40).optional(),
  consent: formConsentSchema,
  spam: formSpamSchema,
  thankYou: formThankYouSchema,
};

export const formCreateBody = z.strictObject({
  companyId: uuid,
  kind: z.enum(['enquiry', 'checkout']).default('enquiry'),
  ...formBase,
});

export const formPatchBody = z
  .strictObject({
    name: requiredText(120),
    audience: z.enum(['b2c', 'b2b']),
    unitId: uuid,
    productLineId: uuid.nullable(),
    fields: z.array(formFieldSchema).max(40),
    consent: formConsentSchema.unwrap(),
    spam: formSpamSchema.unwrap(),
    thankYou: formThankYouSchema.unwrap(),
    active: z.boolean(),
  })
  .partial();

// ---------- Routing: identities, pools, partner links ----------

export const identityBody = z
  .strictObject({
    type: z.enum(CHANNEL_TYPES),
    identity: requiredText(500),
    label: optionalText(120),
    shared: z.boolean().default(false),
    companyId: uuid.nullable().optional(),
    companyIds: z.array(uuid).max(20).default([]),
    unitId: uuid.nullable().optional(),
    productLineId: uuid.nullable().optional(),
  })
  .refine((b) => (b.shared ? b.companyIds.length >= 2 : Boolean(b.companyId)), { message: 'Pick the company that owns it, or at least two companies for a shared channel', path: ['companyId'] });

export const identityPatchBody = z.strictObject({ label: optionalText(120).nullable(), active: z.boolean(), unitId: uuid.nullable(), productLineId: uuid.nullable(), companyIds: z.array(uuid).min(2).max(20) }).partial();

const memberSchema = z.strictObject({
  userId: uuid,
  capacity: z.number().int().min(0).max(10_000).nullable().default(null),
  languages: z.array(z.string().regex(/^[a-z]{2,3}$/)).max(10).default([]),
  timeZone: timeZoneSchema.nullable().default(null),
  active: z.boolean().default(true),
  awayUntil: z.iso.datetime({ offset: true }).nullable().default(null),
});

const poolFields = {
  name: requiredText(80),
  unitId: uuid,
  kind: z.enum(['b2c', 'b2b']).nullable().default(null),
  productLineIds: z.array(uuid).max(50).default([]),
  isDefault: z.boolean().default(false),
  languageMatch: z.enum(['prefer', 'require', 'ignore']).default('prefer'),
  workingHours: z.enum(['prefer', 'require', 'ignore']).default('prefer'),
  timeZoneMatch: z.enum(['prefer', 'ignore']).default('prefer'),
  position: z.number().int().min(0).max(1000).default(0),
};

export const poolCreateBody = z.strictObject({ companyId: uuid, ...poolFields, members: z.array(memberSchema).max(200).default([]) });
export const poolPatchBody = z
  .strictObject({
    name: requiredText(80),
    unitId: uuid,
    kind: z.enum(['b2c', 'b2b']).nullable(),
    productLineIds: z.array(uuid).max(50),
    isDefault: z.boolean(),
    languageMatch: z.enum(['prefer', 'require', 'ignore']),
    workingHours: z.enum(['prefer', 'require', 'ignore']),
    timeZoneMatch: z.enum(['prefer', 'ignore']),
    position: z.number().int().min(0).max(1000),
    active: z.boolean(),
  })
  .partial();
export const poolMembersBody = z.strictObject({ members: z.array(memberSchema).max(200) });

export const partnerLinkBody = z.strictObject({
  companyId: uuid,
  code: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{2,39}$/, 'Use 3 to 40 letters, digits, - or _'),
  partnerId: uuid,
  partnerName: requiredText(120),
  ownerUserId: uuid.nullable().default(null),
  productLineId: uuid.nullable().default(null),
  formId: uuid.nullable().default(null),
});
export const partnerLinkPatchBody = z.strictObject({ partnerName: requiredText(120), ownerUserId: uuid.nullable(), productLineId: uuid.nullable(), formId: uuid.nullable(), active: z.boolean() }).partial();
