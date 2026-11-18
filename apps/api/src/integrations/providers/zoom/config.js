import { z } from 'zod';
import { ZoomConfigError } from './errors.js';

/**
 * Connection config for one Zoom Server-to-Server OAuth app.
 * Where each value comes from: docs/providers/zoom.md#config-fields.
 *
 * Secrets (clientSecret, webhookSecretToken) only ever come from here: never from env
 * lookups inside this module, never logged, never echoed in validation errors.
 */
const httpsUrl = z
  .url()
  .refine((value) => value.startsWith('https://'), { message: 'must be an https URL' });

export const zoomConfigSchema = z.object({
  /** Zoom account ID shown on the S2S app's "App credentials" page. */
  accountId: z.string().trim().min(1).max(200),
  clientId: z.string().trim().min(1).max(200),
  clientSecret: z.string().min(1).max(500),
  /** "Secret Token" from the app's Features > Access page; needed for webhooks only. */
  webhookSecretToken: z.string().min(1).max(500).optional(),
  /** Global by default; https://api-in.zoom.us/v2 etc. pins a region. No trailing slash. */
  apiBaseUrl: httpsUrl.default('https://api.zoom.us/v2'),
  oauthTokenUrl: httpsUrl.default('https://zoom.us/oauth/token'),
  /** Use the `api_url` returned with the token (regional cluster) instead of apiBaseUrl. */
  useTokenApiUrl: z.boolean().default(false),
  /** Host for createMeeting when the call does not name one: user ID, email, or 'me'. */
  defaultHostUserId: z.string().trim().min(1).max(320).default('me'),
  /** IANA zone Zoom uses to display start times in invites (start_time itself is always sent in UTC). */
  defaultTimezone: z.string().trim().min(1).max(64).default('Asia/Kolkata'),
  timeoutMs: z.number().int().min(500).max(120_000).default(10_000),
  maxRetries: z.number().int().min(0).max(6).default(2),
  retryBaseDelayMs: z.number().int().min(0).max(60_000).default(500),
  /** A Retry-After longer than this is not waited for: the error is thrown (retryable) instead. */
  maxRetryDelayMs: z.number().int().min(0).max(300_000).default(15_000),
  /** Refresh the cached token this many seconds before it expires. */
  tokenRefreshSkewSeconds: z.number().int().min(0).max(1800).default(60),
  /** Reject webhooks whose x-zm-request-timestamp is further than this from now. 0 disables. */
  webhookToleranceSeconds: z.number().int().min(0).max(86_400).default(300),
  /** Zoom `settings` merged over the built-in demo defaults for every created meeting. */
  meetingSettings: z.record(z.string(), z.unknown()).default({}),
});

/** @typedef {z.infer<typeof zoomConfigSchema>} ZoomConfig */

/**
 * Validate and apply defaults. Throws ZoomConfigError naming the bad fields (never their values).
 * @param {unknown} input
 * @returns {ZoomConfig}
 */
export function parseZoomConfig(input) {
  const result = zoomConfigSchema.safeParse(input ?? {});
  if (!result.success) {
    const fields = result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
    throw new ZoomConfigError(`Invalid Zoom config: ${fields.join('; ')}`, {
      details: result.error.issues.map((issue) => ({ path: issue.path.join('.'), code: issue.code })),
    });
  }
  const config = result.data;
  return { ...config, apiBaseUrl: config.apiBaseUrl.replace(/\/+$/, '') };
}
