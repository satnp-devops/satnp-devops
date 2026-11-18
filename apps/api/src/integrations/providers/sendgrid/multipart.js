/**
 * Minimal, binary-safe multipart/form-data parser (RFC 7578) for webhook bodies.
 * Works on the raw request Buffer so the same bytes can be signature-checked first.
 */

/** @typedef {{ name: string|null, filename: string|null, contentType: string|null, headers: Record<string, string>, content: Buffer }} MultipartPart */

/**
 * Split a header value such as `form-data; name="a"; filename*=UTF-8''r%C3%A9.pdf` into its
 * main value and lower-cased parameters.
 * @param {string} value
 * @returns {{ value: string, params: Record<string, string> }}
 */
export function parseHeaderParams(value) {
  const params = /** @type {Record<string, string>} */ ({});
  const text = String(value ?? '');
  const semi = text.indexOf(';');
  const main = (semi === -1 ? text : text.slice(0, semi)).trim().toLowerCase();
  const re = /;\s*([^=;\s]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const key = m[1].toLowerCase();
    const raw = m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : m[3].trim();
    if (key.endsWith('*')) {
      const decoded = decodeExtendedParam(raw);
      if (decoded !== null) params[key.slice(0, -1)] = decoded;
    } else if (!(key in params)) {
      params[key] = raw;
    }
  }
  return { value: main, params };
}

/** RFC 5987/2231 `charset'lang'percent-encoded` value. @param {string} raw */
function decodeExtendedParam(raw) {
  const match = /^([^']*)'[^']*'(.*)$/.exec(raw);
  if (!match) return null;
  try {
    const bytes = Buffer.from(match[2].replace(/%([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
    return new TextDecoder(match[1] || 'utf-8').decode(bytes);
  } catch {
    return null;
  }
}

/**
 * @param {string} contentType
 * @returns {string}
 */
export function boundaryFrom(contentType) {
  const { value, params } = parseHeaderParams(contentType);
  if (!value.startsWith('multipart/')) throw new TypeError('Not a multipart content type');
  const boundary = params.boundary;
  if (!boundary || boundary.length > 200) throw new TypeError('Multipart boundary missing or invalid');
  return boundary;
}

/**
 * Parse a multipart body. Throws TypeError when the body is malformed.
 * @param {Buffer} body raw bytes
 * @param {string} contentType header value including the boundary
 * @param {{ maxParts?: number }} [options]
 * @returns {{ parts: MultipartPart[], fields: Record<string, string>, fieldBytes: Record<string, Buffer>, files: MultipartPart[] }}
 */
export function parseMultipart(body, contentType, { maxParts = 500 } = {}) {
  const parts = splitMultipart(body, boundaryFrom(contentType), maxParts);
  const fields = /** @type {Record<string, string>} */ ({});
  const fieldBytes = /** @type {Record<string, Buffer>} */ ({});
  const files = [];
  for (const part of parts) {
    if (part.filename !== null) files.push(part);
    else if (part.name !== null && !(part.name in fieldBytes)) {
      fieldBytes[part.name] = part.content;
      fields[part.name] = part.content.toString('utf8');
    }
  }
  return { parts, fields, fieldBytes, files };
}

/**
 * Split any multipart/* body into parts (also used for MIME messages).
 * @param {Buffer} body
 * @param {string} boundary
 * @param {number} maxParts
 * @returns {MultipartPart[]}
 */
export function splitMultipart(body, boundary, maxParts = 500) {
  const delimiter = Buffer.from(`--${boundary}`, 'latin1');
  const start = body.indexOf(delimiter);
  if (start === -1) throw new TypeError('Multipart boundary not found in body');
  const crlf = body[start + delimiter.length] === 0x0d; // line ending used by this body
  const separator = Buffer.concat([Buffer.from(crlf ? '\r\n' : '\n'), delimiter]);
  /** @type {MultipartPart[]} */
  const parts = [];
  let cursor = start + delimiter.length;
  for (;;) {
    if (body[cursor] === 0x2d && body[cursor + 1] === 0x2d) break; // closing "--"
    const lineEnd = body.indexOf('\n', cursor);
    if (lineEnd === -1) throw new TypeError('Multipart body truncated');
    const headerStart = lineEnd + 1;
    const headerEnd = findHeaderEnd(body, headerStart);
    if (headerEnd === null) throw new TypeError('Multipart part headers truncated');
    const next = body.indexOf(separator, headerEnd.bodyStart);
    if (next === -1) throw new TypeError('Multipart closing boundary missing');
    const headers = parseHeaderBlock(body.subarray(headerStart, headerEnd.headerEnd).toString('utf8'));
    parts.push(partFrom(headers, body.subarray(headerEnd.bodyStart, next)));
    if (parts.length > maxParts) throw new TypeError('Too many multipart parts');
    cursor = next + separator.length;
  }
  return parts;
}

/**
 * @param {Buffer} body
 * @param {number} from
 * @returns {{ headerEnd: number, bodyStart: number } | null}
 */
function findHeaderEnd(body, from) {
  // A part may have no headers at all: the body starts right after an empty line.
  if (body[from] === 0x0d && body[from + 1] === 0x0a) return { headerEnd: from, bodyStart: from + 2 };
  if (body[from] === 0x0a) return { headerEnd: from, bodyStart: from + 1 };
  const crlf = body.indexOf('\r\n\r\n', from);
  const lf = body.indexOf('\n\n', from);
  if (crlf !== -1 && (lf === -1 || crlf <= lf)) return { headerEnd: crlf, bodyStart: crlf + 4 };
  if (lf !== -1) return { headerEnd: lf, bodyStart: lf + 2 };
  return null;
}

/**
 * Unfold and split an RFC 5322 style header block. Keys are lower-cased; for repeated headers
 * the first value is kept (use parseHeaderList when every value matters).
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseHeaderBlock(text) {
  const headers = /** @type {Record<string, string>} */ ({});
  for (const [key, value] of parseHeaderList(text)) if (!(key in headers)) headers[key] = value;
  return headers;
}

/**
 * @param {string} text
 * @returns {Array<[string, string]>}
 */
export function parseHeaderList(text) {
  /** @type {Array<[string, string]>} */
  const list = [];
  const unfolded = String(text).replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    list.push([line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()]);
  }
  return list;
}

/**
 * @param {Record<string, string>} headers
 * @param {Buffer} content
 * @returns {MultipartPart}
 */
function partFrom(headers, content) {
  const disposition = parseHeaderParams(headers['content-disposition'] ?? '');
  return {
    name: disposition.params.name ?? null,
    filename: disposition.params.filename ?? null,
    contentType: headers['content-type'] ?? null,
    headers,
    content,
  };
}
