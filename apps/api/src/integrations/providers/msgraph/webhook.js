import { createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, verify } from 'node:crypto';
import { fromGraphTimestamp } from './normalize.js';

/**
 * Pure helpers for Microsoft Graph change-notification webhooks.
 *
 * Graph does not sign basic change notifications. Its documented authenticity check is the
 * `clientState` value: the subscriber chooses it (max 128 characters) when creating the
 * subscription and Graph echoes it in every change and lifecycle notification. We make that
 * value self-verifying and unguessable:
 *
 *   clientState = "v1." + nonce + "." + base64url(HMAC-SHA256(webhookSecret, "msgraph.clientState.v1." + nonce))
 *
 * so the receiver needs no stored per-subscription state, secrets can rotate, and the check is a
 * constant-time HMAC comparison. Graph defines no timestamp on notifications; instead we reject
 * notifications for subscriptions that expired longer ago than Graph's 4-hour redelivery window.
 *
 * Notifications that include resource data ("rich" notifications) also carry `validationTokens`
 * (JWTs from the Microsoft identity platform); verifyValidationToken checks those against a JWKS
 * that the caller fetches and caches.
 */

export const CLIENT_STATE_MAX_LENGTH = 128;
const CLIENT_STATE_PREFIX = 'v1';
const CLIENT_STATE_CONTEXT = 'msgraph.clientState.v1.';
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
/** Graph retries undelivered notifications for up to 4 hours; allow a little clock skew on top. */
export const DEFAULT_EXPIRED_GRACE_MS = 4 * 60 * 60 * 1000 + 15 * 60 * 1000;
/** App ID of the Microsoft Graph Change Tracking service that issues validation tokens. */
export const GRAPH_CHANGE_TRACKING_APP_ID = '0bf30f3b-4a52-48df-9a82-234910c4a086';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** @param {string} secret @param {string} nonce */
function clientStateMac(secret, nonce) {
  return createHmac('sha256', secret).update(CLIENT_STATE_CONTEXT + nonce).digest();
}

/**
 * Create a clientState for a new subscription.
 * @param {string} secret webhook secret (>= 32 chars)
 * @param {{ nonce?: string }} [options] nonce for deterministic tests; random 16 bytes otherwise
 */
export function createClientState(secret, { nonce = randomBytes(16).toString('base64url') } = {}) {
  if (typeof secret !== 'string' || secret.length < 32) throw new TypeError('webhook secret must be at least 32 characters');
  if (!NONCE_PATTERN.test(nonce)) throw new TypeError('nonce must be 16-64 base64url characters');
  return `${CLIENT_STATE_PREFIX}.${nonce}.${clientStateMac(secret, nonce).toString('base64url')}`;
}

/**
 * Constant-time check of a clientState against the current and previous secrets.
 * @param {unknown} clientState
 * @param {string | string[]} secrets
 */
export function verifyClientState(clientState, secrets) {
  if (typeof clientState !== 'string' || clientState.length > CLIENT_STATE_MAX_LENGTH) return false;
  const parts = clientState.split('.');
  if (parts.length !== 3 || parts[0] !== CLIENT_STATE_PREFIX || !NONCE_PATTERN.test(parts[1])) return false;
  if (!/^[A-Za-z0-9_-]{43}$/.test(parts[2])) return false;
  const given = Buffer.from(parts[2], 'base64url');
  if (given.length !== 32) return false;
  let matched = false;
  for (const secret of [secrets].flat()) {
    if (typeof secret !== 'string' || secret.length < 32) continue;
    // No early exit: every secret is checked so timing doesn't reveal which one matched.
    if (timingSafeEqual(given, clientStateMac(secret, parts[1]))) matched = true;
  }
  return matched;
}

const PLAIN_TEXT_HEADERS = Object.freeze({
  'content-type': 'text/plain; charset=utf-8',
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
});

/**
 * Subscription endpoint validation. Graph POSTs to `{notificationUrl}?validationToken=...` (also to
 * the lifecycle URL) and expects, within 10 seconds, 200 OK, text/plain, and the URL-decoded token.
 * Returns null when the request carries no validationToken (so it is a real notification).
 * @param {URLSearchParams | string | Record<string, unknown>} query parsed query, query string or full URL
 * @returns {{ status: number, headers: Record<string, string>, body: string } | null}
 */
