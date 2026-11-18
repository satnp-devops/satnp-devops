import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Google Calendar push notifications (events.watch).
 *
 * Google does not sign notifications. Each one is an HTTPS POST with no body; everything is in
 * X-Goog-* headers, and the only authenticator is the `token` string we chose when creating the
 * channel, echoed back in X-Goog-Channel-Token. So we make that token a MAC:
 *
 *   token = "v1." + exp + "." + base64url(HMAC-SHA256(secret, "v1." + channelId + "." + exp))
 *
 * where exp is the channel's expiry in epoch seconds. Verification recomputes the MAC for the
 * channel ID in the X-Goog-Channel-ID header and compares in constant time, so a token cannot be
 * reused for another channel, and notifications presented after the channel's expiry (plus a
 * tolerance for clock skew) are rejected as replays. Nothing in the (empty) body is trusted.
 */

export const TOKEN_VERSION = 'v1';
export const DEFAULT_TOLERANCE_SECONDS = 300;
/** Google allows channel IDs up to 64 characters; tokens up to 256. */
export const MAX_CHANNEL_ID_LENGTH = 64;
export const MAX_TOKEN_LENGTH = 256;

export const HEADER = Object.freeze({
  channelId: 'x-goog-channel-id',
  channelToken: 'x-goog-channel-token',
  channelExpiration: 'x-goog-channel-expiration',
  resourceId: 'x-goog-resource-id',
  resourceUri: 'x-goog-resource-uri',
  resourceState: 'x-goog-resource-state',
  messageNumber: 'x-goog-message-number',
});

/** Resource states Google documents, mapped to normalised event types. */
export const RESOURCE_STATE_TYPES = Object.freeze({
  sync: 'calendar.channel.sync',
  exists: 'calendar.events.changed',
  not_exists: 'calendar.events.resource_gone',
});

/**
 * Case-insensitive header lookup for a Headers instance, a Node/Express headers object, or a
 * plain record. Multi-valued headers take the first value. Values are trimmed (Google's own
 * example has a double space after the colon).
 * @param {Headers|Record<string, string|string[]|undefined>|undefined|null} headers
 * @param {string} name lower-case header name
 * @returns {string|null}
 */
export function getHeader(headers, name) {
  if (!headers) return null;
  if (typeof (/** @type {any} */ (headers).get) === 'function') {
    const value = /** @type {Headers} */ (headers).get(name);
    return value == null ? null : value.trim();
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    const first = Array.isArray(value) ? value[0] : value;
    return first == null ? null : String(first).trim();
  }
  return null;
}

/** @param {string} secret @param {string} channelId @param {number} exp */
function mac(secret, channelId, exp) {
  return createHmac('sha256', secret).update(`${TOKEN_VERSION}.${channelId}.${exp}`, 'utf8').digest();
}

/**
 * Mint the token to pass as `token` in events.watch.
 * @param {string} secret
 * @param {string} channelId
 * @param {number} expiresAtMs channel expiry, epoch milliseconds
 */
export function createChannelToken(secret, channelId, expiresAtMs) {
  if (!channelId || channelId.length > MAX_CHANNEL_ID_LENGTH) throw new RangeError('channelId must be 1-64 characters');
  const exp = Math.floor(expiresAtMs / 1000);
  return `${TOKEN_VERSION}.${exp}.${mac(secret, channelId, exp).toString('base64url')}`;
}

/**
 * @typedef {{ ok: true, channelId: string, expiresAtMs: number } | { ok: false, reason: 'missing_headers'|'missing_token'|'malformed_token'|'bad_signature'|'expired'|'no_secret' }} VerifyResult
 */

/**
 * Verify a push notification. Pure: no I/O.
 * @param {string|Buffer|null|undefined} rawBody ignored except that it is never trusted (Google sends none)
 * @param {Headers|Record<string, string|string[]|undefined>} headers request headers
 * @param {string|string[]} secret current channel secret, or [current, ...previous] during rotation
 * @param {{ now?: number, toleranceSeconds?: number }} [options] now = epoch ms
 * @returns {VerifyResult}
 */
