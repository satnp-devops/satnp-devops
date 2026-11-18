import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { ZoomWebhookError } from './errors.js';
import { normalizeParticipantRow } from './participants.js';
import { toUtcIso } from './meetings.js';

/**
 * Zoom webhooks (pure functions; no I/O).
 *
 * Signature (docs "Verify webhook events", sample github.com/zoom/webhook-sample):
 *   message   = "v0:" + <x-zm-request-timestamp> + ":" + <raw request body>
 *   signature = "v0=" + hex(HMAC-SHA256(webhookSecretToken, message))   -> header x-zm-signature
 * We hash the raw bytes as received (Zoom's sample re-serialises parsed JSON, which only
 * matches when the body round-trips byte for byte), compare in constant time, and reject
 * timestamps outside a tolerance window. Zoom documents no tolerance; ours defaults to 300 s.
 *
 * URL validation (CRC): event "endpoint.url_validation" with payload.plainToken; answer 200
 * within 3 s with { plainToken, encryptedToken: hex(HMAC-SHA256(secret, plainToken)) }.
 * We only answer after the signature check passes: answering unsigned challenges would turn
 * the endpoint into an HMAC oracle (plainToken = "v0:<ts>:<forged body>" yields a valid signature).
 */

export const SIGNATURE_HEADER = 'x-zm-signature';
export const TIMESTAMP_HEADER = 'x-zm-request-timestamp';
export const REQUEST_ID_HEADER = 'x-zm-request-id';
export const URL_VALIDATION_EVENT = 'endpoint.url_validation';
export const DEFAULT_TOLERANCE_SECONDS = 300;

/**
 * Case-insensitive header lookup for a fetch Headers object, a Node/Express headers object,
 * or a plain record. Array values (repeated headers) yield the first entry.
 * @param {Headers|Record<string, string|string[]|undefined>|undefined|null} headers
 * @param {string} name
 * @returns {string|null}
 */
export function getHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    const first = Array.isArray(value) ? value[0] : value;
    return first === undefined || first === null ? null : String(first);
  }
  return null;
}

function toBuffer(rawBody) {
  if (Buffer.isBuffer(rawBody)) return rawBody;
  if (rawBody instanceof Uint8Array) return Buffer.from(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength);
  if (typeof rawBody === 'string') return Buffer.from(rawBody, 'utf8');
  return null;
}

function hmac(secret, data) {
  return createHmac('sha256', secret).update(data).digest();
}

/**
 * The x-zm-signature value Zoom would send for this body and timestamp.
 * @param {string|Buffer|Uint8Array} rawBody
 * @param {string|number} timestamp  seconds, exactly as sent in x-zm-request-timestamp
 * @param {string} secret
 */
export function computeSignature(rawBody, timestamp, secret) {
  const body = toBuffer(rawBody);
  if (!body) throw new TypeError('rawBody must be a string or Buffer');
  const message = Buffer.concat([Buffer.from(`v0:${timestamp}:`, 'utf8'), body]);
  return `v0=${hmac(secret, message).toString('hex')}`;
}

/**
 * @typedef {{ valid: true, timestamp: number, secretIndex: number } | { valid: false, reason: 'missing_secret'|'invalid_body'|'missing_signature'|'missing_timestamp'|'malformed_signature'|'malformed_timestamp'|'timestamp_out_of_tolerance'|'signature_mismatch' }} VerifyResult
 */

/**
 * Verify a Zoom webhook request. Never throws for bad input; returns a reason instead.
 * @param {string|Buffer|Uint8Array} rawBody  the exact bytes received (do not re-serialise)
 * @param {Headers|Record<string, string|string[]|undefined>} headers
 * @param {string|string[]} secret  webhook secret token; pass [new, old] while rotating
 * @param {{ now?: number, toleranceSeconds?: number }} [options]  now in epoch ms; tolerance 0 disables the check
 * @returns {VerifyResult}
 */