export function validationResponse(query) {
  const token = readValidationToken(query);
  if (token === null) return null;
  // Graph treats the token as opaque and never sends HTML/JS; refuse anything that could be markup.
  if (token.length === 0 || token.length > 8192 || /[\u0000-\u001f\u007f<>]/.test(token)) {
    return { status: 400, headers: { ...PLAIN_TEXT_HEADERS }, body: '' };
  }
  return { status: 200, headers: { ...PLAIN_TEXT_HEADERS }, body: token };
}

/** @param {URLSearchParams | string | Record<string, unknown>} query */
function readValidationToken(query) {
  if (query instanceof URLSearchParams) return query.get('validationToken');
  if (typeof query === 'string') {
    const search = query.includes('?') ? query.slice(query.indexOf('?') + 1) : query.replace(/^\?/, '');
    return new URLSearchParams(search).get('validationToken');
  }
  const value = query?.validationToken;
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : null;
  return typeof value === 'string' ? value : null;
}

/** @param {Record<string, unknown> | Headers | undefined} headers @param {string} name */
function headerValue(headers, name) {
  if (!headers) return undefined;
  if (typeof (/** @type {any} */ (headers).get) === 'function') return /** @type {Headers} */ (headers).get(name) ?? undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return Array.isArray(value) ? String(value[0]) : String(value);
  }
  return undefined;
}

/**
 * @typedef {{
 *   tenantId?: string,
 *   isKnownSubscription?: (subscriptionId: string) => boolean,
 *   now?: number,
 *   expiredGraceMs?: number,
 *   maxBytes?: number,
 *   jwks?: { keys: Array<Record<string, unknown>> },
 *   clientId?: string | string[],
 *   requireValidationTokens?: boolean,
 * }} VerifyOptions
 */

/**
 * Verify a change/lifecycle notification POST from its raw body.
 * Each item must carry a clientState that verifies against `secret` (current or previous), belong
 * to the expected tenant, and not be for a subscription expired beyond the redelivery window.
 * @param {Buffer | Uint8Array | string} rawBody
 * @param {Record<string, unknown> | Headers} headers request headers (content-type is checked)
 * @param {string | string[]} secret webhook secret(s) used to derive clientState
 * @param {VerifyOptions} [options]
 * @returns {{ valid: boolean, reason: string | null, notifications: any[], rejected: Array<{ index: number, reason: string }>, validationTokensChecked: boolean }}
 */
export function verifyWebhook(rawBody, headers, secret, options = {}) {
  const { now = Date.now(), expiredGraceMs = DEFAULT_EXPIRED_GRACE_MS, maxBytes = 4 * 1024 * 1024 } = options;
  const fail = (/** @type {string} */ reason) => ({ valid: false, reason, notifications: [], rejected: [], validationTokensChecked: false });
  const contentType = headerValue(headers, 'content-type');
  if (contentType && !/^application\/json\b/i.test(contentType.trim())) return fail('unsupported_content_type');
  const buffer = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : Buffer.from(rawBody ?? []);
  if (buffer.length === 0) return fail('empty_body');
  if (buffer.length > maxBytes) return fail('body_too_large');
  /** @type {any} */
  let body;
  try {
    body = JSON.parse(buffer.toString('utf8'));
  } catch {
    return fail('invalid_json');
  }
  if (!body || !Array.isArray(body.value) || body.value.length === 0) return fail('no_notifications');

  let validationTokensChecked = false;
  if (body.validationTokens != null || options.requireValidationTokens) {
    const tokenCheck = checkValidationTokens(body.validationTokens, options, now);
    if (!tokenCheck.ok) return fail(tokenCheck.reason);
    validationTokensChecked = tokenCheck.checked;
  }

  const notifications = [];
  const rejected = [];
  for (const [index, item] of body.value.entries()) {
    const reason = rejectReason(item, secret, options, now, expiredGraceMs);
    if (reason) rejected.push({ index, reason });
    else notifications.push(item);
  }
  const valid = rejected.length === 0;
  return { valid, reason: valid ? null : rejected[0].reason, notifications, rejected, validationTokensChecked };
}

