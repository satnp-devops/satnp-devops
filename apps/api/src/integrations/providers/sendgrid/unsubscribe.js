import { createHmac, timingSafeEqual } from 'node:crypto';
import { parseMultipart } from './multipart.js';

/**
 * One-click unsubscribe (RFC 8058) helpers. Provider-neutral: any email adapter can use them.
 *
 * RFC 8058 rules implemented here:
 * - List-Unsubscribe MUST contain one HTTPS URI (a mailto: URI may be added as well).
 * - List-Unsubscribe-Post MUST be exactly "List-Unsubscribe=One-Click".
 * - The HTTPS URI SHOULD carry an opaque, hard-to-forge identifier: `createUnsubscribeToken`.
 * - The receiver POSTs "List-Unsubscribe=One-Click" as multipart/form-data or
 *   application/x-www-form-urlencoded, without cookies or auth: `isOneClickUnsubscribePost`.
 * - The endpoint MUST NOT redirect, and the headers MUST be covered by a DKIM signature
 *   (SendGrid signs with the authenticated domain; see docs/providers/sendgrid.md).
 */

export const ONE_CLICK_POST_VALUE = 'List-Unsubscribe=One-Click';

/**
 * @param {{ url: string, mailto?: string }} input
 * @returns {{ 'List-Unsubscribe': string, 'List-Unsubscribe-Post': string }}
 */
export function buildListUnsubscribeHeaders({ url, mailto }) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new TypeError('Unsubscribe url must be an absolute https URL');
  }
  if (parsed.protocol !== 'https:') throw new TypeError('Unsubscribe url must use https (RFC 8058)');
  if (/[<>,\s]/.test(parsed.href)) throw new TypeError('Unsubscribe url contains characters not allowed in the header');
  const uris = [];
  if (mailto) {
    const address = mailto.replace(/^mailto:/i, '');
    if (!/^[^\s<>@,]+@[^\s<>@,]+$/.test(address.split('?')[0])) throw new TypeError('Unsubscribe mailto is not an email address');
    uris.push(`<mailto:${address}>`);
  }
  uris.push(`<${parsed.href}>`);
  return { 'List-Unsubscribe': uris.join(', '), 'List-Unsubscribe-Post': ONE_CLICK_POST_VALUE };
}

/**
 * True when a POST body is the RFC 8058 one-click request. Anything else (for example a GET from
 * a link scanner, or a form with other values) must not unsubscribe without confirmation.
 * @param {Buffer|string} rawBody
 * @param {string} contentType
 */
export function isOneClickUnsubscribePost(rawBody, contentType) {
  const type = (contentType ?? '').toLowerCase();
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ''), 'utf8');
  if (type.startsWith('application/x-www-form-urlencoded')) {
    return new URLSearchParams(body.toString('utf8').trim()).get('List-Unsubscribe') === 'One-Click';
  }
  if (type.startsWith('multipart/form-data')) {
    try {
      const { fields } = parseMultipart(body, contentType);
      return fields['List-Unsubscribe']?.trim() === 'One-Click';
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Opaque token for the unsubscribe URL: base64url(payload).base64url(HMAC-SHA256).
 * The payload is JSON (keep it small and free of PII: ids, not email addresses).
 * @param {Record<string, string|number>} payload e.g. { c: contactId, l: listOrTopic }
 * @param {string} secret at least 32 characters, from config, never logged
 */
export function createUnsubscribeToken(payload, secret) {
  assertSecret(secret);
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${sign(body, secret)}`;
}

/**
 * @param {string} token
 * @param {string} secret
 * @returns {Record<string, string|number> | null} the payload, or null when invalid
 */
export function verifyUnsubscribeToken(token, secret) {
  assertSecret(secret);
  if (typeof token !== 'string' || token.length > 2048) return null;
  const [body, mac, extra] = token.split('.');
  if (!body || !mac || extra !== undefined) return null;
  const expected = Buffer.from(sign(body, secret), 'utf8');
  const given = Buffer.from(mac, 'utf8');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
}

/** @param {string} body @param {string} secret */
function sign(body, secret) {
  return createHmac('sha256', secret).update(`list-unsubscribe.v1.${body}`).digest('base64url');
}

/** @param {unknown} secret */
function assertSecret(secret) {
  if (typeof secret !== 'string' || secret.length < 32) throw new TypeError('Unsubscribe signing secret must be at least 32 characters');
}
