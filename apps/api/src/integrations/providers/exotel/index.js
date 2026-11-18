import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { MAX_CUSTOM_FIELD_LENGTH, MAX_TIME_LIMIT_SECONDS, parseConfig, resolveBaseUrl, webhookSecrets } from './config.js';
import {
  ExotelConfigError,
  ExotelError,
  ExotelNetworkError,
  ExotelNotFoundError,
  ExotelProviderError,
  ExotelValidationError,
  createRedactor,
} from './errors.js';
import { createHttp } from './http.js';
import { normaliseCall, parseWebhook } from './parse.js';
import { checkCallCompliance, isSipUri, toE164 } from './phone.js';
import { buildFlowUrl, signCallbackUrl, verifyWebhook } from './webhook.js';

/**
 * Exotel calling client (kind: calling) for the Phoenix CRM.
 *
 *   const exotel = createExotelClient(config, { fetch, now, logger });
 *   const call = await exotel.connectCall({ agentNumber, customerNumber, ref: activityId });
 *   // later, in the webhook route:
 *   const check = exotel.verifyWebhook(rawBody, req.headers, { url: req.originalUrl, remoteIp: req.ip });
 *   if (check.valid) for (const event of exotel.parseWebhook(rawBody, { contentType, query })) ...
 *
 * See docs/providers/exotel.md for setup, verification scheme and India-specific rules.
 */

export const PROVIDER = 'exotel';
export const KIND = 'calling';
export const CAPABILITIES = Object.freeze([
  'click_to_call',
  'caller_id_selection',
  'call_recording',
  'call_status_webhooks',
  'inbound_call_passthru',
  'call_details',
  'recording_download',
]);

const ref = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/, 'ref must be 1-128 chars of [A-Za-z0-9._:-]');

const connectInput = z
  .object({
    agentNumber: z.string().trim().min(3).max(200),
    customerNumber: z.string().trim().min(3).max(30),
    callerId: z.string().trim().min(5).max(20).optional(),
    ref: ref.optional(),
    purpose: z.enum(['service', 'transactional', 'promotional']).default('service'),
    callType: z.literal('trans').optional(),
    timeLimitSeconds: z.number().int().min(1).max(MAX_TIME_LIMIT_SECONDS).optional(),
    ringTimeoutSeconds: z.number().int().min(5).max(300).optional(),
    record: z.boolean().optional(),
    recordingChannels: z.enum(['single', 'dual']).optional(),
    recordingFormat: z.enum(['mp3', 'mp3-hq']).optional(),
    waitUrl: z.url({ protocol: /^https$/ }).optional(),
    statusCallbackUrl: z.union([z.url({ protocol: /^https$/ }), z.null()]).optional(),
    statusCallbackEvents: z.array(z.enum(['terminal', 'answered', 'ringing'])).min(1).optional(),
    signal: z.instanceof(AbortSignal).optional(),
  })
  .strict();

/**
 * @typedef {z.input<typeof connectInput>} ConnectCallInput
 * @typedef {import('./parse.js').ExotelCall} ExotelCall
 * @typedef {import('./parse.js').ExotelCallEvent} ExotelCallEvent
 * @typedef {import('./webhook.js').VerifyResult} VerifyResult
 */

/**
 * @typedef {object} ClientDeps
 * @property {typeof fetch} [fetch] defaults to the global fetch
 * @property {() => number | Date} [now] clock, ms since epoch (or Date); defaults to Date.now
 * @property {any} [logger] pino-style logger; receives metadata only (no bodies, no secrets)
 * @property {(ms: number) => Promise<void>} [sleep] backoff sleep (tests pass a no-op)
 * @property {() => number} [random] jitter source in [0, 1)
 * @property {() => string} [generateRef] id generator for CustomField when no ref is given
 */

/**
 * @param {unknown} config validated with exotelConfigSchema (see config.js)
 * @param {ClientDeps} [deps]
 */