/**
 * @param {any} item
 * @param {string | string[]} secret
 * @param {VerifyOptions} options
 * @param {number} now
 * @param {number} graceMs
 */
function rejectReason(item, secret, options, now, graceMs) {
  if (!item || typeof item !== 'object') return 'malformed_notification';
  if (!verifyClientState(item.clientState, secret)) return 'client_state_mismatch';
  if (typeof item.subscriptionId !== 'string' || !GUID.test(item.subscriptionId)) return 'missing_subscription_id';
  if (options.tenantId && String(item.tenantId ?? '').toLowerCase() !== options.tenantId.toLowerCase()) return 'tenant_mismatch';
  if (options.isKnownSubscription && !options.isKnownSubscription(item.subscriptionId)) return 'unknown_subscription';
  if (!item.changeType && !item.lifecycleEvent) return 'malformed_notification';
  const expiresAt = fromGraphTimestamp(item.subscriptionExpirationDateTime);
  if (expiresAt && Date.parse(expiresAt) + graceMs < now) return 'subscription_expired';
  return null;
}

/**
 * @param {unknown} tokens
 * @param {VerifyOptions} options
 * @param {number} now
 * @returns {{ ok: true, checked: boolean } | { ok: false, reason: string }}
 */
function checkValidationTokens(tokens, options, now) {
  if (!Array.isArray(tokens) || tokens.length === 0) {
    return options.requireValidationTokens ? { ok: false, reason: 'missing_validation_tokens' } : { ok: true, checked: false };
  }
  if (!options.jwks || !options.clientId) {
    return options.requireValidationTokens ? { ok: false, reason: 'jwks_not_configured' } : { ok: true, checked: false };
  }
  for (const token of tokens) {
    const result = verifyValidationToken(token, { jwks: options.jwks, clientId: options.clientId, tenantId: options.tenantId, now });
    if (!result.valid) return { ok: false, reason: `validation_token_${result.reason}` };
  }
  return { ok: true, checked: true };
}

