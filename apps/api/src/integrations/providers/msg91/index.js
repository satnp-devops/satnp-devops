/**
 * MSG91 SMS provider (India, DLT) for the Phoenix integration framework (kind: messaging.sms).
 *
 *   import { createMsg91Client, verifyWebhook, parseWebhook } from './providers/msg91/index.js';
 *   const sms = createMsg91Client(connection.config, { fetch, now, logger });
 *   await sms.sendTemplate({ template: 'admission.counselling_reminder', to: '9876543210',
 *     variables: { name: 'Asha', date: '12 Nov' }, reference: messageId });
 *
 * See docs/providers/msg91.md for config fields, webhook setup, DLT rules and unconfirmed facts.
 */
export { createMsg91Client } from './client.js';
export { msg91ConfigSchema, parseMsg91Config, templateSchema, TEMPLATE_CATEGORIES, VARIABLE_TYPES } from './config.js';
export {
  Msg91Error,
  Msg91ConfigError,
  Msg91ValidationError,
  PROVIDER_ERROR_CODES,
  classifyProviderError,
  redact,
} from './errors.js';
export {
  verifyWebhook,
  parseWebhook,
  deriveWebhookToken,
  safeEqual,
  classifyFailureReason,
  toUtcIso,
  toMoney,
  DELIVERY_STATUS_CODES,
  MAX_WEBHOOK_BYTES,
} from './webhook.js';
export {
  normalizeMobile,
  maskMobile,
  extractPlaceholders,
  extractDltTags,
  bodiesMatch,
  templateVariables,
  checkTemplateDefinition,
  checkSenderId,
  checkVariableValue,
  checkUrls,
  findUrls,
  isUrlWhitelisted,
  isIpUrl,
  isCallbackNumberWhitelisted,
  renderTemplate,
  promotionalWindowStatus,
  isWindowRestricted,
  formatIst,
  checkSchedule,
  toCrqid,
  estimateSegments,
  IST_OFFSET_MINUTES,
  SHORT_URL_BASE,
  CRQID_MAX_LENGTH,
  MAX_SCHEDULE_AHEAD_MS,
} from './dlt.js';
export { parseRetryAfter } from './http.js';

/** Capabilities this client implements, for the adapter registry. */
export const MSG91_CAPABILITIES = Object.freeze([
  'sms.template.send',
  'sms.template.schedule',
  'sms.template.validate',
  'sms.otp.send',
  'sms.otp.verify',
  'sms.otp.resend',
  'sms.delivery_reports.webhook',
  'sms.delivery_reports.logs',
  'sms.templates.list',
  'connection.check',
]);
