import { z } from 'zod';
import { WaError } from './errors.js';

/**
 * Pure builders for Cloud API request bodies. Nothing here does I/O, so the adapter can
 * preview or test payloads without a client.
 *
 * Shapes follow https://developers.facebook.com/documentation/business-messaging/whatsapp/
 * (messages/send-messages, templates/overview, templates/components; read 2026-11-05).
 */

/** Template names: lowercase letters, digits and underscores, max 512 (templates/template-management). */
export const TEMPLATE_NAME_RE = /^[a-z0-9_]{1,512}$/;
/** Template language codes look like `en`, `en_US`, `bn_IN` (templates/supported-languages). */
export const LANGUAGE_RE = /^[a-z]{2,3}(_[A-Z]{2,4})?$/;
/** Text message bodies are limited to 4096 characters (messages/text-messages). */
export const TEXT_MAX = 4096;
/** biz_opaque_callback_data is echoed back on status webhooks. 512 is the historic limit (unconfirmed in 2026 docs). */
export const CALLBACK_DATA_MAX = 512;

export const MEDIA_KINDS = Object.freeze(['image', 'video', 'audio', 'document', 'sticker']);

/**
 * Supported upload MIME types and size limits (business-phone-numbers/media, read 2026-11-05).
 * Stickers are image/webp with 100 KB (static) / 500 KB (animated) limits; we enforce the larger.
 */
export const MEDIA_LIMITS = Object.freeze({
  'audio/aac': 16 * 1024 * 1024,
  'audio/amr': 16 * 1024 * 1024,
  'audio/mpeg': 16 * 1024 * 1024,
  'audio/mp4': 16 * 1024 * 1024,
  'audio/ogg': 16 * 1024 * 1024,
  'text/plain': 100 * 1024 * 1024,
  'application/vnd.ms-excel': 100 * 1024 * 1024,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 100 * 1024 * 1024,
  'application/msword': 100 * 1024 * 1024,
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 100 * 1024 * 1024,
  'application/vnd.ms-powerpoint': 100 * 1024 * 1024,
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 100 * 1024 * 1024,
  'application/pdf': 100 * 1024 * 1024,
  'image/jpeg': 5 * 1024 * 1024,
  'image/png': 5 * 1024 * 1024,
  'image/webp': 5 * 1024 * 1024,
  'video/3gpp': 16 * 1024 * 1024,
  'video/mp4': 16 * 1024 * 1024,
});

/**
 * @param {string} message
 * @returns {WaError}
 */
function invalid(message) {
  return new WaError(message, { kind: 'invalid_request', retryable: false });
}

/**
 * Parse input with a zod schema and throw an invalid_request WaError naming the bad fields.
 * Values are never echoed (they may be phone numbers or message text).
 * @template T
 * @param {z.ZodType<T>} schema
 * @param {unknown} input
 * @param {string} what
 * @returns {T}
 */
export function parseInput(schema, input, what) {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const fields = result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
  throw invalid(`Invalid ${what}: ${fields.join('; ')}`);
}

/**
 * Normalise a phone number to E.164 with a leading plus, as Meta recommends for `to`.
 * Without a plus, Meta prepends the business number's country code, which misdelivers.
 *
 * - `+91 98765 43210`, `0091 9876543210` -> `+919876543210`
 * - `919876543210` (a wa_id from a webhook) -> `+919876543210`
 * - `09876543210` or `9876543210` with defaultCountryCode '91' -> `+919876543210`
 *
 * @param {string} input
 * @param {{ defaultCountryCode?: string }} [options]
 * @returns {string}
 */
