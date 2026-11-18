import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db, json } from '../../lib/db.js';
import { AppError, errors } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { parseOrThrow } from '../../lib/validate.js';
import { getAdapter, isIntegrationError } from '../../integrations/index.js';
import { writeAudit } from '../audit.js';
import { effectiveConsent, loadConsentRecords } from '../crm/consent.js';
import { addTimelineEvent } from '../crm/timeline.js';
import { emitEvent } from '../events.js';
import { companyMessagingConnections, pickConnection } from './connections.js';
import { CHANNEL_KINDS, CHANNEL_LABELS, CHANNEL_METHOD_KINDS, MESSAGE_CHANNELS, MESSAGE_PURPOSES, THROTTLE_LIMITS, TIMELINE_KIND_OF_CHANNEL } from './constants.js';
import { decideSend, purposeFor } from './rules.js';
import { renderTemplate, renderedText, standardVariables } from './templates.js';
import { throttleOutbound } from './throttle.js';
import { customerServiceWindow } from './window.js';

// sendMessage() is the single way the platform sends a WhatsApp message, an email or an SMS to a
// person: people in the reply box, automations, reminders and the AI all call it. In order:
//
//   1. load and check the company, person, number or address, deal and template
//   2. consent and opt-out (DPDP), the template rule for SMS, WhatsApp's 24-hour window
//   3. pick the connection (the thread's own, else the company's default) and take a throttle token
//   4. transaction 1: the conversation and a "queued" message
//   5. the provider call, outside any transaction (a slow provider never holds a database lock)
//   6. transaction 2: "sent" or "failed", the timeline entry, message.sent / message.failed, audit
//
// Refusals (step 2) write nothing and throw 409 message_blocked with details.reason.

const variableValue = z.union([z.string().max(1024), z.number()]).transform(String);

export const sendMessageInput = z
  .strictObject({
    companyId: z.uuid(),
    channel: z.enum(MESSAGE_CHANNELS),
    contactId: z.uuid(),
    methodId: z.uuid().optional().describe("The contact's number or address to use (default: their primary one for the channel)"),
    templateId: z.uuid().optional(),
    template: z.strictObject({ name: z.string().min(1).max(100), language: z.string().min(2).max(15).default('en') }).optional(),
    variables: z.record(z.string().max(40), variableValue).default({}),
    text: z.string().trim().min(1, 'Write a message').max(4096).optional(),
    subject: z.string().trim().min(1).max(200).optional(),
    purpose: z.enum(MESSAGE_PURPOSES).optional(),
    dealId: z.uuid().nullable().optional(),
    reference: z.string().trim().min(1).max(120).optional().describe('Idempotency key: a second send with the same reference returns the first message'),
    connectionId: z.uuid().optional(),
    actor: z.strictObject({ type: z.enum(['user', 'system', 'ai']), userId: z.uuid().nullable().optional() }),
  })
  .refine((input) => [input.templateId, input.template, input.text].filter(Boolean).length === 1, {
    message: 'Send a template or a text, not both',
    path: ['text'],
  });

const blocked = (reason, message) => new AppError(409, 'message_blocked', message, { reason });

/** The contact's number or address for a channel: the one asked for, else the primary of the preferred kind. Pure. */
export function pickMethod(methods, channel, methodId = null) {
  const kinds = CHANNEL_METHOD_KINDS[channel];
  const usable = methods.filter((m) => kinds.includes(m.kind));
  if (methodId) return usable.find((m) => m.id === methodId) ?? null;
  const rank = (m) => kinds.indexOf(m.kind) * 2 + (m.is_primary ? 0 : 1);
  return [...usable].sort((a, b) => rank(a) - rank(b) || new Date(a.created_at) - new Date(b.created_at))[0] ?? null;
}

async function loadTemplate({ companyId, channel, templateId, template }, path) {
  const query = db('message_templates as t')
    .leftJoin('message_template_versions as v', function joinLive() {
      this.on('v.template_id', 't.id').andOn('v.version', 't.approved_version');
    })
    .where('t.company_id', companyId)
    .whereNull('t.archived_at')
    .select('t.*', db.raw('row_to_json(v) as live'));
  if (templateId) query.where('t.id', templateId);
  else query.where({ 't.channel': channel, 't.name': template.name, 't.language': template.language });
  const row = await query.first();
  if (!row) throw errors.validation([{ path: `${path}.${templateId ? 'templateId' : 'template'}`, message: 'Template not found' }]);
  if (row.channel !== channel) throw errors.validation([{ path: `${path}.templateId`, message: `This is not a ${CHANNEL_LABELS[channel]} template` }]);
  return row;
}

