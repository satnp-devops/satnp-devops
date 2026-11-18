import { createHmac, timingSafeEqual } from 'node:crypto';
import { DIGIO_ENVIRONMENTS } from './config.js';
import { normalizeDocument, normalizeSigner, parseDigioTime } from './mapping.js';

/**
 * Digio webhooks (documentation.digio.in/webhooks, /webhooks/faq, /webhooks/structure,
 * /digisign/api_integration/webhooks; checked 2026-11-05):
 * - POST with a JSON body { id, created_at (epoch ms), event, entities[], payload }.
 * - Authentication: header X-Digio-Checksum = hex(HMAC-SHA256(secret, raw request body)).
 *   The secret is set per webhook group in the enterprise dashboard (Profile > Webhooks).
 * - No signed timestamp header. Delivery is at-least-once with retries for up to 24 hours
 *   (5, 10, 15, 30 minutes, then hourly), so dedupe on `id` instead of rejecting old events.
 * - Respond 200 within 10 seconds or Digio counts the attempt as failed.
 */
export const DIGIO_SIGNATURE_HEADER = 'x-digio-checksum';

/** Digio event name -> platform event type. */
const EVENT_TYPES = Object.freeze({
  'doc.signed': 'esign.signer.signed',
  'doc.sign.failed': 'esign.signer.failed',
  'doc.sign.rejected': 'esign.signer.rejected',
});

/**
 * @typedef {{ ok: true, createdAt: string | null } | { ok: false, reason: 'missing_secret' | 'raw_body_required'
 *   | 'missing_signature' | 'malformed_signature' | 'signature_mismatch' | 'invalid_json' | 'missing_timestamp'
 *   | 'timestamp_out_of_range' }} VerifyResult
 */

/**
 * Verify a Digio webhook. Pass the exact bytes received (express.raw / req.rawBody), never a
 * re-serialised object: any whitespace change breaks the HMAC.
 *
 * Digio defines no timestamp tolerance. `toleranceSeconds` is optional and checks the signed
 * `created_at` in the body; keep it above 25 hours if set, because Digio retries for 24 hours.
 *
 * @param {Buffer | Uint8Array | string} rawBody
 * @param {Headers | Record<string, string | string[] | undefined>} headers
 * @param {string | readonly string[]} secret one secret, or several during rotation / for several groups
 * @param {{ toleranceSeconds?: number, now?: () => Date | number }} [options]
 * @returns {VerifyResult}
 */
export function verifyWebhook(rawBody, headers, secret, options = {}) {
  const secrets = (Array.isArray(secret) ? secret : [secret]).filter((s) => typeof s === 'string' && s.length > 0);
  if (secrets.length === 0) return { ok: false, reason: 'missing_secret' };
  if (!(typeof rawBody === 'string' || rawBody instanceof Uint8Array)) return { ok: false, reason: 'raw_body_required' };

  const header = readHeader(headers, DIGIO_SIGNATURE_HEADER);
  if (header === null) return { ok: false, reason: 'missing_signature' };
  const received = header.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(received)) return { ok: false, reason: 'malformed_signature' };
  const receivedBytes = Buffer.from(received, 'hex');

  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  let matched = false;
  for (const key of secrets) {
    const expected = createHmac('sha256', key).update(body).digest();
    // No early exit: every configured secret is compared.
    matched = timingSafeEqual(expected, receivedBytes) || matched;
  }
  if (!matched) return { ok: false, reason: 'signature_mismatch' };

  let createdAt = null;
  try {
    createdAt = parseDigioTime(JSON.parse(Buffer.from(body).toString('utf8')).created_at);
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
  if (options.toleranceSeconds !== undefined) {
    if (!createdAt) return { ok: false, reason: 'missing_timestamp' };
    const nowMs = new Date(options.now ? options.now() : Date.now()).getTime();
    const ageMs = nowMs - Date.parse(createdAt);
    // Allow 5 minutes of clock skew into the future.
    if (ageMs > options.toleranceSeconds * 1000 || ageMs < -300_000) return { ok: false, reason: 'timestamp_out_of_range' };
  }
  return { ok: true, createdAt };
}

/**
 * Compute the checksum Digio would send for a body (for tests and local tooling).
 * @param {Buffer | Uint8Array | string} rawBody
 * @param {string} secret
 */
export function computeWebhookChecksum(rawBody, secret) {
  return createHmac('sha256', secret)
    .update(typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody)
    .digest('hex');
}

