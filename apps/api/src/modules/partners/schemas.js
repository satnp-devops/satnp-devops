import { z } from 'zod';
import { emailSchema, nameSchema, webUrlSchema } from '../../lib/schemas.js';
import {
  currencySchema,
  dateOnlySchema,
  dateTimeSchema,
  nullableText,
  optionalText,
  pageQuery,
  utmSchema,
  valueMinorSchema,
} from '../../core/crm/schemas.js';
import {
  COMMISSION_STATUSES,
  MAX_BULK,
  PARTNER_KINDS,
  PARTNER_LINK_STATUSES,
  PAYOUT_STATUSES,
  PLAN_BASES,
  PLAN_TRIGGERS,
  TOUCHES,
} from './constants.js';
import { REFERRAL_CODE_PATTERN } from './rules.js';

// Inputs of the partners endpoints. Bodies and queries are strict: unknown keys are a 422.

const phone = z.preprocess((v) => (typeof v === 'string' ? v.trim() : v), z.string().min(5).max(40));
const referralCode = z.preprocess(
  (v) => (typeof v === 'string' ? v.trim() : v),
  z.string().regex(REFERRAL_CODE_PATTERN, 'Use 3 to 40 letters, digits, dashes or underscores'),
);
const landingUrl = webUrlSchema;

export const listQuery = (extra = {}) => z.strictObject({ unitId: z.uuid(), ...pageQuery, ...extra });

// ---------- Partners ----------

export const partnersListQuery = listQuery({
  q: z.string().trim().max(100).optional(),
  status: z.enum(PARTNER_LINK_STATUSES).optional(),
  ownerUserId: z.uuid().optional(),
});

const partnerFields = {
  kind: z.enum(PARTNER_KINDS),
  name: nameSchema,
  code: referralCode.nullable().optional(),
  legalName: nullableText(200).optional(),
  email: emailSchema.nullable().optional(),
  phone: phone.nullable().optional(),
  city: nullableText(100).optional(),
  notes: nullableText(2000).optional(),
};

export const createPartnerBody = z.strictObject({
  unitId: z.uuid(),
  ...partnerFields,
  ownerUserId: z.uuid().nullable().optional(),
  status: z.enum(['pending', 'active']).default('active'),
  commissionPlanId: z.uuid().nullable().optional(),
});

export const updatePartnerBody = z
  .strictObject({
    kind: partnerFields.kind.optional(),
    name: partnerFields.name.optional(),
    code: partnerFields.code,
    legalName: partnerFields.legalName,
    email: partnerFields.email,
    phone: partnerFields.phone,
    city: partnerFields.city,
    notes: partnerFields.notes,
  })
  .refine((body) => Object.keys(body).length > 0, 'Change at least one field');

export const linkCompanyBody = z.strictObject({
  unitId: z.uuid(),
  ownerUserId: z.uuid().nullable().optional(),
  status: z.enum(['pending', 'active']).default('active'),
  commissionPlanId: z.uuid().nullable().optional(),
});