export function normalizePhone(input, options = {}) {
  if (typeof input !== 'string') throw invalid('Phone number must be a string');
  const trimmed = input.trim();
  if (!/^[+0-9()\-.\s]+$/.test(trimmed)) throw invalid('Phone number contains unsupported characters');
  let digits = trimmed.replace(/\D/g, '');
  const cc = options.defaultCountryCode;
  if (trimmed.startsWith('+')) {
    // already international
  } else if (digits.startsWith('00')) {
    digits = digits.slice(2);
  } else if (cc) {
    const national = digits.replace(/^0+/, '');
    const nationalLength = cc === '91' ? 10 : null;
    const hasCountryCode = digits.startsWith(cc) && (nationalLength === null ? digits.length > 10 : digits.length === cc.length + nationalLength);
    digits = hasCountryCode ? digits : `${cc}${national}`;
  }
  if (digits.length < 8 || digits.length > 15 || digits.startsWith('0')) throw invalid('Phone number is not a valid international number');
  if (digits.startsWith('91') && digits.length !== 12) throw invalid('Indian phone numbers have 10 digits after +91');
  return `+${digits}`;
}

/** Business-scoped user ids (BSUID) look like `US.13491208655302741918` (business-scoped-user-ids, 2026). */
const BSUID_RE = /^[A-Za-z0-9._-]{6,160}$/;

const recipientSchema = z
  .object({
    /** Phone number in any common format; normalised to +E.164. */
    to: z.string().min(1).optional(),
    /** Business-scoped user id, for users who hide their phone number behind a username. */
    recipient: z.string().regex(BSUID_RE, 'must be a business-scoped user id').optional(),
  })
  .refine((v) => Boolean(v.to) !== Boolean(v.recipient), 'give exactly one of to or recipient');

const commonSchema = z.object({
  /** Echoed back as biz_opaque_callback_data on status webhooks: put the outbox/message id here. */
  callbackData: z.string().min(1).max(CALLBACK_DATA_MAX).optional(),
  /** wamid of the message being replied to (contextual reply). */
  replyTo: z.string().min(1).optional(),
});

/**
 * @param {{ to?: string, recipient?: string, callbackData?: string, replyTo?: string }} input
 * @param {{ defaultCountryCode?: string, messagingAccountId?: string }} options
 * @param {string} type
 */
function envelope(input, options, type) {
  /** @type {Record<string, unknown>} */
  const body = { messaging_product: 'whatsapp', recipient_type: 'individual' };
  if (input.recipient) body.recipient = input.recipient;
  else body.to = normalizePhone(/** @type {string} */ (input.to), options);
  body.type = type;
  if (input.replyTo) body.context = { message_id: input.replyTo };
  if (input.callbackData) body.biz_opaque_callback_data = input.callbackData;
  if (options.messagingAccountId) body.messaging_account_id = options.messagingAccountId;
  return body;
}

const moneySchema = z.object({
  amountMinor: z.number().int(),
  currency: z.string().regex(/^[A-Z]{3}$/),
});

const textValue = z.union([z.string().min(1).max(TEXT_MAX), moneySchema]);

/**
 * Format integer minor units as display text, e.g. { amountMinor: 123450, currency: 'INR' } -> '₹1,234.50'.
 * Template variables are plain text, so money is rendered here (en-IN grouping by default).
 * @param {{ amountMinor: number, currency: string }} money
 * @param {string} [locale]
 */
export function formatMoney({ amountMinor, currency }, locale = 'en-IN') {
  const formatter = new Intl.NumberFormat(locale, { style: 'currency', currency });
  const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  return formatter.format(amountMinor / 10 ** digits);
}

/** @param {string | { amountMinor: number, currency: string }} value */
function toText(value) {
  return typeof value === 'string' ? value : formatMoney(value);
}

const mediaRef = z
  .object({ id: z.string().min(1).optional(), link: z.url().optional(), filename: z.string().max(240).optional() })
  .refine((v) => Boolean(v.id) !== Boolean(v.link), 'give exactly one of id or link');

const headerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: textValue, name: z.string().regex(/^[a-z0-9_]+$/).optional() }),
  z.object({ type: z.literal('image'), id: z.string().optional(), link: z.url().optional() }),
  z.object({ type: z.literal('video'), id: z.string().optional(), link: z.url().optional() }),
  z.object({ type: z.literal('document'), id: z.string().optional(), link: z.url().optional(), filename: z.string().max(240).optional() }),
  z.object({
    type: z.literal('location'),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    name: z.string().optional(),
    address: z.string().optional(),
  }),
]);

const buttonSchema = z.discriminatedUnion('type', [
  /** Dynamic URL suffix; percent-encoded for you unless `encoded: true`. */
  z.object({ type: z.literal('url'), index: z.number().int().min(0).max(9), text: z.string().min(1), name: z.string().optional(), encoded: z.boolean().optional() }),
  z.object({ type: z.literal('quick_reply'), index: z.number().int().min(0).max(9), payload: z.string().min(1).max(256) }),
]);

export const templateVariablesSchema = z.object({
  header: headerSchema.optional(),
  /** Positional ({{1}}, {{2}}) as an array, or named ({{first_name}}) as an object. */
  body: z.union([z.array(textValue), z.record(z.string().regex(/^[a-z0-9_]+$/), textValue)]).optional(),
  buttons: z.array(buttonSchema).max(10).optional(),
});

/**
 * Turn friendly template variables into Cloud API `components`.
 * @param {z.infer<typeof templateVariablesSchema>} variables
 * @returns {Array<Record<string, unknown>>}
 */
export function buildTemplateComponents(variables) {
  const v = parseInput(templateVariablesSchema, variables, 'template variables');
  const components = [];
  if (v.header) components.push({ type: 'header', parameters: [headerParameter(v.header)] });
  if (v.body) {
    const parameters = Array.isArray(v.body)
      ? v.body.map((value) => ({ type: 'text', text: toText(value) }))
      : Object.entries(v.body).map(([name, value]) => ({ type: 'text', parameter_name: name, text: toText(value) }));
    if (parameters.length) components.push({ type: 'body', parameters });
  }
  for (const button of v.buttons ?? []) {
    if (button.type === 'url') {
      const text = button.encoded ? button.text : encodeURIComponent(button.text);
      const parameter = { type: 'text', text, ...(button.name ? { parameter_name: button.name } : {}) };
      components.push({ type: 'button', sub_type: 'url', index: String(button.index), parameters: [parameter] });
    } else {
      components.push({ type: 'button', sub_type: 'quick_reply', index: String(button.index), parameters: [{ type: 'payload', payload: button.payload }] });
    }
  }
  return components;
}

/** @param {z.infer<typeof headerSchema>} header */
function headerParameter(header) {
  if (header.type === 'text') {
    return { type: 'text', text: toText(header.text), ...(header.name ? { parameter_name: header.name } : {}) };
  }
  if (header.type === 'location') {
    const { latitude, longitude, name, address } = header;
    return { type: 'location', location: { latitude: String(latitude), longitude: String(longitude), name, address } };
  }
  if (Boolean(header.id) === Boolean(header.link)) throw invalid('Template media header needs exactly one of id or link');
  const media = header.id ? { id: header.id } : { link: header.link };
  if (header.type === 'document' && header.filename) Object.assign(media, { filename: header.filename });
  return { type: header.type, [header.type]: media };
}

const templateSendSchema = z
  .object({
    name: z.string().regex(TEMPLATE_NAME_RE, 'lowercase letters, digits and underscores only'),
    language: z.string().regex(LANGUAGE_RE, 'must be a template language code such as en or en_US'),
    /** Raw Cloud API components (escape hatch). Do not combine with variables. */
    components: z.array(z.record(z.string(), z.unknown())).optional(),
    variables: templateVariablesSchema.optional(),
  })
  .refine((v) => !(v.components && v.variables), 'give components or variables, not both');

/**
 * Body for sending an approved template (works outside the 24-hour customer service window).
 * @param {object} input
 * @param {{ defaultCountryCode?: string, messagingAccountId?: string }} [options]
 */
