import { parseHeaderList, parseHeaderParams, splitMultipart } from './multipart.js';

/**
 * Small MIME helpers for inbound email: header decoding (RFC 2047), address lists (RFC 5322),
 * and a basic message walker for Inbound Parse "raw" mode. It covers common mail
 * (multipart/mixed|alternative|related, base64 and quoted-printable) and is not a full MIME
 * implementation (no S/MIME, no message/rfc822 recursion, no uuencode).
 */

/**
 * Decode bytes in a named charset; unknown labels fall back to UTF-8.
 * @param {Buffer} bytes
 * @param {string|null|undefined} charset
 */
export function decodeCharset(bytes, charset) {
  const label = (charset ?? 'utf-8').trim().toLowerCase() || 'utf-8';
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/**
 * Decode RFC 2047 encoded words such as `=?UTF-8?B?4KSo4KSu4KS44KWN4KSk4KWH?=`.
 * @param {string} text
 */
export function decodeEncodedWords(text) {
  if (!text || !text.includes('=?')) return text ?? '';
  // Whitespace between two adjacent encoded words is not part of the text.
  const joined = text.replace(/(=\?[^?\s]+\?[BbQq]\?[^?\s]*\?=)\s+(?==\?[^?\s]+\?[BbQq]\?)/g, '$1');
  return joined.replace(/=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g, (whole, charset, enc, data) => {
    try {
      const bytes =
        enc.toUpperCase() === 'B'
          ? Buffer.from(data, 'base64')
          : Buffer.from(
              data.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (/** @type {string} */ _, /** @type {string} */ h) => String.fromCharCode(parseInt(h, 16))),
              'latin1',
            );
      return decodeCharset(bytes, charset.split('*')[0]);
    } catch {
      return whole;
    }
  });
}

/**
 * Parse `"Sharma, Priya" <priya@example.in>, rahul@example.com` into addresses.
 * Group syntax (`Friends: a@x, b@y;`) is flattened; invalid entries are skipped.
 * @param {string|null|undefined} text
 * @returns {Array<{ email: string, name: string|null }>}
 */
export function parseAddressList(text) {
  if (!text) return [];
  const out = [];
  for (const raw of splitAddresses(String(text))) {
    let item = raw.trim();
    const group = /^[^"<>@]*:(.*)$/.exec(item);
    if (group && !item.includes('<') ) item = group[1].trim();
    item = item.replace(/;$/, '').trim();
    if (!item) continue;
    const angle = /^(.*)<([^<>]+)>\s*(\(.*\))?$/.exec(item);
    let email;
    let name = null;
    if (angle) {
      email = angle[2].trim();
      name = unquote(angle[1].trim()) || null;
    } else {
      email = item.replace(/\(.*\)/g, '').trim();
    }
    email = email.replace(/^mailto:/i, '');
    if (!/^[^\s@<>()]+@[^\s@<>()]+$/.test(email)) continue;
    out.push({ email, name: name ? decodeEncodedWords(name) : null });
  }
  return out;
}

/** @param {string} text */
function splitAddresses(text) {
  const parts = [];
  let current = '';
  let quoted = false;
  let angle = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\\' && quoted) {
      current += ch + (text[i + 1] ?? '');
      i += 1;
      continue;
    }
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === '<') angle += 1;
    else if (!quoted && ch === '>') angle = Math.max(0, angle - 1);
    if (ch === ',' && !quoted && angle === 0) {
      parts.push(current);
      current = '';
    } else current += ch;
  }
  parts.push(current);
  return parts;
}

/** @param {string} s */
function unquote(s) {
  return s.startsWith('"') && s.endsWith('"') && s.length >= 2 ? s.slice(1, -1).replace(/\\(.)/g, '$1') : s;
}

/**
 * Message-ID style list: `<a@x> <b@y>` -> ['<a@x>', '<b@y>'].
 * @param {string|null|undefined} text
 */
export function parseMessageIds(text) {
  return text ? (String(text).match(/<[^<>\s]+>/g) ?? []) : [];
}

/** @param {Buffer} bytes */
export function decodeQuotedPrintable(bytes) {
  const text = bytes.toString('latin1').replace(/=\r?\n/g, '');
  const out = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      out.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else out.push(text.charCodeAt(i) & 0xff);
  }
  return Buffer.from(out);
}

/**
 * @typedef {{ filename: string|null, contentType: string, contentId: string|null, disposition: 'inline'|'attachment', content: Buffer }} MimeAttachment
 * @typedef {{ headers: Array<[string, string]>, text: string|null, html: string|null, attachments: MimeAttachment[] }} MimeMessage
 */

/**
 * Walk a full MIME message (Inbound Parse raw mode `email` field).
 * @param {Buffer} raw
 * @returns {MimeMessage}
 */
export function parseMimeMessage(raw) {
  const { headerText, body } = splitHead(raw);
  const headers = parseHeaderList(headerText);
  /** @type {MimeMessage} */
  const message = { headers, text: null, html: null, attachments: [] };
  walk(headersToObject(headers), body, message, 0);
  return message;
}

/** @param {Buffer} raw */
function splitHead(raw) {
  const crlf = raw.indexOf('\r\n\r\n');
  const lf = raw.indexOf('\n\n');
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { headerText: raw.subarray(0, crlf).toString('utf8'), body: raw.subarray(crlf + 4) };
  if (lf !== -1) return { headerText: raw.subarray(0, lf).toString('utf8'), body: raw.subarray(lf + 2) };
  return { headerText: raw.toString('utf8'), body: Buffer.alloc(0) };
}

/** @param {Array<[string, string]>} list */
function headersToObject(list) {
  const out = /** @type {Record<string, string>} */ ({});
  for (const [k, v] of list) if (!(k in out)) out[k] = v;
  return out;
}

/**
 * @param {Record<string, string>} headers
 * @param {Buffer} body
 * @param {MimeMessage} message
 * @param {number} depth
 */
function walk(headers, body, message, depth) {
  const type = parseHeaderParams(headers['content-type'] ?? 'text/plain; charset=us-ascii');
  if (type.value.startsWith('multipart/') && depth < 10 && type.params.boundary) {
    let parts;
    try {
      parts = splitMultipart(body, type.params.boundary, 500);
    } catch {
      return;
    }
    for (const part of parts) walk(part.headers, part.content, message, depth + 1);
    return;
  }
  const encoding = (headers['content-transfer-encoding'] ?? '7bit').trim().toLowerCase();
  const content =
    encoding === 'base64'
      ? Buffer.from(body.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64')
      : encoding === 'quoted-printable'
        ? decodeQuotedPrintable(body)
        : body;
  const disposition = parseHeaderParams(headers['content-disposition'] ?? '');
  const filename = disposition.params.filename ?? type.params.name ?? null;
  const isAttachment = disposition.value === 'attachment' || (filename !== null && disposition.value !== 'inline') || !type.value.startsWith('text/');
  if (!isAttachment && type.value === 'text/plain' && message.text === null) {
    message.text = decodeCharset(content, type.params.charset);
    return;
  }
  if (!isAttachment && type.value === 'text/html' && message.html === null) {
    message.html = decodeCharset(content, type.params.charset);
    return;
  }
  message.attachments.push({
    filename: filename ? decodeEncodedWords(filename) : null,
    contentType: type.value || 'application/octet-stream',
    contentId: headers['content-id'] ? headers['content-id'].replace(/^<|>$/g, '') : null,
    disposition: disposition.value === 'inline' ? 'inline' : 'attachment',
    content,
  });
}
