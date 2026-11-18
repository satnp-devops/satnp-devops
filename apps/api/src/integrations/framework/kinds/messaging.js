import { z } from 'zod';
import { defineKind, e164, email, isoTime, optionalReference } from './common.js';

// Messaging kinds: WhatsApp, email and SMS. Feature code (phase 5, communication) decides what to
// send and when (consent, the WhatsApp 24-hour window, quiet hours); adapters only deliver.

const accepted = z.object({
  providerMessageId: z.string().min(1),
  status: z.enum(['accepted', 'queued']),
  acceptedAt: isoTime,
});

export const whatsapp = defineKind({
  key: 'messaging.whatsapp',
  label: 'WhatsApp',
  description: 'Send approved templates and replies from a WhatsApp Business number; receive messages and delivery receipts.',
  methods: {
    sendTemplate: {
      description: 'Send an approved message template (works outside the 24-hour customer service window).',
      input: z.strictObject({
        to: e164,
        template: z.strictObject({
          name: z.string().min(1).max(512),
          language: z.string().min(2).max(15).describe('Template language code, e.g. en or en_US'),
          bodyVariables: z.array(z.string().max(1024)).max(20).default([]),
          headerVariables: z.array(z.string().max(1024)).max(5).default([]),
          buttonVariables: z.array(z.string().max(2000)).max(10).default([]),
        }),
        reference: optionalReference,
      }),
      output: accepted,
    },
    sendText: {
      description:
        'Send a free-form reply. Only allowed inside the 24-hour window after the customer last wrote; the provider refuses it otherwise (integration_provider_error, details.reason "outside_window").',
      input: z.strictObject({
        to: e164,
        text: z.string().min(1).max(4096),
        previewUrl: z.boolean().default(false),
        reference: optionalReference,
      }),
      output: accepted,
    },
    listTemplates: {
      description: 'The templates approved (or pending) for this number.',
      input: z.strictObject({}),
      output: z.object({
        templates: z.array(
          z.object({
            name: z.string(),
            language: z.string(),
            category: z.enum(['marketing', 'utility', 'authentication']),
            status: z.enum(['approved', 'pending', 'rejected', 'paused', 'disabled']),
            bodyVariableCount: z.number().int().min(0),
          }),
        ),
      }),
    },
  },
  webhooks: {
    description: 'Meta calls us with inbound messages and status updates (signed X-Hub-Signature-256) and a GET hub.challenge handshake.',
    events: {
      'message.received': '{ from, to, providerMessageId, text, mediaType?, contactName?, replyToProviderMessageId? }',
      'message.status': '{ providerMessageId, status: sent | delivered | read | failed, errorCode?, errorMessage? }',
      'template.status': '{ name, language, status }',
    },
  },
  sample: {
    method: 'sendText',
    input: () => ({ to: '+919000000001', text: 'Test message from Phoenix (connection check)' }),
  },
});

const address = z.strictObject({ email, name: z.string().min(1).max(200).optional() });

export const emailKind = defineKind({
  key: 'messaging.email',
  label: 'Email',
  description: 'Send email from a company inbox or domain; receive delivery events and inbound replies.',
  methods: {
    send: {
      description: 'Send one email. Give text, html or a provider templateId (with templateData).',
      input: z
        .strictObject({
          to: z.array(address).min(1).max(50),
          cc: z.array(address).max(50).default([]),
          bcc: z.array(address).max(50).default([]),
          from: address.optional().describe("Defaults to the connection's sender"),
          replyTo: address.optional(),
          subject: z.string().min(1).max(998),
          text: z.string().max(1_000_000).optional(),
          html: z.string().max(2_000_000).optional(),
          templateId: z.string().min(1).max(100).optional(),
          templateData: z.record(z.string(), z.unknown()).optional(),
          attachments: z
            .array(
              z.strictObject({
                fileName: z.string().min(1).max(255),
                contentType: z.string().min(3).max(255),
                contentBase64: z.string().min(1).max(14_000_000),
              }),
            )
            .max(10)
            .default([]),
          categories: z.array(z.string().min(1).max(255)).max(10).default([]),
          reference: optionalReference,
        })
        .refine((m) => m.text || m.html || m.templateId, { message: 'Give text, html or templateId', path: ['text'] }),
      output: accepted,
    },
  },
  webhooks: {
    description: 'Delivery events (signed Event Webhook) and inbound email (Inbound Parse) for the connection.',
    events: {
      'email.delivered': '{ providerMessageId, email }',
      'email.bounced': '{ providerMessageId, email, bounceType: hard | soft, reason }',
      'email.opened': '{ providerMessageId, email }',
      'email.clicked': '{ providerMessageId, email, url }',
      'email.spam_reported': '{ providerMessageId, email }',
      'email.unsubscribed': '{ providerMessageId, email }',
      'email.received': '{ from, to, subject, text, html?, messageIdHeader?, inReplyTo? }',
    },
  },
  sample: {
    method: 'send',
    input: () => ({ to: [{ email: 'test@example.com', name: 'Test recipient' }], subject: 'Test email from Phoenix', text: 'This is a connection check.' }),
  },
});

export const sms = defineKind({
  key: 'messaging.sms',
  label: 'SMS',
  description: 'Send DLT-registered SMS templates (required in India); receive delivery reports.',
  methods: {
    send: {
      description: 'Send a registered template. Free text is not allowed on Indian routes (TRAI DLT).',
      input: z.strictObject({
        to: e164,
        templateId: z.string().min(1).max(64).describe("The provider's template id, mapped to a DLT template"),
        variables: z.record(z.string().regex(/^[A-Za-z0-9_]{1,40}$/), z.string().max(160)).default({}),
        senderId: z.string().regex(/^[A-Z]{6}$/, 'Six capital letters').optional(),
        reference: optionalReference,
      }),
      output: accepted,
    },
  },
  webhooks: {
    description: 'Delivery reports, authenticated by a shared token header.',
    events: {
      'sms.delivered': '{ providerMessageId, to }',
      'sms.failed': '{ providerMessageId, to, reason }',
    },
  },
  sample: {
    method: 'send',
    input: () => ({ to: '+919000000001', templateId: 'connection_check', variables: { name: 'Test' } }),
  },
});
