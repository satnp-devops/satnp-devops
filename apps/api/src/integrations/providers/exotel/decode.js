import { ExotelWebhookError } from './errors.js';

/**
 * Decoding of the three body formats Exotel uses for callbacks, plus small value helpers.
 *  - application/json (StatusCallbackContentType=application/json)
 *  - multipart/form-data (StatusCallbackContentType=multipart/form-data)
 *  - query string / x-www-form-urlencoded (Passthru and Connect-applet URLs, older callbacks)
 * Bracketed keys such as `Legs[0][OnCallDuration]` are expanded into arrays/objects.
 */

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_BODY_CHARS = 1024 * 1024;

/**
 * @param {unknown} body raw body (string/Buffer/Uint8Array), parsed object, or URLSearchParams
 * @param {{ contentType?: string | null, query?: string | URLSearchParams | Record<string, unknown> | null }} [options]
 * @returns {Record<string, any>}
 */
export function decodePayload(body, { contentType = null, query = null } = {}) {
  const fromQuery = query ? decodeQuery(query) : {};
  const fromBody = decodeBody(body, contentType);
  return merge(fromQuery, fromBody);
}

/**
 * @param {unknown} body
 * @param {string | null} contentType
 * @returns {Record<string, any>}
 */
function decodeBody(body, contentType) {
  if (body === null || body === undefined) return {};
  if (body instanceof URLSearchParams) return fromPairs(body.entries());
  if (typeof body === 'object' && !(body instanceof Uint8Array)) return expandObject(/** @type {object} */ (body));
  const text = typeof body === 'string' ? body : Buffer.from(/** @type {Uint8Array} */ (body)).toString('utf8');
  if (text.length > MAX_BODY_CHARS) throw new ExotelWebhookError('Webhook body is too large');
  const trimmed = text.trim();
  if (!trimmed) return {};
  const type = String(contentType ?? '').toLowerCase();
  if (type.includes('multipart/form-data')) return parseMultipart(text, contentType ?? '');
  if (type.includes('json') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      return expandObject(parsed);
    } catch {
      throw new ExotelWebhookError('Webhook body is not valid JSON');
    }
  }
  return fromPairs(new URLSearchParams(trimmed).entries());
}

/** @param {string | URLSearchParams | Record<string, unknown>} query */
function decodeQuery(query) {
  if (query instanceof URLSearchParams) return fromPairs(query.entries());
  if (typeof query === 'string') return fromPairs(new URLSearchParams(query.replace(/^[^?]*\?/, '')).entries());
  return expandObject(query);
}

/**
 * Minimal multipart/form-data parser for text fields (Exotel sends no files).
 * @param {string} text
 * @param {string} contentType
 */
export function parseMultipart(text, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  if (!match) throw new ExotelWebhookError('multipart body without boundary');
  const boundary = `--${match[1] ?? match[2]}`;
  /** @type {Array<[string, string]>} */
  const pairs = [];
  for (const rawPart of text.split(boundary).slice(1)) {
    if (rawPart.startsWith('--')) break;
    const part = rawPart.replace(/^\r?\n/, '');
    const split = /\r?\n\r?\n/.exec(part);
    if (!split) continue;
    const head = part.slice(0, split.index);
    const name = /content-disposition:[^\r\n]*\bname="([^"]*)"/i.exec(head);
    if (!name || /\bfilename=/i.test(head)) continue;
    pairs.push([name[1], part.slice(split.index + split[0].length).replace(/\r?\n$/, '')]);
  }
  return fromPairs(pairs);
}

/**
 * Builds a nested object from flat pairs, expanding `a[0][b]` paths.
 * @param {Iterable<[string, unknown]>} pairs
 */
function fromPairs(pairs) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const [key, value] of pairs) setPath(out, splitKey(key), value);
  return out;
}

/** Expands bracketed keys of an already-parsed object (e.g. Express' urlencoded parser output). */
function expandObject(/** @type {object} */ input) {
  const out = {};
  for (const [key, value] of Object.entries(input)) setPath(out, splitKey(key), value);
  return out;
}

