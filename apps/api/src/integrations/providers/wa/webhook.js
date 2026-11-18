import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { WaError, normalizeWebhookError } from './errors.js';

/**
 * Webhook helpers. All pure: no I/O, no clock unless you pass `now`.
 *
 * Verification scheme (webhooks/create-webhook-endpoint, read 2026-11-05):
 * - GET  ?hub.mode=subscribe&hub.verify_token=...&hub.challenge=... -> reply 200 with the challenge.
 * - POST header `X-Hub-Signature-256: sha256=<hex HMAC-SHA256(raw body, app secret)>`.
 * Meta defines no timestamp tolerance and retries failed deliveries for up to 7 days, so replay
 * protection is deduplication on `eventId`; `maxAgeSeconds` is an opt-in extra check.
 */

/**
 * @param {Headers | Record<string, string | string[] | undefined> | null | undefined} headers
 * @param {string} name lowercase header name
 * @returns {string | null}
 */
export function getHeader(headers, name) {
  if (!headers) return null;
  if (typeof /** @type {any} */ (headers).get === 'function') return /** @type {Headers} */ (headers).get(name);
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
  }
  return null;
}

/**
 * @param {Buffer | Uint8Array | ArrayBuffer | string} rawBody
 * @returns {Buffer}
 */
function toBuffer(rawBody) {
  if (Buffer.isBuffer(rawBody)) return rawBody;
  if (rawBody instanceof Uint8Array) return Buffer.from(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength);
  if (rawBody instanceof ArrayBuffer) return Buffer.from(rawBody);
  if (typeof rawBody === 'string') return Buffer.from(rawBody, 'utf8');
  throw new WaError('Webhook body must be the raw request bytes', { kind: 'invalid_payload', retryable: false });
}

/**
 * Compute the X-Hub-Signature-256 value Meta would send for a body (for tests and local simulators).
 * @param {Buffer | Uint8Array | string} rawBody
 * @param {string} appSecret
 */
export function signWebhook(rawBody, appSecret) {
  return `sha256=${createHmac('sha256', appSecret).update(toBuffer(rawBody)).digest('hex')}`;
}

/**
 * @typedef {{ ok: true, secretIndex: number } | { ok: false, reason: 'missing_secret' | 'missing_signature' | 'malformed_signature' | 'bad_signature' | 'stale' | 'invalid_json' }} VerifyResult
 */

/**
 * Verify a webhook POST. Pass the exact bytes received (express.raw / req.rawBody), never a
 * re-serialised JSON object: Meta signs the raw payload, including its \u escapes.
 *
 * @param {Buffer | Uint8Array | ArrayBuffer | string} rawBody
 * @param {Headers | Record<string, string | string[] | undefined>} headers
 * @param {string | ReadonlyArray<string | undefined | null>} secret app secret, or [current, previous] while rotating
 * @param {{ maxAgeSeconds?: number, now?: () => number }} [options] opt-in staleness check (Meta defines none)
 * @returns {VerifyResult}
 */
export function verifyWebhook(rawBody, headers, secret, options = {}) {
  const secrets = (Array.isArray(secret) ? secret : [secret]).filter((s) => typeof s === 'string' && s.length > 0);
  if (!secrets.length) return { ok: false, reason: 'missing_secret' };
  const header = getHeader(headers, 'x-hub-signature-256');
  if (!header) return { ok: false, reason: 'missing_signature' };
  const match = /^sha256=([0-9a-fA-F]{64})$/.exec(header.trim());
  if (!match) return { ok: false, reason: 'malformed_signature' };
  const provided = Buffer.from(match[1], 'hex');
  const body = toBuffer(rawBody);
  let secretIndex = -1;
  secrets.forEach((s, index) => {
    // Check every secret so timing does not reveal which one matched.
    const expected = createHmac('sha256', /** @type {string} */ (s)).update(body).digest();
    if (timingSafeEqual(expected, provided) && secretIndex === -1) secretIndex = index;
  });
  if (secretIndex === -1) return { ok: false, reason: 'bad_signature' };
  if (options.maxAgeSeconds !== undefined) {
    let parsed;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      return { ok: false, reason: 'invalid_json' };
    }
    const newest = newestTimestamp(parsed);
    const nowSeconds = Math.floor((options.now ?? Date.now)() / 1000);
    if (newest !== null && nowSeconds - newest > options.maxAgeSeconds) return { ok: false, reason: 'stale' };
  }
  return { ok: true, secretIndex };
}