export function verifyWebhook(rawBody, headers, secret, options = {}) {
  const secrets = (Array.isArray(secret) ? secret : [secret]).filter((s) => typeof s === 'string' && s.length > 0);
  if (secrets.length === 0) return { valid: false, reason: 'missing_secret' };
  const body = toBuffer(rawBody);
  if (!body) return { valid: false, reason: 'invalid_body' };

  const signatureHeader = getHeader(headers, SIGNATURE_HEADER);
  const timestampHeader = getHeader(headers, TIMESTAMP_HEADER);
  if (!signatureHeader) return { valid: false, reason: 'missing_signature' };
  if (!timestampHeader) return { valid: false, reason: 'missing_timestamp' };

  const match = /^v0=([0-9a-fA-F]{64})$/.exec(signatureHeader.trim());
  if (!match) return { valid: false, reason: 'malformed_signature' };
  if (!/^\d{1,13}$/.test(timestampHeader)) return { valid: false, reason: 'malformed_timestamp' };
  const timestamp = Number(timestampHeader);

  const toleranceSeconds = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (toleranceSeconds > 0) {
    const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
    if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return { valid: false, reason: 'timestamp_out_of_tolerance' };
  }

  const provided = Buffer.from(match[1], 'hex');
  // Sign the header text as received so "0123" and "123" cannot be confused.
  const message = Buffer.concat([Buffer.from(`v0:${timestampHeader}:`, 'utf8'), body]);
  let secretIndex = -1;
  secrets.forEach((candidate, index) => {
    // Check every secret (no early exit) so timing does not reveal which one matched.
    if (timingSafeEqual(hmac(candidate, message), provided) && secretIndex === -1) secretIndex = index;
  });
  return secretIndex >= 0 ? { valid: true, timestamp, secretIndex } : { valid: false, reason: 'signature_mismatch' };
}

/**
 * Challenge response for endpoint.url_validation.
 * @param {string} plainToken
 * @param {string} secret
 * @returns {{ plainToken: string, encryptedToken: string }}
 */
export function buildUrlValidationResponse(plainToken, secret) {
  if (typeof plainToken !== 'string' || plainToken.length === 0 || plainToken.length > 1024) {
    throw new ZoomWebhookError('Invalid plainToken in Zoom URL validation request', { reason: 'invalid_plain_token' });
  }
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new ZoomWebhookError('Zoom webhook secret token is not configured', { reason: 'missing_secret' });
  }
  return { plainToken, encryptedToken: createHmac('sha256', secret).update(plainToken, 'utf8').digest('hex') };
}

