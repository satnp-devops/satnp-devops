import { createHmac } from 'node:crypto';
import { decrypt, encrypt } from '../../lib/crypto.js';

/**
 * Connection credentials are stored as one AES-256-GCM ciphertext (lib/crypto.js, key from
 * APP_ENCRYPTION_KEY). The plaintext is JSON that also carries the connection id, and decryption
 * refuses a ciphertext whose id doesn't match the row it was read from, so copying one company's
 * encrypted credentials onto another connection doesn't work. GCM's tag makes tampering fail too.
 *
 * Decrypt only just before building an adapter; never log, audit or return the result.
 */

const VERSION = 1;

export function encryptCredentials(connectionId, credentials, key) {
  if (!connectionId) throw new Error('encryptCredentials needs the connection id');
  return encrypt(JSON.stringify({ v: VERSION, c: connectionId, s: credentials ?? {} }), key);
}

export function decryptCredentials(connectionId, payload, key) {
  if (!payload) return {};
  let parsed;
  try {
    parsed = JSON.parse(decrypt(payload, key));
  } catch {
    throw new Error('Connection credentials could not be decrypted (wrong APP_ENCRYPTION_KEY or a damaged value)');
  }
  if (parsed?.v !== VERSION || parsed.c !== connectionId || typeof parsed.s !== 'object' || parsed.s === null) {
    throw new Error('Connection credentials belong to a different connection');
  }
  return parsed.s;
}

/**
 * A stable per-connection secret derived from the platform key, for mocks and for webhook
 * tokens a provider lets us choose (MSG91 headers, Google channel tokens). Never stored.
 */
export function deriveConnectionSecret(connectionId, purpose, key) {
  return createHmac('sha256', key).update(`phoenix-integrations:v1:${purpose}:${connectionId}`).digest('base64url');
}
