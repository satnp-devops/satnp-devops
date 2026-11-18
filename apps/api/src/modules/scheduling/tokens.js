import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env.js';

// Signed links for the public booking page. No session: the token in the URL is the credential.
//
//   booking link  /book/<token>          → a scheduling_booking_links row (public or personal)
//   manage link   /book/manage/<token>   → one booking (view, reschedule, cancel)
//
// A token is 44 bytes, base64url (59 characters):
//   version (1) · kind (1) · id (16, a uuid) · expiry (4, unix seconds, 0 = none) · nonce (6) · MAC (16)
// The MAC is HMAC-SHA256 over the first 28 bytes with a key derived from APP_ENCRYPTION_KEY,
// truncated to 128 bits. A forged or altered token fails the MAC before any database read; a valid
// one is still checked against its row (revoked links, rotated booking nonces, cancelled bookings).

const VERSION = 1;
const KINDS = Object.freeze({ link: 1, manage: 2 });
const BODY_BYTES = 28;
const MAC_BYTES = 16;
const TOKEN_BYTES = BODY_BYTES + MAC_BYTES;
const NONCE_BYTES = 6;

/** The signing key, derived once so the raw encryption key is never used for two purposes. */
let derivedKey = null;
function signingKey() {
  if (!derivedKey) derivedKey = createHmac('sha256', env.encryptionKey).update('phoenix.scheduling.links.v1').digest();
  return derivedKey;
}

/** For tests: sign with another key (a token signed elsewhere must not verify here). */
export function macWithKey(key, body) {
  return createHmac('sha256', key).update(body).digest().subarray(0, MAC_BYTES);
}

const mac = (body) => macWithKey(signingKey(), body);

const uuidToBytes = (uuid) => Buffer.from(uuid.replace(/-/g, ''), 'hex');
function bytesToUuid(bytes) {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A fresh random nonce for a booking's manage link (12 hex characters). */
export const newNonce = () => randomBytes(NONCE_BYTES).toString('hex');

/**
 * @param {{ kind: 'link' | 'manage', id: string, expiresAt?: Date | string | number | null, nonce?: string | null }} input
 * @returns {string}
 */
export function signToken({ kind, id, expiresAt = null, nonce = null }) {
  if (!KINDS[kind]) throw new Error(`Unknown token kind ${kind}`);
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Token ids are uuids');
  const body = Buffer.alloc(BODY_BYTES);
  body.writeUInt8(VERSION, 0);
  body.writeUInt8(KINDS[kind], 1);
  uuidToBytes(id).copy(body, 2);
  const exp = expiresAt == null ? 0 : Math.floor(new Date(expiresAt).getTime() / 1000);
  body.writeUInt32BE(Math.max(0, Math.min(exp, 0xffffffff)), 18);
  if (nonce) Buffer.from(nonce, 'hex').copy(body, 22, 0, NONCE_BYTES);
  return Buffer.concat([body, mac(body)]).toString('base64url');
}

/**
 * Check a token's signature, kind and expiry. Never throws.
 * @returns {{ ok: true, id: string, expiresAt: Date | null, nonce: string } | { ok: false, reason: 'invalid' | 'expired', id?: string }}
 */
export function verifyToken(token, kind, { now = Date.now() } = {}) {
  if (typeof token !== 'string' || token.length !== 59 || !/^[A-Za-z0-9_-]+$/.test(token)) return { ok: false, reason: 'invalid' };
  const raw = Buffer.from(token, 'base64url');
  if (raw.length !== TOKEN_BYTES) return { ok: false, reason: 'invalid' };
  const body = raw.subarray(0, BODY_BYTES);
  if (!timingSafeEqual(raw.subarray(BODY_BYTES), mac(body))) return { ok: false, reason: 'invalid' };
  if (body.readUInt8(0) !== VERSION || body.readUInt8(1) !== KINDS[kind]) return { ok: false, reason: 'invalid' };
  const id = bytesToUuid(body.subarray(2, 18));
  const exp = body.readUInt32BE(18);
  if (exp !== 0 && exp * 1000 <= now) return { ok: false, reason: 'expired', id };
  return { ok: true, id, expiresAt: exp ? new Date(exp * 1000) : null, nonce: body.subarray(22, 28).toString('hex') };
}

/** How long a booking's manage link works: until 30 days after the meeting ends. */
export const MANAGE_LINK_DAYS_AFTER = 30;

export function manageTokenFor(booking) {
  const end = new Date(booking.end_at).getTime();
  return signToken({ kind: 'manage', id: booking.id, nonce: booking.token_nonce, expiresAt: end + MANAGE_LINK_DAYS_AFTER * 86_400_000 });
}

export function linkTokenFor(link) {
  return signToken({ kind: 'link', id: link.id, expiresAt: link.expires_at ?? null });
}

/** Absolute URLs for the web app's public pages. */
export const bookingPageUrl = (token) => `${env.APP_URL}/book/${token}`;
export const managePageUrl = (token) => `${env.APP_URL}/book/manage/${token}`;
