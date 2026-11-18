import { z } from 'zod';
import {
  booleanQuery,
  csvList,
  currencySchema,
  dateOnlySchema,
  dateTimeSchema,
  nullableText,
  optionalText,
  ownerFilterSchema,
  pageQuery,
  requiredText,
  valueMinorSchema,
} from '../../core/crm/schemas.js';
import { emailSchema } from '../../lib/schemas.js';
import {
  ACCESS_STATUSES,
  BATCH_MODES,
  BATCH_STATUSES,
  ENROLLMENT_STATUSES,
  ITEM_STATUSES,
  OWNER_ROLES,
  PROJECT_STATUSES,
  REFUND_UNITS,
  SEAT_STATUSES,
  WEEKDAYS,
  WITHDRAWAL_CHANNELS,
} from './constants.js';

// Request schemas of the delivery module (docs/delivery/DELIVERY.md §8). Bodies and queries are
// strict: unknown keys are a 422, like every phase 2 endpoint.

export const moneySchema = z.strictObject({ valueMinor: valueMinorSchema, currency: currencySchema });

const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 17:30');

export const scheduleSchema = z
  .strictObject({
    days: z.array(z.enum(WEEKDAYS)).max(7).optional(),
    startTime: timeSchema.optional(),
    endTime: timeSchema.optional(),
    timeZone: optionalText(60),
    notes: optionalText(300),
  })
  .refine((s) => !s.startTime || !s.endTime || s.startTime < s.endTime, { message: 'End after the start', path: ['endTime'] });

// Fields without defaults (PATCH keeps what is stored); defaults are added for POST only.
const batchFields = {
  code: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : v), z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9-_]{0,39}$/, 'Letters, digits and dashes').nullable()),
  name: requiredText(120),
  mode: z.enum(BATCH_MODES),
  schedule: scheduleSchema,
  startsOn: dateOnlySchema,
  endsOn: dateOnlySchema,
  capacity: z.number().int().min(1, 'At least one seat').max(100000),
  waitlistEnabled: z.boolean(),
  waitlistLimit: z.number().int().min(1).max(100000).nullable(),
  fee: moneySchema.nullable(),
  checkoutEnabled: z.boolean(),
  teacherUserId: z.uuid().nullable(),
  teacherName: nullableText(120),
  location: nullableText(200),
  status: z.enum(BATCH_STATUSES),
  refundUnit: z.enum(REFUND_UNITS),
  totalClasses: z.number().int().min(1).max(5000).nullable(),
};

const batchRules = (value, ctx) => {
  if (value.startsOn && value.endsOn && value.endsOn < value.startsOn) ctx.addIssue({ code: 'custom', path: ['endsOn'], message: 'End on or after the start' });
};

export const createBatchSchema = z
  .strictObject({
    unitId: z.uuid(),
    productId: z.uuid(),
    ...batchFields,
    code: batchFields.code.optional(),
    mode: batchFields.mode.default('online'),
    schedule: scheduleSchema.default({}),
    waitlistEnabled: z.boolean().default(true),
    waitlistLimit: batchFields.waitlistLimit.optional(),
    fee: batchFields.fee.optional(),
    checkoutEnabled: z.boolean().default(false),
    teacherUserId: batchFields.teacherUserId.optional(),
    teacherName: batchFields.teacherName.optional(),
    location: batchFields.location.optional(),
    status: batchFields.status.default('open'),
    refundUnit: batchFields.refundUnit.default('days'),
    totalClasses: batchFields.totalClasses.optional(),
  })
  .superRefine((value, ctx) => {
    batchRules(value, ctx);
    if (value.checkoutEnabled && !value.fee) ctx.addIssue({ code: 'custom', path: ['fee'], message: 'Set the fee to sell this batch online' });
    if (value.refundUnit === 'classes' && !value.totalClasses) {
      ctx.addIssue({ code: 'custom', path: ['totalClasses'], message: 'Give the number of classes to refund by class' });
    }
  });

/** PATCH: every field optional, no defaults. Rules that need the stored row are checked in the route. */
export const updateBatchSchema = z
  .strictObject(Object.fromEntries(Object.entries(batchFields).map(([k, schema]) => [k, schema.optional()])))
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change' })
  .superRefine(batchRules);

export const batchListQuery = z.strictObject({
  unitId: z.uuid(),
  productId: z.uuid().optional(),
  status: csvList(z.enum(BATCH_STATUSES), 5).optional(),
  joinable: booleanQuery.optional(),
  q: optionalText(100),
  ...pageQuery,
});

