import { z } from 'zod';
import { gstinRefinement, isValidPan, isValidStateCode, numberSeriesSchema } from '../../core/billing/index.js';
import {
  csvList,
  currencySchema,
  dateOnlySchema,
  dateTimeSchema,
  keySchema,
  nullableText,
  optionalText,
  pageQuery,
  requiredText,
  valueMinorSchema,
} from '../../core/crm/schemas.js';
import { addressSchema } from '../../core/crm/schemas.js';
import {
  ACCOUNT_SCOPES,
  AGREEMENT_STATUSES,
  AUDIENCES,
  BILLING_INTERVALS,
  FY_STYLE_KEYS,
  PAYMENT_METHODS,
  PAYMENT_PROVIDERS,
  PAYMENT_STATUSES,
  PLAN_KINDS,
  PLAN_UNITS,
  QUOTE_KINDS,
  QUOTE_STATUSES,
  REFUND_REASONS,
  REFUND_STATUSES,
  SERIES_DOCUMENT_TYPES,
  SIGN_TYPES,
  SIGNER_ROLES,
  SUBSCRIPTION_STATUSES,
  TAXABILITIES,
} from './constants.js';

// zod schemas for every money endpoint (bodies and queries are strict: unknown keys → 422).

export { pageQuery };
const id = z.uuid();
const amount = valueMinorSchema;
const positiveAmount = valueMinorSchema.refine((v) => v > 0, 'Enter an amount above zero');
const rateBp = z.number().int().min(0).max(10_000);
const sac = z.string().trim().regex(/^\d{4,8}$/, 'Use a 4 to 8 digit SAC or HSN code');
const stateCode = z
  .string()
  .trim()
  .refine((code) => isValidStateCode(code, { allowCentre: false }) || code === '96', 'Use a GST state code like 27');
export const gstinSchema = z.preprocess(
  (v) => (typeof v === 'string' ? v.trim().toUpperCase() : v),
  z.string().refine(gstinRefinement, 'Enter a valid GSTIN'),
);

export const companyQuery = z.strictObject({ companyId: id });
export const unitOrCompanyQuery = z
  .strictObject({ companyId: id.optional(), unitId: id.optional(), includeInactive: z.enum(['true', 'false']).optional() })
  .refine((q) => Boolean(q.companyId) !== Boolean(q.unitId), { message: 'Pass companyId or unitId', path: ['companyId'] });

// ---------- Setup ----------

export const profileBody = z.strictObject({
  companyId: id,
  legalName: requiredText(200),
  tradeName: nullableText(200).optional(),
  gstin: gstinSchema.nullable().optional(),
  stateCode: stateCode.optional(),
  pan: z
    .preprocess((v) => (typeof v === 'string' ? v.trim().toUpperCase() : v), z.string().refine(isValidPan, 'Enter a valid PAN'))
    .nullable()
    .optional(),
  address: addressSchema.optional(),
  email: z.email().max(254).nullable().optional(),
  phone: nullableText(40).optional(),
  lutNumber: nullableText(40).optional(),
  lutValidUntil: dateOnlySchema.nullable().optional(),
  roundOff: z.boolean().optional(),
  invoiceNotes: nullableText(1000).optional(),
  bankDetails: z
    .strictObject({ accountName: optionalText(120), accountNumber: optionalText(40), ifsc: optionalText(20), bank: optionalText(120) })
    .optional(),
});

export const seriesBody = z.strictObject({
  companyId: id,
  documentType: z.enum(SERIES_DOCUMENT_TYPES),
  prefix: z.string().trim().min(1).max(10).regex(/^[A-Za-z1-9][A-Za-z0-9/-]*$/, 'Letters, digits, / and -; not starting with 0'),
  format: optionalText(40),
  fyStyle: z.enum(FY_STYLE_KEYS).default('compact'),
  padding: z.number().int().min(1).max(10).default(5),
  isDefault: z.boolean().default(true),
});
export const seriesPatchBody = z.strictObject({ isDefault: z.literal(true).optional(), active: z.boolean().optional() });
export { numberSeriesSchema };

