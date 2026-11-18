import { z } from 'zod';
import { Msg91ConfigError, redact } from './errors.js';

/**
 * Configuration for one MSG91 connection (one MSG91 account, usually one per company).
 * Secrets (`authKey`, `webhook.secret`) come only from this object: the client never reads env
 * vars, never logs them and scrubs them from every error message.
 */

export const TEMPLATE_CATEGORIES = /** @type {const} */ ([
  'transactional',
  'service_implicit',
  'service_explicit',
  'promotional',
]);

/** Data-type tags a DLT template variable can carry (SmartPing/Tata tag list, msg91.com help). */
export const VARIABLE_TYPES = /** @type {const} */ ([
  'text',
  'numeric',
  'alphanumeric',
  'url',
  'urlott',
  'cbn',
  'email',
]);

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM (24h, IST)');

const variableSchema = z.object({
  /** Exact, case-sensitive name used in the MSG91 template: `##name##` → `name`. */
  name: z.string().regex(/^[A-Za-z0-9_]{1,40}$/, 'variable names are letters, digits and _'),
  type: z.enum(VARIABLE_TYPES).default('text'),
  /** DLT caps a {#var#} value at 40 characters; a lower cap can be set per variable. */
  maxLength: z.number().int().min(1).max(40).optional(),
});

export const templateSchema = z.object({
  /** MSG91 template (flow) id from SMS → Templates, e.g. 669a29fbd6fc053066739b42. */
  templateId: z.string().regex(/^[A-Za-z0-9]{6,40}$/, 'MSG91 template id'),
  /** DLT content template id (19 digits) from the operator DLT portal. */
  dltTemplateId: z.string().regex(/^\d{19}$/, 'DLT template id is 19 digits'),
  category: z.enum(TEMPLATE_CATEGORIES),
  /** Approved 6-character DLT header; falls back to config.senderId. */
  senderId: z.string().optional(),
  /** Template text as saved on MSG91, with ##name## placeholders. Enables rendering and URL checks. */
  body: z.string().min(1).max(2000).optional(),
  /** Template text exactly as approved on DLT, with {#var#} placeholders. Checked against `body`. */
  dltBody: z.string().min(1).max(2000).optional(),
  /** Variable list; derived from `body` placeholders (type text) when omitted. */
  variables: z.array(variableSchema).optional(),
  description: z.string().max(500).optional(),
});

export const msg91ConfigSchema = z.object({
  /** MSG91 → Profile → Authkey. Sent only in the `authkey` header. */
  authKey: z.string().trim().min(8, 'authKey looks too short'),
  baseUrl: z.url().default('https://control.msg91.com'),
  /** Default approved DLT header (sender id) for templates that do not set one. */
  senderId: z.string().optional(),
  /** Country code assumed for 10-digit numbers. */
  defaultCountryCode: z.string().regex(/^\d{1,3}$/).default('91'),
  /** DLT rules only cover Indian numbers; keep false unless the account has international routes. */
  allowInternational: z.boolean().default(false),
  /** Registered templates by local key (e.g. 'admission.counselling_reminder'). */
  templates: z.record(z.string().min(1), templateSchema).default({}),
  otp: z
    .object({
      /** SendOTP template id (OTP section of MSG91; its text must contain ##OTP##). */
      templateId: z.string().regex(/^[A-Za-z0-9]{6,40}$/).optional(),
      length: z.number().int().min(4).max(9).optional(),
      expiryMinutes: z.number().int().min(1).max(10080).optional(),
    })
    .prefault({}),
  dlt: z
    .object({
      /** Turn client-side DLT validation off only for non-Indian traffic. */
      enforce: z.boolean().default(true),
      /** Principal Entity id (19 digits) — informational, MSG91 binds it to the account. */
      principalEntityId: z.string().regex(/^\d{19}$/).optional(),
      /** CTA-whitelisted URLs exactly as on DLT. Entries ending in '?' or '/' match as prefixes. */
      whitelistedUrls: z.array(z.string().min(4)).default([]),
      /** CTA-whitelisted callback numbers (digits; country code optional). */
      whitelistedCallbackNumbers: z.array(z.string().regex(/^\+?\d{6,15}$/)).default([]),
      /** Delivery window for promotional / service-explicit SMS, in IST. */
      promotionalWindow: z.object({ start: hhmm, end: hhmm }).default({ start: '10:00', end: '21:00' }),
      /** Behaviour when a promotional send falls outside the window. */
      outsideWindow: z.enum(['reject', 'schedule']).default('reject'),
      maxVariableLength: z.number().int().min(1).max(40).default(40),
    })
    .prefault({}),
  webhook: z
    .object({
      /** Shared secret MSG91 sends back in a custom header (Webhook (New) → Headers). */
      secret: z.string().min(16, 'webhook secret must be at least 16 characters').optional(),
      headerName: z.string().regex(/^[A-Za-z0-9-]{1,64}$/).default('x-phoenix-webhook-token'),
      /** Query parameter accepted for legacy (v2/v3/v4) webhooks that cannot send headers. */
      queryParam: z.string().regex(/^[A-Za-z0-9_]{1,32}$/).default('token'),
    })
    .prefault({}),
  http: z
    .object({
      timeoutMs: z.number().int().min(500).max(60000).default(10000),
      maxRetries: z.number().int().min(0).max(5).default(2),
      retryBaseDelayMs: z.number().int().min(0).max(10000).default(250),
      retryMaxDelayMs: z.number().int().min(0).max(60000).default(5000),
    })
    .prefault({}),
  /** Recipients per Send SMS request; larger batches must be chunked by the caller. */
  maxRecipientsPerRequest: z.number().int().min(1).max(10000).default(500),
  /** ISO 4217 currency of the MSG91 wallet (Indian accounts are billed in INR). */
  currency: z.string().regex(/^[A-Z]{3}$/).default('INR'),
  /** 'dry_run' validates and logs but never calls MSG91 (MSG91 has no sandbox). */
  mode: z.enum(['live', 'dry_run']).default('live'),
  /** dry_run only: the code verifyOtp() accepts (never used in live mode). */
  dryRunOtp: z.string().regex(/^\d{4,9}$/).optional(),
});

/** @typedef {z.infer<typeof msg91ConfigSchema>} Msg91Config */
/** @typedef {z.infer<typeof templateSchema>} Msg91Template */

/**
 * Validate and normalise a raw config object. Throws Msg91ConfigError listing every problem;
 * values of secrets never appear in the issues.
 * @param {unknown} raw
 * @returns {Msg91Config}
 */
export function parseMsg91Config(raw) {
  const result = msg91ConfigSchema.safeParse(raw);
  if (!result.success) {
    const secrets = collectSecrets(raw);
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: redact(issue.message, secrets),
    }));
    throw new Msg91ConfigError(`Invalid MSG91 config: ${issues.map((i) => `${i.path || '(root)'}: ${i.message}`).join('; ')}`, issues);
  }
  return result.data;
}

/** @param {unknown} raw */
function collectSecrets(raw) {
  if (!raw || typeof raw !== 'object') return [];
  const cfg = /** @type {Record<string, any>} */ (raw);
  return [cfg.authKey, cfg.webhook?.secret].filter((s) => typeof s === 'string');
}
