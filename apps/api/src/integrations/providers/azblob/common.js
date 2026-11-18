import { createHash } from 'node:crypto';
import { containerName } from './config.js';
import { AzblobError } from './errors.js';

/**
 * Validation and encoding shared by the Azure client and the local-disk implementation,
 * so both accept and reject exactly the same names and options.
 */

const METADATA_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_METADATA_BYTES = 8 * 1024;
const ACCESS_TIERS = new Set(['Hot', 'Cool', 'Cold', 'Archive']);

/** @param {string | undefined} name */
export function validateContainer(name) {
  if (!containerName.safeParse(name).success) {
    throw new AzblobError('Invalid container name (3-63 lowercase letters, digits, single hyphens)', { kind: 'validation' });
  }
  return name;
}

/**
 * Blob names: 1-1024 characters. We are stricter than Azure so names stay portable to the
 * local-disk store and cannot be normalised by URL parsers: no control characters, no
 * backslash, no empty, "." or ".." path segments, no trailing dot.
 * @param {string} name
 */
export function validateBlobName(name) {
  const bad = (why) => new AzblobError(`Invalid blob name: ${why}`, { kind: 'validation' });
  if (typeof name !== 'string' || name.length === 0) throw bad('empty');
  if (name.length > 1024) throw bad('longer than 1024 characters');
  if (/[\u0000-\u001f\u007f\\]/.test(name)) throw bad('control character or backslash');
  if (name.endsWith('.')) throw bad('ends with a dot');
  if (name.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw bad('empty, "." or ".." path segment');
  }
  return name;
}

/** Percent-encode each path segment, keep "/" as the virtual directory separator. */
export function encodeBlobPath(name) {
  return name.split('/').map(encodeURIComponent).join('/');
}

/**
 * x-ms-meta-* headers. Names must be C# identifiers; values must be printable ASCII
 * (they travel as HTTP headers). Encode anything else (for example as base64) before storing.
 * @param {Record<string, string> | undefined} metadata
 */
export function metadataHeaders(metadata) {
  const headers = {};
  let size = 0;
  for (const [name, value] of Object.entries(metadata ?? {})) {
    if (!METADATA_NAME.test(name)) throw new AzblobError(`Invalid metadata name "${name}"`, { kind: 'validation' });
    const text = String(value);
    if (!/^[\x20-\x7e]*$/.test(text)) {
      throw new AzblobError(`Metadata "${name}" must be printable ASCII`, { kind: 'validation' });
    }
    size += name.length + text.length;
    headers[`x-ms-meta-${name.toLowerCase()}`] = text;
  }
  if (size > MAX_METADATA_BYTES) throw new AzblobError('Metadata exceeds 8 KiB', { kind: 'validation' });
  return headers;
}

/** Read x-ms-meta-* response headers back into an object (names are lowercased by HTTP). */
export function metadataFromHeaders(headers) {
  const out = {};
  headers.forEach((value, name) => {
    if (name.startsWith('x-ms-meta-')) out[name.slice('x-ms-meta-'.length)] = value;
  });
  return out;
}

/** @param {string | undefined} tier */
export function validateAccessTier(tier) {
  if (tier !== undefined && !ACCESS_TIERS.has(tier)) {
    throw new AzblobError('accessTier must be Hot, Cool, Cold or Archive', { kind: 'validation' });
  }
  return tier;
}

/**
 * RFC 6266 Content-Disposition with an ASCII fallback and an RFC 5987 UTF-8 filename*,
 * so names like "प्रवेश-पत्र.pdf" or "Fee receipt (Term 1).pdf" download correctly.
 * @param {string} filename
 * @param {{ inline?: boolean }} [options]
 */
export function contentDisposition(filename, { inline = false } = {}) {
  const type = inline ? 'inline' : 'attachment';
  const clean = String(filename ?? '').replace(/[\u0000-\u001f\u007f/\\]/g, '').trim();
  if (!clean) return type;
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_').replace(/["%]/g, '_');
  const encoded = encodeURIComponent(clean).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** Accept Buffer, Uint8Array, ArrayBuffer or string (UTF-8). Always returns a Buffer. */
export function toBuffer(body) {
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  throw new AzblobError('Blob body must be a Buffer, Uint8Array, ArrayBuffer or string', { kind: 'validation' });
}

/** @param {Buffer} buffer */
export function md5Base64(buffer) {
  return createHash('md5').update(buffer).digest('base64');
}

/** RFC 1123 header date -> ISO 8601 UTC, or null. */
export function httpDateToIso(value) {
  const ms = value ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Range option -> "bytes=start-end" (end inclusive).
 * @param {{ offset: number, count?: number } | undefined} range
 */
export function rangeHeader(range) {
  if (!range) return undefined;
  const { offset, count } = range;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new AzblobError('range.offset must be >= 0', { kind: 'validation' });
  if (count === undefined) return `bytes=${offset}-`;
  if (!Number.isSafeInteger(count) || count < 1) throw new AzblobError('range.count must be >= 1', { kind: 'validation' });
  return `bytes=${offset}-${offset + count - 1}`;
}
