/**
 * Stripe v1 takes application/x-www-form-urlencoded bodies with bracket notation:
 *   { metadata: { lead: 'L1' }, line_items: [{ price: 'price_1', quantity: 2 }] }
 *   -> metadata[lead]=L1&line_items[0][price]=price_1&line_items[0][quantity]=2
 *
 * Rules (same as Stripe's own SDKs):
 *   - undefined, empty objects and empty arrays are skipped
 *   - null becomes an empty value, which tells Stripe to unset the field
 *   - Date becomes Unix seconds; booleans become "true"/"false"
 *   - arrays use indexes (expand[0]=...)
 */

/**
 * @param {unknown} value
 * @param {string} key
 * @param {Array<[string, string]>} out
 */
function flatten(value, key, out) {
  if (value === undefined) return;
  if (value === null) {
    out.push([key, '']);
    return;
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError(`Invalid date for ${key}`);
    out.push([key, String(Math.floor(value.getTime() / 1000))]);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => flatten(item, `${key}[${index}]`, out));
    return;
  }
  if (typeof value === 'object') {
    for (const [child, childValue] of Object.entries(value)) {
      flatten(childValue, key ? `${key}[${child}]` : child, out);
    }
    return;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError(`Invalid number for ${key}`);
  if (typeof value === 'function' || typeof value === 'symbol') throw new TypeError(`Unsupported value for ${key}`);
  out.push([key, String(value)]);
}

/**
 * Flattens params into ordered [key, value] pairs.
 * @param {Record<string, unknown>} [params]
 * @returns {Array<[string, string]>}
 */
export function flattenParams(params) {
  /** @type {Array<[string, string]>} */
  const out = [];
  if (params) flatten(params, '', out);
  return out;
}

/**
 * Encodes params as a form body / query string. Brackets stay literal for readable logs and
 * diffs; Stripe accepts both literal and percent-encoded brackets.
 * @param {Record<string, unknown>} [params]
 * @returns {string}
 */
export function encodeForm(params) {
  return new URLSearchParams(flattenParams(params)).toString().replace(/%5B/g, '[').replace(/%5D/g, ']');
}

/**
 * Deep-merges `extra` into `base` (plain objects only; arrays and scalars in `extra` win).
 * Lets callers pass Stripe parameters the high-level helpers don't model.
 * @param {Record<string, any>} base
 * @param {Record<string, any>} [extra]
 * @returns {Record<string, any>}
 */
export function mergeParams(base, extra) {
  if (!extra) return base;
  /** @type {Record<string, any>} */
  const out = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const current = out[key];
    out[key] = isPlainObject(current) && isPlainObject(value) ? mergeParams(current, value) : value;
  }
  return out;
}

/** @param {unknown} value */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
}
