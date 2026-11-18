import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { db } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { emitEvent } from '../../core/events.js';
import { deriveConnectionSecret } from '../../integrations/framework/credentials.js';
import {
  normalizeAddress,
  recordHandover,
  recordInboundMessage,
  recordMessageStatus,
  recordUnsubscribe,
  resolveInboundCompany,
} from '../../core/messaging/index.js';
import { applyProviderTemplateStatus } from './templates.js';
import { PermanentJobError } from '../../core/jobs/runner.js';

// Webhook handlers of the messaging module (docs/platform/MESSAGING.md, "Webhooks").
//
// The webhooks service (core/webhooks) owns the HTTP route, signature checks for provider adapters,
// de-duplication by (connection, eventId), the queue and retries. Once an adapter's parseWebhook()
// has turned a request into normalised events, the worker runs the handlers module.js registers
// for the connection's kind and the event's type (messagingWebhookHandlerMap, at the bottom).
//
// The separate WhatsApp tool (the inbox a person or an AI bot answers chats in) isn't an adapter:
// it posts its own signed events, and `whatsappTool` below verifies and parses them, then its
// handlers run the same way.
//
// Every handler is idempotent and resolves to { status: 'processed' | 'duplicate' | 'ignored' | 'unrouted', ... }.
// They throw only for problems a retry can fix (the database is down); a payload they can't read
// throws AppError 422 (retrying won't help: send it to the dead-letter queue).

/**
 * @typedef {{ eventId: string, type: string, occurredAt: string, reference?: string | null, data: Record<string, unknown> }} WebhookEvent
 * @typedef {{ connection: { id: string, kind?: string, provider?: string }, log?: object }} WebhookContext
 */

const bad = (message) => new AppError(422, 'webhook_invalid', message);

