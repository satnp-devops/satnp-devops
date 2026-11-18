import { z } from 'zod';
import { WaError } from './errors.js';

/**
 * Graph API version used when the connection does not pin one.
 * v26.0 was released 2026-07-29 (https://developers.facebook.com/docs/graph-api/changelog/versions/,
 * read 2026-11-05). Meta's WhatsApp examples already show v27.0; pin it per connection once confirmed.
 */
export const DEFAULT_GRAPH_VERSION = 'v26.0';
export const DEFAULT_BASE_URL = 'https://graph.facebook.com';

/**
 * Hosts the client will send the access token to when downloading media.
 * Media URLs returned by GET /{media-id} are on lookaside.fbsbx.com in practice (not stated in the docs).
 */
export const DEFAULT_MEDIA_HOSTS = Object.freeze(['lookaside.fbsbx.com', 'graph.facebook.com']);

const graphId = z.string().regex(/^\d{1,30}$/, 'must be a numeric Graph API id');

/**
 * Connection config for one WhatsApp business phone number.
 * Secrets: accessToken, appSecret, verifyToken. They live only in this object and are never logged.
 */
export const waConfigSchema = z.object({
  /** System user (or business integration system user) access token with whatsapp_business_messaging (+ _management for templates). */
  accessToken: z.string().min(20, 'looks too short for a Graph access token'),
  /** App secret (App Dashboard > App settings > Basic). Signs webhooks (X-Hub-Signature-256) and appsecret_proof. */
  appSecret: z.string().min(8).optional(),
  /** Previous app secret, accepted for webhook verification while rotating. */
  previousAppSecret: z.string().min(8).optional(),
  /** Verify token typed into App Dashboard > WhatsApp > Configuration > Verify token. */
  verifyToken: z.string().min(8).optional(),
  /** Business phone number id (WhatsApp Manager / App Dashboard > WhatsApp > API Setup). */
  phoneNumberId: graphId,
  /** WhatsApp Business Account id (Meta now also calls it the Messaging account id). Needed for templates. */
  wabaId: graphId.optional(),
  /** Only when the token can message for more than one Messaging account on this number. */
  messagingAccountId: graphId.optional(),
  graphVersion: z.string().regex(/^v\d{1,3}\.\d$/, 'must look like v26.0').default(DEFAULT_GRAPH_VERSION),
  baseUrl: z.url().refine((u) => u.startsWith('https://') || u.startsWith('http://127.0.0.1') || u.startsWith('http://localhost'), 'must be https').default(DEFAULT_BASE_URL),
  /** Send appsecret_proof with every call (required when the app enables "Require app secret"). */
  appSecretProof: z.boolean().default(false),
  timeoutMs: z.number().int().min(100).max(120_000).default(15_000),
  /** Extra attempts after the first one, for calls that are safe to repeat. */
  maxRetries: z.number().int().min(0).max(6).default(2),
  retryBaseMs: z.number().int().min(10).max(60_000).default(500),
  /** Never sleep longer than this between attempts; longer waits are left to the caller's queue. */
  maxRetryDelayMs: z.number().int().min(100).max(120_000).default(10_000),
  mediaHosts: z.array(z.string().min(3)).min(1).default([...DEFAULT_MEDIA_HOSTS]),
  maxMediaBytes: z.number().int().positive().max(100 * 1024 * 1024).default(100 * 1024 * 1024),
  /** Country calling code assumed for numbers without one, e.g. '91' for India. */
  defaultCountryCode: z.string().regex(/^[1-9]\d{0,2}$/).optional(),
  userAgent: z.string().max(200).default('phoenix-crm-whatsapp/1.0'),
});

/** @typedef {z.infer<typeof waConfigSchema>} WaConfig */
/** @typedef {z.input<typeof waConfigSchema>} WaConfigInput */

/**
 * Validate a connection config. Errors name the fields that failed, never their values.
 * @param {unknown} input
 * @returns {Readonly<WaConfig>}
 */
export function parseWaConfig(input) {
  const result = waConfigSchema.safeParse(input);
  if (!result.success) {
    const fields = result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
    const error = new WaError(`Invalid WhatsApp config: ${fields.join('; ')}`, { kind: 'config', retryable: false });
    throw Object.assign(error, { fields: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  }
  return Object.freeze(result.data);
}

/**
 * The parts of a config that are safe to show or log.
 * @param {Readonly<WaConfig>} config
 */
export function describeConfig(config) {
  return {
    provider: 'whatsapp',
    phoneNumberId: config.phoneNumberId,
    wabaId: config.wabaId ?? null,
    graphVersion: config.graphVersion,
    baseUrl: config.baseUrl,
    appSecretProof: config.appSecretProof,
    hasAppSecret: Boolean(config.appSecret),
    hasVerifyToken: Boolean(config.verifyToken),
  };
}