export const enrollmentListQuery = z.strictObject({
  unitId: z.uuid(),
  status: csvList(z.enum(ENROLLMENT_STATUSES), 4).optional(),
  seatStatus: z.enum(SEAT_STATUSES).optional(),
  batchId: z.uuid().optional(),
  productId: z.uuid().optional(),
  dealId: z.uuid().optional(),
  contactId: z.uuid().optional(),
  owner: ownerFilterSchema.optional(),
  q: optionalText(100),
  ...pageQuery,
});

export const countsQuery = z.strictObject({ unitId: z.uuid() });

export const createEnrollmentSchema = z.strictObject({
  unitId: z.uuid(),
  dealId: z.uuid().nullable().optional(),
  studentContactId: z.uuid(),
  payerContactId: z.uuid().nullable().optional(),
  householdId: z.uuid().nullable().optional(),
  productId: z.uuid(),
  batchId: z.uuid().nullable().optional(),
  joinWaitlist: z.boolean().default(true),
  ownerUserId: z.uuid().nullable().optional(),
  fee: moneySchema.nullable().optional(),
  startsOn: dateOnlySchema.nullable().optional(),
  accessStatus: z.enum(['not_required', 'pending']).optional(),
});

export const updateEnrollmentSchema = z
  .strictObject({
    ownerUserId: z.uuid().nullable().optional(),
    accessStatus: z.enum(ACCESS_STATUSES).optional(),
    startsOn: dateOnlySchema.nullable().optional(),
    endsOn: dateOnlySchema.nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change' });

export const moveBatchSchema = z.strictObject({ batchId: z.uuid(), joinWaitlist: z.boolean().default(false) });

export const pauseSchema = z.strictObject({ resumeOn: dateOnlySchema.nullable().optional(), reason: nullableText(300).optional() });

export const refundPreviewSchema = z.strictObject({
  receivedAt: dateTimeSchema.optional(),
  effectiveOn: dateOnlySchema.optional(),
  classesAttended: z.number().int().min(0).max(5000).nullable().optional(),
});

export const withdrawSchema = z.strictObject({
  receivedAt: dateTimeSchema.optional(),
  channel: z.enum(WITHDRAWAL_CHANNELS),
  reason: nullableText(500).optional(),
  effectiveOn: dateOnlySchema.optional(),
  classesAttended: z.number().int().min(0).max(5000).nullable().optional(),
  requestedByContactId: z.uuid().nullable().optional(),
});

// ---------- Public checkout ----------

const personName = { firstName: requiredText(80, 'Enter a first name'), lastName: optionalText(80) };
const phoneText = z.string().trim().min(6, 'Enter a phone number').max(30);

export const checkoutCompanyParams = z.strictObject({ company: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9-_]+$/, 'Unknown company') });

export const checkoutSessionSchema = z.strictObject({
  batchId: z.uuid(),
  parent: z.strictObject({ ...personName, phone: phoneText, email: emailSchema, relation: optionalText(40) }),
  student: z.strictObject({
    ...personName,
    phone: phoneText.optional().or(z.literal('').transform(() => undefined)),
    email: emailSchema.optional().or(z.literal('').transform(() => undefined)),
    grade: optionalText(20),
    school: optionalText(120),
    city: optionalText(80),
  }),
  consent: z.strictObject({
    acceptPolicy: z.literal(true, { error: 'Accept the fee and refund policy to continue' }),
    policyVersion: z.string().trim().min(6).max(40),
    whatsappUpdates: z.boolean().default(false),
    marketing: z.boolean().default(false),
  }),
  utm: z
    .strictObject({ source: optionalText(100), medium: optionalText(100), campaign: optionalText(100), term: optionalText(100), content: optionalText(100) })
    .optional(),
});

export const checkoutTokenQuery = z.strictObject({ token: z.string().min(20).max(200) });
export const checkoutTokenBody = z.strictObject({ token: z.string().min(20).max(200) });

// ---------- Onboarding ----------

export const phaseSchema = z.strictObject({
  key: z.string().trim().regex(/^[a-z][a-z0-9_]{1,39}$/, 'Use lower-case letters, digits and _'),
  name: requiredText(80),
  offsetDays: z.number().int().min(0).max(730).default(0),
});

export const templateItemSchema = z.strictObject({
  phaseKey: z.string().trim().max(40).nullable().optional(),
  title: requiredText(200),
  description: nullableText(1000).optional(),
  ownerRole: z.enum(OWNER_ROLES).default('record_owner'),
  dueOffsetDays: z.number().int().min(0).max(730).default(0),
});