/** A template version as render input. */
export const versionContent = (channel, version) => ({
  channel,
  header: version.header ?? null,
  subject: version.subject ?? null,
  body: version.body,
  footer: version.footer ?? null,
  buttons: version.buttons ?? [],
});

async function deliver(adapter, { channel, to, toName, template, live, rendered, text, subject, reference }) {
  if (channel === 'whatsapp') {
    if (template) {
      return adapter.sendTemplate({
        to,
        template: {
          name: live.provider_template_name || template.name,
          language: template.language,
          bodyVariables: rendered.parameters.body,
          headerVariables: rendered.parameters.header,
          buttonVariables: rendered.parameters.buttons,
        },
        reference,
      });
    }
    return adapter.sendText({ to, text, reference });
  }
  if (channel === 'sms') {
    return adapter.send({ to, templateId: live.provider_template_id || live.provider_template_name || template.name, variables: rendered.values, reference });
  }
  return adapter.send({
    to: [{ email: to, ...(toName ? { name: toName.slice(0, 200) } : {}) }],
    subject: template ? rendered.subject : subject,
    text: template ? renderedText(rendered) : text,
    reference,
  });
}

function failureOf(err) {
  if (isIntegrationError(err)) return { code: err.code, message: err.message, retryable: err.retryable === true };
  return { code: 'send_failed', message: 'The message could not be sent', retryable: true };
}

const titleOf = ({ channel, templateName, subject }) => {
  if (channel === 'email') return subject || 'Email';
  if (templateName) return `${CHANNEL_LABELS[channel]} template "${templateName}"`;
  return `${CHANNEL_LABELS[channel]} message`;
};

/**
 * Send one message. See the top of this file for the steps.
 *
 *   const { message } = await sendMessage({
 *     companyId, channel: 'whatsapp', contactId, dealId,
 *     templateId, variables: { booking_link: url },
 *     actor: { type: 'user', userId: req.auth.user.id },
 *   }, { req });
 *
 * companyId, contactId and dealId must already be scoped to the caller (routes check visibility and
 * messaging.send; automations act for the company). Returns the message row (status "sent", or
 * "failed" with error_code and error_message when the provider refused) and its conversation.
 *
 * @param {z.input<typeof sendMessageInput>} rawInput
 * @param {{ req?: import('express').Request | null, now?: () => number, log?: object, path?: string }} [options]
 * @returns {Promise<{ message: object, conversation: object, created: boolean }>}
 */