/**
 * Newest Unix timestamp (seconds) mentioned in a payload: entry.time, messages[].timestamp, statuses[].timestamp.
 * @param {any} payload
 * @returns {number | null}
 */
export function newestTimestamp(payload) {
  let newest = null;
  const consider = (value) => {
    const n = Number(value);
    if (value !== undefined && value !== null && Number.isFinite(n) && n > 0) newest = newest === null ? n : Math.max(newest, n);
  };
  for (const entry of asArray(payload?.entry)) {
    consider(entry?.time);
    for (const change of asArray(entry?.changes)) {
      for (const m of asArray(change?.value?.messages)) consider(m?.timestamp);
      for (const s of asArray(change?.value?.statuses)) consider(s?.timestamp);
    }
  }
  return newest;
}

/**
 * Answer Meta's GET subscription check. Respond 200 text/plain with `challenge` when ok, else 403.
 * @param {Record<string, unknown> | URLSearchParams} query parsed query string (keys 'hub.mode', ...)
 * @param {string | undefined} verifyToken
 * @returns {{ ok: true, challenge: string } | { ok: false, reason: 'missing_verify_token' | 'bad_mode' | 'bad_token' | 'bad_challenge' }}
 */
export function verifySubscription(query, verifyToken) {
  if (!verifyToken) return { ok: false, reason: 'missing_verify_token' };
  const read = (key) => {
    const value = query instanceof URLSearchParams ? query.get(key) : query?.[key] ?? nested(query, key);
    return typeof value === 'string' ? value : Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;
  };
  if (read('hub.mode') !== 'subscribe') return { ok: false, reason: 'bad_mode' };
  const token = read('hub.verify_token') ?? '';
  // Hash both sides so the comparison is constant-time regardless of length.
  const a = createHash('sha256').update(token).digest();
  const b = createHash('sha256').update(verifyToken).digest();
  if (!timingSafeEqual(a, b)) return { ok: false, reason: 'bad_token' };
  const challenge = read('hub.challenge');
  // Echo only a plain token: the challenge is reflected into our response body.
  if (!challenge || !/^[\x21-\x7e]{1,1024}$/.test(challenge) || /[<>"'&]/.test(challenge)) return { ok: false, reason: 'bad_challenge' };
  return { ok: true, challenge };
}

/** Some query parsers turn `hub.mode` into `{ hub: { mode } }`. */
function nested(query, key) {
  const [head, tail] = key.split('.');
  const inner = /** @type {any} */ (query)?.[head];
  return inner && typeof inner === 'object' ? inner[tail] : undefined;
}

/** @param {unknown} value */
function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/** @param {unknown} seconds Unix seconds (string or number) -> ISO 8601 UTC, or null */
export function toIso(seconds) {
  const n = Number(seconds);
  if (seconds === undefined || seconds === null || seconds === '' || !Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString();
}

/** @param {unknown} waId digits as sent by Meta -> +E.164, or null */
function phoneFromWaId(waId) {
  return typeof waId === 'string' && /^\d{6,15}$/.test(waId) ? `+${waId}` : null;
}

/** Stable id for events Meta gives no id to: identical retried payloads hash to the same id. */
function hashId(prefix, ...parts) {
  return `${prefix}:${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32)}`;
}

/** @param {any} value */
function str(value) {
  return typeof value === 'string' && value.length ? value : null;
}

/**
 * @typedef {object} WaEventBase
 * @property {'whatsapp'} provider
 * @property {string} eventId        stable across Meta's retries; dedupe on (provider, eventId)
 * @property {string | null} occurredAt ISO 8601 UTC
 * @property {string | null} wabaId
 * @property {string | null} phoneNumberId
 * @property {string | null} displayPhoneNumber
 * @property {string} field          webhook field, e.g. 'messages'
 */

/**
 * Normalise a webhook payload into a flat list of events.
 * Kinds: 'message.received', 'message.status', 'template.status', 'error', 'other'.
 * Never throws for unexpected shapes (unknown parts become 'other' events); throws only when
 * the input is not JSON at all.
 *
 * @param {unknown} body parsed JSON, or the raw body (string / Buffer)
 * @returns {Array<WaEventBase & Record<string, any>>}
 */
export function parseWebhook(body) {
  let payload = body;
  if (typeof body === 'string' || Buffer.isBuffer(body) || body instanceof Uint8Array) {
    try {
      payload = JSON.parse(toBuffer(/** @type {any} */ (body)).toString('utf8'));
    } catch (cause) {
      throw new WaError('Webhook body is not valid JSON', { kind: 'invalid_payload', retryable: false, cause });
    }
  }
  if (!payload || typeof payload !== 'object') {
    throw new WaError('Webhook body must be a JSON object', { kind: 'invalid_payload', retryable: false });
  }
  const p = /** @type {Record<string, any>} */ (payload);
  const events = [];
  for (const entry of asArray(p.entry)) {
    for (const change of asArray(entry?.changes)) {
      const field = str(change?.field) ?? 'unknown';
      const value = change?.value && typeof change.value === 'object' ? change.value : {};
      const base = {
        provider: /** @type {const} */ ('whatsapp'),
        field,
        wabaId: str(entry?.id),
        phoneNumberId: str(value.metadata?.phone_number_id),
        displayPhoneNumber: str(value.metadata?.display_phone_number),
      };
      if (p.object === 'whatsapp_business_account' && field === 'messages') {
        events.push(...parseMessagesChange(value, base, entry));
      } else if (p.object === 'whatsapp_business_account' && field === 'message_template_status_update') {
        events.push(parseTemplateStatus(value, base, entry));
      } else {
        events.push({
          ...base,
          kind: 'other',
          eventId: hashId(`other:${field}`, p.object, entry?.id, entry?.time, value),
          occurredAt: toIso(entry?.time),
          object: str(p.object),
          value,
        });
      }
    }
  }
  return events;
}

/**
 * @param {Record<string, any>} value
 * @param {Record<string, any>} base
 * @param {Record<string, any>} entry
 */
function parseMessagesChange(value, base, entry) {
  const events = [];
  const contacts = asArray(value.contacts);
  const contactFor = (waId, userId) =>
    contacts.find((c) => (waId && c?.wa_id === waId) || (userId && c?.user_id === userId)) ?? (contacts.length === 1 ? contacts[0] : null);

  for (const m of asArray(value.messages)) {
    if (!m || typeof m !== 'object') continue;
    const contact = contactFor(str(m.from), str(m.from_user_id));
    events.push({ ...base, ...normalizeInbound(m, contact) });
  }
  for (const s of asArray(value.statuses)) {
    if (!s || typeof s !== 'object') continue;
    events.push({ ...base, ...normalizeStatus(s) });
  }
  const errors = asArray(value.errors);
  if (errors.length) {
    events.push({
      ...base,
      kind: 'error',
      eventId: hashId('error', entry?.id, entry?.time, errors),
      occurredAt: toIso(entry?.time),
      errors: errors.map(normalizeWebhookError),
    });
  }
  return events;
}

/**
 * @param {Record<string, any>} m one item of value.messages
 * @param {Record<string, any> | null} contact matching item of value.contacts
 */
export function normalizeInbound(m, contact) {
  const type = str(m.type) ?? 'unknown';
  const id = str(m.id);
  const waId = str(m.from) ?? str(contact?.wa_id);
  const event = {
    kind: 'message.received',
    eventId: id ?? hashId('message', m),
    messageId: id,
    occurredAt: toIso(m.timestamp),
    from: {
      phone: phoneFromWaId(waId),
      waId,
      userId: str(m.from_user_id) ?? str(contact?.user_id),
      name: str(contact?.profile?.name),
      username: str(contact?.profile?.username),
    },
    type,
    text: null,
    media: null,
    reply: null,
    location: null,
    reaction: null,
    contacts: null,
    context: null,
    referral: null,
    errors: asArray(m.errors).map(normalizeWebhookError),
    raw: m,
  };

  if (type === 'text') event.text = str(m.text?.body);
  if (['image', 'video', 'audio', 'document', 'sticker'].includes(type)) {
    const media = m[type] ?? {};
    event.media = {
      kind: type,
      id: str(media.id),
      mimeType: str(media.mime_type),
      sha256: str(media.sha256),
      caption: str(media.caption),
      filename: str(media.filename),
      voice: media.voice === true,
      animated: media.animated === true,
    };
    event.text = str(media.caption);
  }
  if (type === 'button') {
    event.reply = { kind: 'button', id: str(m.button?.payload), title: str(m.button?.text), description: null };
    event.text = str(m.button?.text);
  }
  if (type === 'interactive') {
    const it = m.interactive ?? {};
    const kind = str(it.type);
    const r = kind ? it[kind] ?? {} : {};
    event.reply = {
      kind,
      id: str(r.id),
      title: str(r.title) ?? str(r.name),
      description: str(r.description),
      ...(kind === 'nfm_reply' ? { responseJson: str(r.response_json) } : {}),
    };
    event.text = str(r.title);
  }
  if (type === 'location' && m.location) {
    const l = m.location;
    event.location = {
      latitude: Number(l.latitude),
      longitude: Number(l.longitude),
      name: str(l.name),
      address: str(l.address),
      url: str(l.url),
    };
  }
  if (type === 'reaction') {
    event.reaction = { messageId: str(m.reaction?.message_id), emoji: str(m.reaction?.emoji) };
  }
  if (type === 'contacts') event.contacts = asArray(m.contacts);
  if (m.context && typeof m.context === 'object') {
    event.context = {
      messageId: str(m.context.id),
      from: str(m.context.from),
      forwarded: m.context.forwarded === true,
      frequentlyForwarded: m.context.frequently_forwarded === true,
      referredProduct: m.context.referred_product
        ? { catalogId: str(m.context.referred_product.catalog_id), productRetailerId: str(m.context.referred_product.product_retailer_id) }
        : null,
    };
  }
  if (m.referral && typeof m.referral === 'object') {
    const r = m.referral;
    event.referral = {
      sourceType: str(r.source_type),
      sourceId: str(r.source_id),
      sourceUrl: str(r.source_url),
      headline: str(r.headline),
      body: str(r.body),
      mediaType: str(r.media_type),
      ctwaClid: str(r.ctwa_clid),
    };
  }
  return event;
}

/** @param {Record<string, any>} s one item of value.statuses */
export function normalizeStatus(s) {
  const id = str(s.id);
  const status = str(s.status) ?? 'unknown';
  const isGroup = s.recipient_type === 'group';
  const waId = isGroup ? str(s.recipient_participant_id) : str(s.recipient_id);
  return {
    kind: 'message.status',
    eventId: id ? `${id}:${status}` : hashId('status', s),
    messageId: id,
    status,
    occurredAt: toIso(s.timestamp),
    recipient: {
      phone: phoneFromWaId(waId),
      waId,
      userId: str(s.recipient_user_id),
      groupId: isGroup ? str(s.recipient_id) : null,
    },
    callbackData: str(s.biz_opaque_callback_data),
    pricing: s.pricing && typeof s.pricing === 'object'
      ? {
          billable: typeof s.pricing.billable === 'boolean' ? s.pricing.billable : null,
          model: str(s.pricing.pricing_model),
          type: str(s.pricing.type),
          category: str(s.pricing.category),
        }
      : null,
    conversation: s.conversation && typeof s.conversation === 'object'
      ? { id: str(s.conversation.id), originType: str(s.conversation.origin?.type), expiresAt: toIso(s.conversation.expiration_timestamp) }
      : null,
    errors: asArray(s.errors).map(normalizeWebhookError),
    raw: s,
  };
}

/**
 * @param {Record<string, any>} value
 * @param {Record<string, any>} base
 * @param {Record<string, any>} entry
 */
function parseTemplateStatus(value, base, entry) {
  const templateId = value.message_template_id === undefined || value.message_template_id === null ? null : String(value.message_template_id);
  const status = str(value.event) ?? 'UNKNOWN';
  return {
    ...base,
    kind: 'template.status',
    eventId: templateId ? `template:${templateId}:${status}:${entry?.time ?? ''}` : hashId('template', entry?.time, value),
    occurredAt: toIso(entry?.time),
    templateId,
    name: str(value.message_template_name),
    language: str(value.message_template_language),
    status,
    reason: str(value.reason),
    category: str(value.message_template_category),
    rejection: value.rejection_info
      ? { reason: str(value.rejection_info.reason), recommendation: str(value.rejection_info.recommendation) }
      : null,
    disabledAt: toIso(value.disable_info?.disable_date),
    raw: value,
  };
}