export function createExotelClient(config, deps = {}) {
  const cfg = parseConfig(config);
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new ExotelConfigError('No fetch implementation available');
  const nowMs = () => {
    const value = (deps.now ?? Date.now)();
    return value instanceof Date ? value.getTime() : Number(value);
  };
  const secrets = webhookSecrets(cfg);
  const basic = Buffer.from(`${cfg.apiKey}:${cfg.apiToken}`, 'utf8').toString('base64');
  const redact = createRedactor([cfg.apiKey, cfg.apiToken, basic, ...secrets]);
  const baseUrl = resolveBaseUrl(cfg);
  const accountPath = `/v1/Accounts/${encodeURIComponent(cfg.accountSid)}`;
  const http = createHttp({
    fetch: fetchImpl,
    nowMs,
    sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    random: deps.random ?? Math.random,
    logger: deps.logger,
    redact,
    timeoutMs: cfg.timeoutMs,
    maxRetries: cfg.maxRetries,
    retryBaseDelayMs: cfg.retryBaseDelayMs,
    maxRetryAfterMs: cfg.maxRetryAfterMs,
  });
  const generateRef = deps.generateRef ?? (() => randomUUID());
  const normaliseOptions = { timeZoneOffset: cfg.timeZoneOffset, currency: cfg.currency };

  const authHeaders = () => ({
    Authorization: `Basic ${basic}`,
    Accept: 'application/json',
    'User-Agent': 'phoenix-crm-exotel/1.0',
  });

  /**
   * Click-to-call: Exotel rings the agent first; when the agent answers it dials the customer and
   * bridges them. The customer sees `callerId` (an ExoPhone on the account).
   * Not retried on timeout/5xx (no idempotency keys); such errors carry outcomeUnknown + ref, and
   * the call's StatusCallback will still arrive with CustomField = ref if it was placed.
   * @param {ConnectCallInput} input
   * @returns {Promise<ExotelCall & { ref: string, complianceWarnings: string[] }>}
   */
  async function connectCall(input) {
    const parsed = connectInput.safeParse(input);
    if (!parsed.success) throw validationError('connectCall', parsed.error);
    const args = parsed.data;
    const callerId = args.callerId ?? cfg.callerId;
    if (!callerId) throw new ExotelValidationError('callerId (ExoPhone) is required', { operation: 'connectCall', code: 'caller_id_missing' });
    const compliance = checkCallCompliance({ purpose: args.purpose, callerId });
    if (!compliance.allowed) {
      throw new ExotelValidationError(`Call blocked by calling rules: ${compliance.reasons.join(', ')}`, {
        operation: 'connectCall',
        code: 'compliance_blocked',
        details: { reasons: compliance.reasons, series: compliance.series },
      });
    }
    const callRef = args.ref ?? generateRef();
    if (callRef.length > MAX_CUSTOM_FIELD_LENGTH) throw new ExotelValidationError('ref is too long', { operation: 'connectCall' });
    const form = new URLSearchParams();
    form.set('From', isSipUri(args.agentNumber) ? args.agentNumber : e164(args.agentNumber, 'agentNumber'));
    form.set('To', e164(args.customerNumber, 'customerNumber'));
    // CallerId is sent as configured (the ExoPhone exactly as the dashboard shows it); Exotel
    // documents E.164 for From/To but not for CallerId. It must still be a valid number.
    e164(callerId, 'callerId');
    form.set('CallerId', callerId);
    if (args.callType) form.set('CallType', args.callType);
    const timeLimit = args.timeLimitSeconds ?? cfg.timeLimitSeconds;
    if (timeLimit) form.set('TimeLimit', String(timeLimit));
    const ringTimeout = args.ringTimeoutSeconds ?? cfg.ringTimeoutSeconds;
    if (ringTimeout) form.set('TimeOut', String(ringTimeout));
    if (args.waitUrl) form.set('WaitUrl', args.waitUrl);
    if (args.record ?? cfg.record) {
      form.set('Record', 'true');
      form.set('RecordingChannels', args.recordingChannels ?? cfg.recordingChannels);
      form.set('RecordingFormat', args.recordingFormat ?? cfg.recordingFormat);
    }
    form.set('CustomField', callRef);
    const callbackUrl = statusCallbackFor(args.statusCallbackUrl, callRef, timeLimit);
    if (callbackUrl) {
      form.set('StatusCallback', callbackUrl);
      (args.statusCallbackEvents ?? cfg.statusCallbackEvents).forEach((event, i) => {
        form.set(`StatusCallbackEvents[${i}]`, event);
      });
      form.set('StatusCallbackContentType', cfg.statusCallbackContentType);
    }
    try {
      const res = await http.send({
        operation: 'connectCall',
        method: 'POST',
        url: `${baseUrl}${accountPath}/Calls/connect.json`,
        headers: { ...authHeaders(), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        idempotent: false,
        signal: args.signal,
      });
      const call = readCall(/** @type {{ text: string }} */ (res).text, 'connectCall');
      return { ...call, ref: call.ref ?? callRef, complianceWarnings: compliance.warnings };
    } catch (error) {
      if (error instanceof ExotelError) error.details = { ...(error.details ?? {}), ref: callRef };
      throw error;
    }
  }

  /**
   * @param {string | null | undefined} override
   * @param {string} callRef
   * @param {number | undefined} timeLimit
   */
  function statusCallbackFor(override, callRef, timeLimit) {
    if (override === null) return null;
    const base = override ?? cfg.statusCallbackUrl;
    if (!base) return null;
    if (!secrets.length) {
      if (cfg.allowedWebhookIps.length) return base;
      throw new ExotelConfigError('Status callbacks need webhookSecret (or allowedWebhookIps) to be verifiable');
    }
    const ttl = Math.max(cfg.callbackTtlSeconds, (timeLimit ?? 0) + 3600);
    return signCallbackUrl(base, secrets[0], { ref: callRef, expiresAt: Math.floor(nowMs() / 1000) + ttl });
  }

  /**
   * Call Details API (idempotent, retried). Final Duration/Price arrive ~2 minutes after hang-up.
   * @param {string} callId Exotel CallSid
   * @param {{ details?: boolean, signal?: AbortSignal }} [options]
   * @returns {Promise<ExotelCall>}
   */
  async function getCall(callId, { details = true, signal } = {}) {
    if (typeof callId !== 'string' || !/^[A-Za-z0-9_-]{6,64}$/.test(callId)) {
      throw new ExotelValidationError('callId must be an Exotel CallSid', { operation: 'getCall' });
    }
    const query = details ? '?details=true' : '';
    const res = await http.send({
      operation: 'getCall',
      method: 'GET',
      url: `${baseUrl}${accountPath}/Calls/${encodeURIComponent(callId)}.json${query}`,
      headers: authHeaders(),
      idempotent: true,
      signal,
    });
    return readCall(/** @type {{ text: string }} */ (res).text, 'getCall');
  }

  /**
   * Downloads a call recording. Exotel made recording URLs private in Oct 2024: they need Basic
   * auth with the API key/token unless the server's IP is whitelisted with Exotel. Credentials
   * are only sent to Exotel-owned https hosts; redirects are followed manually and credentials
   * are dropped when a redirect leaves Exotel (e.g. to a pre-signed S3 URL).
   * @param {string} recordingUrl
   * @param {{ maxBytes?: number, signal?: AbortSignal }} [options]
   * @returns {Promise<{ contentType: string | null, sizeBytes: number, body: Buffer }>}
   */
  async function fetchRecording(recordingUrl, { maxBytes = cfg.maxRecordingBytes, signal } = {}) {
    let url = parseRecordingUrl(recordingUrl);
    const deadline = AbortSignal.timeout(cfg.recordingTimeoutMs);
    const overall = signal ? AbortSignal.any([signal, deadline]) : deadline;
    for (let hop = 0; hop <= 3; hop += 1) {
      let res;
      try {
        res = /** @type {Response} */ (
          await http.send({
            operation: 'fetchRecording',
            method: 'GET',
            url: url.toString(),
            headers: isExotelHost(url.hostname) ? { ...authHeaders(), Accept: '*/*' } : { Accept: '*/*' },
            idempotent: true,
            redirect: 'manual',
            raw: true,
            signal: overall,
          })
        );
      } catch (error) {
        if (error instanceof ExotelNotFoundError) {
          throw new ExotelNotFoundError('Recording not available yet (or deleted after the retention period)', {
            operation: 'fetchRecording',
            status: 404,
            code: 'recording_not_available',
            retryable: true,
          });
        }
        throw error;
      }
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        await res.body?.cancel();
        if (!location) break;
        url = parseRecordingUrl(new URL(location, url).toString());
        continue;
      }
      return readLimited(res, maxBytes);
    }
    throw new ExotelProviderError('Too many or invalid redirects while fetching recording', {
      code: 'provider_error',
      operation: 'fetchRecording',
      retryable: false,
    });
  }

  /** @param {string} text @param {string} operation */
  function readCall(text, operation) {
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ExotelProviderError(`Exotel ${operation} returned a non-JSON response`, { code: 'response_invalid', operation });
    }
    if (!json?.Call?.Sid) {
      throw new ExotelProviderError(`Exotel ${operation} response has no Call.Sid`, { code: 'response_invalid', operation });
    }
    return normaliseCall(json.Call, normaliseOptions);
  }

  return Object.freeze({
    provider: PROVIDER,
    kind: KIND,
    capabilities: CAPABILITIES,
    region: cfg.region,
    baseUrl,
    connectCall,
    getCall,
    fetchRecording,
    /**
     * Signed StatusCallback URL for a ref (connectCall does this automatically).
     * @param {string} callRef
     * @param {{ baseUrl?: string, ttlSeconds?: number }} [options]
     */
    buildStatusCallbackUrl(callRef, options = {}) {
      const base = options.baseUrl ?? cfg.statusCallbackUrl;
      if (!base || !secrets.length) throw new ExotelConfigError('statusCallbackUrl and webhookSecret are required');
      const expiresAt = Math.floor(nowMs() / 1000) + (options.ttlSeconds ?? cfg.callbackTtlSeconds);
      return signCallbackUrl(base, secrets[0], { ref: callRef, expiresAt });
    },
    /**
     * URL with a static token, to paste into a Passthru / Connect applet in the Exotel flow builder.
     * @param {string} url
     * @param {{ purpose?: string, inPath?: boolean }} [options]
     */
    buildFlowUrl(url, options) {
      if (!secrets.length) throw new ExotelConfigError('webhookSecret is required to build flow URLs');
      return buildFlowUrl(url, secrets[0], options);
    },
    /**
     * @param {string | Buffer | Uint8Array | null | undefined} rawBody
     * @param {Record<string, string | string[] | undefined> | Headers | null | undefined} headers
     * @param {Omit<import('./webhook.js').VerifyOptions, 'allowedIps'>} [options]
     * @returns {VerifyResult}
     */
    verifyWebhook(rawBody, headers, options = {}) {
      return verifyWebhook(rawBody, headers, secrets, { now: nowMs(), ...options, allowedIps: cfg.allowedWebhookIps });
    },
    /**
     * @param {unknown} body
     * @param {import('./parse.js').ParseOptions} [options]
     * @returns {ExotelCallEvent[]}
     */
    parseWebhook(body, options = {}) {
      return parseWebhook(body, { timeZoneOffset: cfg.timeZoneOffset, receivedAt: new Date(nowMs()), ...options });
    },
    checkCallCompliance,
    /** Masks secrets in arbitrary text (for adapters that log provider output). */
    redact,
  });
}

