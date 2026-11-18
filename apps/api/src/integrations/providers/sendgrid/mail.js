import { z } from 'zod';
import { SendgridError } from './errors.js';
import { buildListUnsubscribeHeaders } from './unsubscribe.js';

/**
 * Normalised outbound email -> SendGrid v3 /mail/send JSON. Pure: no I/O, so the request a
 * message would produce can be previewed and unit-tested.
 *
 * Limits enforced locally (from the Mail Send reference, overview and errors pages):
 * - at most 1,000 personalizations and 1,000 recipients (to+cc+bcc) per request
 * - an address may appear once per personalization across to/cc/bcc
 * - at most 10 categories, unique, ASCII, 255 chars each
 * - custom_args values are strings; merged size kept under 10,000 bytes (the overview's limit;
 *   the errors page states 50,000 bytes per personalization, we use the stricter one)
 * - reserved headers cannot be set; header keys are ASCII without spaces
 * - send_at at most 72 hours ahead
 * - request body under 30 MB (SendGrid's limit is on the whole email incl. attachments)
 * - text/plain content first, then text/html
 */

export const MAX_RECIPIENTS = 1000;
export const MAX_CATEGORIES = 10;
export const MAX_CUSTOM_ARGS_BYTES = 10_000;
export const MAX_SCHEDULE_AHEAD_SECONDS = 72 * 3600;
export const MAX_BODY_BYTES = 30 * 1024 * 1024;
export const RESERVED_HEADERS = Object.freeze([
  'x-sg-id',
  'x-sg-eid',
  'received',
  'dkim-signature',
  'content-type',
  'content-transfer-encoding',
  'to',
  'from',
  'subject',
  'reply-to',
  'cc',
  'bcc',
]);

const trimmed = (/** @type {unknown} */ v) => (typeof v === 'string' ? v.trim() : v);
const noLineBreaks = (/** @type {string} */ v) => !/[\r\n]/.test(v);

const addressObject = z.object({
  email: z.preprocess(trimmed, z.email().max(254)),
  name: z.preprocess(trimmed, z.string().max(200).refine(noLineBreaks, 'No line breaks')).optional(),
});
/** "a@b.c" or { email, name } */
const address = z.union([z.preprocess(trimmed, z.email().max(254)).transform((email) => ({ email })), addressObject]);
const addressList = z.union([address.transform((a) => [a]), z.array(address)]);

const stringRecord = z.record(z.string(), z.string());
const sendAtSchema = z.union([z.date(), z.iso.datetime({ offset: true }), z.number().int().positive()]);
const unsubscribeSchema = z.object({ url: z.string(), mailto: z.string().optional() });

const personalizationSchema = z.object({
  messageId: z.string().min(1).max(128).optional(),
  to: addressList,
  cc: addressList.optional(),
  bcc: addressList.optional(),
  subject: z.string().min(1).max(998).optional(),
  templateData: z.record(z.string(), z.unknown()).optional(),
  customArgs: stringRecord.optional(),
  headers: stringRecord.optional(),
  sendAt: sendAtSchema.optional(),
  unsubscribe: unsubscribeSchema.optional(),
});

const attachmentSchema = z.object({
  filename: z.string().min(1).max(255).refine(noLineBreaks, 'No line breaks'),
  content: z.union([z.instanceof(Uint8Array), z.string().min(1)]),
  contentType: z.string().min(1).max(255).regex(/^[^;,\r\n]+$/, 'No ; , or line breaks').optional(),
  disposition: z.enum(['attachment', 'inline']).default('attachment'),
  contentId: z.string().min(1).max(255).optional(),
});

/** The normalised message the adapter hands to `send`. */
export const outboundEmailSchema = z
  .object({
    messageId: z.string().min(1).max(128),
    from: addressObject.optional(),
    replyTo: address.optional(),
    replyToList: z.array(address).min(1).max(1000).optional(),
    to: addressList.optional(),
    cc: addressList.optional(),
    bcc: addressList.optional(),
    personalizations: z.array(personalizationSchema).min(1).max(1000).optional(),
    subject: z.string().min(1).max(998).optional(),
    text: z.string().min(1).optional(),
    html: z.string().min(1).optional(),
    templateId: z.string().regex(/^d-[A-Za-z0-9]{8,64}$/, 'Use a dynamic template id (starts with d-)').optional(),
    templateData: z.record(z.string(), z.unknown()).optional(),
    categories: z.array(z.string()).optional(),
    customArgs: stringRecord.optional(),
    headers: stringRecord.optional(),
    attachments: z.array(attachmentSchema).max(100).optional(),
    sendAt: sendAtSchema.optional(),
    batchId: z.string().min(1).max(200).optional(),
    asm: z.object({ groupId: z.number().int().positive().optional(), groupsToDisplay: z.array(z.number().int().positive()).max(25).optional() }).optional(),
    unsubscribe: unsubscribeSchema.optional(),
    tracking: z.object({ opens: z.boolean().optional(), clicks: z.boolean().optional(), subscription: z.boolean().optional() }).optional(),
    sandbox: z.boolean().optional(),
    ipPoolName: z.string().min(2).max(64).optional(),
  })
  .strict();

