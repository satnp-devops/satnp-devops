import { createHash } from 'node:crypto';
import { decodePayload, int, list, str, toMoney, toUtcIso } from './decode.js';
import { ExotelWebhookError } from './errors.js';
import { toE164Safe } from './phone.js';

/**
 * Normalises Exotel payloads (webhooks and API responses) into provider-neutral shapes.
 *
 * Exotel sends three kinds of HTTP requests to us:
 *  - status_callback: POST to the StatusCallback URL of a Connect API call (ringing/answered/terminal)
 *  - passthru:        GET (or POST) from a Passthru applet in a call flow, e.g. an incoming call lead
 *  - connect_applet:  GET from a Connect applet's agent pass-through URL (Dial/Ringing/Answered/Terminal)
 * Exotel sends no event id, so each event gets a deterministic `eventId` that is stable across
 * Exotel's retries (they resend the same payload) and distinct between events of the same call.
 */

/** @typedef {'queued'|'ringing'|'in_progress'|'completed'|'busy'|'no_answer'|'failed'|'canceled'|'unknown'} CallStatus */

const STATUS_MAP = /** @type {Record<string, CallStatus>} */ ({
  queued: 'queued',
  ringing: 'ringing',
  'in-progress': 'in_progress',
  in_progress: 'in_progress',
  completed: 'completed',
  busy: 'busy',
  failed: 'failed',
  'no-answer': 'no_answer',
  no_answer: 'no_answer',
  canceled: 'canceled',
  cancelled: 'canceled',
});

/** Our own query parameters on callback URLs; never part of the provider payload. */
export const OWN_PARAM_PREFIX = 'phx_';

/**
 * @param {unknown} value
 * @returns {CallStatus | null}
 */
export function mapStatus(value) {
  const text = str(value);
  if (!text) return null;
  return STATUS_MAP[text.toLowerCase()] ?? 'unknown';
}

/**
 * @param {unknown} value
 * @returns {'inbound' | 'outbound' | null}
 */
export function mapDirection(value) {
  const text = str(value)?.toLowerCase();
  if (!text) return null;
  if (text === 'inbound' || text === 'incoming') return 'inbound';
  if (text.startsWith('outbound')) return 'outbound';
  return null;
}

/** @param {unknown} value */
function phone(value) {
  const text = str(value);
  if (!text) return null;
  return toE164Safe(text) ?? text;
}

/** @param {unknown} value IVR digits arrive wrapped in double quotes, e.g. "\"2\"". */
function digits(value) {
  const text = str(value);
  return text === null ? null : text.replace(/^"+|"+$/g, '') || null;
}

/**
 * @typedef {object} CallLeg
 * @property {number} index 1-based
 * @property {'agent' | 'customer' | null} role leg 1 is the agent and leg 2 the customer for click-to-call
 * @property {CallStatus | null} status
 * @property {number | null} onCallDurationSeconds
 * @property {number | null} ringingDurationSeconds
 * @property {string | null} answeredBy Human | Machine | NotSure | NA
 * @property {string | null} number
 * @property {string | null} causeCode ISDN cause name, e.g. NORMAL_CLEARING (Passthru only)
 * @property {number | null} cause ISDN cause number (Passthru only)
 */

/**
 * @param {unknown} rawLegs
 * @param {boolean} clickToCall
 * @returns {CallLeg[]}
 */
function parseLegs(rawLegs, clickToCall) {
  return list(rawLegs).map((item, i) => {
    const leg = /** @type {Record<string, unknown>} */ (item && typeof item === 'object' ? item : {});
    const inner = /** @type {Record<string, unknown>} */ (leg.Leg && typeof leg.Leg === 'object' ? leg.Leg : leg);
    const index = int(inner.Id) ?? i + 1;
    return {
      index,
      role: clickToCall ? (index === 1 ? 'agent' : index === 2 ? 'customer' : null) : null,
      status: mapStatus(inner.Status),
      onCallDurationSeconds: int(inner.OnCallDuration),
      ringingDurationSeconds: int(inner.RingingDuration),
      answeredBy: str(inner.AnsweredBy),
      number: phone(inner.Number),
      causeCode: str(inner.CauseCode),
      cause: int(inner.Cause),
    };
  });
}

/**
 * Click-to-call outcome from the CRM's point of view.
 * @param {CallStatus | null} status
 * @param {CallLeg[]} legs
 * @param {number | null} talkSeconds
 * @returns {'connected' | 'agent_missed' | 'customer_missed' | 'failed' | 'unknown'}
 */
