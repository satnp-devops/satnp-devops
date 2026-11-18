import { z } from 'zod';
import { StripeConfigError } from './errors.js';

/** Latest Stripe API version on 2026-11-05 (docs.stripe.com/api/versioning). Pin it; upgrade on purpose. */
export const DEFAULT_API_VERSION = '2026-10-28.endive';
export const DEFAULT_API_BASE = 'https://api.stripe.com';
/** Stripe's libraries default to 300 s (docs.stripe.com/webhooks#replay-attacks). */
export const DEFAULT_WEBHOOK_TOLERANCE_SEC = 300;

const secretKey = z
  .string()
  .regex(/^(sk|rk)_(test|live)_[A-Za-z0-9]{8,}$/, 'must be a Stripe secret key (sk_test_/sk_live_) or restricted key (rk_test_/rk_live_)');
const webhookSecret = z.string().regex(/^whsec_[A-Za-z0-9_]{6,}$/, 'must be a webhook signing secret starting with whsec_');

/**
 * Connection config. Secrets come only from here (never from env inside the client).
 * Field docs and where to get each value: docs/providers/stripe.md.
 */
export const stripeConfigSchema = z
  .object({
    secretKey,
    /** One secret, or several while an endpoint secret is being rolled. */
    webhookSecret: z.union([webhookSecret, z.array(webhookSecret).min(1).max(5)]).optional(),
    apiVersion: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}(\.[a-z]+)?$/, 'must look like 2026-10-28.endive')
      .default(DEFAULT_API_VERSION),
    /** Connect only: act on this connected account (Stripe-Account header). */
    accountId: z.string().regex(/^acct_[A-Za-z0-9]+$/, 'must start with acct_').optional(),
    apiBase: z.url({ protocol: /^https?$/ }).default(DEFAULT_API_BASE),
    timeoutMs: z.number().int().min(1000).max(120_000).default(30_000),
    maxRetries: z.number().int().min(0).max(5).default(2),
    webhookToleranceSec: z.number().int().min(1).max(3600).default(DEFAULT_WEBHOOK_TOLERANCE_SEC),
    /**
     * Indian Stripe account selling to customers abroad: Checkout and Payment Links then
     * require a description and collect the billing address (docs.stripe.com/india-exports).
     */
    indiaExports: z.boolean().default(false),
  })
  .strict();

/** @typedef {z.output<typeof stripeConfigSchema>} StripeConfig */

/**
 * Validates config. Errors name the field and the rule, never the value.
 * @param {unknown} input
 * @returns {StripeConfig & { mode: 'test'|'live' }}
 */
export function parseStripeConfig(input) {
  const result = stripeConfigSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
    throw new StripeConfigError(
      `Invalid Stripe config: ${issues.map((i) => `${i.path || '(root)'} ${i.message}`).join('; ')}`,
      issues,
    );
  }
  const config = result.data;
  const mode = config.secretKey.includes('_live_') ? 'live' : 'test';
  if (config.apiBase !== DEFAULT_API_BASE && mode === 'live' && !config.apiBase.startsWith('https://')) {
    throw new StripeConfigError('Invalid Stripe config: apiBase must use https with a live key');
  }
  return { ...config, mode };
}
