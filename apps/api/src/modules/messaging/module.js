import { db } from '../../lib/db.js';
import { eraseContactMessages, messagingSettings, moveContactMessages } from '../../core/messaging/index.js';
import { messagingRoutes } from './routes.js';
import { messagingWebhookHandlerMap, messagingWebhookSources } from './webhooks.js';

/**
 * Phase 5 foundations: messaging (docs/platform/MESSAGING.md). Conversations and messages on
 * WhatsApp, email and SMS through each company's connections, the WhatsApp 24-hour window, consent
 * checks, outbound throttling, message templates with approval, and the webhook handlers for
 * providers and the separate WhatsApp tool (modules/messaging/webhooks.js).
 *
 * The platform's one way to send is core/messaging sendMessage(); this module adds the HTTP API.
 */
export default {
  name: 'messaging',
  label: 'Messaging',
  permissions: [
    {
      key: 'messaging.view',
      label: 'See messages',
      description: 'See conversations and the WhatsApp messages, emails and SMS sent and received',
      supportsOwn: true,
    },
    {
      key: 'messaging.send',
      label: 'Send messages',
      description: 'Send WhatsApp templates and replies, emails and SMS to people',
      supportsOwn: true,
    },
    {
      key: 'messaging.templates_view',
      label: 'See message templates',
      description: "See the company's WhatsApp, email and SMS templates and their approval status",
    },
    {
      key: 'messaging.templates_manage',
      label: 'Manage message templates',
      description: 'Create and edit message templates and submit them for approval',
    },
  ],
  roleGrants: {
    group_admin: ['messaging.view', 'messaging.send', 'messaging.templates_view', 'messaging.templates_manage'],
    company_admin: ['messaging.view', 'messaging.send', 'messaging.templates_view', 'messaging.templates_manage'],
    manager: ['messaging.view', 'messaging.send', 'messaging.templates_view'],
    counsellor: ['messaging.view:own', 'messaging.send:own', 'messaging.templates_view'],
    account_executive: ['messaging.view:own', 'messaging.send:own', 'messaging.templates_view'],
    finance: ['messaging.view', 'messaging.send', 'messaging.templates_view'],
    marketing: ['messaging.view', 'messaging.templates_view', 'messaging.templates_manage'],
    support: ['messaging.view', 'messaging.send', 'messaging.templates_view'],
    analyst: ['messaging.templates_view'],
  },
  settings: messagingSettings,
  // No enquiry channels of its own: WhatsApp and email are built in (core/crm/channels.js), and SMS
  // only goes out (registered templates), so it never brings in an enquiry.
  eventHandlers: {
    // Keep messages with the person when the contacts module merges or erases them.
    'contact.merged': async (event) => {
      const { targetId, sourceId } = event.payload ?? {};
      if (targetId && sourceId) await db.transaction((trx) => moveContactMessages(trx, { sourceId, targetId }));
    },
    'contact.erased': async (event) => {
      const { contactId } = event.payload ?? {};
      if (contactId) await db.transaction((trx) => eraseContactMessages(trx, contactId));
    },
  },
  // Provider events (delivery receipts, inbound messages, template approvals) and the separate
  // WhatsApp tool's own signed events (POST /api/v1/webhooks/whatsapp_tool/:connectionId).
  webhookSources: messagingWebhookSources,
  webhookHandlers: messagingWebhookHandlerMap,
  routes: (router) => messagingRoutes(router),
};