/** @typedef {z.input<typeof outboundEmailSchema>} OutboundEmail */

/**
 * @param {OutboundEmail} input
 * @param {import('./config.js').SendgridConfig} config
 * @param {{ now?: () => number }} [deps]
 * @returns {{ body: Record<string, any>, sandbox: boolean, recipients: number }}
 */
export function buildMailSendBody(input, config, { now = Date.now } = {}) {
  const parsed = outboundEmailSchema.safeParse(input);
  if (!parsed.success) {
    throw invalid(parsed.error.issues.map((i) => ({ path: i.path.join('.') || '(root)', message: i.message })));
  }
  const message = parsed.data;
  /** @type {Array<{ path: string, message: string }>} */
  const issues = [];
  const nowSeconds = Math.floor(now() / 1000);

  if (Boolean(message.to) === Boolean(message.personalizations)) {
    issues.push({ path: 'to', message: 'Give either to (with cc/bcc) or personalizations, not both' });
  }
  if (message.replyTo && message.replyToList) issues.push({ path: 'replyToList', message: 'Use replyTo or replyToList, not both' });

  const baseArgs = { ...(message.customArgs ?? {}), [config.messageIdArg]: message.messageId };
  if (message.customArgs?.[config.messageIdArg] !== undefined && message.customArgs[config.messageIdArg] !== message.messageId) {
    issues.push({ path: `customArgs.${config.messageIdArg}`, message: 'Reserved for the message id' });
  }

  const sources = message.personalizations ?? [{ to: message.to ?? [], cc: message.cc, bcc: message.bcc }];
  let recipients = 0;
  const personalizations = sources.map((p, index) => {
    const built = buildPersonalization(p, index, message, config, baseArgs, nowSeconds, issues);
    recipients += built.recipients;
    return built.value;
  });
  if (recipients > MAX_RECIPIENTS) issues.push({ path: 'to', message: `At most ${MAX_RECIPIENTS} recipients per request (got ${recipients})` });

  const content = [];
  if (message.text) content.push({ type: 'text/plain', value: message.text });
  if (message.html) content.push({ type: 'text/html', value: message.html });
  if (!message.templateId) {
    if (content.length === 0) issues.push({ path: 'text', message: 'Give text or html (or a templateId)' });
    if (!message.subject && personalizations.some((p) => !p.subject)) issues.push({ path: 'subject', message: 'Subject is required without a template' });
  }

  const categories = [...new Set([...config.defaultCategories, ...(message.categories ?? [])])];
  checkCategories(categories, issues);
  const headers = message.headers ? checkHeaders(message.headers, 'headers', issues) : {};
  if (message.unsubscribe) Object.assign(headers, unsubscribeHeaders(message.unsubscribe, 'unsubscribe', issues));

  /** @type {Record<string, any>} */
  const body = { personalizations, from: compact(message.from ?? config.defaultFrom) };
  const replyTo = message.replyTo ?? (message.replyToList ? undefined : config.defaultReplyTo);
  if (replyTo) body.reply_to = compact(replyTo);
  if (message.replyToList) body.reply_to_list = message.replyToList.map(compact);
  if (message.subject) body.subject = message.subject;
  if (content.length) body.content = content;
  if (message.templateId) body.template_id = message.templateId;
  if (message.attachments?.length) body.attachments = message.attachments.map((a, i) => buildAttachment(a, i, issues));
  if (Object.keys(headers).length) body.headers = headers;
  if (categories.length) body.categories = categories;
  if (message.sendAt !== undefined) body.send_at = toSendAt(message.sendAt, 'sendAt', nowSeconds, issues);
  if (message.batchId) body.batch_id = message.batchId;
  const asmGroup = message.asm ? (message.asm.groupId ?? config.asmGroupId) : undefined;
  if (message.asm && !asmGroup) issues.push({ path: 'asm.groupId', message: 'No unsubscribe group id given or configured' });
  if (asmGroup) body.asm = { group_id: asmGroup, ...(message.asm?.groupsToDisplay ? { groups_to_display: message.asm.groupsToDisplay } : {}) };
  const ipPool = message.ipPoolName ?? config.ipPoolName;
  if (ipPool) body.ip_pool_name = ipPool;

  const sandbox = config.sandboxMode || message.sandbox === true;
  if (sandbox) body.mail_settings = { sandbox_mode: { enable: true } };
  const tracking = trackingSettings(message);
  if (tracking) body.tracking_settings = tracking;

  if (issues.length === 0) {
    const size = Buffer.byteLength(JSON.stringify(body), 'utf8');
    if (size >= MAX_BODY_BYTES) issues.push({ path: 'attachments', message: `Email is ${size} bytes; SendGrid allows under 30 MB` });
  }
  if (issues.length) throw invalid(issues);
  return { body, sandbox, recipients };
}