export function buildTemplateMessage(input, options = {}) {
  const r = parseInput(recipientSchema, input, 'recipient');
  const c = parseInput(commonSchema, input, 'message');
  const t = parseInput(templateSendSchema, input, 'template message');
  const body = envelope({ ...r, ...c }, options, 'template');
  /** @type {Record<string, unknown>} */
  const template = { name: t.name, language: { code: t.language } };
  const components = t.components ?? (t.variables ? buildTemplateComponents(t.variables) : []);
  if (components.length) template.components = components;
  body.template = template;
  return body;
}

const textSchema = z.object({ body: z.string().min(1).max(TEXT_MAX), previewUrl: z.boolean().optional() });

/**
 * Free-form text (only inside the 24-hour customer service window, else error 131047).
 * @param {object} input
 * @param {{ defaultCountryCode?: string, messagingAccountId?: string }} [options]
 */
export function buildTextMessage(input, options = {}) {
  const r = parseInput(recipientSchema, input, 'recipient');
  const c = parseInput(commonSchema, input, 'message');
  const t = parseInput(textSchema, input, 'text message');
  const body = envelope({ ...r, ...c }, options, 'text');
  body.text = { body: t.body, ...(t.previewUrl === undefined ? {} : { preview_url: t.previewUrl }) };
  return body;
}

const mediaSchema = z.object({
  kind: z.enum(/** @type {['image', 'video', 'audio', 'document', 'sticker']} */ ([...MEDIA_KINDS])),
  media: mediaRef,
  caption: z.string().min(1).max(1024).optional(),
});

/**
 * Image, video, audio, document or sticker by uploaded media id or by https link.
 * @param {object} input
 * @param {{ defaultCountryCode?: string, messagingAccountId?: string }} [options]
 */
export function buildMediaMessage(input, options = {}) {
  const r = parseInput(recipientSchema, input, 'recipient');
  const c = parseInput(commonSchema, input, 'message');
  const m = parseInput(mediaSchema, input, 'media message');
  if (m.caption && (m.kind === 'audio' || m.kind === 'sticker')) throw invalid(`${m.kind} messages cannot have a caption`);
  if (m.media.filename && m.kind !== 'document') throw invalid('Only documents take a filename');
  const body = envelope({ ...r, ...c }, options, m.kind);
  body[m.kind] = {
    ...(m.media.id ? { id: m.media.id } : { link: m.media.link }),
    ...(m.caption ? { caption: m.caption } : {}),
    ...(m.media.filename ? { filename: m.media.filename } : {}),
  };
  return body;
}

const reactionSchema = z.object({ messageId: z.string().min(1), emoji: z.string().max(16) });

/**
 * React to a received message; an empty emoji removes the reaction.
 * @param {object} input
 * @param {{ defaultCountryCode?: string, messagingAccountId?: string }} [options]
 */
export function buildReactionMessage(input, options = {}) {
  const r = parseInput(recipientSchema, input, 'recipient');
  const x = parseInput(reactionSchema, input, 'reaction');
  const body = envelope(r, options, 'reaction');
  body.reaction = { message_id: x.messageId, emoji: x.emoji };
  return body;
}

const interactiveSchema = z.object({
  interactive: z.looseObject({ type: z.string().min(1), action: z.record(z.string(), z.unknown()) }),
});

/**
 * Interactive messages (reply buttons, lists, CTA URL, flows). The `interactive` object is passed
 * through as documented by Meta; only its envelope is built here.
 * @param {object} input
 * @param {{ defaultCountryCode?: string, messagingAccountId?: string }} [options]
 */
export function buildInteractiveMessage(input, options = {}) {
  const r = parseInput(recipientSchema, input, 'recipient');
  const c = parseInput(commonSchema, input, 'message');
  const i = parseInput(interactiveSchema, input, 'interactive message');
  const body = envelope({ ...r, ...c }, options, 'interactive');
  body.interactive = i.interactive;
  return body;
}

