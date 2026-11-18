import { createHash, createPublicKey, timingSafeEqual, verify as cryptoVerify } from 'node:crypto';

/**
 * Blob Storage has no webhooks of its own: blob events reach us through Azure Event Grid
 * (system topic on the storage account -> event subscription -> our HTTPS endpoint).
 *
 * Event Grid does NOT sign payloads (no HMAC, no timestamp header). Its documented ways to
 * authenticate a webhook delivery are:
 *   1. a client secret in a query parameter of the endpoint URL (e.g. ?code=<secret>), or
 *   2. a static delivery-property header marked "secret" (e.g. x-phoenix-webhook-secret), or
 *   3. a Microsoft Entra ID bearer token (Entra-protected webhook), see verifyEntraBearer().
 * verifyWebhook() checks 1 and 2 (and "Authorization: Bearer <shared secret>") in constant time.
 * Because there is no signature, a "tampered" body cannot be detected cryptographically; the
 * secret proves the sender, TLS protects the body in transit.
 *
 * Event Grid defines no timestamp tolerance and retries for up to 24 hours by default, so a
 * freshness window is opt-in (toleranceSeconds) and must be longer than the subscription's
 * event time-to-live if you enable it.
 */

export const WEBHOOK_SECRET_HEADER = 'x-phoenix-webhook-secret';
export const EVENT_GRID_ORIGIN = 'eventgrid.azure.net';
const MIN_SECRET_LENGTH = 16;
const FUTURE_SKEW_MS = 5 * 60 * 1000;