/**
 * @param {z.output<typeof personalizationSchema> | { to: Array<{email: string, name?: string}>, cc?: any, bcc?: any }} p
 * @param {number} index
 * @param {z.output<typeof outboundEmailSchema>} message
 * @param {import('./config.js').SendgridConfig} config
 * @param {Record<string, string>} baseArgs
 * @param {number} nowSeconds
 * @param {Array<{ path: string, message: string }>} issues
 */
function buildPersonalization(p, index, message, config, baseArgs, nowSeconds, issues) {
  const at = message.personalizations ? `personalizations.${index}` : '';
  const path = (/** @type {string} */ field) => (at ? `${at}.${field}` : field);
  const pp = /** @type {z.output<typeof personalizationSchema>} */ (p);
  /** @type {Record<string, any>} */
  const value = { to: pp.to.map(compact) };
  if (pp.cc?.length) value.cc = pp.cc.map(compact);
  if (pp.bcc?.length) value.bcc = pp.bcc.map(compact);
  const all = [...pp.to, ...(pp.cc ?? []), ...(pp.bcc ?? [])];
  if (pp.to.length === 0) issues.push({ path: path('to'), message: 'At least one recipient is required' });
  const seen = new Set();
  for (const a of all) {
    const key = a.email.toLowerCase();
    if (seen.has(key)) issues.push({ path: path('to'), message: `${a.email} appears more than once across to/cc/bcc` });
    seen.add(key);
  }
  if (pp.subject) value.subject = pp.subject;
  const data = message.templateData || pp.templateData ? { ...(message.templateData ?? {}), ...(pp.templateData ?? {}) } : null;
  if (data && !message.templateId) issues.push({ path: path('templateData'), message: 'templateData needs a templateId' });
  if (data) value.dynamic_template_data = data;
  const args = { ...baseArgs, ...(pp.customArgs ?? {}), ...(pp.messageId ? { [config.messageIdArg]: pp.messageId } : {}) };
  if (pp.customArgs?.[config.messageIdArg] !== undefined) issues.push({ path: path(`customArgs.${config.messageIdArg}`), message: 'Use messageId instead' });
  const argBytes = Buffer.byteLength(JSON.stringify(args), 'utf8');
  if (argBytes >= MAX_CUSTOM_ARGS_BYTES) issues.push({ path: path('customArgs'), message: `Custom args are ${argBytes} bytes; keep under ${MAX_CUSTOM_ARGS_BYTES}` });
  value.custom_args = args;
  const headers = pp.headers ? checkHeaders(pp.headers, path('headers'), issues) : {};
  if (pp.unsubscribe) Object.assign(headers, unsubscribeHeaders(pp.unsubscribe, path('unsubscribe'), issues));
  if (Object.keys(headers).length) value.headers = headers;
  if (pp.sendAt !== undefined) value.send_at = toSendAt(pp.sendAt, path('sendAt'), nowSeconds, issues);
  return { value, recipients: all.length };
}

/** @param {{ email: string, name?: string }} a */
function compact(a) {
  return a.name ? { email: a.email, name: a.name } : { email: a.email };
}

/**
 * @param {Record<string, string>} headers
 * @param {string} path
 * @param {Array<{ path: string, message: string }>} issues
 */
