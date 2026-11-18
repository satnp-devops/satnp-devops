import { createHmac } from 'node:crypto';

/**
 * Shared Key authorization for the Blob service, version 2009-09-19 and later
 * (Microsoft Learn, "Authorize with Shared Key", checked 2026-11-05).
 *
 * StringToSign = VERB \n Content-Encoding \n Content-Language \n Content-Length \n Content-MD5 \n
 *                Content-Type \n Date \n If-Modified-Since \n If-Match \n If-None-Match \n
 *                If-Unmodified-Since \n Range \n CanonicalizedHeaders CanonicalizedResource
 *
 * Content-Length is the empty string when it is zero (version 2015-02-21 and later).
 * We always send x-ms-date, so the Date line is empty.
 */

const STANDARD_HEADERS = [
  'content-encoding',
  'content-language',
  'content-length',
  'content-md5',
  'content-type',
  'date',
  'if-modified-since',
  'if-match',
  'if-none-match',
  'if-unmodified-since',
  'range',
];

/** @param {Record<string, string | number | undefined>} headers */
function lowerCaseHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (value !== undefined && value !== null) out[name.toLowerCase()] = String(value);
  }
  return out;
}

/** Replace runs of linear whitespace with one space, except inside quoted strings, then trim. */
export function collapseWhitespace(value) {
  let out = '';
  let inQuotes = false;
  let pendingSpace = false;
  for (const ch of String(value)) {
    if (ch === '"') inQuotes = !inQuotes;
    if (!inQuotes && /\s/.test(ch)) {
      pendingSpace = true;
      continue;
    }
    if (pendingSpace && out) out += ' ';
    pendingSpace = false;
    out += ch;
  }
  return out;
}

/**
 * CanonicalizedHeaders: every x-ms-* header, lowercased, sorted by name, "name:value\n".
 * @param {Record<string, string | number | undefined>} headers
 */
export function canonicalizeHeaders(headers) {
  const lower = lowerCaseHeaders(headers);
  return Object.keys(lower)
    .filter((name) => name.startsWith('x-ms-'))
    .sort()
    .map((name) => `${name}:${collapseWhitespace(lower[name])}\n`)
    .join('');
}

/** Split a URL string into its still-encoded path and raw query without normalising anything. */
export function splitUrl(url) {
  const match = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*([^?#]*)(?:\?([^#]*))?/i.exec(url);
  if (!match) throw new TypeError('Expected an absolute URL');
  return { path: match[1] || '/', query: match[2] ?? '' };
}

/** @param {string} component */
function decodeQueryComponent(component) {
  try {
    return decodeURIComponent(component);
  } catch {
    return component;
  }
}

/**
 * CanonicalizedResource (2009-09-19 and later): "/" + account + encoded URI path, then one
 * "\nname:value" line per query parameter (names lowercased and sorted; values URL-decoded,
 * sorted and comma-joined when a name repeats).
 * @param {string} accountName
 * @param {string} url absolute request URL exactly as it will be sent
 */
export function canonicalizeResource(accountName, url) {
  const { path, query } = splitUrl(url);
  let out = `/${accountName}${path}`;
  const params = new Map();
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const at = pair.indexOf('=');
    const name = decodeQueryComponent(at === -1 ? pair : pair.slice(0, at)).toLowerCase();
    const value = at === -1 ? '' : decodeQueryComponent(pair.slice(at + 1));
    if (!params.has(name)) params.set(name, []);
    params.get(name).push(value);
  }
  for (const name of [...params.keys()].sort()) {
    out += `\n${name}:${params.get(name).sort().join(',')}`;
  }
  return out;
}

/**
 * Build the exact string Azure expects us to sign.
 * @param {{ method: string, url: string, headers: Record<string, string | number | undefined>, accountName: string }} request
 */
export function buildSharedKeyStringToSign({ method, url, headers, accountName }) {
  const lower = lowerCaseHeaders(headers);
  const standard = STANDARD_HEADERS.map((name) => {
    const value = lower[name] ?? '';
    if (name === 'content-length' && (value === '0' || value === '')) return '';
    if (name === 'date' && lower['x-ms-date']) return '';
    return value;
  });
  return `${method.toUpperCase()}\n${standard.join('\n')}\n${canonicalizeHeaders(headers)}${canonicalizeResource(accountName, url)}`;
}

/**
 * Base64(HMAC-SHA256(UTF8(stringToSign), Base64Decode(accountKey)))
 * @param {string} stringToSign
 * @param {string} base64Key
 */
export function hmacSha256Base64(stringToSign, base64Key) {
  return createHmac('sha256', Buffer.from(base64Key, 'base64')).update(stringToSign, 'utf8').digest('base64');
}

/**
 * Authorization header value: "SharedKey <account>:<signature>".
 * @param {{ method: string, url: string, headers: Record<string, string | number | undefined>, accountName: string, accountKey: string }} request
 */
export function signSharedKey({ method, url, headers, accountName, accountKey }) {
  const stringToSign = buildSharedKeyStringToSign({ method, url, headers, accountName });
  return `SharedKey ${accountName}:${hmacSha256Base64(stringToSign, accountKey)}`;
}
