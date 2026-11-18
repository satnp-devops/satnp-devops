import { createHmac, randomBytes } from 'node:crypto';
import { safeEqual } from './crypto.js';

// Time-based one-time passwords (RFC 6238), compatible with Google Authenticator,
// Microsoft Authenticator, 1Password and similar apps.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input) {
  const clean = String(input).toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) throw new Error('Invalid base32 character');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
    value &= (1 << bits) - 1;
  }
  return Buffer.from(bytes);
}

export function hotp(key, counter, digits = 6) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', key).update(message).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function totp(key, { time = Date.now(), step = 30, digits = 6 } = {}) {
  return hotp(key, Math.floor(time / 1000 / step), digits);
}

/**
 * Check a code against the secret, allowing one step of clock drift either way.
 * Returns the matching time-step counter (for replay protection) or null.
 */
export function verifyTotp(secretBase32, token, { window = 1, time = Date.now(), step = 30, digits = 6 } = {}) {
  const code = String(token ?? '').replace(/\s+/g, '');
  if (!new RegExp(`^\\d{${digits}}$`).test(code)) return null;
  const key = base32Decode(secretBase32);
  const counter = Math.floor(time / 1000 / step);
  for (let drift = -window; drift <= window; drift += 1) {
    if (safeEqual(hotp(key, counter + drift, digits), code)) return counter + drift;
  }
  return null;
}

export const generateTotpSecret = (bytes = 20) => base32Encode(randomBytes(bytes));

export function otpauthUrl({ secret, account, issuer }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** One-time recovery codes like 7KQ2M-XD4PA. */
export function generateRecoveryCodes(count = 8) {
  return Array.from({ length: count }, () => {
    const raw = base32Encode(randomBytes(7)).slice(0, 10);
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

export const normaliseRecoveryCode = (code) => String(code).toUpperCase().replace(/[^A-Z2-7]/g, '');
