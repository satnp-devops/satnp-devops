import { z } from 'zod';
import { validate } from '../../lib/validate.js';
import { idParams } from '../../lib/schemas.js';
import { requireAuth } from '../../core/guards.js';
import { describe } from '../../core/openapi/describe.js';
import { booleanQuery } from '../../core/crm/schemas.js';
import {
  DELIVERY_STATUSES,
  MESSAGE_CHANNELS,
  MESSAGE_PURPOSES,
  TEMPLATE_CATEGORIES,
  TEMPLATE_STATUSES,
} from '../../core/messaging/index.js';
import { VARIABLE_NAME } from '../../core/messaging/templates.js';
import { buildReplyContext } from './context.js';
import { devDeals, devInbound, devOnly, devStatus } from './dev.js';
import { listMessages, sendFromRequest } from './messages.js';
import { MANAGE, VIEW, archiveTemplate, createTemplate, getTemplate, listTemplates, submitTemplate, updateTemplate } from './templates.js';

// HTTP endpoints of the messaging module (docs/platform/MESSAGING.md, "Endpoints").

const channel = z.enum(MESSAGE_CHANNELS);
const variableKey = z.string().regex(VARIABLE_NAME, 'Unknown variable');

const subjectFields = {
  dealId: z.uuid().optional(),
  contactId: z.uuid().optional(),
  companyId: z.uuid().optional().describe('For a person known to several companies: which one is messaging them'),
};
const hasSubject = [(q) => Boolean(q.dealId || q.contactId), { message: 'Give a deal or a contact', path: ['dealId'] }];

const contextQuery = z.strictObject(subjectFields).refine(...hasSubject);

const messagesQuery = z
  .strictObject({
    ...subjectFields,
    channel: channel.optional(),
    cursor: z.string().max(500).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  })
  .refine(...hasSubject);

const sendBody = z
  .strictObject({
    ...subjectFields,
    channel,
    methodId: z.uuid().optional().describe("Which of the person's numbers or addresses (default: their primary one)"),
    templateId: z.uuid().optional(),
    variables: z.record(variableKey, z.string().max(1024)).default({}),
    text: z.string().trim().min(1, 'Write a message').max(4096).optional(),
    subject: z.string().trim().min(1).max(200).optional().describe('Email free text only'),
    purpose: z.enum(MESSAGE_PURPOSES).optional().describe('Free text only; templates send under their category'),
    clientId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{8,64}$/)
      .optional()
      .describe('Idempotency key from the client: retrying with the same one never sends twice'),
  })
  .refine(...hasSubject)
  .refine((b) => Boolean(b.templateId) !== Boolean(b.text), { message: 'Pick a template or write a message', path: ['text'] });

const header = z.strictObject({ type: z.literal('text'), text: z.string().trim().max(60) }).nullable();
const buttonText = z.string().trim().max(25);
const button = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('quick_reply'), text: buttonText }),
  z.strictObject({ type: z.literal('url'), text: buttonText, url: z.string().trim().max(2000) }),
  z.strictObject({ type: z.literal('phone'), text: buttonText, phone: z.string().trim().max(20) }),
]);
const contentFields = {
  header: header.optional(),
  subject: z.string().trim().max(200).nullable().optional(),
  footer: z.string().trim().max(60).nullable().optional(),
  buttons: z.array(button).max(10).optional(),
  samples: z.record(variableKey, z.string().trim().max(1024)).optional(),
  providerTemplateName: z
    .string()
    .trim()
    .regex(/^[a-z0-9_]{1,512}$/, 'Lower-case letters, digits and underscores')
    .nullable()
    .optional()
    .describe('The name registered with the provider, when it differs'),
  providerTemplateId: z.string().trim().max(100).nullable().optional().describe('The DLT template id (SMS) or Meta template id'),
};

const templateCreate = z.strictObject({
  companyId: z.uuid(),
  channel,
  name: z.string().trim().min(1, 'Name the template').max(100),
  language: z.string().trim().min(2).max(15).default('en'),
  category: z.enum(TEMPLATE_CATEGORIES),
  description: z.string().trim().max(300).nullable().optional(),
  body: z.string().max(20_000),
  ...contentFields,
});