/** @param {string} value @param {string} field */
function e164(value, field) {
  try {
    return toE164(value);
  } catch {
    throw new ExotelValidationError(`${field} is not a valid phone number`, { operation: 'connectCall', code: 'invalid_phone', details: { field } });
  }
}

/** @param {string} operation @param {z.ZodError} error */
function validationError(operation, error) {
  const fields = error.issues.map((issue) => `${issue.path.join('.') || '(input)'}: ${issue.code}`);
  return new ExotelValidationError(`Invalid ${operation} input: ${fields.join('; ')}`, { operation, details: { fields } });
}

/** @param {string} hostname */
export function isExotelHost(hostname) {
  const host = hostname.toLowerCase();
  return host === 'exotel.com' || host.endsWith('.exotel.com') || host === 'exotel.in' || host.endsWith('.exotel.in');
}

/** @param {string} value */
function parseRecordingUrl(value) {
  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    throw new ExotelValidationError('recordingUrl is not a URL', { operation: 'fetchRecording' });
  }
  if (url.protocol !== 'https:') throw new ExotelValidationError('recordingUrl must be https', { operation: 'fetchRecording' });
  if (url.username || url.password) throw new ExotelValidationError('recordingUrl must not embed credentials', { operation: 'fetchRecording' });
  return url;
}