function parseData(schema, data, type) {
  const result = schema.safeParse(data ?? {});
  if (!result.success) throw bad(`Unreadable ${type} event: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return result.data;
}

/** Emit message.unrouted when a shared connection can't tell which company a person wrote to (intake routes it). */
async function unrouted({ connection, channel, event, from, text, contactName }) {
  const row = await db('integration_connections').where({ id: connection.id }).first('group_id');
  await db.transaction((trx) =>
    emitEvent(trx, {
      type: 'message.unrouted',
      groupId: row?.group_id ?? null,
      aggregateType: 'connection',
      aggregateId: connection.id,
      // Intake needs the message to route it; this payload stays inside the outbox.
      payload: { connectionId: connection.id, channel, eventId: event.eventId, occurredAt: event.occurredAt, from, text: text ?? null, contactName: contactName ?? null },
    }),
  );
  return { status: 'unrouted' };
}

async function inbound({ channel, connection, event, from, to, contactName, text, subject, media, providerMessageId, replyTo, hint, source = 'provider' }) {
  const company = await db('integration_connections').where({ id: connection.id }).first('group_id');
  if (!company) throw bad('Unknown connection');
  const address = normalizeAddress(channel, from);
  const companyId = await resolveInboundCompany({ connectionId: connection.id, channel, address, hint });
  if (!companyId) return unrouted({ connection, channel, event, from, text, contactName });
  const result = await recordInboundMessage({
    companyId,
    channel,
    connectionId: connection.id,
    from,
    to: to ?? null,
    contactName: contactName ?? null,
    text: text ?? null,
    subject: subject ?? null,
    media: media ?? [],
    providerMessageId,
    occurredAt: event.occurredAt,
    source,
    replyToProviderMessageId: replyTo ?? null,
  });
  return { status: result.created ? 'processed' : 'duplicate', messageId: result.message.id, companyId };
}

async function status({ channel, connection, event, providerMessageId, value, errorCode, errorMessage }) {
  const result = await recordMessageStatus({
    channel,
    connectionId: connection.id,
    providerMessageId,
    status: value,
    occurredAt: event.occurredAt,
    errorCode: errorCode ?? null,
    errorMessage: errorMessage ?? null,
  });
  if (!result.found) return { status: 'ignored', reason: 'unknown_message' };
  return { status: result.changed ? 'processed' : 'duplicate', messageId: result.message.id };
}

// ---------- Provider events (adapters' parseWebhook output, docs/platform/INTEGRATIONS.md) ----------

const whatsappReceived = z.object({
  from: z.string().min(3),
  to: z.string().optional(),
  providerMessageId: z.string().min(1),
  text: z.string().max(20_000).nullable().optional(),
  mediaType: z.string().max(40).optional(),
  contactName: z.string().max(200).nullable().optional(),
  replyToProviderMessageId: z.string().nullable().optional(),
});
const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'document', 'sticker', 'location', 'contact']);
const providerStatus = z.object({
  providerMessageId: z.string().min(1),
  status: z.enum(['sent', 'delivered', 'read', 'failed']),
  errorCode: z.union([z.string(), z.number()]).transform(String).optional(),
  errorMessage: z.string().max(500).optional(),
});
const templateStatus = z.object({ name: z.string().min(1), language: z.string().min(2), status: z.string().min(1), reason: z.string().max(300).optional() });
const emailReceived = z.object({
  from: z.string().min(3),
  to: z.string().optional(),
  subject: z.string().max(998).optional(),
  text: z.string().max(200_000).nullable().optional(),
  html: z.string().optional(),
  messageIdHeader: z.string().max(300).optional(),
  inReplyTo: z.string().max(300).optional(),
});
const emailEvent = z.object({ providerMessageId: z.string().min(1), email: z.string().optional(), bounceType: z.enum(['hard', 'soft']).optional(), reason: z.string().max(500).optional() });
const smsEvent = z.object({ providerMessageId: z.string().min(1), to: z.string().optional(), reason: z.string().max(500).optional() });

/** Handlers by integration kind and event type, for the webhooks service to register. */
export const messagingWebhookHandlers = Object.freeze({
  'messaging.whatsapp': Object.freeze({
    /** @param {WebhookEvent} event @param {WebhookContext} context */
    'message.received': async (event, { connection }) => {
      const data = parseData(whatsappReceived, event.data, event.type);
      return inbound({
        channel: 'whatsapp',
        connection,
        event,
        from: data.from,
        to: data.to,
        contactName: data.contactName,
        text: data.text ?? null,
        media: data.mediaType ? [{ type: MEDIA_TYPES.has(data.mediaType) ? data.mediaType : 'other' }] : [],
        providerMessageId: data.providerMessageId,
        replyTo: data.replyToProviderMessageId,
      });
    },
    'message.status': async (event, { connection }) => {
      const data = parseData(providerStatus, event.data, event.type);
      return status({ channel: 'whatsapp', connection, event, providerMessageId: data.providerMessageId, value: data.status, errorCode: data.errorCode, errorMessage: data.errorMessage });
    },
    'template.status': async (event, { connection }) => {
      const data = parseData(templateStatus, event.data, event.type);
      const changed = await applyProviderTemplateStatus({ connectionId: connection.id, name: data.name, language: data.language, status: data.status.toLowerCase(), reason: data.reason ?? null });
      return { status: changed ? 'processed' : 'ignored', templates: changed };
    },
  }),
  'messaging.email': Object.freeze({
    'email.received': async (event, { connection }) => {
      const data = parseData(emailReceived, event.data, event.type);
      return inbound({
        channel: 'email',
        connection,
        event,
        from: data.from,
        to: data.to,
        subject: data.subject ?? null,
        text: data.text ?? null,
        providerMessageId: data.messageIdHeader || `event:${event.eventId}`,
        replyTo: data.inReplyTo,
      });
    },
    'email.delivered': async (event, { connection }) => {
      const data = parseData(emailEvent, event.data, event.type);
      return status({ channel: 'email', connection, event, providerMessageId: data.providerMessageId, value: 'delivered' });
    },
    'email.opened': async (event, { connection }) => {
      const data = parseData(emailEvent, event.data, event.type);
      return status({ channel: 'email', connection, event, providerMessageId: data.providerMessageId, value: 'read' });
    },
    'email.clicked': async (event, { connection }) => {
      const data = parseData(emailEvent, event.data, event.type);
      return status({ channel: 'email', connection, event, providerMessageId: data.providerMessageId, value: 'read' });
    },
    'email.bounced': async (event, { connection }) => {
      const data = parseData(emailEvent, event.data, event.type);
      // A soft bounce is retried by the provider; only a hard bounce fails the message.
      if (data.bounceType === 'soft') return { status: 'ignored', reason: 'soft_bounce' };
      return status({ channel: 'email', connection, event, providerMessageId: data.providerMessageId, value: 'failed', errorCode: 'bounced', errorMessage: data.reason ?? 'The address bounced' });
    },
    'email.unsubscribed': async (event, { connection }) => {
      const data = parseData(emailEvent, event.data, event.type);
      const result = await recordUnsubscribe({ channel: 'email', providerMessageId: data.providerMessageId, connectionId: connection.id, reason: 'unsubscribed', occurredAt: event.occurredAt });
      return { status: result.found ? (result.consent ? 'processed' : 'duplicate') : 'ignored' };
    },
    'email.spam_reported': async (event, { connection }) => {
      const data = parseData(emailEvent, event.data, event.type);
      const result = await recordUnsubscribe({ channel: 'email', providerMessageId: data.providerMessageId, connectionId: connection.id, reason: 'spam_reported', occurredAt: event.occurredAt });
      return { status: result.found ? (result.consent ? 'processed' : 'duplicate') : 'ignored' };
    },
  }),
  'messaging.sms': Object.freeze({
    'sms.delivered': async (event, { connection }) => {
      const data = parseData(smsEvent, event.data, event.type);
      return status({ channel: 'sms', connection, event, providerMessageId: data.providerMessageId, value: 'delivered' });
    },
    'sms.failed': async (event, { connection }) => {
      const data = parseData(smsEvent, event.data, event.type);
      return status({ channel: 'sms', connection, event, providerMessageId: data.providerMessageId, value: 'failed', errorCode: 'sms_failed', errorMessage: data.reason ?? null });
    },
  }),
});

/**
 * Run the messaging handler for a provider event, if there is one.
 * @param {string} kind the connection's kind
 * @param {WebhookEvent} event
 * @param {WebhookContext} context
 */
export async function handleMessagingWebhookEvent(kind, event, context) {
  const handler = messagingWebhookHandlers[kind]?.[event.type];
  if (!handler) return { status: 'ignored', reason: 'no_handler' };
  return handler(event, { log: logger, ...context });
}

// ---------- The WhatsApp tool ----------

export const WHATSAPP_TOOL_SIGNATURE_HEADER = 'x-phoenix-signature';

const agent = z.strictObject({ type: z.enum(['bot', 'human']), name: z.string().trim().max(120).optional(), email: z.string().trim().max(254).optional() });
const toolMedia = z.strictObject({
  type: z.enum(['image', 'video', 'audio', 'document', 'sticker', 'location', 'contact', 'other']),
  url: z.url().max(2000).optional(),
  fileId: z.string().max(200).optional(),
  mimeType: z.string().max(120).optional(),
  caption: z.string().max(1024).optional(),
  fileName: z.string().max(255).optional(),
});
const companyHint = z.uuid().optional().describe('Which company the chat is for, when the number is shared by several');

export const whatsappToolEventSchemas = Object.freeze({
  'message.in': z.strictObject({
    messageId: z.string().trim().min(1).max(300).describe("WhatsApp's message id (wamid), so the same message from the provider and the tool is stored once"),
    from: z.string().trim().min(3).max(32),
    to: z.string().trim().max(32).optional(),
    contactName: z.string().trim().max(200).optional(),
    text: z.string().max(4096).optional(),
    media: z.array(toolMedia).max(10).default([]),
    replyToMessageId: z.string().max(300).optional(),
    companyId: companyHint,
  }),
  'message.out': z.strictObject({
    messageId: z.string().trim().min(1).max(300),
    to: z.string().trim().min(3).max(32),
    from: z.string().trim().max(32).optional(),
    text: z.string().max(4096).optional(),
    media: z.array(toolMedia).max(10).default([]),
    template: z.strictObject({ name: z.string().max(100), language: z.string().max(15).optional() }).optional(),
    agent,
    companyId: companyHint,
  }),
  'message.status': z.strictObject({
    messageId: z.string().trim().min(1).max(300),
    status: z.enum(['sent', 'delivered', 'read', 'failed']),
    errorCode: z.string().max(100).optional(),
    errorMessage: z.string().max(500).optional(),
  }),
  'conversation.handover': z.strictObject({
    from: z.string().trim().min(3).max(32).describe("The person's WhatsApp number"),
    to: z.enum(['human', 'bot', 'crm']),
    reason: z.string().trim().max(300).optional(),
    summary: z.string().trim().max(4000).optional(),
    agent: agent.optional(),
    companyId: companyHint,
  }),
});

const toolEnvelope = z.object({
  events: z
    .array(
      z.object({
        id: z.string().min(1).max(200),
        type: z.enum(Object.keys(whatsappToolEventSchemas)),
        occurredAt: z.iso.datetime({ offset: true }),
        data: z.record(z.string(), z.unknown()).default({}),
      }),
    )
    .min(1)
    .max(100),
});

/** The secret the WhatsApp tool signs its webhooks with, one per WhatsApp connection. Never stored. */
export const whatsappToolSecret = (connectionId) => deriveConnectionSecret(connectionId, 'whatsapp-tool', env.encryptionKey);

export const signWhatsappToolBody = (secret, rawBody) => `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;

const headerOf = (headers, name) => {
  const value = headers?.[name];
  return Array.isArray(value) ? value[0] : value;
};

async function toolCompany(connection, address, hint) {
  return resolveInboundCompany({ connectionId: connection.id, channel: 'whatsapp', address: address ? normalizeAddress('whatsapp', address) : null, hint: hint ?? null });
}

/**
 * The WhatsApp tool as a webhook source, shaped like an adapter's webhook methods so the webhooks
 * service can treat it the same way. Its route is POST /api/v1/webhooks/whatsapp_tool/:connectionId,
 * where the connection is the company's (or the group's shared) messaging.whatsapp connection.
 */
export const whatsappTool = Object.freeze({
  source: 'whatsapp_tool',
  kind: 'messaging.whatsapp',

  /** HMAC-SHA256 of the exact raw body, constant-time compared. Never throws. */
  async verifyWebhook(request, { connectionId }) {
    try {
      const given = headerOf(request.headers, WHATSAPP_TOOL_SIGNATURE_HEADER);
      if (!given) return { ok: false, reason: 'missing_signature' };
      const expected = Buffer.from(signWhatsappToolBody(whatsappToolSecret(connectionId), Buffer.from(request.rawBody)));
      const actual = Buffer.from(String(given));
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return { ok: false, reason: 'bad_signature' };
      return { ok: true };
    } catch {
      return { ok: false, reason: 'unreadable' };
    }
  },

  /** { events: [{ eventId, type, occurredAt, data }] }; throws 422 for a body it can't read. */
  async parseWebhook(request) {
    let body;
    try {
      body = JSON.parse(Buffer.from(request.rawBody).toString('utf8'));
    } catch {
      throw bad('The webhook body is not JSON');
    }
    const parsed = toolEnvelope.safeParse(body);
    if (!parsed.success) throw bad('The webhook body is not a WhatsApp tool event list');
    return {
      events: parsed.data.events.map((e) => ({ eventId: e.id, type: e.type, occurredAt: new Date(e.occurredAt).toISOString(), reference: null, data: e.data })),
    };
  },

  async webhookChallenge(request) {
    const challenge = request.query?.challenge;
    if (request.method !== 'GET' || typeof challenge !== 'string' || !challenge) return null;
    return { status: 200, contentType: 'text/plain', body: challenge.slice(0, 200) };
  },

  handlers: Object.freeze({
    'message.in': async (event, { connection }) => {
      const data = parseData(whatsappToolEventSchemas['message.in'], event.data, event.type);
      return inbound({
        channel: 'whatsapp',
        connection,
        event,
        from: data.from,
        to: data.to,
        contactName: data.contactName,
        text: data.text ?? null,
        media: data.media,
        providerMessageId: data.messageId,
        replyTo: data.replyToMessageId,
        hint: data.companyId,
        source: 'whatsapp_tool',
      });
    },
    'message.out': async (event, { connection }) => {
      const data = parseData(whatsappToolEventSchemas['message.out'], event.data, event.type);
      const companyId = await toolCompany(connection, data.to, data.companyId);
      if (!companyId) return unrouted({ connection, channel: 'whatsapp', event, from: data.to, text: data.text });
      const result = await recordInboundMessage({
        companyId,
        channel: 'whatsapp',
        connectionId: connection.id,
        direction: 'outbound',
        from: data.from ?? null,
        to: data.to,
        text: data.text ?? null,
        media: data.media,
        template: data.template ?? null,
        agent: data.agent,
        providerMessageId: data.messageId,
        occurredAt: event.occurredAt,
        source: 'whatsapp_tool',
      });
      return { status: result.created ? 'processed' : 'duplicate', messageId: result.message.id, companyId };
    },
    'message.status': async (event, { connection }) => {
      const data = parseData(whatsappToolEventSchemas['message.status'], event.data, event.type);
      return status({ channel: 'whatsapp', connection, event, providerMessageId: data.messageId, value: data.status, errorCode: data.errorCode, errorMessage: data.errorMessage });
    },
    'conversation.handover': async (event, { connection }) => {
      const data = parseData(whatsappToolEventSchemas['conversation.handover'], event.data, event.type);
      const companyId = await toolCompany(connection, data.from, data.companyId);
      if (!companyId) return unrouted({ connection, channel: 'whatsapp', event, from: data.from, text: data.summary });
      const result = await recordHandover({
        companyId,
        connectionId: connection.id,
        eventId: event.eventId,
        from: data.from,
        to: data.to,
        reason: data.reason ?? null,
        summary: data.summary ?? null,
        agent: data.agent ?? null,
        occurredAt: event.occurredAt,
      });
      return { status: result.created ? 'processed' : 'duplicate', conversationId: result.conversation.id };
    },
  }),
});

/** Run the WhatsApp tool's handler for one parsed event. */
export async function handleWhatsappToolEvent(event, context) {
  const handler = whatsappTool.handlers[event.type];
  if (!handler) return { status: 'ignored', reason: 'no_handler' };
  return handler(event, { log: logger, ...context });
}

/** A signed WhatsApp tool request, for tests and local development: { rawBody, headers }. */
export function buildWhatsappToolRequest(connectionId, events) {
  const rawBody = Buffer.from(JSON.stringify({ events }));
  return {
    method: 'POST',
    rawBody,
    query: {},
    headers: { 'content-type': 'application/json', [WHATSAPP_TOOL_SIGNATURE_HEADER]: signWhatsappToolBody(whatsappToolSecret(connectionId), rawBody) },
  };
}

// ---------- Registration with the webhooks service (core/webhooks, docs/platform/WEBHOOKS_AND_JOBS.md) ----------

/**
 * A messaging handler as the webhooks worker runs it: the connection comes from the stored event,
 * and a payload the handler can't read (422 webhook_invalid) dead-letters at once instead of retrying.
 */
const asWebhookHandler = (handler) => async (event, { log }) => {
  try {
    return await handler(event, { connection: { id: event.connectionId, kind: event.kind, provider: event.provider }, log });
  } catch (err) {
    if (err instanceof AppError && err.status < 500) throw new PermanentJobError(err.message);
    throw err;
  }
};

/** module.js webhookHandlers: '<kind>:<event>' for provider adapters, 'whatsapp_tool:<event>' for the tool. */
export const messagingWebhookHandlerMap = Object.freeze(
  Object.fromEntries([
    ...Object.entries(messagingWebhookHandlers).flatMap(([kind, handlers]) =>
      Object.entries(handlers).map(([type, handler]) => [`${kind}:${type}`, asWebhookHandler(handler)]),
    ),
    ...Object.entries(whatsappTool.handlers).map(([type, handler]) => [`${whatsappTool.source}:${type}`, asWebhookHandler(handler)]),
  ]),
);

/** module.js webhookSources: POST /api/v1/webhooks/whatsapp_tool/:connectionId (any active WhatsApp connection). */
export const messagingWebhookSources = Object.freeze({
  [whatsappTool.source]: Object.freeze({
    kind: whatsappTool.kind,
    events: Object.keys(whatsappTool.handlers),
    verifyWebhook: (request, ctx) => whatsappTool.verifyWebhook(request, ctx),
    parseWebhook: (request) => whatsappTool.parseWebhook(request),
    webhookChallenge: (request) => whatsappTool.webhookChallenge(request),
  }),
});
