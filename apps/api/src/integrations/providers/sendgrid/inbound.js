import { createHash } from 'node:crypto';
import { SendgridError } from './errors.js';
import { parseMultipart, parseHeaderList } from './multipart.js';
import { decodeCharset, decodeEncodedWords, parseAddressList, parseMessageIds, parseMimeMessage } from './mime.js';
import { headerValue } from './webhook.js';

/**
 * Inbound Parse webhook (multipart/form-data POST) -> normalised inbound email.
 *
 * Handles both settings of the Parse webhook:
 * - default ("parsed"): fields headers, to, cc, from, subject, text, html, envelope, charsets,
 *   attachments (count), attachment-info, content-ids, SPF, dkim, spam_score, spam_report,
 *   sender_ip, and file parts attachment1..N.
 * - raw ("POST the raw, full MIME message"): field `email` holds the whole MIME message, which
 *   is walked with the small parser in mime.js.
 *
 * SendGrid retries a failed POST (5xx) for up to 3 days, so `dedupeKey` (the Message-ID, or a
 * hash of the body when there is none) lets the receiver ignore repeats.
 */

/** SendGrid's limit is 30 MB per message; allow multipart overhead on top. */
export const DEFAULT_MAX_INBOUND_BYTES = 40 * 1024 * 1024;

/**
 * @typedef {{ filename: string|null, contentType: string, contentId: string|null, disposition: 'inline'|'attachment', size: number, content: Buffer }} InboundAttachment
 * @typedef {{
 *   provider: 'sendgrid', mode: 'parsed'|'raw', dedupeKey: string,
 *   from: { email: string, name: string|null } | null, to: Array<{ email: string, name: string|null }>,
 *   cc: Array<{ email: string, name: string|null }>, replyTo: Array<{ email: string, name: string|null }>,
 *   subject: string, text: string|null, html: string|null, date: string|null,
 *   messageIdHeader: string|null, inReplyTo: string|null, references: string[],
 *   envelope: { from: string|null, to: string[] }, recipientTags: string[],
 *   headers: Record<string, string>, attachments: InboundAttachment[],
 *   spam: { score: number|null, report: string|null }, spf: string|null, dkim: string|null, senderIp: string|null,
 *   charsets: Record<string, string>
 * }} InboundEmail
 */

/**
 * @param {Buffer|Uint8Array} rawBody exact request bytes (verify the signature on these first)
 * @param {string | Record<string, string|string[]|undefined> | Headers} contentTypeOrHeaders
 * @param {{ maxBytes?: number }} [options]
 * @returns {InboundEmail}
 */
