/**
 * Google Calendar + Google Meet client (no SDK; global fetch + node:crypto).
 *
 *   const google = createGoogleClient(config, { fetch, now, logger });
 *   const busy = await google.calendar.freeBusy({ calendarIds: ['host@school.in'], timeMin, timeMax });
 *   const event = await google.calendar.insertEvent({ summary, start, end, attendees, withMeet: true,
 *     idempotencyKey: `booking:${booking.id}` });
 *   event.meet?.url; // https://meet.google.com/abc-mnop-xyz (status may be "pending": see waitForConference)
 *
 * Webhooks (Calendar push): verifyWebhook(rawBody, headers, secret) then parseWebhook(rawBody, headers),
 * then run calendar.syncEvents({ calendarId, syncToken }) to fetch what changed.
 *
 * See docs/providers/google.md for capabilities, config, limits and verified sources.
 */
import { createTokenProvider } from './auth.js';
import { createCalendarApi } from './calendar.js';
import { parseConfig, secretsOf } from './config.js';
import { GoogleError } from './errors.js';
import { createHttp } from './http.js';
import { createMeetApi } from './meet.js';
import { verifyWebhook as verify } from './webhook.js';

export { configSchema, parseConfig, serviceAccountFromJson, SCOPES, DEFAULT_SCOPES, DEFAULT_ENDPOINTS } from './config.js';
export { GoogleError, FullSyncRequiredError, redact } from './errors.js';
export { verifyWebhook, parseWebhook, createChannelToken, getHeader, calendarIdFromResourceUri, HEADER } from './webhook.js';
export { eventIdFromKey, conferenceRequestIdFromKey, normalizeEvent, extractMeet, meetingCodeFromUrl, unionSeconds } from './normalize.js';
export { signRs256, createServiceAccountAssertion, buildAuthorizationUrl } from './auth.js';
export { conferenceRecordFilter } from './meet.js';

export const PROVIDER = 'google';

/** What this client can do, for the adapter registry (kinds: calendar + meetings). */
export const CAPABILITIES = Object.freeze({
  kinds: ['calendar', 'meetings'],
  calendar: ['freeBusy', 'events.insert', 'events.get', 'events.patch', 'events.delete', 'events.list', 'events.sync', 'events.watch', 'channels.stop'],
  meetings: ['meet.createWithEvent', 'meet.spaces.get', 'meet.conferenceRecords.list', 'meet.participants.list', 'meet.participantSessions.list', 'meet.attendance'],
  webhooks: { verification: 'channel-token-hmac-sha256', bodySigned: false },
  auth: ['service_account', 'service_account+delegation', 'oauth_user'],
});

/**
 * @typedef {object} ClientDeps
 * @property {typeof fetch} [fetch] defaults to globalThis.fetch
 * @property {() => number} [now] epoch ms; defaults to Date.now
 * @property {{ debug?: Function, info?: Function, warn?: Function, error?: Function }} [logger] receives no secrets
 * @property {(ms: number) => Promise<void>} [sleep] for tests
 * @property {() => number} [random] for tests (backoff jitter)
 */

/**
 * @param {import('./config.js').GoogleConfigInput} rawConfig
 * @param {ClientDeps} [deps]
 */
