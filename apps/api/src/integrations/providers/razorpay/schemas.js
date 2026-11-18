import { z } from 'zod';
import { toUnixSeconds } from './util.js';

/**
 * Input schemas for client calls (camelCase in, Razorpay snake_case out).
 * Limits are Razorpay's documented ones (fetched 2026-11-05) unless marked "ours".
 */

/** Razorpay ids are `<prefix>_<14 alphanumerics>`; we only check prefix + charset (keeps paths safe). */
const idOf = (prefix) => z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9]+$`), `Must be a Razorpay ${prefix}_ id`);
export const ids = {
  order: idOf('order'),
  payment: idOf('pay'),
  paymentLink: idOf('plink'),
  refund: idOf('rfnd'),
  plan: idOf('plan'),
  subscription: idOf('sub'),
  offer: idOf('offer'),
};

/** Integer minor units (paise for INR). */
export const amount = z.number().int('Amount must be an integer in minor units (paise)').positive().max(Number.MAX_SAFE_INTEGER);
export const currency = z.string().regex(/^[A-Z]{3}$/, 'Currency must be an ISO 4217 code such as INR').default('INR');

/** Notes: at most 15 pairs, 256 characters each (Razorpay convention for all entities). */
export const notes = z
  .record(z.string().min(1).max(256), z.string().max(256))
  .refine((n) => Object.keys(n).length <= 15, 'Notes can hold at most 15 key-value pairs')
  .optional();

/** Date, ISO-8601 string with offset, or unix seconds → unix seconds. */
export const timestamp = z
  .union([z.date(), z.iso.datetime({ offset: true }), z.number().int().positive()])
  .transform((v) => toUnixSeconds(v));

/** INR orders and links have a ₹1 (100 paise) minimum. */
const inrMinimum = (v, ctx) => {
  if (v.currency === 'INR' && v.amount < 100) {
    ctx.addIssue({ code: 'custom', path: ['amount'], message: 'INR amounts must be at least 100 paise (₹1)' });
  }
};

export const createOrderInput = z
  .object({
    amount,
    currency,
    receipt: z.string().min(1).max(40).optional(),
    notes,
    partialPayment: z.boolean().optional(),
    firstPaymentMinAmount: amount.optional(),
  })
  .strict()
  .superRefine(inrMinimum);

export const createPaymentLinkInput = z
  .object({
    amount,
    currency,
    description: z.string().max(2048).optional(),
    customer: z
      .object({
        name: z.string().min(1).max(255).optional(),
        email: z.email().optional(),
        contact: z.string().regex(/^\+?[0-9 ()-]{8,20}$/, 'Contact must be a phone number').optional(),
      })
      .strict()
      .optional(),
    notify: z.object({ sms: z.boolean().optional(), email: z.boolean().optional() }).strict().optional(),
    reminderEnable: z.boolean().optional(),
    expireBy: timestamp.optional(),
    referenceId: z.string().min(1).max(40).optional(),
    notes,
    callbackUrl: z.url({ protocol: /^https?$/ }).optional(),
    acceptPartial: z.boolean().optional(),
    firstMinPartialAmount: amount.optional(),
  })
  .strict()
  .superRefine(inrMinimum)
  .superRefine((v, ctx) => {
    if (v.firstMinPartialAmount !== undefined && !v.acceptPartial) {
      ctx.addIssue({ code: 'custom', path: ['firstMinPartialAmount'], message: 'Only allowed with acceptPartial: true' });
    }
  });

/** Idempotency key for refunds: at least 10 characters of letters, digits, hyphen, underscore (max is ours). */
export const refundIdempotencyKey = z
  .string()
  .regex(/^[A-Za-z0-9_-]{10,255}$/, 'Idempotency key must be 10+ characters of letters, digits, - or _');

export const createRefundInput = z
  .object({
    amount: amount.optional(), // omitted = full refund
    speed: z.enum(['normal', 'optimum']).default('normal'),
    receipt: z.string().min(1).max(40).optional(),
    notes,
    idempotencyKey: refundIdempotencyKey.optional(),
  })
  .strict();

export const createPlanInput = z
  .object({
    period: z.enum(['daily', 'weekly', 'monthly', 'quarterly', 'yearly']),
    interval: z.number().int().positive(),
    item: z
      .object({
        name: z.string().min(1).max(255),
        amount,
        currency,
        description: z.string().max(2048).optional(),
      })
      .strict(),
    notes,
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.period === 'daily' && v.interval < 7) {
      ctx.addIssue({ code: 'custom', path: ['interval'], message: 'Daily plans need an interval of at least 7' });
    }
  });

export const createSubscriptionInput = z
  .object({
    planId: ids.plan,
    totalCount: z.number().int().positive(),
    quantity: z.number().int().positive().optional(),
    startAt: timestamp.optional(),
    expireBy: timestamp.optional(),
    customerNotify: z.boolean().optional(),
    addons: z
      .array(z.object({ name: z.string().min(1).max(255), amount, currency }).strict())
      .max(10)
      .optional(),
    offerId: ids.offer.optional(),
    notes,
  })
  .strict();

export const cancelSubscriptionInput = z.object({ atCycleEnd: z.boolean().default(false) }).strict();