export const updateLinkBody = z
  .strictObject({
    unitId: z.uuid().optional(),
    ownerUserId: z.uuid().nullable().optional(),
    status: z.enum(PARTNER_LINK_STATUSES).optional(),
    commissionPlanId: z.uuid().nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'Change at least one field');

export const portalAccessBody = z.strictObject({ email: emailSchema, name: nameSchema.optional() });

// ---------- Referral links ----------

export const linksListQuery = listQuery({
  partnerId: z.uuid().optional(),
  active: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  q: z.string().trim().max(60).optional(),
});

const linkFields = {
  label: nullableText(120).optional(),
  productLineId: z.uuid().nullable().optional(),
  landingUrl: landingUrl.nullable().optional(),
  utm: utmSchema.optional(),
};

export const createLinkBody = z.strictObject({
  partnerId: z.uuid(),
  companyId: z.uuid(),
  code: referralCode.optional(),
  ...linkFields,
});

export const updateLinkFieldsBody = z
  .strictObject({ ...linkFields, active: z.boolean().optional() })
  .refine((body) => Object.keys(body).length > 0, 'Change at least one field');

// Partners can't point links at their own pages: portal links use the company's landing page.
export const portalCreateLinkBody = z.strictObject({ companyId: z.uuid(), label: linkFields.label, productLineId: linkFields.productLineId, utm: linkFields.utm });
export const portalUpdateLinkBody = z
  .strictObject({ label: linkFields.label, active: z.boolean().optional() })
  .refine((body) => Object.keys(body).length > 0, 'Change at least one field');

// ---------- Attributions ----------

export const attributionsListQuery = listQuery({
  partnerId: z.uuid().optional(),
  dealId: z.uuid().optional(),
  touch: z.enum(TOUCHES).optional(),
  /** One row per lead and partner: the first-touch row stands for both when the partner holds both. */
  onePerLead: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});

export const createAttributionBody = z.strictObject({
  dealId: z.uuid(),
  partnerId: z.uuid(),
  touch: z.enum(TOUCHES),
  referralLinkId: z.uuid().nullable().optional(),
});

// ---------- Commission plans ----------

export const plansListQuery = z.strictObject({ unitId: z.uuid().optional(), companyId: z.uuid().optional() }).refine(
  (q) => q.unitId || q.companyId,
  'Send unitId or companyId',
);

const planFields = {
  name: z.preprocess((v) => (typeof v === 'string' ? v.trim() : v), z.string().min(1, 'Name the plan').max(120)),
  description: nullableText(1000).optional(),
  productLineId: z.uuid().nullable().optional(),
  basis: z.enum(PLAN_BASES),
  rateBps: z.number().int().min(1, 'At least 0.01%').max(10_000, 'At most 100%').nullable().optional(),
  fixedMinor: valueMinorSchema.min(1).nullable().optional(),
  currency: currencySchema.nullable().optional(),
  trigger: z.enum(PLAN_TRIGGERS),
  clawbackDays: z.number().int().min(0).max(730),
  capMinor: valueMinorSchema.min(1).nullable().optional(),
  active: z.boolean().optional(),
  position: z.number().int().min(0).max(10_000).optional(),
};

/** The amount rules a plan must satisfy, as field errors (also checked on updates, after merging). */
export function planAmountIssues(plan) {
  const issues = [];
  if (plan.basis === 'percent' && !plan.rateBps) issues.push({ path: 'body.rateBps', message: 'Enter the percentage' });
  if (plan.basis === 'fixed' && !plan.fixedMinor) issues.push({ path: 'body.fixedMinor', message: 'Enter the amount' });
  if (plan.basis === 'fixed' && !plan.currency) issues.push({ path: 'body.currency', message: 'Pick the currency of the amount' });
  if (plan.capMinor && !plan.currency) issues.push({ path: 'body.currency', message: 'Pick the currency of the cap' });
  return issues;
}

export const createPlanBody = z.strictObject({ companyId: z.uuid(), ...planFields });
export const updatePlanBody = z
  .strictObject(Object.fromEntries(Object.entries(planFields).map(([key, schema]) => [key, schema.optional()])))
  .refine((body) => Object.keys(body).length > 0, 'Change at least one field');

// ---------- Commissions ----------

export const commissionsListQuery = listQuery({
  partnerId: z.uuid().optional(),
  dealId: z.uuid().optional(),
  status: z.enum(COMMISSION_STATUSES).optional(),
  currency: currencySchema.optional(),
});

export const rejectCommissionBody = z.strictObject({ reason: z.preprocess((v) => (typeof v === 'string' ? v.trim() : v), z.string().min(3, 'Say why').max(500)) });
export const bulkApproveBody = z.strictObject({ ids: z.array(z.uuid()).min(1).max(MAX_BULK) });

// ---------- Payouts ----------

export const payoutsListQuery = listQuery({ status: z.enum(PAYOUT_STATUSES).optional() });

export const createPayoutBody = z
  .strictObject({
    companyId: z.uuid(),
    periodStart: dateOnlySchema,
    periodEnd: dateOnlySchema,
    currency: currencySchema.default('INR'),
    notes: optionalText(1000),
  })
  .refine((body) => body.periodEnd >= body.periodStart, { path: ['periodEnd'], message: 'The period ends before it starts' });

export const markPaidBody = z.strictObject({
  reference: z.preprocess((v) => (typeof v === 'string' ? v.trim() : v), z.string().min(3, 'Enter the bank reference').max(120)),
  paidAt: dateTimeSchema.optional(),
  lines: z
    .array(z.strictObject({ partnerId: z.uuid(), reference: z.preprocess((v) => (typeof v === 'string' ? v.trim() : v), z.string().min(3).max(120)) }))
    .max(1000)
    .optional(),
});

export const cancelPayoutBody = z.strictObject({ reason: z.preprocess((v) => (typeof v === 'string' ? v.trim() : v), z.string().min(3, 'Say why').max(500)) });

// ---------- Portal ----------

export const portalPageQuery = z.strictObject({ ...pageQuery, companyId: z.uuid().optional() });

// ---------- Domain events from other modules (payloads are validated before use) ----------

/** payment.succeeded, from the money module (phase 7). Extra keys are ignored. */
export const paymentSucceededPayload = z.object({
  paymentId: z.string().min(1).max(200),
  companyId: z.uuid(),
  dealId: z.uuid(),
  amountMinor: z.number().int().min(0),
  currency: currencySchema,
  paidAt: z.string().optional(),
  isFirstPayment: z.boolean().optional(),
  fullyPaid: z.boolean().optional(),
  totalMinor: z.number().int().min(0).optional(),
  paidTotalMinor: z.number().int().min(0).optional(),
  productLineId: z.uuid().nullable().optional(),
});

/** refund.processed (also accepted as refund.succeeded, the provider adapters' name). */
export const refundProcessedPayload = z.object({
  refundId: z.string().min(1).max(200),
  paymentId: z.string().min(1).max(200).optional(),
  dealId: z.uuid().optional(),
  companyId: z.uuid().optional(),
  amountMinor: z.number().int().min(0).optional(),
  currency: currencySchema.optional(),
  full: z.boolean().optional(),
  processedAt: z.string().optional(),
});
