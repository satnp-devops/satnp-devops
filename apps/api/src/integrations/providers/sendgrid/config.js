import { z } from 'zod';
import { SendgridError } from './errors.js';

/** API hosts documented on the Mail Send reference (global vs EU regional subusers). */
export const SENDGRID_HOSTS = Object.freeze({
  global: 'https://api.sendgrid.com',
  eu: 'https://api.eu.sendgrid.com',
});

const trimmed = (/** @type {unknown} */ value) => (typeof value === 'string' ? value.trim() : value);

const addressSchema = z.object({
  email: z.preprocess(trimmed, z.email().max(254)),
  name: z.preprocess(trimmed, z.string().min(1).max(200)).optional(),
});

/** Header-safe ASCII token used as the custom_args key that carries our message id. */
const argKeySchema = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/, 'Use letters, numbers, _ . - (max 64)');

/**
 * Connection config for one SendGrid account (or subuser). Secrets come only from here.
 *
 * - apiKey: Settings > API Keys in the SendGrid app ("Restricted Access" with Mail Send is enough
 *   for sending; add "Mail Settings"/webhook read access to fetch the signing key via API).
 * - region: 'eu' only for EU regional subusers (Pro plan and above).
 * - eventWebhookPublicKey: Settings > Mail Settings > Event Webhooks > (webhook) > Security
 *   features > Signed Event Webhook "Verification Key" (base64 DER SPKI, or PEM).
 * - inboundParsePublicKey: `signature.public_key` returned when the Inbound Parse webhook
 *   security policy is created (POST /v3/user/webhooks/security/policies).
 */
export const sendgridConfigSchema = z
  .object({
    apiKey: z.string().min(10, 'apiKey is required').max(512),
    region: z.enum(['global', 'eu']).default('global'),
    baseUrl: z.url({ protocol: /^https?$/ }).optional(),
    defaultFrom: addressSchema,
    defaultReplyTo: addressSchema.optional(),
    eventWebhookPublicKey: z.string().min(40).max(4096).optional(),
    inboundParsePublicKey: z.string().min(40).max(4096).optional(),
    webhookToleranceSeconds: z.number().int().positive().max(7 * 86400).nullable().default(null),
    sandboxMode: z.boolean().default(false),
    timeoutMs: z.number().int().min(500).max(120_000).default(10_000),
    maxRetries: z.number().int().min(0).max(5).default(2),
    onBehalfOf: z.string().min(1).max(200).optional(),
    ipPoolName: z.string().min(2).max(64).optional(),
    asmGroupId: z.number().int().positive().optional(),
    messageIdArg: argKeySchema.default('phoenix_message_id'),
    defaultCategories: z.array(z.string().min(1).max(255)).max(10).default([]),
  })
  .strict();

/** @typedef {z.output<typeof sendgridConfigSchema>} SendgridConfig */

/**
 * Validate config; throws a SendgridError('config') listing field paths only (never values).
 * @param {unknown} input
 * @returns {SendgridConfig}
 */
export function parseSendgridConfig(input) {
  const result = sendgridConfigSchema.safeParse(input);
  if (!result.success) {
    const fields = result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
    throw new SendgridError('config', `Invalid SendGrid config: ${fields.join('; ')}`, { retryable: false });
  }
  return result.data;
}

/** @param {SendgridConfig} config */
export function apiBaseUrl(config) {
  return (config.baseUrl ?? SENDGRID_HOSTS[config.region]).replace(/\/+$/, '');
}

/**
 * Config summary safe to show in the UI or logs (no secrets, only whether they are set).
 * @param {SendgridConfig} config
 */
export function describeConfig(config) {
  return {
    region: config.region,
    baseUrl: apiBaseUrl(config),
    defaultFrom: config.defaultFrom,
    apiKey: `set (${config.apiKey.length} chars)`,
    eventWebhookPublicKey: config.eventWebhookPublicKey ? 'set' : 'not set',
    inboundParsePublicKey: config.inboundParsePublicKey ? 'set' : 'not set',
    webhookToleranceSeconds: config.webhookToleranceSeconds,
    sandboxMode: config.sandboxMode,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    onBehalfOf: config.onBehalfOf ?? null,
    messageIdArg: config.messageIdArg,
  };
}