/**
 * Mark a received message as read, optionally showing a typing indicator (dismissed on reply or after 25 s).
 * @param {{ messageId: string, typing?: boolean }} input
 */
export function buildMarkRead(input) {
  const x = parseInput(z.object({ messageId: z.string().min(1), typing: z.boolean().optional() }), input, 'mark read');
  return {
    messaging_product: 'whatsapp',
    status: 'read',
    message_id: x.messageId,
    ...(x.typing ? { typing_indicator: { type: 'text' } } : {}),
  };
}

export const TEMPLATE_CATEGORIES = Object.freeze(['AUTHENTICATION', 'MARKETING', 'UTILITY']);

export const createTemplateSchema = z.object({
  name: z.string().regex(TEMPLATE_NAME_RE, 'lowercase letters, digits and underscores only'),
  language: z.string().regex(LANGUAGE_RE, 'must be a template language code such as en or en_US'),
  category: z.string().transform((s) => s.toUpperCase()).pipe(z.enum(['AUTHENTICATION', 'MARKETING', 'UTILITY'])),
  components: z.array(z.record(z.string(), z.unknown())).min(1),
  parameterFormat: z.string().transform((s) => s.toUpperCase()).pipe(z.enum(['NAMED', 'POSITIONAL'])).optional(),
  allowCategoryChange: z.boolean().optional(),
  messageSendTtlSeconds: z.number().int().positive().optional(),
});

/**
 * Body for POST /{WABA-ID}/message_templates.
 * @param {z.input<typeof createTemplateSchema>} input
 */
export function buildCreateTemplate(input) {
  const t = parseInput(createTemplateSchema, input, 'template');
  return {
    name: t.name,
    language: t.language,
    category: t.category,
    components: t.components,
    ...(t.parameterFormat ? { parameter_format: t.parameterFormat } : {}),
    ...(t.allowCategoryChange === undefined ? {} : { allow_category_change: t.allowCategoryChange }),
    ...(t.messageSendTtlSeconds ? { message_send_ttl_seconds: t.messageSendTtlSeconds } : {}),
  };
}

export const editTemplateSchema = z
  .object({
    category: z.string().transform((s) => s.toUpperCase()).pipe(z.enum(['AUTHENTICATION', 'MARKETING', 'UTILITY'])).optional(),
    components: z.array(z.record(z.string(), z.unknown())).min(1).optional(),
    messageSendTtlSeconds: z.number().int().positive().optional(),
  })
  .refine((v) => v.category || v.components || v.messageSendTtlSeconds, 'nothing to change');

/**
 * Body for POST /{TEMPLATE-ID}. Components replace all existing components.
 * @param {z.input<typeof editTemplateSchema>} input
 */
export function buildEditTemplate(input) {
  const t = parseInput(editTemplateSchema, input, 'template edit');
  return {
    ...(t.category ? { category: t.category } : {}),
    ...(t.components ? { components: t.components } : {}),
    ...(t.messageSendTtlSeconds ? { message_send_ttl_seconds: t.messageSendTtlSeconds } : {}),
  };
}

/**
 * Normalise a template object from the Message Templates API.
 * @param {Record<string, any>} t
 */
export function normalizeTemplate(t) {
  return {
    id: String(t.id ?? ''),
    name: t.name ?? null,
    language: t.language ?? null,
    status: t.status ?? null,
    category: t.category ?? null,
    subCategory: t.sub_category ?? null,
    parameterFormat: t.parameter_format ?? null,
    qualityScore: t.quality_score?.score ?? null,
    rejectedReason: t.rejected_reason ?? null,
    components: Array.isArray(t.components) ? t.components : [],
    lastUpdatedAt: Number.isFinite(Number(t.last_updated_time)) && t.last_updated_time !== undefined
      ? new Date(Number(t.last_updated_time) * 1000).toISOString()
      : null,
  };
}