/** @param {unknown} body */
function toObject(body) {
  if (body && typeof body === 'object' && !Buffer.isBuffer(body) && !(body instanceof Uint8Array)) return body;
  const buffer = toBuffer(/** @type {any} */ (body));
  if (!buffer) return null;
  try {
    const parsed = JSON.parse(buffer.toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

const EVENT_TYPES = {
  'meeting.participant_joined': 'participant.joined',
  'meeting.participant_left': 'participant.left',
  'meeting.started': 'meeting.started',
  'meeting.ended': 'meeting.ended',
  [URL_VALIDATION_EVENT]: 'url_validation',
};

/**
 * Zoom sends no event ID in the body. We derive a stable one from fields that do not change
 * between Zoom's delivery retries (event name, event_ts, meeting instance, participant session),
 * so the same notification always maps to the same ID for de-duplication.
 */
export function deriveEventId(event) {
  const object = event?.payload?.object ?? {};
  const participant = object.participant ?? {};
  const parts = [
    event?.event ?? '',
    event?.event_ts ?? '',
    event?.payload?.account_id ?? '',
    object.uuid ?? object.id ?? '',
    participant.participant_uuid ?? participant.user_id ?? '',
    participant.join_time ?? participant.leave_time ?? participant.date_time ?? '',
  ];
  return `zoom_${createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32)}`;
}

function normalizeMeetingObject(object) {
  return {
    id: object.id === undefined || object.id === null ? null : String(object.id),
    uuid: object.uuid ?? null,
    hostId: object.host_id ?? null,
    hostEmail: object.host_email ? String(object.host_email).toLowerCase() : null,
    topic: object.topic ?? null,
    type: object.type ?? null,
    startTime: toUtcIso(object.start_time),
    endTime: toUtcIso(object.end_time),
    timezone: object.timezone ?? null,
    durationMinutes: typeof object.duration === 'number' ? object.duration : null,
  };
}

/**
 * @typedef {object} ZoomWebhookEvent
 * @property {'zoom'} provider
 * @property {string} id                 derived, stable across Zoom retries (see deriveEventId)
 * @property {'participant.joined'|'participant.left'|'meeting.started'|'meeting.ended'|'url_validation'|'unknown'} type
 * @property {string} providerEventType  Zoom's `event`, e.g. "meeting.participant_joined"
 * @property {string|null} occurredAt    UTC ISO from event_ts (ms)
 * @property {string|null} accountId
 * @property {string|null} requestId     x-zm-request-id header when headers are passed
 * @property {ReturnType<typeof normalizeMeetingObject>|null} meeting
 * @property {import('./participants.js').ZoomParticipantSession|null} participant
 * @property {string|null} plainToken    url_validation only
 * @property {Record<string, unknown>} raw
 */

/**
 * Parse a (verified) webhook body into normalised events. Unknown events are returned with
 * type 'unknown' rather than dropped. Malformed bodies yield [].
 * @param {string|Buffer|object} body
 * @param {{ headers?: Headers|Record<string, string|string[]|undefined> }} [options]
 * @returns {ZoomWebhookEvent[]}
 */
export function parseWebhook(body, options = {}) {
  const event = toObject(body);
  if (!event || typeof event.event !== 'string') return [];
  const object = event.payload?.object;
  const participantRaw = object?.participant;
  return [
    {
      provider: 'zoom',
      id: deriveEventId(event),
      type: EVENT_TYPES[event.event] ?? 'unknown',
      providerEventType: event.event,
      occurredAt: toUtcIso(typeof event.event_ts === 'number' ? event.event_ts : null),
      accountId: event.payload?.account_id ?? null,
      requestId: getHeader(options.headers, REQUEST_ID_HEADER),
      meeting: object && typeof object === 'object' ? normalizeMeetingObject(object) : null,
      participant: participantRaw && typeof participantRaw === 'object' ? normalizeParticipantRow(participantRaw) : null,
      plainToken: event.event === URL_VALIDATION_EVENT ? (event.payload?.plainToken ?? null) : null,
      raw: event,
    },
  ];
}

/**
 * One call for an HTTP route: verify, answer URL validation, parse events.
 * Respond with `status` and `body` (JSON) exactly; enqueue `events` for processing after
 * responding (Zoom wants 200/204 within 3 seconds).
 * @param {{ rawBody: string|Buffer|Uint8Array, headers: Headers|Record<string, string|string[]|undefined> }} request
 * @param {{ secret: string|string[], now?: number, toleranceSeconds?: number }} options
 * @returns {{ status: 200|400|401, body: object, events: ZoomWebhookEvent[], reason?: string }}
 */
export function handleWebhookRequest(request, options) {
  const verification = verifyWebhook(request.rawBody, request.headers, options.secret, options);
  if (!verification.valid) {
    return { status: 401, body: { error: 'invalid_signature' }, events: [], reason: verification.reason };
  }
  const events = parseWebhook(request.rawBody, { headers: request.headers });
  if (events.length === 0) return { status: 400, body: { error: 'invalid_body' }, events: [], reason: 'invalid_body' };
  const [event] = events;
  if (event.type === 'url_validation') {
    // Answer with the secret that signed the request (matters while rotating secrets).
    const secrets = (Array.isArray(options.secret) ? options.secret : [options.secret]).filter((s) => typeof s === 'string' && s.length > 0);
    try {
      return { status: 200, body: buildUrlValidationResponse(event.plainToken, secrets[verification.secretIndex]), events: [] };
    } catch (error) {
      return { status: 400, body: { error: 'invalid_body' }, events: [], reason: error.reason ?? 'invalid_plain_token' };
    }
  }
  return { status: 200, body: { received: true }, events };
}
