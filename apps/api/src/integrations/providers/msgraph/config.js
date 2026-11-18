import { z } from 'zod';
import { MsgraphError } from './errors.js';

/**
 * Configuration for one Microsoft 365 tenant connection (app-only access).
 * Secrets come only from this object; the client never reads the environment.
 */

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOMAIN = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const MULTI_TENANT_ALIASES = new Set(['common', 'organizations', 'consumers']);

/** @param {string} value */
function isHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

const httpsUrl = z.string().refine(isHttpsUrl, { message: 'Must be an https:// URL without credentials' });

export const msgraphConfigSchema = z.object({
  /** Directory (tenant) ID GUID or a verified domain such as contoso.onmicrosoft.com. */
  tenantId: z
    .string()
    .trim()
    .refine((v) => !MULTI_TENANT_ALIASES.has(v.toLowerCase()), {
      message: 'App-only tokens need a specific tenant, not common/organizations/consumers',
    })
    .refine((v) => GUID.test(v) || DOMAIN.test(v), { message: 'Must be a tenant GUID or domain name' }),
  /** Application (client) ID of the Entra app registration. */
  clientId: z.string().trim().regex(GUID, { message: 'Must be the application (client) ID GUID' }),
  /** Client secret value (not the secret ID). */
  clientSecret: z.string().min(1, { message: 'Required' }),
  /** Key used to derive and verify the per-subscription clientState. At least 32 characters. */
  webhookSecret: z.string().min(32, { message: 'Must be at least 32 characters' }),
  /** Older webhook secrets still accepted while subscriptions created with them expire. */
  previousWebhookSecrets: z.array(z.string().min(32)).max(5).default([]),
  /** Public HTTPS endpoint that receives change notifications. */
  notificationUrl: httpsUrl.optional(),
  /** Public HTTPS endpoint that receives lifecycle notifications (may equal notificationUrl). */
  lifecycleNotificationUrl: httpsUrl.optional(),
  authorityHost: httpsUrl.default('https://login.microsoftonline.com'),
  graphBaseUrl: httpsUrl.default('https://graph.microsoft.com/v1.0'),
  requestTimeoutMs: z.number().int().min(1000).max(120_000).default(15_000),
  maxRetries: z.number().int().min(0).max(10).default(3),
  retryBaseDelayMs: z.number().int().min(0).max(60_000).default(500),
  /** A Retry-After longer than this is not waited out in-process; the error is returned as retryable. */
  maxRetryDelayMs: z.number().int().min(0).max(600_000).default(30_000),
  /** Outlook allows four concurrent requests per app and mailbox. */
  maxConcurrentPerMailbox: z.number().int().min(1).max(4).default(4),
  /** Outlook event subscriptions live at most 10,080 minutes; keep a margin for clock skew. */
  subscriptionLifetimeMinutes: z.number().int().min(45).max(10_080).default(10_000),
  /** Send Prefer: IdType="ImmutableId" so event IDs survive moves between folders. */
  useImmutableIds: z.boolean().default(true),
  /** Refresh the access token this long before it expires. */
  tokenRefreshSkewMs: z.number().int().min(0).max(1_800_000).default(300_000),
});

/** @typedef {z.output<typeof msgraphConfigSchema>} MsgraphConfig */
/** @typedef {z.input<typeof msgraphConfigSchema>} MsgraphConfigInput */

/** Config keys whose values must never appear in logs or errors. */
export const SECRET_KEYS = Object.freeze(['clientSecret', 'webhookSecret', 'previousWebhookSecrets']);

/**
 * Validate config. Throws MsgraphError(kind 'config') listing field paths, never values.
 * @param {unknown} input
 * @returns {MsgraphConfig}
 */
export function parseMsgraphConfig(input) {
  const result = msgraphConfigSchema.safeParse(input);
  if (result.success) return result.data;
  const issues = result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
  return failConfig(issues);
}

/** @param {Array<{ path: string, message: string }>} issues @returns {never} */
function failConfig(issues) {
  throw new MsgraphError(`Invalid Microsoft Graph config: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`, {
    kind: 'config',
    code: 'invalid_config',
    details: { issues },
  });
}

/**
 * Copy of the config that is safe to log or show in an admin screen.
 * @param {Partial<MsgraphConfig>} config
 */
export function redactConfig(config) {
  /** @type {Record<string, unknown>} */
  const out = { ...config };
  for (const key of SECRET_KEYS) {
    if (out[key] === undefined) continue;
    out[key] = Array.isArray(out[key]) ? out[key].map(() => '[REDACTED]') : '[REDACTED]';
  }
  return out;
}

/** @param {MsgraphConfig} config */
export function secretValues(config) {
  return [config.clientSecret, config.webhookSecret, ...config.previousWebhookSecrets];
}