/** @param {string} key */
function splitKey(key) {
  const first = key.split('[')[0];
  const rest = [...key.slice(first.length).matchAll(/\[([^\]]*)\]/g)].map((m) => m[1]);
  return [first, ...rest];
}

/**
 * @param {Record<string, any>} target
 * @param {string[]} path
 * @param {unknown} value
 */
function setPath(target, path, value) {
  // Guards: prototype pollution, and huge indexes that would create giant sparse arrays.
  if (path.some((segment) => FORBIDDEN_KEYS.has(segment) || (/^\d+$/.test(segment) && Number(segment) > 1000))) {
    return;
  }
  let node = target;
  for (let i = 0; i < path.length - 1; i += 1) {
    const segment = path[i];
    const nextIsIndex = /^\d+$/.test(path[i + 1]);
    if (node[segment] === undefined || node[segment] === null || typeof node[segment] !== 'object') {
      node[segment] = nextIsIndex ? [] : {};
    }
    node = node[segment];
  }
  node[path[path.length - 1]] = value;
}

/** Body fields win over query fields. @param {Record<string, any>} a @param {Record<string, any>} b */
function merge(a, b) {
  return { ...a, ...b };
}

/**
 * Exotel sometimes sends the string "null" or "" for missing values.
 * @param {unknown} value
 * @returns {string | null}
 */
export function str(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (text === '' || text.toLowerCase() === 'null' || text.toLowerCase() === 'undefined') return null;
  return text;
}

/** @param {unknown} value @returns {number | null} */
export function int(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : null;
  const text = str(value);
  return text !== null && /^-?\d+$/.test(text) ? Number(text) : null;
}

/** @param {unknown} value @returns {unknown[]} */
export function list(value) {
  if (Array.isArray(value)) return value.filter((v) => v !== undefined);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .filter((k) => /^\d+$/.test(k))
      .sort((x, y) => Number(x) - Number(y))
      .map((k) => /** @type {any} */ (value)[k]);
  }
  return [];
}

/**
 * Converts an Exotel timestamp to ISO 8601 UTC. Exotel's "YYYY-MM-DD HH:mm:ss" strings carry no
 * zone; they are local to the account (IST for Indian accounts: the documented Passthru
 * placeholder "1970-01-01 05:30:00" is the Unix epoch in IST). That placeholder maps to null.
 * @param {unknown} value
 * @param {string} offset e.g. '+05:30'
 * @returns {string | null}
 */
export function toUtcIso(value, offset) {
  const text = str(value);
  if (!text || text.startsWith('0000-00-00')) return null;
  let ms;
  const local = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?$/.exec(text);
  const rfc = /^[A-Z][a-z]{2}, \d{1,2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2}$/.exec(text);
  if (local) ms = Date.parse(`${local[1]}T${local[2]}${local[3] ?? ''}${offset}`);
  else if (rfc) ms = Date.parse(`${text} ${offset.replace(':', '')}`);
  else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(text)) ms = Date.parse(text);
  else ms = Number.NaN;
  if (Number.isNaN(ms) || ms <= 0) return null;
  return new Date(ms).toISOString();
}

/**
 * Converts a decimal price string ("1.500") into integer minor units using the currency's
 * exponent (INR has 2). Rounds half away from zero.
 * @param {unknown} value
 * @param {string} currency
 * @returns {{ amountMinor: number, currency: string } | null}
 */
export function toMoney(value, currency) {
  const text = str(value);
  if (!text || !/^-?\d+(\.\d+)?$/.test(text)) return null;
  const exponent = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  const negative = text.startsWith('-');
  const [whole, fraction = ''] = text.replace('-', '').split('.');
  const kept = fraction.padEnd(exponent, '0').slice(0, exponent);
  const roundUp = fraction.length > exponent && Number(fraction[exponent]) >= 5;
  const minor = Number(whole) * 10 ** exponent + Number(kept || '0') + (roundUp ? 1 : 0);
  return { amountMinor: negative ? -minor : minor, currency };
}
