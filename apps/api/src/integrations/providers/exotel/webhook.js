import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { decodePayload, str } from './decode.js';
import { isIpOrCidr } from './config.js';

/**
 * Webhook authentication for Exotel.
 *
 * Exotel does not sign callbacks (no signature header, no HMAC) and does not publish its source
 * IP ranges in its docs (checked 2026-11-05). So we authenticate the URL we hand to Exotel:
 *
 *  1. Signed callback URL (per call, Connect API StatusCallback):
 *       <base>?phx_ref=<ref>&phx_exp=<unix seconds>&phx_sig=<sig>
 *       sig = base64url( HMAC-SHA256( key = webhookSecret (UTF-8),
 *                                     msg = "exotel-cb.v1\n" + ref + "\n" + exp ) )
 *     The same ref is sent as CustomField, which Exotel echoes in extended callbacks, so a body
 *     whose CustomField differs from phx_ref is rejected. exp gives the timestamp tolerance.
 *  2. Static token (flow URLs pasted into the Exotel dashboard: Passthru, Connect applet):
 *       <base>?phx_token=<token>,  token = base64url( HMAC-SHA256( webhookSecret, "exotel-static.v1\n" + purpose ) )
 *  3. Optional source-IP allow-list (CIDRs from Exotel support), checked in addition to the token,
 *     or alone when no secret is configured.
 *
 * Comparisons are constant-time. The body itself is NOT authenticated by Exotel; treat callbacks
 * as notifications and confirm money- or SLA-relevant facts with getCall() (Call Details API).
 */

export const CALLBACK_SIGNATURE_VERSION = 'exotel-cb.v1';
export const STATIC_TOKEN_VERSION = 'exotel-static.v1';
export const PARAMS = Object.freeze({ ref: 'phx_ref', exp: 'phx_exp', sig: 'phx_sig', token: 'phx_token' });
const REF_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** @param {string} secret @param {string} message */
function hmac(secret, message) {
  return createHmac('sha256', Buffer.from(secret, 'utf8')).update(message, 'utf8').digest('base64url');
}

/**
 * Constant-time string comparison that also hides length differences.
 * @param {string} a @param {string} b
 */
export function safeEqual(a, b) {
  const ha = createHash('sha256').update(String(a), 'utf8').digest();
  const hb = createHash('sha256').update(String(b), 'utf8').digest();
  return timingSafeEqual(ha, hb) && String(a).length === String(b).length;
}

/** @param {string | string[] | undefined | null} secret @returns {string[]} */
function secretList(secret) {
  if (!secret) return [];
  return (Array.isArray(secret) ? secret : [secret]).filter((s) => typeof s === 'string' && s.length > 0);
}

/**
 * @param {string} secret
 * @param {string} ref
 * @param {number} exp unix seconds
 */
export function computeCallbackSignature(secret, ref, exp) {
  return hmac(secret, `${CALLBACK_SIGNATURE_VERSION}\n${ref}\n${exp}`);
}

/** @param {string} secret @param {string} [purpose] */
export function computeStaticToken(secret, purpose = 'passthru') {
  return hmac(secret, `${STATIC_TOKEN_VERSION}\n${purpose}`);
}

/**
 * Adds phx_ref/phx_exp/phx_sig to a callback URL.
 * @param {string} baseUrl https URL
 * @param {string} secret
 * @param {{ ref: string, expiresAt: number }} input expiresAt in unix seconds
 */
export function signCallbackUrl(baseUrl, secret, { ref, expiresAt }) {
  if (!REF_PATTERN.test(ref)) throw new TypeError('ref must be 1-128 chars of [A-Za-z0-9._:-]');
  if (!Number.isInteger(expiresAt) || expiresAt <= 0) throw new TypeError('expiresAt must be unix seconds');
  const url = new URL(baseUrl);
  for (const key of Object.values(PARAMS)) url.searchParams.delete(key);
  url.searchParams.set(PARAMS.ref, ref);
  url.searchParams.set(PARAMS.exp, String(expiresAt));
  url.searchParams.set(PARAMS.sig, computeCallbackSignature(secret, ref, expiresAt));
  return url.toString();
}

/**
 * Adds phx_token to a URL you paste into an Exotel flow (Passthru, Connect applet pass-through).
 * @param {string} baseUrl
 * @param {string} secret
 * @param {{ purpose?: string, inPath?: boolean }} [options] inPath appends the token as the last
 *   path segment instead of a query parameter (use if a flow rejects URLs that already have a query)
 */
export function buildFlowUrl(baseUrl, secret, { purpose = 'passthru', inPath = false } = {}) {
  const url = new URL(baseUrl);
  const token = computeStaticToken(secret, purpose);
  url.searchParams.delete(PARAMS.token);
  if (inPath) url.pathname = `${url.pathname.replace(/\/+$/, '')}/${token}`;
  else url.searchParams.set(PARAMS.token, token);
  return url.toString();
}

/**
 * @typedef {object} VerifyOptions
 * @property {string} [url] request URL as received (full URL or path+query, e.g. req.originalUrl). Required for token schemes.
 * @property {string | null} [remoteIp] client IP as resolved by your trusted proxy chain (e.g. req.ip)
 * @property {string[]} [allowedIps] IPs/CIDRs; when non-empty the source IP must match
 * @property {number | Date} [now] current time (ms since epoch or Date); default Date.now()
 * @property {number} [clockSkewSeconds] grace after phx_exp, default 300
 * @property {string} [purpose] expected static-token purpose, default 'passthru'
 * @property {string} [token] static token taken from the path by your router (buildFlowUrl with inPath)
 */