const planFields = {
  productId: id.nullable().optional(),
  code: z.preprocess((v) => (typeof v === 'string' ? v.trim().toUpperCase() : v), z.string().regex(/^[A-Z0-9][A-Z0-9_-]{0,39}$/, 'Use letters, digits, - and _')),
  name: requiredText(200),
  description: nullableText(1000).optional(),
  kind: z.enum(PLAN_KINDS),
  audience: z.enum(AUDIENCES),
  unit: z.enum(PLAN_UNITS).default('flat'),
  interval: z.enum(BILLING_INTERVALS).nullable().optional(),
  sac: sac.nullable().optional(),
  taxRateBp: rateBp.default(1800),
  taxability: z.enum(TAXABILITIES).default('taxable'),
  position: z.number().int().min(0).max(10_000).optional(),
  active: z.boolean().optional(),
};
const intervalRule = (p) => (p.kind === 'recurring' ? Boolean(p.interval) : !p.interval);
export const planBody = z.strictObject({ companyId: id, ...planFields }).refine(intervalRule, {
  message: 'Recurring plans need an interval; one-time plans have none',
  path: ['interval'],
});
export const planPatchBody = z.strictObject(planFields).partial();

const priceEntry = z.strictObject({ planId: id, unitAmountMinor: amount });
export const priceListBody = z.strictObject({
  companyId: id,
  name: requiredText(120),
  currency: currencySchema,
  pricesIncludeTax: z.boolean().default(true),
  isDefault: z.boolean().default(false),
  prices: z.array(priceEntry).max(500).default([]),
});
export const priceListPatchBody = z
  .strictObject({ name: requiredText(120), pricesIncludeTax: z.boolean(), isDefault: z.boolean(), active: z.boolean(), prices: z.array(priceEntry).max(500) })
  .partial();

export const paymentAccountBody = z.strictObject({
  companyId: id,
  provider: z.enum(['razorpay', 'stripe']),
  label: requiredText(80),
  scope: z.enum(ACCOUNT_SCOPES).default('domestic'),
  mode: z.enum(['test', 'live']).default('test'),
  accountRef: nullableText(60).optional(),
  connectionId: id.nullable().optional(),
  entityCountry: z.string().trim().regex(/^[A-Z]{2}$/).default('IN'),
  indiaExports: z.boolean().default(false),
  purposeCode: z.string().trim().regex(/^P\d{4}$/, 'Use a purpose code like P1107').nullable().optional(),
});
export const paymentAccountPatchBody = z
  .strictObject({
    label: requiredText(80),
    scope: z.enum(ACCOUNT_SCOPES),
    mode: z.enum(['test', 'live']),
    accountRef: nullableText(60),
    connectionId: id.nullable(),
    entityCountry: z.string().trim().regex(/^[A-Z]{2}$/),
    indiaExports: z.boolean(),
    purposeCode: z.string().trim().regex(/^P\d{4}$/).nullable(),
    active: z.boolean(),
  })
  .partial();

export const templateBody = z.strictObject({
  companyId: id,
  key: keySchema,
  name: requiredText(120),
  audience: z.enum(AUDIENCES).default('b2c'),
  body: requiredText(20_000),
  signType: z.enum(SIGN_TYPES).default('aadhaar'),
  expiresInDays: z.number().int().min(1).max(90).default(10),
});
export const templatePatchBody = z
  .strictObject({ name: requiredText(120), audience: z.enum(AUDIENCES), body: requiredText(20_000), signType: z.enum(SIGN_TYPES), expiresInDays: z.number().int().min(1).max(90), active: z.boolean() })
  .partial();

// ---------- Quotes and fee proposals ----------

export const quoteLineInput = z.strictObject({
  planId: id.nullable().optional(),
  description: optionalText(300),
  quantity: z.number().positive().max(100_000).multipleOf(0.001).default(1),
  /** Defaults to the plan's price in the price list. */
  unitPriceMinor: amount.optional(),
  discountMinor: amount.default(0),
  /** Lines without a plan must give SAC, rate and taxability (or take 18% taxable). */
  sac: sac.nullable().optional(),
  taxRateBp: rateBp.optional(),
  taxability: z.enum(TAXABILITIES).optional(),
});

