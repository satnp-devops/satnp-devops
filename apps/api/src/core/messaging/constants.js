// Vocabularies of the messaging service (docs/platform/MESSAGING.md).

export const MESSAGE_CHANNELS = ['whatsapp', 'email', 'sms'];

/** The integration kind that delivers each channel (docs/platform/INTEGRATIONS.md). */
export const CHANNEL_KINDS = Object.freeze({
  whatsapp: 'messaging.whatsapp',
  email: 'messaging.email',
  sms: 'messaging.sms',
});

export const CHANNEL_LABELS = Object.freeze({ whatsapp: 'WhatsApp', email: 'Email', sms: 'SMS' });

/** Which contact_methods kinds can receive each channel, in order of preference. */
export const CHANNEL_METHOD_KINDS = Object.freeze({
  whatsapp: ['whatsapp', 'phone'],
  sms: ['phone', 'whatsapp'],
  email: ['email'],
});

/** Timeline kind of a message on each channel (docs/crm/PHASE2_CONTRACT.md §11.3). */
export const TIMELINE_KIND_OF_CHANNEL = Object.freeze({ whatsapp: 'message', sms: 'message', email: 'email' });

export const MESSAGE_DIRECTIONS = ['inbound', 'outbound'];
export const MESSAGE_STATUSES = ['queued', 'sent', 'delivered', 'read', 'failed', 'received'];
/** Statuses a provider (or the WhatsApp tool) reports after a send. */
export const DELIVERY_STATUSES = ['sent', 'delivered', 'read', 'failed'];
export const MESSAGE_SOURCES = ['crm', 'provider', 'whatsapp_tool'];
export const MESSAGE_PURPOSES = ['marketing', 'transactional', 'service'];

export const TEMPLATE_CATEGORIES = ['utility', 'marketing', 'authentication'];
export const TEMPLATE_STATUSES = ['draft', 'submitted', 'approved', 'rejected'];
export const TEMPLATE_BUTTON_TYPES = ['quick_reply', 'url', 'phone'];

/**
 * The consent purpose a template category sends under (core/crm/consent.js):
 * marketing needs a grant; utility (booking links, reminders, receipts) and authentication (codes)
 * are transactional, allowed unless withdrawn.
 */
export const PURPOSE_OF_CATEGORY = Object.freeze({ marketing: 'marketing', utility: 'transactional', authentication: 'transactional' });

/** WhatsApp's customer-service window: free-form replies only within 24 hours of the customer's last message. */
export const WHATSAPP_WINDOW_HOURS = 24;

/**
 * Outbound throttle per connection (token bucket, core/messaging/throttle.js): sustained rate and
 * burst. Kept below the providers' published limits (WhatsApp Cloud API 80 messages/s per number,
 * MSG91 and SendGrid well above these), so one company's bulk send can't trip them.
 */
export const THROTTLE_LIMITS = Object.freeze({
  whatsapp: { ratePerSecond: 20, burst: 40 },
  sms: { ratePerSecond: 20, burst: 40 },
  email: { ratePerSecond: 10, burst: 20 },
});

/** How long a send may wait for a token before it is refused (429 message_throttled). */
export const THROTTLE_MAX_WAIT_MS = 3000;