/** @param {string} part */
function decodeJsonPart(part) {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Verify one validation token (RS256 JWT) from a rich notification, per Graph's documented rules:
 * signature by a Microsoft identity platform key, not expired, audience = our app ID, and caller
 * (`azp` for v2.0 tokens, `appid` for v1.0) = the Graph Change Tracking app.
 * @param {unknown} token
 * @param {{ jwks: { keys: Array<Record<string, unknown>> }, clientId: string | string[], tenantId?: string, now?: number, clockToleranceSec?: number, issuerHost?: string }} options
 * @returns {{ valid: true, claims: Record<string, any> } | { valid: false, reason: string }}
 */
export function verifyValidationToken(token, options) {
  const { jwks, now = Date.now(), clockToleranceSec = 300, issuerHost = 'https://login.microsoftonline.com' } = options;
  if (typeof token !== 'string') return { valid: false, reason: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 3) return { valid: false, reason: 'malformed' };
  const header = decodeJsonPart(parts[0]);
  const claims = decodeJsonPart(parts[1]);
  if (!header || !claims) return { valid: false, reason: 'malformed' };
  if (header.alg !== 'RS256') return { valid: false, reason: 'unsupported_alg' };
  const jwk = jwks?.keys?.find((k) => k.kid === header.kid && k.kty === 'RSA');
  if (!jwk) return { valid: false, reason: 'unknown_key' };
  let signatureOk = false;
  try {
    const key = createPublicKey({ key: /** @type {any} */ (jwk), format: 'jwk' });
    signatureOk = verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) return { valid: false, reason: 'bad_signature' };
  const nowSec = Math.floor(now / 1000);
  if (typeof claims.exp !== 'number' || claims.exp + clockToleranceSec < nowSec) return { valid: false, reason: 'expired' };
  if (typeof claims.nbf === 'number' && claims.nbf - clockToleranceSec > nowSec) return { valid: false, reason: 'not_yet_valid' };
  const audiences = [options.clientId].flat().map((a) => a.toLowerCase());
  if (!audiences.includes(String(claims.aud ?? '').toLowerCase())) return { valid: false, reason: 'wrong_audience' };
  const tid = String(claims.tid ?? '');
  if (options.tenantId && tid.toLowerCase() !== options.tenantId.toLowerCase()) return { valid: false, reason: 'wrong_tenant' };
  const issuers = claims.ver === '1.0' ? [`https://sts.windows.net/${tid}/`] : [`${issuerHost}/${tid}/v2.0`];
  if (!tid || !issuers.includes(claims.iss)) return { valid: false, reason: 'wrong_issuer' };
  const caller = claims.ver === '1.0' ? claims.appid : claims.azp;
  if (caller !== GRAPH_CHANGE_TRACKING_APP_ID) return { valid: false, reason: 'wrong_publisher' };
  return { valid: true, claims };
}

const LIFECYCLE_TYPES = Object.freeze({
  reauthorizationRequired: 'subscription.reauthorization_required',
  subscriptionRemoved: 'subscription.removed',
  missed: 'subscription.missed',
});

/** @param {string | undefined} resource */
function parseResource(resource) {
  const match = /^\/?users\/([^/]+)\/(?:calendars\/[^/]+\/|calendar\/)?events\/([^/?]+)/i.exec(resource ?? '');
  if (!match) return { mailboxId: null, eventId: null };
  let mailboxId = decodeURIComponent(match[1]).replace(/^'|'$/g, '');
  // Graph may address users as "{userId}@{tenantId}"; keep the user object ID.
  const guidAtGuid = /^([0-9a-f-]{36})@[0-9a-f-]{36}$/i.exec(mailboxId);
  if (guidAtGuid) mailboxId = guidAtGuid[1];
  return { mailboxId, eventId: decodeURIComponent(match[2]).replace(/^\('|'\)$/g, '') };
}

/**
 * Normalise a notification POST (parsed object, raw string or Buffer) into platform events.
 * Call verifyWebhook first; this function does not authenticate anything.
 * @param {unknown} body
 */
export function parseWebhook(body) {
  const parsed = typeof body === 'string' || Buffer.isBuffer(body) ? JSON.parse(body.toString()) : body;
  const items = Array.isArray(/** @type {any} */ (parsed)?.value) ? /** @type {any} */ (parsed).value : [];
  return items.map(normaliseNotification);
}

/** @param {any} item */
function normaliseNotification(item) {
  const isLifecycle = typeof item.lifecycleEvent === 'string';
  const data = item.resourceData ?? {};
  const { mailboxId, eventId } = parseResource(item.resource);
  const changeType = isLifecycle ? null : (item.changeType ?? null);
  const type = isLifecycle
    ? (LIFECYCLE_TYPES[/** @type {keyof typeof LIFECYCLE_TYPES} */ (item.lifecycleEvent)] ?? 'subscription.unknown')
    : /^(created|updated|deleted)$/.test(changeType ?? '')
      ? `calendar.event.${changeType}`
      : 'calendar.event.unknown';
  const resourceId = data.id ?? eventId ?? null;
  const dedupeKey = createHash('sha256')
    .update(
      [
        item.subscriptionId,
        isLifecycle ? item.lifecycleEvent : changeType,
        resourceId ?? item.resource ?? '',
        data['@odata.etag'] ?? '',
        isLifecycle ? (item.subscriptionExpirationDateTime ?? '') : '',
      ].join('|'),
    )
    .digest('hex')
    .slice(0, 32);
  return {
    provider: 'msgraph',
    /** Graph's notification id when present (it is optional); otherwise a derived key. */
    id: typeof item.id === 'string' && item.id ? item.id : `derived:${dedupeKey}`,
    providerEventId: typeof item.id === 'string' && item.id ? item.id : null,
    dedupeKey,
    kind: isLifecycle ? 'lifecycle' : 'change',
    type,
    changeType,
    lifecycleEvent: isLifecycle ? item.lifecycleEvent : null,
    subscriptionId: item.subscriptionId ?? null,
    subscriptionExpiresAt: fromGraphTimestamp(item.subscriptionExpirationDateTime),
    tenantId: item.tenantId ?? null,
    resource: item.resource ?? null,
    resourceType: data['@odata.type'] ?? null,
    resourceId,
    etag: data['@odata.etag'] ?? null,
    mailboxId,
  };
}
