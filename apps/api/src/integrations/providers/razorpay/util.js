/** Small pure helpers shared by the Razorpay modules. */

/**
 * Unix seconds (Razorpay's time format) to an ISO-8601 UTC string. Razorpay uses 0 or null
 * for "not set" (for example `cancelled_at: 0`), which becomes null.
 * @param {unknown} seconds
 * @returns {string|null}
 */
export function unixToIso(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

/**
 * Date, ISO string or unix seconds to unix seconds (integer, UTC).
 * @param {Date|string|number} value
 * @returns {number}
 */
export function toUnixSeconds(value) {
  if (typeof value === 'number') return Math.floor(value);
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(ms)) throw new TypeError('Invalid date');
  return Math.floor(ms / 1000);
}

/**
 * Case-insensitive header lookup over a plain object (Express/Node), a Map or a WHATWG Headers.
 * Returns undefined when absent and an array when a header was sent more than once.
 * @param {unknown} headers
 * @param {string} name lower-case header name
 * @returns {string|string[]|undefined}
 */
export function getHeader(headers, name) {
  if (!headers || typeof headers !== 'object') return undefined;
  if (typeof (/** @type {any} */ (headers).get) === 'function' && !(headers instanceof Map)) {
    return /** @type {any} */ (headers).get(name) ?? undefined;
  }
  const entries = headers instanceof Map ? [...headers.entries()] : Object.entries(headers);
  for (const [key, value] of entries) {
    if (String(key).toLowerCase() === name) return value ?? undefined;
  }
  return undefined;
}

/**
 * Razorpay returns `notes` as an object, but as `[]` when empty (seen in official samples).
 * @param {unknown} notes
 * @returns {Record<string, string>}
 */
export function normalizeNotes(notes) {
  if (!notes || typeof notes !== 'object' || Array.isArray(notes)) return {};
  return /** @type {Record<string, string>} */ ({ ...notes });
}

/** Drop keys whose value is undefined so request bodies only carry what the caller set. */
export function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, v]) => v !== undefined));
}

/** @param {number} ms */
export const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A logger that drops everything; used when none is injected. */
export const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
