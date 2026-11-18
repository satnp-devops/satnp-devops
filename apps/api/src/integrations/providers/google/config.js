import { z } from 'zod';
import { GoogleError } from './errors.js';

/** OAuth scope URLs used by this client. All are documented on developers.google.com (see docs/providers/google.md). */
export const SCOPES = Object.freeze({
  calendarEvents: 'https://www.googleapis.com/auth/calendar.events',
  calendarFreeBusy: 'https://www.googleapis.com/auth/calendar.freebusy',
  calendarEventsFreeBusy: 'https://www.googleapis.com/auth/calendar.events.freebusy',
  calendar: 'https://www.googleapis.com/auth/calendar',
  meetReadonly: 'https://www.googleapis.com/auth/meetings.space.readonly',
  meetCreated: 'https://www.googleapis.com/auth/meetings.space.created',
});

/**
 * Default scopes: create/edit events (incl. watch + Meet conference via conferenceData), read
 * free/busy of calendars the principal can see (calendar.events does NOT cover freeBusy), and
 * read Meet conference records for attendance.
 */
export const DEFAULT_SCOPES = Object.freeze([SCOPES.calendarEvents, SCOPES.calendarEventsFreeBusy, SCOPES.meetReadonly]);

export const DEFAULT_ENDPOINTS = Object.freeze({
  tokenUrl: 'https://oauth2.googleapis.com/token',
  revokeUrl: 'https://oauth2.googleapis.com/revoke',
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  calendarBaseUrl: 'https://www.googleapis.com/calendar/v3',
  meetBaseUrl: 'https://meet.googleapis.com/v2',
});

const httpsUrl = z.string().url().refine((u) => u.startsWith('https://'), 'must be an https:// URL');
const email = z.string().trim().email();

const serviceAccountAuth = z.object({
  type: z.literal('service_account'),
  /** `client_email` from the service-account JSON key. */
  clientEmail: email,
  /** `private_key` from the JSON key (PKCS#8 PEM). Literal "\n" sequences are accepted and normalised. */
  privateKey: z
    .string()
    .transform((pem) => pem.replace(/\\n/g, '\n'))
    .refine((pem) => /-----BEGIN (RSA )?PRIVATE KEY-----/.test(pem), 'must be a PEM private key'),
  /** `private_key_id` from the JSON key; sent as the JWT `kid` header when present. */
  privateKeyId: z.string().min(1).optional(),
  /** Workspace user to impersonate (domain-wide delegation). Required for Meet REST API and for inviting attendees. */
  subject: email.optional(),
});

const oauthUserAuth = z.object({
  type: z.literal('oauth_user'),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  refreshToken: z.string().min(1),
});

export const configSchema = z.object({
  auth: z.discriminatedUnion('type', [serviceAccountAuth, oauthUserAuth]),
  scopes: z.array(z.string().url()).min(1).default([...DEFAULT_SCOPES]),
  /** Calendar used when a call does not name one. */
  calendarId: z.string().min(1).default('primary'),
  /** IANA zone stamped on events (display zone; all instants are sent and returned in UTC). */
  defaultTimeZone: z.string().min(1).default('Asia/Kolkata'),
  /** Attribute quota to an end user (quotaUser / x-goog-quota-user), useful with service accounts. */
  quotaUser: z.string().min(1).max(40).optional(),
  webhook: z
    .object({
      /** Public HTTPS URL that receives push notifications. */
      address: httpsUrl,
      /** Secret used to mint and verify per-channel tokens (HMAC-SHA256). At least 32 characters. */
      channelSecret: z.string().min(32),
      /** Older secrets still accepted during rotation. */
      previousChannelSecrets: z.array(z.string().min(32)).default([]),
      /** Requested channel lifetime; Google may shorten it. Default 7 days (Google's default for events). */
      ttlSeconds: z.number().int().positive().max(31 * 24 * 3600).default(604800),
    })
    .optional(),
  timeoutMs: z.number().int().positive().max(120000).default(15000),
  maxRetries: z.number().int().min(0).max(8).default(3),
  /** Base backoff; attempt n waits base * 2^n plus up to 1s jitter, capped at maxBackoffMs. */
  backoffBaseMs: z.number().int().min(0).default(1000),
  maxBackoffMs: z.number().int().min(0).default(32000),
  endpoints: z
    .object({
      tokenUrl: httpsUrl.default(DEFAULT_ENDPOINTS.tokenUrl),
      revokeUrl: httpsUrl.default(DEFAULT_ENDPOINTS.revokeUrl),
      authorizeUrl: httpsUrl.default(DEFAULT_ENDPOINTS.authorizeUrl),
      calendarBaseUrl: httpsUrl.default(DEFAULT_ENDPOINTS.calendarBaseUrl),
      meetBaseUrl: httpsUrl.default(DEFAULT_ENDPOINTS.meetBaseUrl),
    })
    .default({ ...DEFAULT_ENDPOINTS }),
});

/** @typedef {z.infer<typeof configSchema>} GoogleConfig */
/** @typedef {z.input<typeof configSchema>} GoogleConfigInput */

/**
 * Collect every secret value in a config so errors and logs can redact them.
 * @param {GoogleConfig} config
 */
export function secretsOf(config) {
  const out = [];
  if (config.auth.type === 'service_account') out.push(config.auth.privateKey);
  else out.push(config.auth.clientSecret, config.auth.refreshToken);
  if (config.webhook) out.push(config.webhook.channelSecret, ...config.webhook.previousChannelSecrets);
  return out;
}

/**
 * Validate a config object. Issues are reported by path only: values (which may be secrets)
 * never appear in the error.
 * @param {unknown} input
 * @returns {GoogleConfig}
 */
export function parseConfig(input) {
  const result = configSchema.safeParse(input);
  if (result.success) return result.data;
  const fields = result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
  throw new GoogleError('config_invalid', `Google config is invalid: ${fields.map((f) => f.path || '(root)').join(', ')}`, {
    details: fields,
  });
}

/**
 * Build the `auth` block from a downloaded service-account JSON key file.
 * @param {string|Record<string, unknown>} json the key file contents
 * @param {{ subject?: string }} [options]
 */
export function serviceAccountFromJson(json, options = {}) {
  const key = typeof json === 'string' ? JSON.parse(json) : json;
  if (key?.type !== 'service_account') {
    throw new GoogleError('config_invalid', 'Not a service-account key file (type must be "service_account")');
  }
  return {
    type: /** @type {const} */ ('service_account'),
    clientEmail: String(key.client_email ?? ''),
    privateKey: String(key.private_key ?? ''),
    privateKeyId: key.private_key_id ? String(key.private_key_id) : undefined,
    subject: options.subject,
  };
}
