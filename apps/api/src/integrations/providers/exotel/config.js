import { isIP } from 'node:net';
import { z } from 'zod';
import { ExotelConfigError } from './errors.js';

/**
 * Exotel runs two clusters. The account is provisioned on one of them and API calls must go to
 * that cluster's host, otherwise authentication fails. The dashboard host tells you which one:
 * my.exotel.com is Singapore, my.exotel.in is Mumbai.
 * Source: developer.exotel.com/docs/voice-api/getting-started/authentication (2026-11-05).
 */
export const REGION_HOSTS = Object.freeze({
  singapore: 'api.exotel.com',
  mumbai: 'api.in.exotel.com',
});

/** Documented maximum for TimeLimit (4 hours). */
export const MAX_TIME_LIMIT_SECONDS = 14400;
/** Documented maximum length of CustomField. */
export const MAX_CUSTOM_FIELD_LENGTH = 128;

const httpsUrl = z.url({ protocol: /^https$/, error: 'must be an https:// URL' });
const secret = z.string().min(32, 'must be at least 32 characters');

/** @param {string} value */
export function isIpOrCidr(value) {
  const [address, prefix, extra] = String(value).trim().split('/');
  if (extra !== undefined) return false;
  const family = isIP(address);
  if (!family) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  return Number(prefix) <= (family === 4 ? 32 : 128);
}

export const exotelConfigSchema = z
  .object({
    /** Account SID, shown on Dashboard > Settings > API Settings. Not a secret. */
    accountSid: z.string().trim().regex(/^[A-Za-z0-9_-]{2,64}$/, 'must be the account SID from API Settings'),
    /** API key (Basic auth username). Secret. */
    apiKey: z.string().trim().min(8),
    /** API token (Basic auth password). Secret. */
    apiToken: z.string().trim().min(8),
    /** Cluster the account lives on. */
    region: z.enum(['singapore', 'mumbai']).default('singapore'),
    /** Overrides the regional host (tests, or a host Exotel support gives you). */
    baseUrl: httpsUrl.optional(),
    /** Default ExoPhone used as CallerId for click-to-call. */
    callerId: z.string().trim().min(5).max(20).optional(),
    /** Public https URL that receives status callbacks. Signed per call when webhookSecret is set. */
    statusCallbackUrl: httpsUrl.optional(),
    statusCallbackEvents: z
      .array(z.enum(['terminal', 'answered', 'ringing']))
      .min(1)
      .default(['terminal', 'answered']),
    statusCallbackContentType: z.enum(['application/json', 'multipart/form-data']).default('application/json'),
    /** HMAC key for callback URL tokens. An array allows rotation: first signs, all verify. Secret. */
    webhookSecret: z.union([secret, z.array(secret).min(1).max(5)]).optional(),
    /** How long a signed status-callback URL stays valid. Exotel retries for a while; keep it generous. */
    callbackTtlSeconds: z
      .number()
      .int()
      .min(300)
      .max(30 * 86400)
      .default(7 * 86400),
    /** Optional source-IP allow-list (IPs or CIDRs) for callbacks; ask Exotel support for the list. */
    allowedWebhookIps: z.array(z.string().refine(isIpOrCidr, 'must be an IP address or CIDR')).max(100).default([]),
    record: z.boolean().default(false),
    recordingChannels: z.enum(['single', 'dual']).default('single'),
    recordingFormat: z.enum(['mp3', 'mp3-hq']).default('mp3'),
    timeLimitSeconds: z.number().int().min(1).max(MAX_TIME_LIMIT_SECONDS).optional(),
    ringTimeoutSeconds: z.number().int().min(5).max(300).optional(),
    /** Offset of Exotel's "YYYY-MM-DD HH:mm:ss" timestamps. IST for Indian accounts (unconfirmed for SG). */
    timeZoneOffset: z
      .string()
      .regex(/^[+-](0\d|1[0-4]):[0-5]\d$/, 'must look like +05:30')
      .default('+05:30'),
    /** ISO 4217 currency of the account's call prices. */
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .default('INR'),
    /** Country code assumed for numbers written without one. */
    defaultCountryCode: z
      .string()
      .regex(/^[1-9]\d{0,2}$/)
      .default('91'),
    timeoutMs: z.number().int().min(50).max(120000).default(15000),
    maxRetries: z.number().int().min(0).max(5).default(2),
    retryBaseDelayMs: z.number().int().min(0).max(10000).default(300),
    /** Longest server-suggested wait (Retry-After) the client will sleep through itself. */
    maxRetryAfterMs: z.number().int().min(0).max(120000).default(30000),
    /** Overall deadline for downloading one recording (the body can be large). */
    recordingTimeoutMs: z.number().int().min(1000).max(30 * 60000).default(120000),
    maxRecordingBytes: z
      .number()
      .int()
      .min(1024)
      .max(1024 * 1024 * 1024)
      .default(100 * 1024 * 1024),
  })
  .strict();

/** @typedef {z.infer<typeof exotelConfigSchema>} ExotelConfig */

/**
 * Validates config. Errors list field paths and rules only, never the values, so a mistyped
 * token cannot leak through a startup log.
 * @param {unknown} input
 * @returns {Readonly<ExotelConfig>}
 */
export function parseConfig(input) {
  const result = exotelConfigSchema.safeParse(input ?? {});
  if (!result.success) {
    const fields = result.error.issues.map((issue) => {
      const path = issue.path.join('.') || '(root)';
      const keys = issue.code === 'unrecognized_keys' ? ` (${issue.keys.join(', ')})` : '';
      return `${path}: ${issue.code}${keys}`;
    });
    throw new ExotelConfigError(`Invalid Exotel configuration: ${fields.join('; ')}`, { details: { fields } });
  }
  return Object.freeze(result.data);
}

/** @param {ExotelConfig} config */
export function resolveBaseUrl(config) {
  const url = config.baseUrl ?? `https://${REGION_HOSTS[config.region]}`;
  return url.replace(/\/+$/, '');
}

/** @param {ExotelConfig} config @returns {string[]} */
export function webhookSecrets(config) {
  if (!config.webhookSecret) return [];
  return Array.isArray(config.webhookSecret) ? [...config.webhookSecret] : [config.webhookSecret];
}