const templateBase = {
  name: requiredText(120),
  productLineId: z.uuid().nullable().optional(),
  productId: z.uuid().nullable().optional(),
  phases: z.array(phaseSchema).max(12).optional(),
  items: z.array(templateItemSchema).max(100).default([]),
  active: z.boolean().optional(),
};

const templateRules = (value, ctx) => {
  if (value.kind === 'b2b' || value.phases) {
    const keys = (value.phases ?? []).map((p) => p.key);
    if (new Set(keys).size !== keys.length) ctx.addIssue({ code: 'custom', path: ['phases'], message: 'Phase keys must be different' });
  }
  if (value.kind === 'b2c' && value.phases?.length) ctx.addIssue({ code: 'custom', path: ['phases'], message: 'Checklists have no phases' });
};

export const createTemplateSchema = z
  .strictObject({ companyId: z.uuid(), kind: z.enum(['b2c', 'b2b']), ...templateBase })
  .superRefine(templateRules);

export const updateTemplateSchema = z.strictObject({ ...templateBase }).superRefine(templateRules);

export const templateListQuery = z
  .strictObject({ unitId: z.uuid().optional(), companyId: z.uuid().optional(), kind: z.enum(['b2c', 'b2b']).optional() })
  .refine((v) => v.unitId || v.companyId, { message: 'Give unitId or companyId' });

export const checklistListQuery = z.strictObject({
  unitId: z.uuid(),
  status: z.enum(['open', 'done']).optional(),
  owner: ownerFilterSchema.optional(),
  overdue: booleanQuery.optional(),
  ...pageQuery,
});

export const itemUpdateSchema = z
  .strictObject({ status: z.enum(ITEM_STATUSES).optional(), ownerUserId: z.uuid().nullable().optional(), dueOn: dateOnlySchema.nullable().optional() })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change' });

export const projectListQuery = z.strictObject({
  unitId: z.uuid(),
  status: csvList(z.enum(PROJECT_STATUSES), 5).optional(),
  owner: ownerFilterSchema.optional(),
  accountId: z.uuid().optional(),
  dealId: z.uuid().optional(),
  ...pageQuery,
});

export const createProjectSchema = z.strictObject({
  unitId: z.uuid(),
  accountId: z.uuid(),
  dealId: z.uuid().nullable().optional(),
  productId: z.uuid().nullable().optional(),
  name: optionalText(160),
  ownerUserId: z.uuid().nullable().optional(),
  kickoffOn: dateOnlySchema.optional(),
  targetGoLiveOn: dateOnlySchema.optional(),
});

export const updateProjectSchema = z
  .strictObject({
    name: requiredText(160).optional(),
    status: z.enum(PROJECT_STATUSES).optional(),
    ownerUserId: z.uuid().nullable().optional(),
    kickoffOn: dateOnlySchema.nullable().optional(),
    targetGoLiveOn: dateOnlySchema.nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change' });

export const addTaskSchema = z.strictObject({
  phaseId: z.uuid(),
  title: requiredText(200),
  description: nullableText(1000).optional(),
  ownerUserId: z.uuid().nullable().optional(),
  dueOn: dateOnlySchema.nullable().optional(),
});

export const taskUpdateSchema = z
  .strictObject({
    status: z.enum(ITEM_STATUSES).optional(),
    title: requiredText(200).optional(),
    ownerUserId: z.uuid().nullable().optional(),
    dueOn: dateOnlySchema.nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change' });

export const phaseUpdateSchema = z
  .strictObject({ ownerUserId: z.uuid().nullable().optional(), dueOn: dateOnlySchema.nullable().optional() })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change' });

export const renewalListQuery = z.strictObject({
  unitId: z.uuid(),
  status: z.enum(['active', 'cancelled', 'ended']).default('active'),
  risk: csvList(z.enum(['low', 'medium', 'high']), 3).optional(),
  dueWithinDays: z.coerce.number().int().min(0).max(730).optional(),
  owner: ownerFilterSchema.optional(),
  upsell: booleanQuery.optional(),
  sort: z.enum(['due', 'risk']).default('due'),
  ...pageQuery,
});

export const idAndItemParams = z.strictObject({ id: z.uuid(), itemId: z.uuid() });
export const idAndTaskParams = z.strictObject({ id: z.uuid(), taskId: z.uuid() });
export const idAndPhaseParams = z.strictObject({ id: z.uuid(), phaseId: z.uuid() });
export const idParams = z.strictObject({ id: z.uuid() });