const templateUpdate = z
  .strictObject({
    category: z.enum(TEMPLATE_CATEGORIES).optional(),
    description: z.string().trim().max(300).nullable().optional(),
    body: z.string().max(20_000).optional(),
    ...contentFields,
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change' });

const templateListQuery = z
  .strictObject({
    unitId: z.uuid().optional().describe('The working unit: its company, or every company under a group'),
    companyId: z.uuid().optional(),
    channel: channel.optional(),
    status: z.enum(TEMPLATE_STATUSES).optional(),
    includeArchived: booleanQuery.optional(),
  })
  .refine((q) => Boolean(q.unitId) !== Boolean(q.companyId), { message: 'Give unitId or companyId', path: ['unitId'] });

export function messagingRoutes(router) {
  // ---------- Reply box ----------
  router.get(
    '/messaging/context',
    describe({
      summary: 'Get what the reply box needs for a deal or person',
      description:
        "Channels that can reach the person (numbers masked without contacts.view_pii), the connection each would use, WhatsApp's 24-hour window, consent per purpose, approved templates and standard variable values.",
      permission: 'messaging.view',
    }),
    requireAuth(),
    validate({ query: contextQuery }),
    async (req, res) => {
      res.json({ data: await buildReplyContext(req, req.valid.query) });
    },
  );

  router.get(
    '/messaging/messages',
    describe({ summary: 'List messages of a deal or person', permission: 'messaging.view', list: true }),
    requireAuth(),
    validate({ query: messagesQuery }),
    async (req, res) => {
      res.json(await listMessages(req, req.valid.query));
    },
  );

  router.post(
    '/messaging/messages',
    describe({
      summary: 'Send a message',
      description:
        'Sends a WhatsApp template or reply, an email or an SMS template through the company\'s connection, after the consent, opt-out and 24-hour window checks. Refusals answer 409 `message_blocked` with `details.reason`. A provider failure is recorded and returned with `status: "failed"`. Emits `message.sent` or `message.failed` and writes a timeline entry.',
      permission: 'messaging.send',
      status: 201,
      errors: [409, 429],
    }),
    requireAuth(),
    validate({ body: sendBody }),
    async (req, res) => {
      res.status(201).json({ data: await sendFromRequest(req, req.valid.body) });
    },
  );

  // ---------- Templates ----------
  router.get(
    '/messaging/templates',
    describe({ summary: 'List message templates', permission: VIEW }),
    requireAuth(),
    validate({ query: templateListQuery }),
    async (req, res) => {
      res.json({ data: await listTemplates(req, req.valid.query) });
    },
  );

  router.post(
    '/messaging/templates',
    describe({ summary: 'Create a message template', description: 'Starts as a draft (version 1). Emits `message_template.created`.', permission: MANAGE, status: 201, errors: [409] }),
    requireAuth(),
    validate({ body: templateCreate }),
    async (req, res) => {
      res.status(201).json({ data: await createTemplate(req, req.valid.body) });
    },
  );

  router.get(
    '/messaging/templates/:id',
    describe({ summary: 'Get a message template with its versions', permission: VIEW }),
    requireAuth(),
    validate({ params: idParams }),
    async (req, res) => {
      res.json({ data: await getTemplate(req, req.valid.params.id) });
    },
  );

  router.patch(
    '/messaging/templates/:id',
    describe({
      summary: 'Edit a message template',
      description: 'Changes the draft in place; editing an approved or rejected template starts a new draft version while the approved one keeps sending.',
      permission: MANAGE,
      errors: [409],
    }),
    requireAuth(),
    validate({ params: idParams, body: templateUpdate }),
    async (req, res) => {
      res.json({ data: await updateTemplate(req, req.valid.params.id, req.valid.body) });
    },
  );

  router.post(
    '/messaging/templates/:id/submit',
    describe({
      summary: 'Submit a template for approval',
      description: 'Email templates and templates on a mock connection are approved at once; on a real provider the version waits for its template.status webhook.',
      permission: MANAGE,
      errors: [409],
    }),
    requireAuth(),
    validate({ params: idParams }),
    async (req, res) => {
      res.json({ data: await submitTemplate(req, req.valid.params.id) });
    },
  );

  router.delete(
    '/messaging/templates/:id',
    describe({ summary: 'Archive a message template', permission: MANAGE, status: 204, errors: [409] }),
    requireAuth(),
    validate({ params: idParams }),
    async (req, res) => {
      await archiveTemplate(req, req.valid.params.id);
      res.status(204).end();
    },
  );

  // ---------- Development helpers (404 in production) ----------
  router.get(
    '/messaging/dev/deals',
    describe({ summary: 'List deals to try the reply box on (development only)', permission: 'deals.view' }),
    requireAuth(),
    devOnly,
    validate({ query: z.strictObject({ unitId: z.uuid() }) }),
    async (req, res) => {
      res.json({ data: await devDeals(req, req.valid.query) });
    },
  );

  router.post(
    '/messaging/dev/inbound',
    describe({ summary: 'Pretend a person wrote to us (development only)', permission: 'messaging.send', status: 201 }),
    requireAuth(),
    devOnly,
    validate({
      body: z
        .strictObject({ ...subjectFields, channel, methodId: z.uuid().optional(), text: z.string().trim().min(1).max(4096) })
        .refine(...hasSubject),
    }),
    async (req, res) => {
      res.status(201).json({ data: await devInbound(req, req.valid.body) });
    },
  );

  router.post(
    '/messaging/dev/status',
    describe({ summary: 'Pretend a provider reported a delivery status (development only)', permission: 'messaging.send' }),
    requireAuth(),
    devOnly,
    validate({ body: z.strictObject({ messageId: z.uuid(), status: z.enum(DELIVERY_STATUSES) }) }),
    async (req, res) => {
      res.json({ data: await devStatus(req, req.valid.body) });
    },
  );
}
