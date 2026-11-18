import { createHmac, timingSafeEqual } from 'node:crypto';
import { DEFAULT_WEBHOOK_TOLERANCE_SEC } from './config.js';
import { StripeSignatureError } from './errors.js';

/**
 * Stripe webhook signatures (docs.stripe.com/webhooks#verify-manually, checked 2026-11-05):
 *   Stripe-Signature: t=1492774577,v1=<hex>[,v1=<hex>...][,v0=<hex>]
 *   v1 = hex(HMAC-SHA256(key = endpoint secret "whsec_..." as UTF-8, message = `${t}.${rawBody}`))
 * Only v1 counts (v0 is a fake test scheme; ignoring other schemes prevents downgrade attacks).
 * Several v1 values appear while an endpoint secret is being rolled: any match is enough.
 * Replay protection: reject when |now - t| > tolerance (Stripe's libraries default to 300 s).
 */

export const SIGNATURE_HEADER = 'stripe-signature';
const SCHEME = 'v1';
const HEX_SHA256 = /^[0-9a-f]{64}$/i;

/**
 * Splits the header into its timestamp and v1 signatures. Unknown elements are dropped.
 * @param {string} header
 * @returns {{ timestamp: number|null, signatures: string[] }}
 */
export function parseSignatureHeader(header) {
  let timestamp = null;
  /** @type {string[]} */
  const signatures = [];
  for (const element of String(header).split(',')) {
    const at = element.indexOf('=');
    if (at < 1) continue;
    const prefix = element.slice(0, at).trim();
    const value = element.slice(at + 1).trim();
    if (prefix === 't' && timestamp === null && /^\d{1,12}$/.test(value)) timestamp = Number(value);
    else if (prefix === SCHEME && value) signatures.push(value);
  }
  return { timestamp, signatures };
}

/**
 * @param {Buffer|Uint8Array|string} rawBody
 * @returns {Buffer}
 */
function bodyBytes(rawBody) {
  if (Buffer.isBuffer(rawBody)) return rawBody;
  if (rawBody instanceof Uint8Array) return Buffer.from(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength);
  if (typeof rawBody === 'string') return Buffer.from(rawBody, 'utf8');
  throw new StripeSignatureError(
    'Webhook body must be the raw request bytes (Buffer or string), not parsed JSON',
    'invalid_body',
  );
}

/**
 * Hex HMAC-SHA256 of `${timestamp}.${rawBody}`, exactly as Stripe computes it.
 * @param {number|string} timestamp Unix seconds
 * @param {Buffer|Uint8Array|string} rawBody
 * @param {string} secret whsec_...
 */
export function computeSignature(timestamp, rawBody, secret) {
  return createHmac('sha256', secret).update(`${timestamp}.`, 'utf8').update(bodyBytes(rawBody)).digest('hex');
}

/**
 * Reads the Stripe-Signature header from a Headers object, a Node/Express headers object
 * (any key case), or the header value itself.
 * @param {Headers|Record<string, string|string[]|undefined>|string|undefined|null} headers
 * @returns {string|undefined}
 */
export function getSignatureHeader(headers) {
  if (typeof headers === 'string') return headers;
  if (!headers || typeof headers !== 'object') return undefined;
  if (typeof (/** @type {any} */ (headers).get) === 'function') {
    return /** @type {Headers} */ (headers).get(SIGNATURE_HEADER) ?? undefined;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== SIGNATURE_HEADER) continue;
    return Array.isArray(value) ? value.join(',') : value;
  }
  return undefined;
}

/** Constant-time comparison of two hex SHA-256 digests. */
function digestsEqual(expectedHex, receivedHex) {
  if (!HEX_SHA256.test(receivedHex)) return false;
  return timingSafeEqual(Buffer.from(expectedHex, 'hex'), Buffer.from(receivedHex, 'hex'));
}

/**
 * Verifies a Stripe webhook. Throws StripeSignatureError (respond 400) when it fails.
 * @param {Buffer|Uint8Array|string} rawBody exact bytes received; never re-serialised JSON
 * @param {Headers|Record<string, string|string[]|undefined>|string} headers request headers, or the header value
 * @param {string|string[]} secret endpoint signing secret(s), whsec_...
 * @param {{ toleranceSec?: number, now?: () => number|Date }} [options]
 * @returns {{ timestamp: number, signedAt: string, secretIndex: number }}
 */
export function verifyWebhook(rawBody, headers, secret, options = {}) {
  const { toleranceSec = DEFAULT_WEBHOOK_TOLERANCE_SEC, now = Date.now } = options;
  const secrets = (Array.isArray(secret) ? secret : [secret]).filter((s) => typeof s === 'string' && s.length > 0);
  if (secrets.length === 0) throw new StripeSignatureError('No webhook signing secret configured', 'missing_secret');
  if (!Number.isFinite(toleranceSec) || toleranceSec <= 0) {
    // A tolerance of 0 disables replay protection, which Stripe warns against.
    throw new StripeSignatureError('Webhook tolerance must be a positive number of seconds', 'invalid_tolerance');
  }
  const body = bodyBytes(rawBody);
  const header = getSignatureHeader(headers);
  if (!header) throw new StripeSignatureError('Missing Stripe-Signature header', 'missing_header');

  const { timestamp, signatures } = parseSignatureHeader(header);
  if (timestamp === null) throw new StripeSignatureError('Stripe-Signature has no valid timestamp', 'malformed_header');
  if (signatures.length === 0) throw new StripeSignatureError('Stripe-Signature has no v1 signature', 'no_v1_signature');

  let secretIndex = -1;
  secrets.forEach((candidate, index) => {
    const expected = computeSignature(timestamp, body, candidate);
    // Compare against every signature without stopping early.
    const matched = signatures.reduce((found, received) => digestsEqual(expected, received) || found, false);
    if (matched && secretIndex === -1) secretIndex = index;
  });
  if (secretIndex === -1) {
    throw new StripeSignatureError('Webhook signature does not match the payload', 'signature_mismatch');
  }

  const nowValue = now();
  const nowSec = Math.floor((nowValue instanceof Date ? nowValue.getTime() : nowValue) / 1000);
  if (Math.abs(nowSec - timestamp) > toleranceSec) {
    throw new StripeSignatureError('Webhook timestamp is outside the tolerance window', 'timestamp_outside_tolerance');
  }
  return { timestamp, signedAt: new Date(timestamp * 1000).toISOString(), secretIndex };
}

/**
 * Builds a Stripe-Signature header for tests and local tools (same idea as stripe-node's
 * generateTestHeaderString). Never use it to "sign" anything you then trust.
 * @param {{ payload: Buffer|string, secret: string, timestamp: number, scheme?: string }} input
 */
export function generateTestSignatureHeader({ payload, secret, timestamp, scheme = SCHEME }) {
  return `t=${timestamp},${scheme}=${computeSignature(timestamp, payload, secret)}`;
}
