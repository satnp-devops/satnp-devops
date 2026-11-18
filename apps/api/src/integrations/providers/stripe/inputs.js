import { z } from 'zod';
import { assertStripeAmount, normalizeCurrency } from './currency.js';
import { StripeConfigError } from './errors.js';
import { mergeParams } from './form.js';

/**
 * Platform-shaped inputs (camelCase, validated with zod) -> Stripe v1 parameters (snake_case).
 * Every input also takes `extra`: raw Stripe params deep-merged last, for anything not modelled.
 */

const MAX_METADATA_KEYS = 50;

/** Stripe metadata: up to 50 keys, key <= 40 chars (no square brackets), value <= 500 chars. */
const metadata = z
  .record(z.string().min(1).max(40).regex(/^[^[\]]+$/, 'metadata keys cannot contain square brackets'), z.string().max(500))
  .refine((m) => Object.keys(m).length <= MAX_METADATA_KEYS, `at most ${MAX_METADATA_KEYS} metadata keys`)
  .optional();
const currency = z.string().regex(/^[A-Za-z]{3}$/, 'must be a 3-letter ISO 4217 code').transform(normalizeCurrency);
const amount = z.number().int().nonnegative();
const url = z.url({ protocol: /^https?$/ });
const extra = z.record(z.string(), z.unknown()).optional();
const id = (prefix) => z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9_]+$`), `must start with ${prefix}_`);
const unixOrDate = z.union([z.date(), z.number().int().positive()]);
const recurring = z
  .object({ interval: z.enum(['day', 'week', 'month', 'year']), intervalCount: z.number().int().min(1).max(156).optional() })
  .strict();

const address = z
  .object({
    line1: z.string().max(200).optional(),
    line2: z.string().max(200).optional(),
    city: z.string().max(200).optional(),
    state: z.string().max(200).optional(),
    postalCode: z.string().max(20).optional(),
    country: z.string().regex(/^[A-Z]{2}$/, 'must be an ISO 3166-1 alpha-2 code').optional(),
  })
  .strict();

const lineItem = z.union([
  z
    .object({
      priceId: id('price'),
      quantity: z.number().int().positive().default(1),
      adjustableQuantity: z.object({ enabled: z.boolean(), minimum: z.number().int().min(0).optional(), maximum: z.number().int().max(999999).optional() }).strict().optional(),
    })
    .strict(),
  z
    .object({
      name: z.string().min(1).max(250),
      description: z.string().max(1000).optional(),
      amount,
      currency,
      quantity: z.number().int().positive().default(1),
      productId: id('prod').optional(),
      images: z.array(url).max(8).optional(),
      recurring: recurring.optional(),
      taxBehavior: z.enum(['inclusive', 'exclusive', 'unspecified']).optional(),
      adjustableQuantity: z.object({ enabled: z.boolean(), minimum: z.number().int().min(0).optional(), maximum: z.number().int().max(999999).optional() }).strict().optional(),
    })
    .strict(),
]);

/** @param {z.output<typeof lineItem>} item */
function toStripeLineItem(item) {
  const adjustable = item.adjustableQuantity
    ? { enabled: item.adjustableQuantity.enabled, minimum: item.adjustableQuantity.minimum, maximum: item.adjustableQuantity.maximum }
    : undefined;
  if ('priceId' in item) return { price: item.priceId, quantity: item.quantity, adjustable_quantity: adjustable };
  assertStripeAmount(item.amount, item.currency);
  return {
    price_data: {
      currency: item.currency,
      unit_amount: item.amount,
      product: item.productId,
      product_data: item.productId ? undefined : { name: item.name, description: item.description, images: item.images },
      recurring: item.recurring ? { interval: item.recurring.interval, interval_count: item.recurring.intervalCount } : undefined,
      tax_behavior: item.taxBehavior,
    },
    quantity: item.quantity,
    adjustable_quantity: adjustable,
  };
}

/**
 * Parses with zod and rethrows as StripeConfigError (nothing is sent to Stripe).
 * @template T
 * @param {z.ZodType<T>} schema
 * @param {unknown} input
 * @param {string} what
 * @returns {T}
 */
export function parseInput(schema, input, what) {
  const result = schema.safeParse(input ?? {});
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
    throw new StripeConfigError(`Invalid ${what}: ${issues.map((i) => `${i.path || '(root)'} ${i.message}`).join('; ')}`, issues);
  }
  return result.data;
}

/** @param {() => void} check */
function amountCheck(check) {
  try {
    check();
  } catch (error) {
    throw new StripeConfigError(/** @type {Error} */ (error).message);
  }
}

// ---------------------------------------------------------------- Checkout Sessions

export const checkoutSessionInput = z
  .object({
    mode: z.enum(['payment', 'subscription', 'setup']).default('payment'),
    lineItems: z.array(lineItem).min(1).max(100).optional(),
    successUrl: url.optional(),
    cancelUrl: url.optional(),
    uiMode: z.enum(['hosted_page', 'embedded_page', 'elements', 'form']).optional(),
    returnUrl: url.optional(),
    customerId: id('cus').optional(),
    customerEmail: z.email().optional(),
    clientReferenceId: z.string().min(1).max(200).optional(),
    description: z.string().min(1).max(1000).optional(),
    metadata,
    expiresAt: unixOrDate.optional(),
    billingAddressCollection: z.enum(['auto', 'required']).optional(),
    customerCreation: z.enum(['always', 'if_required']).optional(),
    paymentMethodTypes: z.array(z.string().regex(/^[a-z_]+$/)).min(1).optional(),
    allowPromotionCodes: z.boolean().optional(),
    locale: z.string().max(10).optional(),
    currency: currency.optional(),
    extra,
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.mode !== 'setup' && !input.lineItems) ctx.addIssue({ code: 'custom', path: ['lineItems'], message: 'required for payment and subscription mode' });
    if (input.customerId && input.customerEmail) ctx.addIssue({ code: 'custom', path: ['customerEmail'], message: 'give customerId or customerEmail, not both' });
    const hosted = !input.uiMode || input.uiMode === 'hosted_page';
    if (hosted && !input.successUrl) ctx.addIssue({ code: 'custom', path: ['successUrl'], message: 'required for hosted Checkout' });
    if (!hosted && input.successUrl) ctx.addIssue({ code: 'custom', path: ['successUrl'], message: 'use returnUrl when uiMode is not hosted_page' });
    if (input.mode === 'subscription' && input.lineItems?.every((item) => 'name' in item && !item.recurring)) {
      ctx.addIssue({ code: 'custom', path: ['lineItems'], message: 'subscription mode needs at least one recurring item' });
    }
  });

/**
 * @param {unknown} raw
 * @param {{ nowMs: number, indiaExports: boolean }} context
 */
export function toCheckoutSessionParams(raw, { nowMs, indiaExports }) {
  const input = parseInput(checkoutSessionInput, raw, 'checkout session');
  if (indiaExports && input.mode !== 'setup' && !input.description) {
    throw new StripeConfigError('Invalid checkout session: description is required for Indian export payments');
  }
  let expiresAt;
  if (input.expiresAt !== undefined) {
    expiresAt = input.expiresAt instanceof Date ? Math.floor(input.expiresAt.getTime() / 1000) : input.expiresAt;
    const minutes = (expiresAt * 1000 - nowMs) / 60_000;
    // Stripe allows 30 minutes to 24 hours after creation; keep a minute of slack for clock skew.
    if (minutes < 31 || minutes > 24 * 60 - 1) throw new StripeConfigError('Invalid checkout session: expiresAt must be 31 minutes to 23 h 59 min from now');
  }
  const lineItems = input.lineItems?.map((item) => {
    let mapped;
    amountCheck(() => {
      mapped = toStripeLineItem(item);
    });
    return mapped;
  });
  const descriptionTarget =
    input.mode === 'payment' ? { payment_intent_data: { description: input.description, metadata: input.metadata } } : {};
  const subscriptionData =
    input.mode === 'subscription' ? { subscription_data: { description: input.description, metadata: input.metadata } } : {};
  const params = {
    mode: input.mode,
    line_items: lineItems,
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    ui_mode: input.uiMode,
    return_url: input.returnUrl,
    customer: input.customerId,
    customer_email: input.customerEmail,
    client_reference_id: input.clientReferenceId,
    metadata: input.metadata,
    expires_at: expiresAt,
    billing_address_collection: input.billingAddressCollection ?? (indiaExports ? 'required' : undefined),
    customer_creation: input.mode === 'payment' ? input.customerCreation : undefined,
    payment_method_types: input.paymentMethodTypes,
    allow_promotion_codes: input.allowPromotionCodes,
    locale: input.locale,
    currency: input.currency,
    ...descriptionTarget,
    ...subscriptionData,
  };
  return mergeParams(params, input.extra);
}

// ---------------------------------------------------------------- Payment Links

export const paymentLinkInput = z
  .object({
    lineItems: z.array(lineItem).min(1).max(20),
    description: z.string().min(1).max(1000).optional(),
    metadata,
    redirectUrl: url.optional(),
    billingAddressCollection: z.enum(['auto', 'required']).optional(),
    allowPromotionCodes: z.boolean().optional(),
    paymentMethodTypes: z.array(z.string().regex(/^[a-z_]+$/)).min(1).optional(),
    extra,
  })
  .strict();

/** @param {unknown} raw @param {{ indiaExports: boolean }} context */
export function toPaymentLinkParams(raw, { indiaExports }) {
  const input = parseInput(paymentLinkInput, raw, 'payment link');
  if (indiaExports && !input.description) {
    throw new StripeConfigError('Invalid payment link: description is required for Indian export payments');
  }
  const recurringLink = input.lineItems.some((item) => 'recurring' in item && item.recurring);
  const lineItems = input.lineItems.map((item) => {
    let mapped;
    amountCheck(() => {
      mapped = toStripeLineItem(item);
    });
    return mapped;
  });
  const params = {
    line_items: lineItems,
    metadata: input.metadata,
    after_completion: input.redirectUrl ? { type: 'redirect', redirect: { url: input.redirectUrl } } : undefined,
    billing_address_collection: input.billingAddressCollection ?? (indiaExports ? 'required' : undefined),
    allow_promotion_codes: input.allowPromotionCodes,
    payment_method_types: input.paymentMethodTypes,
    ...(recurringLink
      ? { subscription_data: { description: input.description, metadata: input.metadata } }
      : { payment_intent_data: { description: input.description, metadata: input.metadata } }),
  };
  return mergeParams(params, input.extra);
}

// ---------------------------------------------------------------- Customers

const customerFields = {
  email: z.email().optional(),
  name: z.string().min(1).max(256).optional(),
  phone: z.string().max(20).optional(),
  description: z.string().max(350).optional(),
  address: address.optional(),
  metadata,
  extra,
};
export const customerInput = z.object(customerFields).strict();

/** @param {unknown} raw */
export function toCustomerParams(raw) {
  const input = parseInput(customerInput, raw, 'customer');
  const a = input.address;
  const params = {
    email: input.email,
    name: input.name,
    phone: input.phone,
    description: input.description,
    address: a ? { line1: a.line1, line2: a.line2, city: a.city, state: a.state, postal_code: a.postalCode, country: a.country } : undefined,
    metadata: input.metadata,
  };
  return mergeParams(params, input.extra);
}

// ---------------------------------------------------------------- Products and Prices

export const productInput = z
  .object({ name: z.string().min(1).max(250), description: z.string().max(1000).optional(), metadata, extra })
  .strict();

/** @param {unknown} raw */
export function toProductParams(raw) {
  const input = parseInput(productInput, raw, 'product');
  return mergeParams({ name: input.name, description: input.description, metadata: input.metadata }, input.extra);
}

export const priceInput = z
  .object({
    amount,
    currency,
    productId: id('prod').optional(),
    productName: z.string().min(1).max(250).optional(),
    recurring: recurring.optional(),
    nickname: z.string().max(250).optional(),
    lookupKey: z.string().max(200).optional(),
    taxBehavior: z.enum(['inclusive', 'exclusive', 'unspecified']).optional(),
    metadata,
    extra,
  })
  .strict()
  .refine((p) => Boolean(p.productId) !== Boolean(p.productName), { message: 'give productId or productName (exactly one)', path: ['productId'] });

/** @param {unknown} raw */
export function toPriceParams(raw) {
  const input = parseInput(priceInput, raw, 'price');
  amountCheck(() => assertStripeAmount(input.amount, input.currency));
  const params = {
    currency: input.currency,
    unit_amount: input.amount,
    product: input.productId,
    product_data: input.productName ? { name: input.productName } : undefined,
    recurring: input.recurring ? { interval: input.recurring.interval, interval_count: input.recurring.intervalCount } : undefined,
    nickname: input.nickname,
    lookup_key: input.lookupKey,
    tax_behavior: input.taxBehavior,
    metadata: input.metadata,
  };
  return mergeParams(params, input.extra);
}

// ---------------------------------------------------------------- Subscriptions

export const subscriptionInput = z
  .object({
    customerId: id('cus'),
    items: z.array(z.object({ priceId: id('price'), quantity: z.number().int().positive().default(1) }).strict()).min(1).max(20),
    description: z.string().max(500).optional(),
    metadata,
    trialPeriodDays: z.number().int().min(1).max(730).optional(),
    cancelAtPeriodEnd: z.boolean().optional(),
    collectionMethod: z.enum(['charge_automatically', 'send_invoice']).optional(),
    daysUntilDue: z.number().int().min(0).max(365).optional(),
    paymentBehavior: z.enum(['allow_incomplete', 'default_incomplete', 'error_if_incomplete', 'pending_if_incomplete']).optional(),
    defaultPaymentMethodId: id('pm').optional(),
    extra,
  })
  .strict()
  .refine((s) => s.collectionMethod === 'send_invoice' || s.daysUntilDue === undefined, {
    message: 'daysUntilDue only applies when collectionMethod is send_invoice',
    path: ['daysUntilDue'],
  });

/** @param {unknown} raw */
export function toSubscriptionParams(raw) {
  const input = parseInput(subscriptionInput, raw, 'subscription');
  const params = {
    customer: input.customerId,
    items: input.items.map((item) => ({ price: item.priceId, quantity: item.quantity })),
    description: input.description,
    metadata: input.metadata,
    trial_period_days: input.trialPeriodDays,
    cancel_at_period_end: input.cancelAtPeriodEnd,
    collection_method: input.collectionMethod,
    days_until_due: input.daysUntilDue,
    payment_behavior: input.paymentBehavior,
    default_payment_method: input.defaultPaymentMethodId,
  };
  return mergeParams(params, input.extra);
}

// ---------------------------------------------------------------- Refunds

export const refundInput = z
  .object({
    paymentIntentId: id('pi').optional(),
    chargeId: z.string().regex(/^(ch|py)_[A-Za-z0-9_]+$/, 'must start with ch_ or py_').optional(),
    /** Omit for a full refund. Same currency and unit as the original payment. */
    amount: z.number().int().positive().optional(),
    reason: z.enum(['duplicate', 'fraudulent', 'requested_by_customer']).optional(),
    metadata,
    extra,
  })
  .strict()
  .refine((r) => Boolean(r.paymentIntentId) !== Boolean(r.chargeId), {
    message: 'give paymentIntentId or chargeId (exactly one)',
    path: ['paymentIntentId'],
  });

/** @param {unknown} raw */
export function toRefundParams(raw) {
  const input = parseInput(refundInput, raw, 'refund');
  const params = {
    payment_intent: input.paymentIntentId,
    charge: input.chargeId,
    amount: input.amount,
    reason: input.reason,
    metadata: input.metadata,
  };
  return mergeParams(params, input.extra);
}

/**
 * Validates a Stripe object id used in a URL path.
 * @param {unknown} value
 * @param {string[]} prefixes
 * @returns {string}
 */
export function pathId(value, prefixes) {
  const text = String(value ?? '');
  const ok = prefixes.some((prefix) => text.startsWith(`${prefix}_`)) && /^[A-Za-z0-9_]{4,255}$/.test(text);
  if (!ok) throw new StripeConfigError(`Invalid Stripe id: expected ${prefixes.map((p) => `${p}_...`).join(' or ')}`);
  return text;
}