/**
 * Reads a response body, aborting once it exceeds maxBytes.
 * @param {Response} res
 * @param {number} maxBytes
 */
async function readLimited(res, maxBytes) {
  const tooLarge = () =>
    new ExotelProviderError(`Recording exceeds ${maxBytes} bytes`, { code: 'recording_too_large', operation: 'fetchRecording', retryable: false });
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel();
    throw tooLarge();
  }
  /** @type {Buffer[]} */
  const chunks = [];
  let size = 0;
  try {
    if (res.body) {
      for await (const chunk of res.body) {
        size += chunk.byteLength;
        if (size > maxBytes) throw tooLarge();
        chunks.push(Buffer.from(chunk));
      }
    }
  } catch (error) {
    if (error instanceof ExotelError) throw error;
    const timedOut = /** @type {any} */ (error)?.name === 'TimeoutError';
    throw new ExotelNetworkError(timedOut ? 'Recording download timed out' : 'Recording download interrupted', {
      code: timedOut ? 'timeout' : 'network_error',
      operation: 'fetchRecording',
    });
  }
  return { contentType: res.headers.get('content-type'), sizeBytes: size, body: Buffer.concat(chunks) };
}

export { parseConfig, exotelConfigSchema, REGION_HOSTS } from './config.js';
export * from './errors.js';
export { parseWebhook, normaliseCall, mapStatus, mapDirection, deriveOutcome } from './parse.js';
export { verifyWebhook, signCallbackUrl, buildFlowUrl, computeCallbackSignature, computeStaticToken, safeEqual, ipAllowed, PARAMS } from './webhook.js';
export { toE164, toE164Safe, isSipUri, classifyIndianNumber, checkCallCompliance } from './phone.js';
export { decodePayload, toUtcIso, toMoney } from './decode.js';