/** @param {Headers | Record<string, string | string[] | undefined> | undefined} headers */
function headerGetter(headers) {
  if (headers && typeof headers.get === 'function') return (name) => headers.get(name) ?? undefined;
  const lower = {};
  for (const [k, v] of Object.entries(headers ?? {})) lower[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
  return (name) => lower[name.toLowerCase()];
}

/** @param {string | URLSearchParams | Record<string, string> | undefined} query */
function queryGetter(query) {
  if (!query) return () => undefined;
  if (query instanceof URLSearchParams) return (name) => query.get(name) ?? undefined;
  if (typeof query === 'string') {
    const raw = query.includes('?') ? query.slice(query.indexOf('?') + 1) : query;
    const params = new URLSearchParams(raw);
    return (name) => params.get(name) ?? undefined;
  }
  return (name) => (typeof query[name] === 'string' ? query[name] : undefined);
}

/** Constant-time equality for strings of any length (hash both sides first). */
export function safeEqual(a, b) {
  const left = createHash('sha256').update(String(a), 'utf8').digest();
  const right = createHash('sha256').update(String(b), 'utf8').digest();
  return timingSafeEqual(left, right);
}

/** @param {Buffer | string | Uint8Array} rawBody */
function parseJsonBody(rawBody) {
  if (rawBody === undefined || rawBody === null) return { ok: false };
  const text = typeof rawBody === 'string' ? rawBody : Buffer.from(rawBody).toString('utf8');
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function eventTimeMs(event) {
  const value = event?.eventTime ?? event?.time;
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Verify an Event Grid delivery to our webhook.
 *
 * @param {Buffer | string | Uint8Array} rawBody the exact bytes received
 * @param {Headers | Record<string, string | string[] | undefined>} headers request headers
 * @param {string | string[]} secret current secret, or [current, previous] while rotating
 * @param {{ query?: string | URLSearchParams | Record<string, string>, headerName?: string, queryParam?: string, toleranceSeconds?: number, now?: () => number }} [options]
 *   query: the request URL or its query string (for the ?code= secret)
 * @returns {{ valid: true, method: 'header' | 'bearer' | 'query' } | { valid: false, reason: string }}
 */
export function verifyWebhook(rawBody, headers, secret, options = {}) {
  const secrets = (Array.isArray(secret) ? secret : [secret]).filter((s) => typeof s === 'string' && s.length >= MIN_SECRET_LENGTH);
  if (secrets.length === 0) return { valid: false, reason: 'secret_not_configured' };

  const header = headerGetter(headers);
  const fromHeader = header(options.headerName ?? WEBHOOK_SECRET_HEADER);
  const bearer = /^Bearer\s+(.+)$/i.exec(header('authorization') ?? '')?.[1]?.trim();
  const fromQuery = queryGetter(options.query)(options.queryParam ?? 'code');
  const presented = [
    ['header', fromHeader],
    ['bearer', bearer],
    ['query', fromQuery],
  ].find(([, value]) => typeof value === 'string' && value.length > 0);
  if (!presented) return { valid: false, reason: 'missing_credential' };

  let matched = false;
  for (const candidate of secrets) matched = safeEqual(presented[1], candidate) || matched;
  if (!matched) return { valid: false, reason: 'bad_credential' };

  const eventType = header('aeg-event-type');
  if (eventType && !['Notification', 'SubscriptionValidation', 'SubscriptionDeletion'].includes(eventType)) {
    return { valid: false, reason: 'unexpected_event_type_header' };
  }
  const body = parseJsonBody(rawBody);
  if (!body.ok || (typeof body.value !== 'object' || body.value === null)) return { valid: false, reason: 'malformed_body' };
  const events = Array.isArray(body.value) ? body.value : [body.value];
  if (events.length === 0 || events.some((e) => typeof e?.id !== 'string' || !e.id)) {
    return { valid: false, reason: 'malformed_body' };
  }

  if (options.toleranceSeconds !== undefined) {
    const nowMs = (options.now ?? Date.now)();
    for (const event of events) {
      const at = eventTimeMs(event);
      if (at === undefined) return { valid: false, reason: 'missing_event_time' };
      if (nowMs - at > options.toleranceSeconds * 1000) return { valid: false, reason: 'expired' };
      if (at - nowMs > FUTURE_SKEW_MS) return { valid: false, reason: 'event_time_in_future' };
    }
  }
  return { valid: true, method: presented[0] };
}

const TYPE_MAP = {
  'Microsoft.Storage.BlobCreated': 'blob.created',
  'Microsoft.Storage.BlobDeleted': 'blob.deleted',
  'Microsoft.Storage.BlobRenamed': 'blob.renamed',
  'Microsoft.Storage.BlobTierChanged': 'blob.tier_changed',
  'Microsoft.Storage.AsyncOperationInitiated': 'blob.async_operation_initiated',
  'Microsoft.Storage.DirectoryCreated': 'directory.created',
  'Microsoft.Storage.DirectoryRenamed': 'directory.renamed',
  'Microsoft.Storage.DirectoryDeleted': 'directory.deleted',
  'Microsoft.Storage.BlobInventoryPolicyCompleted': 'policy.inventory_completed',
  'Microsoft.Storage.LifecyclePolicyCompleted': 'policy.lifecycle_completed',
  'Microsoft.EventGrid.SubscriptionValidationEvent': 'subscription.validation',
  'Microsoft.EventGrid.SubscriptionDeletedEvent': 'subscription.deleted',
};

/** "/blobServices/default/containers/<container>/blobs/<name with slashes>" */
export function parseBlobSubject(subject) {
  const match = /^\/blobServices\/default\/containers\/([^/]+)(?:\/blobs\/(.+))?$/.exec(String(subject ?? ''));
  return match ? { container: match[1], blobName: match[2] ?? null } : { container: null, blobName: null };
}

function accountFromTopic(topic) {
  return /\/storageAccounts\/([^/]+)/i.exec(String(topic ?? ''))?.[1] ?? null;
}

function intOrNull(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Normalise one Event Grid or CloudEvents 1.0 event.
 * @param {Record<string, any>} event
 */
export function normaliseEvent(event) {
  const cloud = typeof event.specversion === 'string';
  const providerType = cloud ? event.type : event.eventType;
  const data = event.data && typeof event.data === 'object' ? event.data : {};
  const at = eventTimeMs(event);
  const { container, blobName } = parseBlobSubject(event.subject);
  return {
    provider: 'azblob',
    id: event.id,
    type: TYPE_MAP[providerType] ?? 'unknown',
    providerType: providerType ?? null,
    schema: cloud ? 'cloudevents' : 'eventgrid',
    occurredAt: at === undefined ? null : new Date(at).toISOString(),
    account: accountFromTopic(cloud ? event.source : event.topic),
    container,
    blobName,
    url: data.url ?? data.destinationUrl ?? null,
    api: data.api ?? null,
    contentType: data.contentType ?? null,
    contentLength: intOrNull(data.contentLength),
    eTag: data.eTag ?? null,
    blobType: data.blobType ?? null,
    accessTier: data.accessTier ?? null,
    previousTier: data.previousTier ?? null,
    sequencer: data.sequencer ?? null,
    requestId: data.requestId ?? null,
    clientRequestId: data.clientRequestId ?? null,
    validationCode: data.validationCode ?? null,
    validationUrl: data.validationUrl ?? null,
    raw: event,
  };
}

/**
 * Parse a delivery body (raw bytes, string, array or single event) into normalised events.
 * The provider's event id is `id`; Event Grid delivers at least once, so dedupe on it.
 * @param {Buffer | string | Uint8Array | object | object[]} body
 */
export function parseWebhook(body) {
  let value = body;
  if (typeof body === 'string' || body instanceof Uint8Array) {
    const parsed = parseJsonBody(body);
    if (!parsed.ok) throw new TypeError('Webhook body is not JSON');
    value = parsed.value;
  }
  const events = Array.isArray(value) ? value : [value];
  return events.filter((e) => e && typeof e === 'object' && typeof e.id === 'string').map(normaliseEvent);
}

/**
 * Event Grid schema handshake: if the delivery is a SubscriptionValidationEvent, the body to
 * return with HTTP 200 within 30 seconds; otherwise null.
 * @param {ReturnType<typeof parseWebhook>} events
 */
export function subscriptionValidationResponse(events) {
  const validation = events.find((e) => e.type === 'subscription.validation' && e.validationCode);
  return validation ? { validationResponse: validation.validationCode } : null;
}

/**
 * CloudEvents 1.0 abuse protection (HTTP OPTIONS preflight from Event Grid).
 * @param {Headers | Record<string, string | string[] | undefined>} headers
 * @param {string[]} [allowedOrigins]
 * @returns {{ allowed: boolean, status: number, headers: Record<string, string> }}
 */
export function abuseProtectionResponse(headers, allowedOrigins = [EVENT_GRID_ORIGIN]) {
  const origin = headerGetter(headers)('webhook-request-origin');
  if (!origin || !allowedOrigins.includes(origin)) return { allowed: false, status: 403, headers: {} };
  return {
    allowed: true,
    status: 200,
    headers: { 'WebHook-Allowed-Origin': origin, 'WebHook-Allowed-Rate': '*', Allow: 'POST, OPTIONS' },
  };
}

function base64UrlJson(segment) {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

/**
 * Verify the Entra ID bearer token on an Entra-protected Event Grid webhook (RS256 JWT).
 * Pure: the caller supplies the tenant's signing keys (JWKS from
 * https://login.microsoftonline.com/<tenant>/discovery/v2.0/keys), cached on its side.
 *
 * @param {string | undefined} authorization the Authorization header value
 * @param {{ jwks: { keys: object[] }, audience: string | string[], issuers: string[], now?: () => number, clockSkewSeconds?: number }} options
 * @returns {{ valid: true, claims: Record<string, unknown> } | { valid: false, reason: string }}
 */
export function verifyEntraBearer(authorization, { jwks, audience, issuers, now = Date.now, clockSkewSeconds = 300 }) {
  const token = /^Bearer\s+([\w-]+\.[\w-]+\.[\w-]+)$/i.exec(String(authorization ?? '').trim())?.[1];
  if (!token) return { valid: false, reason: 'missing_credential' };
  const [h, p, s] = token.split('.');
  let header;
  let claims;
  try {
    header = base64UrlJson(h);
    claims = base64UrlJson(p);
  } catch {
    return { valid: false, reason: 'malformed_token' };
  }
  if (header.alg !== 'RS256') return { valid: false, reason: 'unsupported_alg' };
  const jwk = jwks?.keys?.find((k) => k.kid === header.kid && (k.kty === 'RSA' || !k.kty));
  if (!jwk) return { valid: false, reason: 'unknown_key' };
  let ok = false;
  try {
    const key = createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' });
    ok = cryptoVerify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'));
  } catch {
    ok = false;
  }
  if (!ok) return { valid: false, reason: 'bad_signature' };
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const expected = Array.isArray(audience) ? audience : [audience];
  if (!audiences.some((a) => expected.includes(a))) return { valid: false, reason: 'bad_audience' };
  if (!issuers.includes(claims.iss)) return { valid: false, reason: 'bad_issuer' };
  const nowSeconds = Math.floor(now() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp + clockSkewSeconds < nowSeconds) return { valid: false, reason: 'expired' };
  if (typeof claims.nbf === 'number' && claims.nbf - clockSkewSeconds > nowSeconds) return { valid: false, reason: 'not_yet_valid' };
  return { valid: true, claims };
}
