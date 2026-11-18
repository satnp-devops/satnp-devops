import { z } from 'zod';
import { RazorpayError } from './errors.js';

export const DEFAULT_BASE_URL = 'https://api.razorpay.com/v1';

/**
 * Connection config for one Razorpay account (one company in the group usually has its own).
 * Secrets come only from here; the client never reads process.env.
 *
 * Mode: Razorpay uses the same API host for test and live; the key pair decides the mode.
 * Key ids look like `rzp_test_...` or `rzp_live_...`. If `mode` is given it must agree with
 * the key prefix, which stops a live key being wired into a test connection by mistake.
 */
export const razorpayConfigSchema = z
  .object({
    keyId: z.string().trim().regex(/^rzp_[A-Za-z0-9_]+$/, 'Key Id must look like rzp_test_... or rzp_live_...'),
    keySecret: z.string().min(8, 'Key Secret looks too short'),
    webhookSecret: z
      .union([z.string().min(1), z.array(z.string().min(1)).min(1).max(5)])
      .optional()
      .describe('Webhook secret(s). Pass [new, old] while rotating so retried old events still verify.'),
    mode: z.enum(['test', 'live']).optional(),
    accountId: z
      .string()
      .regex(/^acc_[A-Za-z0-9]+$/, 'Account id must look like acc_...')
      .optional()
      .describe('Merchant account id; when set, webhooks for another account are rejected.'),
    baseUrl: z.url().default(DEFAULT_BASE_URL),
    timeoutMs: z.number().int().min(10).max(120_000).default(15_000),
    maxRetries: z.number().int().min(0).max(5).default(2),
    retryBaseDelayMs: z.number().int().min(0).max(10_000).default(300),
    retryMaxDelayMs: z.number().int().min(0).max(60_000).default(5_000),
    webhookMaxAgeSeconds: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Platform policy, not a Razorpay rule. Razorpay retries for 24h, so use > 86400 if set.'),
  })
  .strict();

/** @typedef {z.input<typeof razorpayConfigSchema>} RazorpayConfigInput */
/** @typedef {z.output<typeof razorpayConfigSchema> & { mode: 'test'|'live', webhookSecrets: string[] }} RazorpayConfig */

/** @param {string} keyId */
export function modeFromKeyId(keyId) {
  if (keyId.startsWith('rzp_test_')) return 'test';
  if (keyId.startsWith('rzp_live_')) return 'live';
  return null;
}

/**
 * Validate config. Issues name the field and the rule, never the value.
 * @param {unknown} input
 * @returns {RazorpayConfig}
 */
export function parseConfig(input) {
  const result = razorpayConfigSchema.safeParse(input);
  if (!result.success) {
    const details = result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
    throw new RazorpayError('config', `Razorpay config is invalid: ${details.map((d) => d.path || 'config').join(', ')}`, {
      details,
    });
  }
  const config = result.data;
  const inferred = modeFromKeyId(config.keyId);
  if (config.mode && inferred && config.mode !== inferred) {
    throw new RazorpayError('config', `Razorpay config is invalid: mode is ${config.mode} but the key is a ${inferred} key`, {
      details: [{ path: 'mode', message: `Key prefix says ${inferred}` }],
    });
  }
  const mode = config.mode ?? inferred;
  if (!mode) {
    throw new RazorpayError('config', 'Razorpay config is invalid: set mode (the key prefix does not say test or live)', {
      details: [{ path: 'mode', message: 'Required when the key id is not rzp_test_/rzp_live_' }],
    });
  }
  const webhookSecrets =
    config.webhookSecret === undefined ? [] : Array.isArray(config.webhookSecret) ? config.webhookSecret : [config.webhookSecret];
  return { ...config, baseUrl: config.baseUrl.replace(/\/+$/, ''), mode, webhookSecrets };
}