export async function sendMessage(rawInput, { req = null, now = Date.now, log = logger, path = 'input' } = {}) {
  const input = parseOrThrow(sendMessageInput, rawInput, path);
  const { companyId, channel, contactId } = input;
  const dealId = input.dealId ?? null;

  const earlierSend = async () => {
    const existing = await db('messages').where({ company_id: companyId, reference: input.reference }).first();
    if (!existing) return null;
    const conversation = await db('conversations').where({ id: existing.conversation_id }).first();
    return { message: existing, conversation, created: false };
  };
  if (input.reference) {
    const earlier = await earlierSend();
    if (earlier) return earlier;
  }

  // 1. Load everything the decision needs, in parallel.
  const [company, contact, methods, link, deal, template, consents, candidates] = await Promise.all([
    db('org_units').where({ id: companyId }).first(),
    db('contacts').where({ id: contactId }).first(),
    db('contact_methods').where({ contact_id: contactId }).whereIn('kind', CHANNEL_METHOD_KINDS[channel]),
    db('contact_companies').where({ contact_id: contactId, company_id: companyId }).first(),
    dealId ? db('deals').where({ id: dealId }).first() : null,
    input.templateId || input.template ? loadTemplate({ companyId, channel, templateId: input.templateId, template: input.template }, path) : null,
    loadConsentRecords(contactId, companyId),
    companyMessagingConnections(companyId),
  ]);
  if (!company || company.type !== 'company' || company.status !== 'active') throw errors.notFound('Company');
  if (!contact || contact.group_id !== company.root_id) throw errors.notFound('Contact');
  if (contact.merged_into_id) throw new AppError(404, 'merged', 'This record was merged into another one', { mergedIntoId: contact.merged_into_id });
  if (contact.erased_at) throw blocked('erased', "This person's data was erased on request");
  if (dealId) {
    if (!deal || deal.company_id !== companyId) throw errors.validation([{ path: `${path}.dealId`, message: 'Deal not found' }]);
    if (deal.primary_contact_id !== contactId) {
      const onDeal = await db('deal_contacts').where({ deal_id: dealId, contact_id: contactId }).first('contact_id');
      if (!onDeal) throw errors.validation([{ path: `${path}.contactId`, message: 'Pick someone on this deal' }]);
    }
  }

  // 2. The rules.
  const method = pickMethod(methods, channel, input.methodId ?? null);
  if (!method) {
    if (input.methodId) throw errors.validation([{ path: `${path}.methodId`, message: `Pick one of their ${CHANNEL_LABELS[channel]} numbers or addresses` }]);
    throw blocked('no_address', channel === 'email' ? 'They have no email address' : `They have no number for ${CHANNEL_LABELS[channel]}`);
  }
  const purpose = purposeFor({ category: template?.category ?? null, purpose: input.purpose ?? null });
  const consent = effectiveConsent(consents, { companyId, channel, purpose });

  const recent = await db('conversations')
    .where({ company_id: companyId, channel, contact_address: method.normalized })
    .orderBy([{ column: 'last_message_at', order: 'desc', nulls: 'last' }])
    .select('id', 'connection_id', 'connection_key', 'last_inbound_at');
  const chosen = pickConnection({
    candidates,
    channel,
    preferredConnectionId: input.connectionId ?? recent.find((c) => c.connection_id)?.connection_id ?? null,
    companyName: company.name,
  });
  if (input.connectionId && chosen.connection?.id !== input.connectionId) {
    throw errors.validation([{ path: `${path}.connectionId`, message: 'That connection is not available' }]);
  }
  if (chosen.error) throw chosen.error;
  const thread = recent.find((c) => c.connection_key === chosen.key) ?? null;
  const window = channel === 'whatsapp' ? customerServiceWindow(thread?.last_inbound_at ?? null, { now: now() }) : null;

  const decision = decideSend({
    channel,
    purpose,
    consentStatus: consent.status,
    optedOut: Boolean(method.opted_out_at),
    content: template ? 'template' : 'text',
    templateApproved: Boolean(template?.live),
    window,
  });
  if (!decision.allowed) throw blocked(decision.reason, decision.message);
  if (channel === 'email' && !template && !input.subject) throw errors.validation([{ path: `${path}.subject`, message: 'Give the email a subject' }]);

  let rendered = null;
  if (template) {
    const owner = deal?.owner_user_id ? await db('users').where({ id: deal.owner_user_id }).first('name') : null;
    const defaults = standardVariables({ contact, company, deal, ownerName: owner?.name ?? null });
    rendered = renderTemplate(versionContent(channel, template.live), { ...defaults, ...input.variables });
    if (rendered.missing.length) {
      throw errors.validation(rendered.missing.map((name) => ({ path: `${path}.variables.${name}`, message: `Fill in {{${name}}}` })));
    }
  }
  const body = template ? renderedText(rendered) : input.text;
  const subject = channel === 'email' ? (template ? rendered.subject : input.subject) : null;

  // 3. The adapter and a throttle token.
  const adapter = await getAdapter({ companyId, kind: CHANNEL_KINDS[channel], connectionId: chosen.connection?.id, log, now });
  await throttleOutbound({ key: chosen.key === 'fallback' ? `fallback:${companyId}:${channel}` : chosen.key, ...THROTTLE_LIMITS[channel], log });

  const unitId = deal?.unit_id ?? link?.unit_id ?? companyId;
  const actorType = input.actor.type;
  const actorUserId = input.actor.userId ?? null;
  const occurredAt = new Date(now());

  // 4. The conversation and a queued message.
  const queueMessage = () => db.transaction(async (trx) => {
    const [conversation] = await trx('conversations')
      .insert({
        group_id: company.root_id,
        company_id: companyId,
        unit_id: link?.unit_id ?? unitId,
        contact_id: contactId,
        channel,
        connection_id: chosen.connection?.id ?? null,
        connection_key: chosen.key,
        contact_address: method.normalized,
        deal_id: dealId,
      })
      .onConflict(['company_id', 'channel', 'connection_key', 'contact_address'])
      .merge({ contact_id: contactId, deal_id: dealId ?? trx.raw('conversations.deal_id'), updated_at: trx.fn.now() })
      .returning('*');
    const [message] = await trx('messages')
      .insert({
        id: randomUUID(),
        group_id: company.root_id,
        company_id: companyId,
        unit_id: unitId,
        conversation_id: conversation.id,
        contact_id: contactId,
        deal_id: dealId,
        channel,
        direction: 'outbound',
        status: 'queued',
        purpose,
        template_id: template?.id ?? null,
        template_version: template?.approved_version ?? null,
        template_name: template?.name ?? null,
        variables: json(rendered?.values ?? {}),
        subject,
        body,
        to_address: method.normalized,
        connection_id: chosen.connection?.id ?? null,
        provider: adapter.connection.provider,
        reference: input.reference ?? null,
        source: 'crm',
        actor_type: actorType,
        sent_by_user_id: actorUserId,
        occurred_at: occurredAt,
      })
      .returning('*');
    return { conversation, message };
  });
  // Two sends with one reference at once: the second loses the race on messages_reference_uq and
  // returns the first.
  let queued;
  try {
    queued = await queueMessage();
  } catch (err) {
    const earlier = err?.code === '23505' && err.constraint === 'messages_reference_uq' ? await earlierSend() : null;
    if (earlier) return earlier;
    throw err;
  }

  // 5. The provider call.
  let result = null;
  let failure = null;
  try {
    result = await deliver(adapter, {
      channel,
      to: method.normalized,
      toName: contact.display_name,
      template,
      live: template?.live ?? null,
      rendered,
      text: input.text,
      subject,
      reference: queued.message.id,
    });
  } catch (err) {
    failure = failureOf(err);
    log.warn({ err, messageId: queued.message.id, channel, code: failure.code }, 'Message send failed');
  }

  // 6. The outcome.
  return db.transaction(async (trx) => {
    const patch = result
      ? { status: 'sent', provider_message_id: result.providerMessageId, sent_at: new Date(result.acceptedAt), updated_at: trx.fn.now() }
      : { status: 'failed', error_code: failure.code, error_message: failure.message.slice(0, 500), failed_at: new Date(now()), updated_at: trx.fn.now() };
    const [message] = await trx('messages').where({ id: queued.message.id }).update(patch).returning('*');
    const [conversation] = await trx('conversations')
      .where({ id: queued.conversation.id })
      .update({
        last_message_at: trx.raw('greatest(last_message_at, ?)', [occurredAt]),
        last_outbound_at: trx.raw('greatest(last_outbound_at, ?)', [occurredAt]),
        updated_at: trx.fn.now(),
      })
      .returning('*');

    if (result) {
      await addTimelineEvent(trx, {
        groupId: company.root_id,
        companyId,
        unitId,
        dealId,
        contactId,
        accountId: deal?.account_id ?? null,
        kind: TIMELINE_KIND_OF_CHANNEL[channel],
        channel,
        direction: 'outbound',
        title: titleOf({ channel, templateName: template?.name, subject }),
        body,
        meta: {
          messageId: message.id,
          conversationId: conversation.id,
          ...(template ? { templateKey: template.name, templateId: template.id, templateVersion: template.approved_version } : {}),
          ...(subject ? { subject } : {}),
          providerMessageId: message.provider_message_id,
          status: 'sent',
          to: method.normalized,
        },
        actorType,
        actorUserId,
        sourceEventId: `message:${message.id}`,
        occurredAt,
      });
    }

    const eventType = result ? 'message.sent' : 'message.failed';
    await emitEvent(trx, {
      type: eventType,
      groupId: company.root_id,
      unitId,
      aggregateType: 'message',
      aggregateId: message.id,
      actorUserId,
      payload: {
        messageId: message.id,
        conversationId: conversation.id,
        companyId,
        contactId,
        dealId,
        channel,
        direction: 'outbound',
        source: 'crm',
        purpose,
        templateId: template?.id ?? null,
        templateName: template?.name ?? null,
        connectionId: chosen.connection?.id ?? null,
        providerMessageId: message.provider_message_id ?? null,
        ...(failure ? { errorCode: failure.code, retryable: failure.retryable } : {}),
      },
    });
    await writeAudit(trx, req, {
      action: eventType,
      entityType: 'message',
      entityId: message.id,
      unit: { id: unitId, root_id: company.root_id },
      actorUserId,
      actorType: req ? undefined : actorType,
      // Never the body or the number: only what kind of message went where.
      after: { channel, contactId, dealId, templateName: template?.name ?? null, purpose, status: message.status },
    });
    return { message, conversation, created: true };
  });
}
