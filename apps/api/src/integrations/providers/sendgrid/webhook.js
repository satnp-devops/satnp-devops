import { createPublicKey, verify as cryptoVerify } from 'node:crypto';

/**
 * Signed Event Webhook (and signed Inbound Parse) verification.
 *
 * Scheme, from SendGrid's "Event Webhook Security Features" page and the official
 * sendgrid-nodejs EventWebhook helper:
 * - headers: X-Twilio-Email-Event-Webhook-Signature (base64 DER-encoded ECDSA signature) and
 *   X-Twilio-Email-Event-Webhook-Timestamp (unix seconds, as sent)
 * - signed bytes: timestamp header value + raw request body, exactly as received
 * - algorithm: ECDSA over NIST P-256 with SHA-256; key is the "Verification Key" from the
 *   webhook's security settings (base64 DER SubjectPublicKeyInfo; PEM is accepted too)
 * - SendGrid defines no timestamp tolerance. `toleranceSeconds` optionally rejects old or
 *   future timestamps; off by default because SendGrid retries for up to 24 hours and it is
 *   not documented whether a retry carries a fresh timestamp.
 *
 * ECDSA verification is done by OpenSSL (crypto.verify); there is no secret-dependent byte
 * comparison in this code to make constant-time.
 */

export const SIGNATURE_HEADER = 'X-Twilio-Email-Event-Webhook-Signature';
export const TIMESTAMP_HEADER = 'X-Twilio-Email-Event-Webhook-Timestamp';

/** @typedef {'missing_signature'|'missing_timestamp'|'invalid_timestamp'|'timestamp_out_of_tolerance'|'invalid_public_key'|'malformed_signature'|'signature_mismatch'|'invalid_body'} VerifyFailure */
/** @typedef {{ ok: true, timestamp: number } | { ok: false, reason: VerifyFailure, timestamp?: number }} VerifyResult */

const keyCache = new Map();

/**
 * Turn the dashboard's verification key (base64 DER SPKI) or a PEM into a P-256 KeyObject.
 * @param {string} publicKey
 * @returns {import('node:crypto').KeyObject}
 */
export function loadPublicKey(publicKey) {
  if (typeof publicKey !== 'string' || publicKey.trim() === '') throw new TypeError('Public key is required');
  const text = publicKey.trim();
  const cached = keyCache.get(text);
  if (cached) return cached;
  const key = text.includes('-----BEGIN')
    ? createPublicKey({ key: text, format: 'pem' })
    : createPublicKey({ key: Buffer.from(text.replace(/\s+/g, ''), 'base64'), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new TypeError('SendGrid webhook keys are ECDSA P-256');
  }
  if (keyCache.size > 32) keyCache.clear();
  keyCache.set(text, key);
  return key;
}

/**
 * Read a header from a plain object (any case), a Headers instance or a Map.
 * @param {Record<string, string|string[]|undefined> | Headers | Map<string, string>} headers
 * @param {string} name
 * @returns {string|undefined}
 */
export function headerValue(headers, name) {
  if (!headers) return undefined;
  if (typeof (/** @type {any} */ (headers).get) === 'function') {
    const v = /** @type {any} */ (headers).get(name) ?? /** @type {any} */ (headers).get(name.toLowerCase());
    return v == null ? undefined : String(v);
  }
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return Array.isArray(value) ? value[0] : value == null ? undefined : String(value);
  }
  return undefined;
}

/**
 * Verify a signed webhook request. Pass the raw body bytes, before any JSON or multipart parsing.
 * @param {Buffer|Uint8Array|string} rawBody
 * @param {Record<string, string|string[]|undefined> | Headers | Map<string, string>} headers
 * @param {string} publicKey verification key (base64 DER SPKI or PEM)
 * @param {{ toleranceSeconds?: number|null, now?: () => number }} [options]
 * @returns {VerifyResult}
 */
export function verifyWebhook(rawBody, headers, publicKey, { toleranceSeconds = null, now = Date.now } = {}) {
  const signature = headerValue(headers, SIGNATURE_HEADER)?.trim();
  const timestampText = headerValue(headers, TIMESTAMP_HEADER)?.trim();
  if (!signature) return { ok: false, reason: 'missing_signature' };
  if (!timestampText) return { ok: false, reason: 'missing_timestamp' };
  if (!/^\d{1,12}$/.test(timestampText)) return { ok: false, reason: 'invalid_timestamp' };
  const timestamp = Number(timestampText);
  if (toleranceSeconds != null && Math.abs(Math.floor(now() / 1000) - timestamp) > toleranceSeconds) {
    return { ok: false, reason: 'timestamp_out_of_tolerance', timestamp };
  }
  let body;
  if (Buffer.isBuffer(rawBody)) body = rawBody;
  else if (rawBody instanceof Uint8Array) body = Buffer.from(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength);
  else if (typeof rawBody === 'string') body = Buffer.from(rawBody, 'utf8');
  else return { ok: false, reason: 'invalid_body' };

  let key;
  try {
    key = loadPublicKey(publicKey);
  } catch {
    return { ok: false, reason: 'invalid_public_key' };
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signature) || signature.length > 200) return { ok: false, reason: 'malformed_signature' };
  const der = Buffer.from(signature, 'base64');
  let valid;
  try {
    valid = cryptoVerify('sha256', Buffer.concat([Buffer.from(timestampText, 'utf8'), body]), { key, dsaEncoding: 'der' }, der);
  } catch {
    return { ok: false, reason: 'malformed_signature', timestamp };
  }
  return valid ? { ok: true, timestamp } : { ok: false, reason: 'signature_mismatch', timestamp };
}