export function verifyWebhook(rawBody, headers, secret, options = {}) {
  void rawBody;
  const secrets = (Array.isArray(secret) ? secret : [secret]).filter((s) => typeof s === 'string' && s.length > 0);
  if (secrets.length === 0) return { ok: false, reason: 'no_secret' };

  const channelId = getHeader(headers, HEADER.channelId);
  const state = getHeader(headers, HEADER.resourceState);
  const resourceId = getHeader(headers, HEADER.resourceId);
  const messageNumber = getHeader(headers, HEADER.messageNumber);
  if (!channelId || !state || !resourceId || !messageNumber) return { ok: false, reason: 'missing_headers' };

  const token = getHeader(headers, HEADER.channelToken);
  if (!token) return { ok: false, reason: 'missing_token' };
  if (token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: 'malformed_token' };
  const match = /^v1\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) return { ok: false, reason: 'malformed_token' };
  const exp = Number(match[1]);
  const provided = Buffer.from(match[2], 'base64url');
  // Reject non-canonical base64url (the last character carries 2 unused bits) so a token has one spelling.
  if (provided.length !== 32 || provided.toString('base64url') !== match[2]) return { ok: false, reason: 'malformed_token' };

  // Compare against every accepted secret without short-circuiting, so timing does not reveal which one matched.
  let valid = false;
  for (const s of secrets) valid = timingSafeEqual(provided, mac(s, channelId, exp)) || valid;
  if (!valid) return { ok: false, reason: 'bad_signature' };

  const now = options.now ?? Date.now();
  const tolerance = (options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS) * 1000;
  if (now > exp * 1000 + tolerance) return { ok: false, reason: 'expired' };
  return { ok: true, channelId, expiresAtMs: exp * 1000 };
}

/**
 * Calendar ID from a watched resource URI such as
 * https://www.googleapis.com/calendar/v3/calendars/my_calendar%40gmail.com/events?alt=json
 * @param {string|null} uri
 */
export function calendarIdFromResourceUri(uri) {
  if (!uri) return null;
  const match = /\/calendars\/([^/?#]+)\/events(?:[/?#]|$)/.exec(uri);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/** @param {string|null} value RFC 1123 date as Google sends it */
function toUtcIso(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * @typedef {object} CalendarPushEvent
 * @property {'google'} provider
 * @property {string} id provider event id: `${channelId}:${messageNumber}` (unique per channel; use for dedup)
 * @property {'calendar.channel.sync'|'calendar.events.changed'|'calendar.events.resource_gone'|'calendar.unknown'} type
 * @property {string} channelId
 * @property {string} resourceId
 * @property {string|null} resourceUri
 * @property {string} resourceState raw X-Goog-Resource-State
 * @property {number} messageNumber
 * @property {string|null} calendarId parsed from resourceUri
 * @property {string|null} channelExpiresAt UTC ISO
 * @property {boolean} requiresSync true when the receiver should run an incremental events sync
 */

/**
 * Normalise a push notification. Call verifyWebhook first. Google sends no body, so the
 * events come from headers; the body argument exists for interface symmetry.
 * @param {string|Buffer|null|undefined} rawBody
 * @param {Headers|Record<string, string|string[]|undefined>} headers
 * @returns {CalendarPushEvent[]} one event, or [] if required headers are missing
 */
export function parseWebhook(rawBody, headers) {
  void rawBody;
  const channelId = getHeader(headers, HEADER.channelId);
  const resourceId = getHeader(headers, HEADER.resourceId);
  const resourceState = getHeader(headers, HEADER.resourceState);
  const messageNumberText = getHeader(headers, HEADER.messageNumber);
  if (!channelId || !resourceId || !resourceState || !messageNumberText || !/^\d+$/.test(messageNumberText)) return [];
  const resourceUri = getHeader(headers, HEADER.resourceUri);
  const type = RESOURCE_STATE_TYPES[/** @type {keyof typeof RESOURCE_STATE_TYPES} */ (resourceState)] ?? 'calendar.unknown';
  return [
    {
      provider: 'google',
      id: `${channelId}:${messageNumberText}`,
      type,
      channelId,
      resourceId,
      resourceUri,
      resourceState,
      messageNumber: Number(messageNumberText),
      calendarId: calendarIdFromResourceUri(resourceUri),
      channelExpiresAt: toUtcIso(getHeader(headers, HEADER.channelExpiration)),
      requiresSync: resourceState === 'exists' || resourceState === 'not_exists',
    },
  ];
}