export function createGoogleClient(rawConfig, deps = {}) {
  const config = parseConfig(rawConfig);
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new GoogleError('config_invalid', 'No fetch implementation available');
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const httpDeps = { fetch: fetchImpl, now, logger: deps.logger, sleep, random: deps.random ?? Math.random };

  /** @type {ReturnType<typeof createTokenProvider>|null} */
  let tokens = null;
  const secrets = () => [...secretsOf(config), tokens?.currentToken() ?? ''].filter(Boolean);
  const bare = createHttp({ config, deps: httpDeps, secrets });
  tokens = createTokenProvider({ config, now, postForm: bare.postForm });
  const http = createHttp({ config, deps: httpDeps, secrets, tokens });

  const calendar = createCalendarApi({ config, request: http.request, now, sleep });
  const meet = createMeetApi({ config, request: http.request, now });

  return {
    provider: PROVIDER,
    capabilities: CAPABILITIES,
    /** Config with secrets removed, safe to log or show in an admin UI. */
    describe() {
      const auth =
        config.auth.type === 'service_account'
          ? { type: config.auth.type, clientEmail: config.auth.clientEmail, subject: config.auth.subject ?? null, privateKeyId: config.auth.privateKeyId ?? null }
          : { type: config.auth.type, clientId: config.auth.clientId };
      return {
        provider: PROVIDER,
        auth,
        scopes: config.scopes,
        calendarId: config.calendarId,
        defaultTimeZone: config.defaultTimeZone,
        webhook: config.webhook ? { address: config.webhook.address, ttlSeconds: config.webhook.ttlSeconds } : null,
      };
    },
    /** Fetch (or reuse) an access token; useful as a connection test. */
    getAccessToken: () => tokens.getAccessToken(),
    calendar,
    meet,
    /** Verify a push notification against this client's channel secret(s). */
    verifyWebhook(rawBody, headers, options = {}) {
      if (!config.webhook) return { ok: false, reason: 'no_secret' };
      return verify(rawBody, headers, [config.webhook.channelSecret, ...config.webhook.previousChannelSecrets], { now: now(), ...options });
    },
  };
}

/**
 * Exchange an authorization code (per-user OAuth connect flow) for tokens. Store
 * `refreshToken` encrypted; it is what `auth.refreshToken` expects.
 * @param {{ clientId: string, clientSecret: string, code: string, redirectUri: string, codeVerifier?: string,
 *   tokenUrl?: string }} input
 * @param {{ fetch?: typeof fetch, timeoutMs?: number }} [deps]
 */
export async function exchangeAuthorizationCode(input, deps = {}) {
  const form = new URLSearchParams({
    code: input.code,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    redirect_uri: input.redirectUri,
    grant_type: 'authorization_code',
  });
  if (input.codeVerifier) form.set('code_verifier', input.codeVerifier);
  const json = await oauthPost(input.tokenUrl ?? 'https://oauth2.googleapis.com/token', form, 'token.exchange', [input.clientSecret, input.code], deps);
  return {
    accessToken: json.access_token,
    expiresInSeconds: Number(json.expires_in ?? 0),
    refreshToken: json.refresh_token ?? null,
    refreshTokenExpiresInSeconds: json.refresh_token_expires_in === undefined ? null : Number(json.refresh_token_expires_in),
    scopes: typeof json.scope === 'string' ? json.scope.split(' ') : [],
    tokenType: json.token_type ?? 'Bearer',
  };
}

/**
 * Revoke a refresh or access token (disconnect). Revoking removes every scope granted to the client.
 * @param {{ token: string, revokeUrl?: string }} input
 * @param {{ fetch?: typeof fetch, timeoutMs?: number }} [deps]
 */
export async function revokeToken(input, deps = {}) {
  await oauthPost(input.revokeUrl ?? 'https://oauth2.googleapis.com/revoke', new URLSearchParams({ token: input.token }), 'token.revoke', [input.token], deps);
  return { revoked: true };
}

/** One-shot OAuth form POST (not retried: a code can be used only once). */
async function oauthPost(url, form, operation, secrets, deps) {
  const http = createHttp({
    config: /** @type {any} */ ({ timeoutMs: deps.timeoutMs ?? 15000, maxRetries: 0, backoffBaseMs: 0, maxBackoffMs: 0 }),
    deps: { fetch: deps.fetch ?? globalThis.fetch, now: Date.now, sleep: async () => {}, random: Math.random },
    secrets: () => secrets,
  });
  const json = await http.request({ operation, method: 'POST', url, form, idempotent: false, authenticated: false, tokenEndpoint: true });
  return json ?? {};
}