export const recipientSchema = z.strictObject({
  name: optionalText(200),
  gstin: gstinSchema.nullable().optional(),
  stateCode: stateCode.nullable().optional(),
  outsideIndia: z.boolean().optional(),
  sez: z.boolean().optional(),
  address: addressSchema.optional(),
});

export const instalmentOptionSchema = z
  .strictObject({
    count: z.number().int().min(2).max(24),
    frequency: z.enum(['monthly', 'custom']).default('monthly'),
    startDate: dateOnlySchema.optional(),
    dayOfMonth: z.number().int().min(1).max(31).optional(),
    intervalMonths: z.number().int().min(1).max(12).optional(),
    dates: z.array(dateOnlySchema).max(24).optional(),
    firstAmountMinor: positiveAmount.optional(),
  })
  .refine((o) => o.frequency !== 'custom' || (o.dates && o.dates.length === o.count), {
    message: 'Give one date per instalment',
    path: ['dates'],
  })
  .refine((o) => o.frequency !== 'monthly' || Boolean(o.startDate), { message: 'Pick the first due date', path: ['startDate'] });

const quoteFields = {
  title: optionalText(200),
  priceListId: id.nullable().optional(),
  currency: currencySchema.optional(),
  lines: z.array(quoteLineInput).min(1, 'Add at least one line').max(50),
  recipient: recipientSchema.optional(),
  instalmentOption: instalmentOptionSchema.nullable().optional(),
  validUntil: dateOnlySchema.optional(),
  notes: nullableText(2000).optional(),
  terms: nullableText(4000).optional(),
  discountNote: nullableText(500).optional(),
};
export const quoteBody = z.strictObject({ dealId: id, kind: z.enum(QUOTE_KINDS).optional(), ...quoteFields });
export const quotePatchBody = z.strictObject(quoteFields).partial();
export const quotePreviewBody = quoteBody;
export const reviewBody = z.strictObject({ note: nullableText(500).optional() });
export const declineBody = z.strictObject({ reason: optionalText(500) });
export const quoteListQuery = z.strictObject({
  unitId: id,
  status: csvList(z.enum(QUOTE_STATUSES), 10).optional(),
  kind: z.enum(QUOTE_KINDS).optional(),
  awaitingApproval: z.enum(['true', 'false']).optional(),
  ...pageQuery,
});

// ---------- Payments ----------

export const paymentLinkBody = z.strictObject({
  dealId: id,
  /** full: the quote total (or what's left of it); instalment: one instalment; emi: the full amount, EMI offered at checkout. */
  purpose: z.enum(['full', 'instalment', 'emi', 'subscription', 'adjustment']),
  quoteId: id.optional(),
  instalmentId: id.optional(),
  subscriptionId: id.optional(),
  /** Adjustments only (an amount not tied to a quote): finance-only. */
  amountMinor: positiveAmount.optional(),
  currency: currencySchema.optional(),
  description: optionalText(250),
  /** Client-chosen key: a second request with the same key returns the first link. */
  idempotencyKey: z.string().trim().min(8).max(100).regex(/^[A-Za-z0-9._:-]+$/).optional(),
  notify: z.boolean().default(true),
});
export const manualPaymentBody = z.strictObject({
  dealId: id,
  quoteId: id.optional(),
  instalmentId: id.optional(),
  subscriptionId: id.optional(),
  amountMinor: positiveAmount,
  currency: currencySchema.optional(),
  method: z.enum(PAYMENT_METHODS),
  reference: requiredText(80),
  paidAt: dateTimeSchema.optional(),
  description: optionalText(250),
});
export const simulateBody = z.strictObject({
  outcome: z.enum(['succeeded', 'failed']),
  method: z.enum(PAYMENT_METHODS).default('upi'),
});
export const paymentListQuery = z.strictObject({
  unitId: id,
  status: csvList(z.enum(PAYMENT_STATUSES), 10).optional(),
  provider: z.enum(PAYMENT_PROVIDERS).optional(),
  dealId: id.optional(),
  ...pageQuery,
});

// ---------- Invoices, credit notes, refunds ----------