export function parseInboundEmail(rawBody, contentTypeOrHeaders, { maxBytes = DEFAULT_MAX_INBOUND_BYTES } = {}) {
  const body = Buffer.isBuffer(rawBody) ? rawBody : rawBody instanceof Uint8Array ? Buffer.from(rawBody) : null;
  if (!body) throw new SendgridError('invalid_payload', 'Inbound Parse body must be the raw request bytes', { retryable: false });
  if (body.length > maxBytes) throw new SendgridError('invalid_payload', `Inbound Parse body is larger than ${maxBytes} bytes`, { retryable: false });
  const contentType =
    typeof contentTypeOrHeaders === 'string' ? contentTypeOrHeaders : headerValue(/** @type {any} */ (contentTypeOrHeaders), 'content-type') ?? '';

  let form;
  try {
    form = parseMultipart(body, contentType);
  } catch (error) {
    throw new SendgridError('invalid_payload', `Inbound Parse body is not valid multipart/form-data: ${/** @type {Error} */ (error).message}`, {
      retryable: false,
    });
  }
  const charsets = jsonField(form.fields.charsets) ?? {};
  const field = (/** @type {string} */ name) => {
    const bytes = form.fieldBytes[name];
    return bytes === undefined ? null : decodeCharset(bytes, charsets[name] ?? 'utf-8');
  };
  const envelopeJson = jsonField(form.fields.envelope) ?? {};
  const envelope = {
    from: typeof envelopeJson.from === 'string' ? envelopeJson.from : null,
    to: Array.isArray(envelopeJson.to) ? envelopeJson.to.filter((/** @type {unknown} */ t) => typeof t === 'string') : [],
  };
  const raw = form.fieldBytes.email;
  const mime = raw ? parseMimeMessage(raw) : null;
  const headerList = mime ? mime.headers : parseHeaderList(field('headers') ?? '');
  const headers = /** @type {Record<string, string>} */ ({});
  for (const [k, v] of headerList) if (!(k in headers)) headers[k] = v;
  // In parsed mode SendGrid has already decoded to/from/cc/subject; raw headers need RFC 2047 decoding.
  const pick = (/** @type {string} */ name) => field(name) ?? (headers[name] !== undefined ? decodeEncodedWords(headers[name]) : null);

  const messageIdHeader = parseMessageIds(headers['message-id'])[0] ?? null;
  const dateHeader = headers.date ? new Date(headers.date) : null;
  const spamScore = form.fields.spam_score === undefined ? NaN : Number(form.fields.spam_score);
  return {
    provider: 'sendgrid',
    mode: raw ? 'raw' : 'parsed',
    dedupeKey: messageIdHeader ? `message-id:${messageIdHeader}` : `sha256:${createHash('sha256').update(body).digest('hex')}`,
    from: parseAddressList(pick('from'))[0] ?? null,
    to: parseAddressList(pick('to')),
    cc: parseAddressList(pick('cc')),
    replyTo: parseAddressList(headers['reply-to'] ? decodeEncodedWords(headers['reply-to']) : null),
    subject: pick('subject') ?? '',
    text: mime ? mime.text : field('text'),
    html: mime ? mime.html : field('html'),
    date: dateHeader && !Number.isNaN(dateHeader.getTime()) ? dateHeader.toISOString() : null,
    messageIdHeader,
    inReplyTo: parseMessageIds(headers['in-reply-to'])[0] ?? null,
    references: parseMessageIds(headers.references),
    envelope,
    recipientTags: envelope.to.map(addressTag).filter((t) => t !== null),
    headers,
    attachments: mime ? mime.attachments.map(withSize) : parsedAttachments(form),
    spam: { score: Number.isFinite(spamScore) ? spamScore : null, report: field('spam_report') },
    spf: form.fields.SPF ?? null,
    dkim: form.fields.dkim ?? null,
    senderIp: form.fields.sender_ip ?? null,
    charsets,
  };
}

/**
 * Plus-address tag: `reply+t_abc123@in.example.com` -> `t_abc123`. Lets a reply be routed back
 * to the conversation that sent it without trusting headers the sender controls.
 * @param {string} address
 * @returns {string|null}
 */
export function addressTag(address) {
  const local = String(address ?? '').split('@')[0] ?? '';
  const plus = local.indexOf('+');
  return plus === -1 || plus === local.length - 1 ? null : local.slice(plus + 1);
}

/** @param {ReturnType<typeof parseMultipart>} form */
function parsedAttachments(form) {
  const info = jsonField(form.fields['attachment-info']) ?? {};
  const cids = jsonField(form.fields['content-ids']) ?? {};
  const cidByField = /** @type {Record<string, string>} */ ({});
  for (const [cid, fieldName] of Object.entries(cids)) if (typeof fieldName === 'string') cidByField[fieldName] = cid;
  return form.files.map((file) => {
    const meta = (file.name && info[file.name]) || {};
    const contentId = meta['content-id'] ?? (file.name ? cidByField[file.name] : undefined) ?? null;
    return withSize({
      filename: meta.filename ?? file.filename ?? null,
      contentType: (meta.type ?? file.contentType ?? 'application/octet-stream').split(';')[0].trim(),
      contentId,
      disposition: contentId ? 'inline' : 'attachment',
      content: file.content,
    });
  });
}

/**
 * @param {{ filename: string|null, contentType: string, contentId: string|null, disposition: 'inline'|'attachment', content: Buffer }} a
 * @returns {InboundAttachment}
 */
function withSize(a) {
  return { ...a, size: a.content.length };
}

/** @param {string|undefined} text */
function jsonField(text) {
  if (!text) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}