function checkHeaders(headers, path, issues) {
  const out = /** @type {Record<string, string>} */ ({});
  const seen = new Set();
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (!/^[\x21-\x39\x3b-\x7e]+$/.test(key)) issues.push({ path: `${path}.${key}`, message: 'Header names must be ASCII without spaces or colons' });
    else if (RESERVED_HEADERS.includes(lower)) issues.push({ path: `${path}.${key}`, message: 'SendGrid does not allow overriding this header' });
    else if (seen.has(lower)) issues.push({ path: `${path}.${key}`, message: 'Duplicate header' });
    if (/[\r\n]/.test(value)) issues.push({ path: `${path}.${key}`, message: 'Header values cannot contain line breaks' });
    seen.add(lower);
    out[key] = value;
  }
  return out;
}

/**
 * @param {{ url: string, mailto?: string }} unsubscribe
 * @param {string} path
 * @param {Array<{ path: string, message: string }>} issues
 */
function unsubscribeHeaders(unsubscribe, path, issues) {
  try {
    return buildListUnsubscribeHeaders(unsubscribe);
  } catch (error) {
    issues.push({ path, message: /** @type {Error} */ (error).message });
    return {};
  }
}

/**
 * @param {string[]} categories
 * @param {Array<{ path: string, message: string }>} issues
 */
function checkCategories(categories, issues) {
  if (categories.length > MAX_CATEGORIES) issues.push({ path: 'categories', message: `At most ${MAX_CATEGORIES} categories (got ${categories.length})` });
  for (const c of categories) {
    if (!c || c.length > 255) issues.push({ path: 'categories', message: 'Each category must be 1-255 characters' });
    else if (!/^[\x20-\x7e]+$/.test(c)) issues.push({ path: 'categories', message: `Category "${c}" must be ASCII` });
  }
}

/**
 * @param {Date|string|number} value Date, ISO 8601 with offset, or unix seconds
 * @param {string} path
 * @param {number} nowSeconds
 * @param {Array<{ path: string, message: string }>} issues
 */
function toSendAt(value, path, nowSeconds, issues) {
  const seconds = typeof value === 'number' ? value : Math.floor(new Date(value).getTime() / 1000);
  if (!Number.isFinite(seconds)) issues.push({ path, message: 'Invalid time' });
  else if (seconds - nowSeconds > MAX_SCHEDULE_AHEAD_SECONDS) issues.push({ path, message: 'SendGrid schedules at most 72 hours ahead' });
  return seconds;
}

/**
 * @param {z.output<typeof attachmentSchema>} a
 * @param {number} index
 * @param {Array<{ path: string, message: string }>} issues
 */
function buildAttachment(a, index, issues) {
  let content;
  if (typeof a.content === 'string') {
    content = a.content.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(content) || content.length % 4 !== 0) {
      issues.push({ path: `attachments.${index}.content`, message: 'String content must be base64 (pass a Buffer for raw bytes)' });
    }
  } else {
    content = Buffer.from(a.content.buffer, a.content.byteOffset, a.content.byteLength).toString('base64');
  }
  if (a.disposition === 'inline' && !a.contentId) issues.push({ path: `attachments.${index}.contentId`, message: 'Inline attachments need a contentId' });
  /** @type {Record<string, string>} */
  const out = { content, filename: a.filename, disposition: a.disposition };
  if (a.contentType) out.type = a.contentType;
  if (a.contentId) out.content_id = a.contentId;
  return out;
}

/** @param {z.output<typeof outboundEmailSchema>} message */
function trackingSettings(message) {
  /** @type {Record<string, any>} */
  const out = {};
  const t = message.tracking ?? {};
  if (t.opens !== undefined) out.open_tracking = { enable: t.opens };
  if (t.clicks !== undefined) out.click_tracking = { enable: t.clicks, enable_text: t.clicks };
  const hasOwnUnsubscribe = Boolean(message.unsubscribe || message.personalizations?.some((p) => p.unsubscribe));
  // Our own one-click headers replace SendGrid's subscription tracking link unless asked otherwise.
  const subscription = t.subscription ?? (hasOwnUnsubscribe ? false : undefined);
  if (subscription !== undefined) out.subscription_tracking = { enable: subscription };
  return Object.keys(out).length ? out : null;
}

/** @param {Array<{ path: string, message: string }>} issues */
function invalid(issues) {
  const summary = issues.slice(0, 5).map((i) => `${i.path}: ${i.message}`).join('; ');
  return new SendgridError('validation', `Email rejected before sending: ${summary}`, { retryable: false, issues });
}