/**
 * @typedef {{
 *   provider: 'digio', id: string, type: string, providerEvent: string, occurredAt: string | null,
 *   entities: string[], documentId: string | null, documentStatus: string | null, completed: boolean,
 *   signer: { identifier: string | null } | null, document: ReturnType<typeof normalizeDocument> | null,
 *   error: { code: string | null, message: string | null } | null, validation: unknown,
 *   raw?: unknown }} DigioWebhookEvent
 */

/**
 * Normalise a verified webhook body. Unknown events (e.g. NACH events sharing the same webhook
 * group) come back with type 'unknown' so callers can acknowledge and ignore them.
 * @param {string | Buffer | Uint8Array | Record<string, any>} body parsed JSON or raw bytes
 * @param {{ includeRaw?: boolean }} [options] raw payloads include Aadhaar demographics; off by default
 * @returns {DigioWebhookEvent}
 */
export function parseWebhook(body, options = {}) {
  const data = typeof body === 'string' || body instanceof Uint8Array ? JSON.parse(Buffer.from(body).toString('utf8')) : body;
  if (!data || typeof data !== 'object' || typeof data.id !== 'string' || typeof data.event !== 'string') {
    throw new TypeError('Not a Digio webhook: expected { id, event, payload }');
  }
  const providerEvent = data.event.toLowerCase();
  const doc = data.payload?.document ?? null;
  const isFullDocument = Boolean(doc && Array.isArray(doc.signing_parties));
  const document = isFullDocument ? normalizeDocument(doc) : null;
  const signerIdentifier = doc?.signer_identifier ?? (isFullDocument ? doc.others?.last_signed_by ?? null : null);
  const completed = Boolean(document && (document.status === 'completed' || doc.others?.has_all_signed === true));

  let type = EVENT_TYPES[providerEvent] ?? 'unknown';
  if (type === 'esign.signer.signed' && completed) type = 'esign.document.completed';

  const hasError = doc && (doc.error_code || doc.error_message);
  return {
    provider: 'digio',
    id: data.id,
    type,
    providerEvent,
    occurredAt: parseDigioTime(data.created_at),
    entities: Array.isArray(data.entities) ? data.entities : [],
    documentId: typeof doc?.id === 'string' ? doc.id : null,
    documentStatus: document?.status ?? null,
    completed,
    signer: signerIdentifier ? signerFrom(document, signerIdentifier) : null,
    document,
    error: hasError ? { code: doc.error_code ?? null, message: doc.error_message ?? null } : null,
    validation: doc?.validation_results ? summariseValidation(doc.validation_results) : null,
    ...(options.includeRaw ? { raw: data } : {}),
  };
}

/**
 * @param {ReturnType<typeof normalizeDocument> | null} document
 * @param {string} identifier
 */
function signerFrom(document, identifier) {
  const match = document?.signers.find((s) => s.identifier === identifier);
  return match ?? { ...normalizeSigner({ identifier }), status: 'unknown' };
}

/**
 * Keep only the outcome of signature verification rules; actual/expected values can hold
 * Aadhaar digits, names and birth years.
 * @param {Record<string, any>} results
 */
function summariseValidation(results) {
  return {
    overallResult: results.overallResult ?? null,
    rules: Array.isArray(results.ruleResults)
      ? results.ruleResults.map((rule) => ({
          ruleId: rule.rule_id ?? rule.ruleId ?? null,
          result: rule.result ?? null,
          failedFields: Array.isArray(rule.conditions)
            ? rule.conditions.filter((c) => c.result === 'FAIL').map((c) => c.field)
            : [],
        }))
      : [],
  };
}

/**
 * Optional network check on top of the HMAC: is the caller one of Digio's published webhook IPs?
 * @param {string} ip remote address (IPv4, or IPv4-mapped IPv6)
 * @param {'sandbox' | 'production'} environment
 */
export function isDigioWebhookIp(ip, environment) {
  const plain = String(ip ?? '').replace(/^::ffff:/, '');
  return DIGIO_ENVIRONMENTS[environment]?.webhookIps.includes(plain) ?? false;
}

/**
 * @param {Headers | Record<string, string | string[] | undefined>} headers
 * @param {string} name lower-case header name
 * @returns {string | null}
 */
function readHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return /** @type {Headers} */ (headers).get(name);
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    if (Array.isArray(value)) return value.length === 1 ? value[0] : null; // duplicates are ambiguous
    return typeof value === 'string' ? value : null;
  }
  return null;
}