/**
 * @typedef {{ valid: true, scheme: 'signed_url' | 'static_token' | 'ip_only', ref: string | null, expiresAt: number | null, ipChecked: boolean }
 *   | { valid: false, reason: string }} VerifyResult
 */

/**
 * Verifies an incoming Exotel request. Fails closed: with no secret and no IP list it rejects.
 * @param {string | Buffer | Uint8Array | null | undefined} rawBody exact body bytes as received ('' for GET)
 * @param {Record<string, string | string[] | undefined> | Headers | null | undefined} headers
 * @param {string | string[] | null | undefined} secret webhook secret(s); arrays allow rotation
 * @param {VerifyOptions} [options]
 * @returns {VerifyResult}
 */
export function verifyWebhook(rawBody, headers, secret, options = {}) {
  const secrets = secretList(secret);
  const allowedIps = options.allowedIps ?? [];
  if (!secrets.length && !allowedIps.length) return { valid: false, reason: 'no_verification_configured' };

  let ipChecked = false;
  if (allowedIps.length) {
    if (!ipAllowed(options.remoteIp, allowedIps)) return { valid: false, reason: 'ip_not_allowed' };
    ipChecked = true;
  }
  if (!secrets.length) return { valid: true, scheme: 'ip_only', ref: null, expiresAt: null, ipChecked };

  if (!options.url && options.token === undefined) return { valid: false, reason: 'url_required' };
  let params;
  try {
    params = new URL(options.url ?? '/', 'https://placeholder.invalid').searchParams;
  } catch {
    return { valid: false, reason: 'url_invalid' };
  }

  const token = options.token ?? params.get(PARAMS.token);
  const sig = params.get(PARAMS.sig);
  if (token !== null && sig === null) {
    const purpose = options.purpose ?? 'passthru';
    const ok = secrets.some((s) => safeEqual(token, computeStaticToken(s, purpose)));
    return ok
      ? { valid: true, scheme: 'static_token', ref: null, expiresAt: null, ipChecked }
      : { valid: false, reason: 'token_mismatch' };
  }
  if (sig === null) return { valid: false, reason: 'token_missing' };
  return verifySignedUrl({ params, sig, secrets, rawBody, headers, options, ipChecked });
}

/**
 * @param {{ params: URLSearchParams, sig: string, secrets: string[], rawBody: unknown, headers: unknown, options: VerifyOptions, ipChecked: boolean }} input
 * @returns {VerifyResult}
 */
function verifySignedUrl({ params, sig, secrets, rawBody, headers, options, ipChecked }) {
  const ref = params.get(PARAMS.ref);
  const expText = params.get(PARAMS.exp);
  if (!ref || !REF_PATTERN.test(ref) || !expText || !/^\d{1,12}$/.test(expText)) {
    return { valid: false, reason: 'signature_params_invalid' };
  }
  const exp = Number(expText);
  const ok = secrets.some((s) => safeEqual(sig, computeCallbackSignature(s, ref, exp)));
  if (!ok) return { valid: false, reason: 'signature_mismatch' };

  const nowMs = options.now instanceof Date ? options.now.getTime() : (options.now ?? Date.now());
  const skew = options.clockSkewSeconds ?? 300;
  if (Math.floor(nowMs / 1000) > exp + skew) return { valid: false, reason: 'expired' };

  // Bind the body to the URL: extended callbacks echo CustomField, which we set to ref.
  let customField = null;
  try {
    const payload = decodePayload(rawBody ?? '', { contentType: headerValue(headers, 'content-type') });
    customField = str(payload.CustomField);
  } catch {
    return { valid: false, reason: 'body_unreadable' };
  }
  if (customField !== null && !safeEqual(customField, ref)) return { valid: false, reason: 'ref_mismatch' };
  return { valid: true, scheme: 'signed_url', ref, expiresAt: exp, ipChecked };
}

/**
 * @param {unknown} headers
 * @param {string} name lower-case header name
 * @returns {string | null}
 */
export function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof (/** @type {any} */ (headers).get) === 'function') return /** @type {Headers} */ (headers).get(name);
  for (const [key, value] of Object.entries(/** @type {Record<string, unknown>} */ (headers))) {
    if (key.toLowerCase() === name) return Array.isArray(value) ? String(value[0]) : String(value);
  }
  return null;
}

/**
 * @param {string | null | undefined} remoteIp
 * @param {string[]} allowed IPs/CIDRs
 */
export function ipAllowed(remoteIp, allowed) {
  if (!remoteIp) return false;
  let ip = String(remoteIp).trim();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) ip = mapped[1];
  const family = isIP(ip);
  if (!family) return false;
  const list = new BlockList();
  for (const entry of allowed) {
    if (!isIpOrCidr(entry)) continue;
    const [address, prefix] = entry.trim().split('/');
    const type = isIP(address) === 4 ? 'ipv4' : 'ipv6';
    if (prefix === undefined) list.addAddress(address, type);
    else list.addSubnet(address, Number(prefix), type);
  }
  return list.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}
