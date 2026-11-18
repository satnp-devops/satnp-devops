/**
 * WhatsApp Cloud API (Meta) provider for Phoenix CRM. Dependency-free apart from zod.
 *
 * Wrap this in the adapter interface (kind: messaging.whatsapp):
 *
 *   import { createWaClient, verifyWebhook, parseWebhook } from './providers/wa/index.js';
 *   const wa = createWaClient(connection.config, { fetch, now, logger });
 *   await wa.sendTemplate({ to: '+919876543210', name: 'admission_followup', language: 'en',
 *     variables: { body: { student_name: 'Asha' } }, callbackData: outboxId });
 *
 *   // POST /webhooks/whatsapp (raw body!)
 *   const check = verifyWebhook(req.rawBody, req.headers, [appSecret, previousAppSecret]);
 *   if (!check.ok) return res.sendStatus(401);
 *   for (const event of parseWebhook(req.rawBody)) await inbox.record(event); // dedupe on event.eventId
 *   res.sendStatus(200);
 *
 * See docs/providers/wa.md for config fields, webhook setup, retry semantics and India notes.
 */
export { createWaClient } from './client.js';
export { DEFAULT_GRAPH_VERSION, DEFAULT_MEDIA_HOSTS, describeConfig, parseWaConfig, waConfigSchema } from './config.js';
export { ERROR_CODES, WaError, classifyError, normalizeWebhookError, redact } from './errors.js';
export {
  MEDIA_KINDS,
  MEDIA_LIMITS,
  TEMPLATE_CATEGORIES,
  buildCreateTemplate,
  buildEditTemplate,
  buildInteractiveMessage,
  buildMarkRead,
  buildMediaMessage,
  buildReactionMessage,
  buildTemplateComponents,
  buildTemplateMessage,
  buildTextMessage,
  formatMoney,
  normalizePhone,
  normalizeTemplate,
} from './payloads.js';
export { getHeader, newestTimestamp, normalizeInbound, normalizeStatus, parseWebhook, signWebhook, toIso, verifySubscription, verifyWebhook } from './webhook.js';

/** Adapter kind this provider implements. */
export const WA_ADAPTER_KIND = 'messaging.whatsapp';

/** What the client can do, for the adapter's capability list. */
export const WA_CAPABILITIES = Object.freeze([
  'send.template',
  'send.text',
  'send.media',
  'send.interactive',
  'send.reaction',
  'message.markRead',
  'message.typingIndicator',
  'webhook.verifySubscription',
  'webhook.verifySignature',
  'webhook.inboundMessages',
  'webhook.messageStatus',
  'webhook.templateStatus',
  'templates.list',
  'templates.get',
  'templates.create',
  'templates.edit',
  'templates.delete',
  'media.upload',
  'media.get',
  'media.download',
  'media.delete',
  'connection.check',
]);
