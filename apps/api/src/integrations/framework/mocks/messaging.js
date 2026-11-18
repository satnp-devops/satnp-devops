import { emailKind, sms, whatsapp } from '../kinds/messaging.js';
import { callKey, healthFor, iso, maybeFail, mockWebhookMethods, stableId } from './common.js';

// Mock WhatsApp, email and SMS: each send is recorded in the sandbox outbox and answered at once.

/** Templates the mock WhatsApp number "has approved". */
export const MOCK_WHATSAPP_TEMPLATES = Object.freeze([
  { name: 'booking_link', language: 'en', category: 'utility', status: 'approved', bodyVariableCount: 2 },
  { name: 'demo_reminder', language: 'en', category: 'utility', status: 'approved', bodyVariableCount: 3 },
  { name: 'payment_reminder', language: 'en', category: 'utility', status: 'approved', bodyVariableCount: 3 },
  { name: 'welcome_family', language: 'en', category: 'marketing', status: 'approved', bodyVariableCount: 1 },
  { name: 'welcome_family', language: 'hi', category: 'marketing', status: 'pending', bodyVariableCount: 1 },
]);

export function createWhatsappMock(ctx) {
  const accepted = async (operation, input, entry) => {
    maybeFail(ctx, operation);
    const providerMessageId = stableId('wamid.mock', ctx.connection.id, operation, callKey(input));
    await ctx.record({ operation, recipient: input.to, providerRef: providerMessageId, status: 'accepted', payload: input, ...entry });
    return { providerMessageId, status: 'accepted', acceptedAt: iso(ctx.now) };
  };
  return {
    kind: whatsapp.key,
    provider: 'mock',
    mock: true,
    async healthCheck() {
      return healthFor(ctx);
    },
    sendTemplate(input) {
      const { name, language, bodyVariables } = input.template;
      const known = MOCK_WHATSAPP_TEMPLATES.some((t) => t.name === name && t.language === language && t.status === 'approved');
      return accepted('sendTemplate', input, {
        subject: `Template ${name} (${language})${known ? '' : ' (not approved on the mock number)'}`,
        body: bodyVariables.length ? bodyVariables.join(' · ') : null,
      });
    },
    sendText(input) {
      return accepted('sendText', input, { subject: null, body: input.text });
    },
    async listTemplates() {
      maybeFail(ctx, 'listTemplates');
      return { templates: MOCK_WHATSAPP_TEMPLATES.map((t) => ({ ...t })) };
    },
    ...mockWebhookMethods(ctx, whatsapp),
  };
}

const htmlToText = (html) =>
  html
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export function createEmailMock(ctx) {
  return {
    kind: emailKind.key,
    provider: 'mock',
    mock: true,
    async healthCheck() {
      return healthFor(ctx);
    },
    async send(input) {
      maybeFail(ctx, 'send');
      const providerMessageId = stableId('mock-email', ctx.connection.id, callKey(input));
      const from = input.from ?? { email: ctx.config.fromEmail || 'no-reply@mock.phoenix.invalid', name: ctx.config.fromName || undefined };
      const body = input.text ?? (input.html ? htmlToText(input.html) : `Provider template ${input.templateId}`);
      await ctx.record({
        operation: 'send',
        recipient: input.to.map((a) => a.email).join(', '),
        subject: input.subject,
        body,
        providerRef: providerMessageId,
        status: 'accepted',
        payload: { ...input, from },
      });
      return { providerMessageId, status: 'accepted', acceptedAt: iso(ctx.now) };
    },
    ...mockWebhookMethods(ctx, emailKind),
  };
}

export function createSmsMock(ctx) {
  return {
    kind: sms.key,
    provider: 'mock',
    mock: true,
    async healthCheck() {
      return healthFor(ctx);
    },
    async send(input) {
      maybeFail(ctx, 'send');
      const providerMessageId = stableId('mock-sms', ctx.connection.id, callKey(input));
      const variables = Object.entries(input.variables)
        .map(([key, value]) => `${key}=${value}`)
        .join(', ');
      await ctx.record({
        operation: 'send',
        recipient: input.to,
        subject: `Template ${input.templateId} from ${input.senderId ?? ctx.config.senderId ?? 'PHXMCK'}`,
        body: variables || null,
        providerRef: providerMessageId,
        status: 'accepted',
        payload: input,
      });
      return { providerMessageId, status: 'accepted', acceptedAt: iso(ctx.now) };
    },
    ...mockWebhookMethods(ctx, sms),
  };
}
