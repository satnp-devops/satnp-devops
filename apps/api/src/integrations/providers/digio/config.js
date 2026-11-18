import { z } from 'zod';
import { DigioError } from './errors.js';

/**
 * Hosts from documentation.digio.in/digienvironments (checked 2026-11-05).
 * `api` is the REST base URL, `app` serves the signing pages (gateway), `dashboard` is the
 * enterprise dashboard where credentials and webhooks are managed.
 */
export const DIGIO_ENVIRONMENTS = Object.freeze({
  sandbox: Object.freeze({
    api: 'https://ext.digio.in:444',
    app: 'https://ext.digio.in',
    dashboard: 'https://ext-enterprise.digio.in',
    webhookIps: Object.freeze(['35.154.20.28']),
  }),
  production: Object.freeze({
    api: 'https://api.digio.in',
    app: 'https://app.digio.in',
    dashboard: 'https://enterprise.digio.in',
    // The webhook FAQ lists 13.126.198.236; the environments page adds 52.66.66.81.
    webhookIps: Object.freeze(['13.126.198.236', '52.66.66.81']),
  }),
});

const httpsUrl = z.url({ protocol: /^https$/, error: 'Must be an https:// URL' });
const secret = z.string().trim().min(8, 'Too short to be a Digio secret').max(512);

export const digioConfigSchema = z
  .object({
    environment: z.enum(['sandbox', 'production']).default('sandbox'),
    /** Basic-auth username: the client id from the enterprise dashboard (Profile > API credentials). */
    clientId: z.string().trim().min(4).max(256),
    /** Basic-auth password: the client secret issued with the client id. */
    clientSecret: secret,
    /** Secret(s) of the webhook group(s) whose events reach this endpoint; several allow rotation. */
    webhookSecret: z.union([secret, z.array(secret).min(1).max(5)]).optional(),
    /** Overrides for proxies or tests; default from DIGIO_ENVIRONMENTS. */
    apiBaseUrl: httpsUrl.optional(),
    appBaseUrl: httpsUrl.optional(),
    timeoutMs: z.number().int().min(1000).max(120_000).default(30_000),
    maxRetries: z.number().int().min(0).max(5).default(2),
    retryBaseDelayMs: z.number().int().min(0).max(10_000).default(500),
    retryMaxDelayMs: z.number().int().min(0).max(60_000).default(8_000),
    /** Our own upload guard; Digio rejects oversize files with error 1037 but does not publish the limit. */
    maxDocumentBytes: z.number().int().min(1024).max(50 * 1024 * 1024).default(10 * 1024 * 1024),
    defaultExpiryDays: z.number().int().min(1).max(90).default(10),
    /** Let Digio email/SMS signers itself (notify_signers + send_sign_link). Off: the CRM sends links. */
    notifySigners: z.boolean().default(false),
    notificationChannel: z.enum(['SMS', 'WHATSAPP', 'EMAIL', 'ALL']).default('SMS'),
    /** Default redirect after signing and brand logo for generated signing links. */
    redirectUrl: httpsUrl.optional(),
    logoUrl: httpsUrl.optional(),
    /** Retry create calls that carry an idempotency key (Digio's `callback` field dedupes them). */
    retryCreateWithIdempotencyKey: z.boolean().default(true),
  })
  .strict();

/** @typedef {z.infer<typeof digioConfigSchema>} DigioConfig */

/**
 * Validate config. Issues name the field but never echo values, so secrets can't leak.
 * @param {unknown} input
 * @returns {DigioConfig & { hosts: { api: string, app: string, dashboard: string, webhookIps: readonly string[] } }}
 */
export function parseDigioConfig(input) {
  const result = digioConfigSchema.safeParse(input ?? {});
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
    throw new DigioError('config_invalid', `Invalid Digio config: ${issues.map((i) => i.path || '(root)').join(', ')}`, {
      details: issues,
    });
  }
  const config = result.data;
  const env = DIGIO_ENVIRONMENTS[config.environment];
  return Object.freeze({
    ...config,
    hosts: Object.freeze({
      api: stripSlash(config.apiBaseUrl ?? env.api),
      app: stripSlash(config.appBaseUrl ?? env.app),
      dashboard: env.dashboard,
      webhookIps: env.webhookIps,
    }),
  });
}

/** @param {string} url */
function stripSlash(url) {
  return url.replace(/\/+$/, '');
}