export function deriveOutcome(status, legs, talkSeconds) {
  const agent = legs.find((l) => l.index === 1);
  const customer = legs.find((l) => l.index === 2);
  if ((talkSeconds ?? 0) > 0) return 'connected';
  if (customer?.status === 'completed' && (customer.onCallDurationSeconds ?? 0) > 0) return 'connected';
  if (agent && agent.status && agent.status !== 'completed' && agent.status !== 'in_progress') return 'agent_missed';
  if (agent?.status === 'completed' && customer && customer.status !== 'completed') return 'customer_missed';
  if (status === 'failed') return 'failed';
  if (status === 'busy' || status === 'no_answer' || status === 'canceled') return legs.length ? 'customer_missed' : 'unknown';
  return status === 'completed' ? 'connected' : 'unknown';
}

/**
 * Stable short hash of a payload, ignoring volatile and own fields.
 * @param {Record<string, any>} payload
 * @param {string[]} ignore
 */
function payloadHash(payload, ignore) {
  const skip = new Set(ignore);
  const canonical = JSON.stringify(
    Object.keys(payload)
      .filter((k) => !skip.has(k))
      .sort()
      .map((k) => [k, payload[k]]),
  );
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/** @param {Record<string, any>} payload */
function withoutOwnParams(payload) {
  return Object.fromEntries(Object.entries(payload).filter(([k]) => !k.startsWith(OWN_PARAM_PREFIX)));
}

/**
 * @typedef {object} ParseOptions
 * @property {string | null} [contentType] Content-Type header of the request
 * @property {string | URLSearchParams | Record<string, unknown> | null} [query] query string (Passthru sends GET)
 * @property {string} [timeZoneOffset] offset of Exotel's local timestamps, default '+05:30'
 * @property {string | Date | null} [receivedAt] when we received it; fallback for occurredAt
 */

/**
 * @typedef {object} ExotelCallEvent
 * @property {'exotel'} provider
 * @property {string} eventId deterministic dedupe key
 * @property {'call.ringing'|'call.answered'|'call.ended'|'call.inbound'|'call.flow_step'|'call.agent_leg'} type
 * @property {'status_callback'|'passthru'|'connect_applet'} source
 * @property {string} callId Exotel CallSid
 * @property {CallStatus | null} status
 * @property {string | null} providerStatus
 * @property {'inbound'|'outbound'|null} direction
 * @property {string | null} providerDirection
 * @property {string | null} from E.164 when parseable, else as sent
 * @property {string | null} to
 * @property {string | null} callerId ExoPhone involved, when known
 * @property {string | null} occurredAt ISO UTC
 * @property {string | null} createdAt
 * @property {string | null} startedAt
 * @property {string | null} endedAt
 * @property {number | null} durationSeconds talk time (both parties connected) when Exotel reports it
 * @property {CallLeg[]} legs
 * @property {CallLeg | null} leg the leg this ringing/answered event is about
 * @property {string | null} outcome connected | agent_missed | customer_missed | failed | unknown (terminal only)
 * @property {string | null} recordingUrl may need Basic auth to download (see fetchRecording)
 * @property {string | null} ref our CustomField correlation id, if the call was started via API
 * @property {Record<string, unknown>} extra source-specific fields
 * @property {{ phone: string | null, calledNumber: string | null, digits: string | null, receivedAt: string | null } | null} lead
 * @property {Record<string, any>} raw decoded payload (our phx_* params removed)
 */

/**
 * Decodes and normalises an Exotel callback. Pure: no I/O, no clock reads.
 * Returns an array (always one event for Exotel) so it composes with batch-style providers.
 * @param {unknown} body raw body, parsed body object, or URLSearchParams
 * @param {ParseOptions} [options]
 * @returns {ExotelCallEvent[]}
 * @throws {ExotelWebhookError}
 */
export function parseWebhook(body, options = {}) {
  const offset = options.timeZoneOffset ?? '+05:30';
  const payload = withoutOwnParams(decodePayload(body, { contentType: options.contentType, query: options.query }));
  const callId = str(payload.CallSid);
  if (!callId) throw new ExotelWebhookError('Not an Exotel call webhook: CallSid is missing');
  const receivedAt =
    options.receivedAt instanceof Date ? options.receivedAt.toISOString() : toUtcIso(options.receivedAt, '+00:00');
  const context = { payload, callId, offset, receivedAt };
  const isFlowRequest = payload.CallFrom !== undefined || payload.CallTo !== undefined || payload.DialWhomNumber !== undefined;
  if (isFlowRequest && str(payload.EventType)) return [connectAppletEvent(context)];
  if (isFlowRequest) return [passthruEvent(context)];
  if (payload.Status !== undefined || payload.EventType !== undefined) return [statusCallbackEvent(context)];
  throw new ExotelWebhookError('Unrecognised Exotel webhook payload');
}

/**
 * @typedef {{ payload: Record<string, any>, callId: string, offset: string, receivedAt: string | null }} Context
 */

/** @param {Context} ctx @returns {ExotelCallEvent} */
function statusCallbackEvent({ payload, callId, offset, receivedAt }) {
  const eventType = (str(payload.EventType) ?? 'terminal').toLowerCase();
  const providerDirection = str(payload.Direction);
  const clickToCall = providerDirection === null || providerDirection === 'outbound-api';
  const legs = parseLegs(payload.Legs, clickToCall);
  const terminal = eventType !== 'answered' && eventType !== 'ringing';
  const progressed = legs.filter((l) => l.status !== null);
  const leg = terminal ? null : (progressed[progressed.length - 1] ?? null);
  const durationSeconds = terminal ? int(payload.ConversationDuration) : null;
  const status = terminal ? mapStatus(payload.Status) : eventType === 'ringing' ? 'ringing' : 'in_progress';
  return {
    ...base(payload, callId, 'status_callback'),
    eventId: terminal ? `${callId}:terminal` : `${callId}:${eventType}:leg${leg?.index ?? 0}`,
    type: terminal ? 'call.ended' : eventType === 'ringing' ? 'call.ringing' : 'call.answered',
    status,
    providerStatus: str(payload.Status),
    direction: mapDirection(providerDirection) ?? 'outbound',
    providerDirection,
    from: phone(payload.From),
    to: phone(payload.To),
    callerId: phone(payload.PhoneNumberSid),
    occurredAt: toUtcIso(payload.EventTime, offset) ?? toUtcIso(payload.DateUpdated, offset) ?? receivedAt,
    createdAt: toUtcIso(payload.DateCreated, offset),
    startedAt: toUtcIso(payload.StartTime, offset),
    endedAt: terminal ? toUtcIso(payload.EndTime, offset) : null,
    durationSeconds,
    legs,
    leg,
    outcome: terminal ? deriveOutcome(status, legs, durationSeconds) : null,
    recordingUrl: str(payload.RecordingUrl),
    ref: str(payload.CustomField),
    extra: { eventType },
  };
}

/** @param {Context} ctx @returns {ExotelCallEvent} */
function passthruEvent({ payload, callId, offset, receivedAt }) {
  const direction = mapDirection(payload.Direction);
  const inbound = direction === 'inbound';
  const occurredAt = toUtcIso(payload.CurrentTime, offset) ?? receivedAt;
  const from = phone(payload.CallFrom ?? payload.From);
  const to = phone(payload.CallTo ?? payload.To);
  const ivrDigits = digits(payload.digits);
  return {
    ...base(payload, callId, 'passthru'),
    eventId: `${callId}:passthru:${payloadHash(payload, ['CurrentTime'])}`,
    type: inbound ? 'call.inbound' : 'call.flow_step',
    status: mapStatus(payload.CallStatus),
    providerStatus: str(payload.CallStatus),
    direction,
    providerDirection: str(payload.Direction),
    from,
    to,
    callerId: inbound ? to : phone(payload.OutgoingPhoneNumber),
    occurredAt,
    createdAt: toUtcIso(payload.Created, offset),
    startedAt: toUtcIso(payload.StartTime, offset),
    endedAt: toUtcIso(payload.EndTime, offset),
    durationSeconds: int(payload.DialCallDuration),
    legs: parseLegs(payload.Legs, false),
    leg: null,
    outcome: null,
    recordingUrl: str(payload.RecordingUrl),
    ref: str(payload.CustomField),
    extra: {
      flowOutcome: str(payload.CallType)?.replace(/-/g, '_') ?? null,
      dialCallStatus: mapStatus(payload.DialCallStatus),
      agentNumber: phone(payload.DialWhomNumber),
      digits: ivrDigits,
    },
    lead: inbound ? { phone: from, calledNumber: to, digits: ivrDigits, receivedAt: occurredAt } : null,
  };
}

/** @param {Context} ctx @returns {ExotelCallEvent} */
function connectAppletEvent({ payload, callId, offset, receivedAt }) {
  const agentEvent = /** @type {string} */ (str(payload.EventType)).toLowerCase();
  return {
    ...base(payload, callId, 'connect_applet'),
    eventId: `${callId}:agent_${agentEvent}:${payloadHash(payload, ['CurrentTime'])}`,
    type: 'call.agent_leg',
    status: agentEvent === 'terminal' ? null : agentEvent === 'answered' ? 'in_progress' : 'ringing',
    providerStatus: str(payload.Status),
    direction: mapDirection(payload.Direction),
    providerDirection: str(payload.Direction),
    from: phone(payload.CallFrom ?? payload.From),
    to: phone(payload.CallTo ?? payload.To),
    callerId: phone(payload.CallTo ?? payload.To),
    occurredAt: toUtcIso(payload.CurrentTime, offset) ?? receivedAt,
    createdAt: toUtcIso(payload.Created, offset),
    startedAt: null,
    endedAt: null,
    durationSeconds: null,
    legs: [],
    leg: null,
    outcome: null,
    recordingUrl: null,
    ref: str(payload.CustomField),
    extra: {
      agentEvent,
      agentNumber: phone(payload.DialWhomNumber),
      agentBusy: str(payload.Status)?.toLowerCase() === 'busy',
    },
  };
}

/**
 * @param {Record<string, any>} payload
 * @param {string} callId
 * @param {ExotelCallEvent['source']} source
 */
function base(payload, callId, source) {
  return { provider: /** @type {const} */ ('exotel'), source, callId, lead: null, raw: payload };
}

/**
 * @typedef {object} ExotelCall
 * @property {string} callId
 * @property {string | null} parentCallId
 * @property {CallStatus | null} status
 * @property {string | null} providerStatus
 * @property {'inbound'|'outbound'|null} direction
 * @property {string | null} providerDirection
 * @property {string | null} from
 * @property {string | null} to
 * @property {string | null} callerId
 * @property {string | null} createdAt
 * @property {string | null} updatedAt
 * @property {string | null} startedAt
 * @property {string | null} endedAt
 * @property {number | null} totalDurationSeconds Exotel "Duration" (final ~2 minutes after hang-up)
 * @property {number | null} talkDurationSeconds Details.ConversationDuration (needs details=true)
 * @property {{ amountMinor: number, currency: string } | null} price
 * @property {string | null} answeredBy
 * @property {string | null} recordingUrl
 * @property {string | null} preSignedRecordingUrl only when Exotel enabled the feature on the account
 * @property {CallLeg[]} legs
 * @property {string | null} outcome
 * @property {string | null} ref
 * @property {Record<string, any>} raw
 */

/**
 * Normalises the `Call` object of the Connect and Call Details APIs.
 * @param {Record<string, any>} call
 * @param {{ timeZoneOffset: string, currency: string }} options
 * @returns {ExotelCall}
 */
export function normaliseCall(call, { timeZoneOffset, currency }) {
  const details = call.Details && typeof call.Details === 'object' ? call.Details : {};
  const providerDirection = str(call.Direction);
  const legs = parseLegs(details.Legs, providerDirection === 'outbound-api');
  for (const leg of legs) {
    if (leg.status === null) leg.status = mapStatus(details[`Leg${leg.index}Status`]);
  }
  const status = mapStatus(call.Status);
  const talk = int(details.ConversationDuration);
  const terminal = ['completed', 'busy', 'no_answer', 'failed', 'canceled'].includes(String(status));
  return {
    callId: String(call.Sid),
    parentCallId: str(call.ParentCallSid),
    status,
    providerStatus: str(call.Status),
    direction: mapDirection(providerDirection),
    providerDirection,
    from: phone(call.From),
    to: phone(call.To),
    callerId: phone(call.PhoneNumberSid),
    createdAt: toUtcIso(call.DateCreated, timeZoneOffset),
    updatedAt: toUtcIso(call.DateUpdated, timeZoneOffset),
    startedAt: toUtcIso(call.StartTime, timeZoneOffset),
    endedAt: toUtcIso(call.EndTime, timeZoneOffset),
    totalDurationSeconds: int(call.Duration),
    talkDurationSeconds: talk,
    price: toMoney(call.Price, currency),
    answeredBy: str(call.AnsweredBy),
    recordingUrl: str(call.RecordingUrl),
    preSignedRecordingUrl: str(call.PreSignedRecordingUrl),
    legs,
    outcome: terminal && legs.length ? deriveOutcome(status, legs, talk) : null,
    ref: str(call.CustomField),
    raw: call,
  };
}