export const listQuery = z.strictObject({ unitId: id, dealId: id.optional(), ...pageQuery });
export const invoiceListQuery = z.strictObject({ unitId: id, dealId: id.optional(), status: z.enum(['issued', 'cancelled']).optional(), ...pageQuery });
export const cancelInvoiceBody = z.strictObject({ reason: requiredText(500) });
export const creditNoteBody = z
  .strictObject({
    mode: z.enum(['full', 'partial']),
    amountMinor: positiveAmount.optional(),
    reason: z.enum(['cancellation', 'post_supply_discount', 'deficiency', 'excess_value', 'excess_tax', 'other']),
    notes: nullableText(500).optional(),
  })
  .refine((b) => b.mode === 'full' || b.amountMinor, { message: 'Enter the amount to credit', path: ['amountMinor'] });

export const refundBody = z.strictObject({
  paymentId: id,
  amountMinor: positiveAmount,
  reason: z.enum(REFUND_REASONS),
  note: optionalText(500),
});
export const refundListQuery = z.strictObject({ unitId: id, status: csvList(z.enum(REFUND_STATUSES), 6).optional(), dealId: id.optional(), ...pageQuery });

// ---------- Instalments ----------

export const instalmentListQuery = z.strictObject({
  unitId: id,
  state: z.enum(['due', 'overdue', 'upcoming', 'paid', 'all']).default('due'),
  dealId: id.optional(),
  ...pageQuery,
});
export const rescheduleBody = z.strictObject({
  count: z.number().int().min(1).max(24),
  frequency: z.enum(['monthly', 'custom']).default('monthly'),
  startDate: dateOnlySchema.optional(),
  dayOfMonth: z.number().int().min(1).max(31).optional(),
  dates: z.array(dateOnlySchema).max(24).optional(),
  reason: requiredText(500),
});

// ---------- Subscriptions ----------

const addon = z.strictObject({ code: requiredText(40), name: requiredText(120), quantity: z.number().int().min(1).max(100_000), unitPriceMinor: amount });
export const subscriptionBody = z.strictObject({
  dealId: id,
  planId: id,
  quantity: z.number().int().min(1).max(1_000_000),
  unitPriceMinor: amount.optional(),
  priceListId: id.optional(),
  startDate: dateOnlySchema.optional(),
  addons: z.array(addon).max(10).default([]),
  sendLink: z.boolean().default(true),
});
export const subscriptionPatchBody = z.strictObject({
  quantity: z.number().int().min(1).max(1_000_000).optional(),
  addons: z.array(addon).max(10).optional(),
  changeDate: dateOnlySchema.optional(),
  preview: z.boolean().default(false),
});
export const subscriptionCancelBody = z.strictObject({ atPeriodEnd: z.boolean().default(true), reason: requiredText(500) });
export const subscriptionListQuery = z.strictObject({
  unitId: id,
  status: csvList(z.enum(SUBSCRIPTION_STATUSES), 3).optional(),
  renewingWithinDays: z.coerce.number().int().min(0).max(365).optional(),
  ...pageQuery,
});

// ---------- Agreements ----------

const signer = z.strictObject({
  name: requiredText(100),
  /** Email or 10-digit Indian mobile number. Personal data: masked for people without contacts.view_pii. */
  identifier: z.string().trim().min(5).max(254),
  role: z.enum(SIGNER_ROLES).default('parent'),
  order: z.number().int().min(1).max(20).optional(),
  signType: z.enum(SIGN_TYPES).optional(),
});
export const agreementBody = z.strictObject({
  dealId: id,
  templateId: id,
  quoteId: id.optional(),
  title: optionalText(200),
  signers: z.array(signer).min(1).max(10),
  send: z.boolean().default(false),
});
export const agreementCancelBody = z.strictObject({ reason: requiredText(500) });
export const agreementSimulateBody = z.strictObject({ outcome: z.enum(['signed', 'failed', 'rejected']) });
export const agreementListQuery = z.strictObject({ unitId: id, status: csvList(z.enum(AGREEMENT_STATUSES), 7).optional(), ...pageQuery });

export const overviewQuery = z.strictObject({ unitId: id });
export const dealParams = z.strictObject({ dealId: id });
export const idParams = z.strictObject({ id });
export { amount, positiveAmount, PAYMENT_METHODS };

