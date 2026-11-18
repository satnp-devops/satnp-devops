import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db, json } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { parseOrThrow } from '../../lib/validate.js';
import { getSetting } from '../settings.js';
import { effectiveConsent, loadConsentRecords } from '../crm/consent.js';
import { findOrCreateContact } from '../crm/contacts.js';
import { normalizeEmail, normalizePhone } from '../crm/normalize.js';
import { defaultCountrySetting } from '../crm/settings.js';
import { addTimelineEvent } from '../crm/timeline.js';
import { emitEvent } from '../events.js';
import { CHANNEL_LABELS, DELIVERY_STATUSES, MESSAGE_CHANNELS, TIMELINE_KIND_OF_CHANNEL } from './constants.js';
import { isOptOutText, parseKeywords } from './rules.js';
import { optOutKeywordsSetting } from './settings.js';
import { applyStatus } from './status.js';
import { customerServiceWindow } from './window.js';

// Provider-neutral inbound handling. Webhook handlers (modules/messaging/webhooks.js) turn each
// provider's or the WhatsApp tool's event into one of these calls:
//
//   recordInboundMessage   a person wrote to us (or the WhatsApp tool's bot or agent replied to them)
//   recordMessageStatus    a delivery receipt: sent, delivered, read or failed
//   recordHandover         the WhatsApp tool handed a chat over (bot to a person, or to the CRM)
//
// Each runs in one transaction and is idempotent: the provider's message id (or the tool's event
// id) is the key, so a webhook delivered twice changes nothing the second time.

const mediaRef = z.strictObject({
  type: z.enum(['image', 'video', 'audio', 'document', 'sticker', 'location', 'contact', 'other']),
  url: z.url().max(2000).optional(),
  fileId: z.string().max(200).optional(),
  mimeType: z.string().max(120).optional(),
  caption: z.string().max(1024).optional(),
  fileName: z.string().max(255).optional(),
});

const agentSchema = z.strictObject({
  type: z.enum(['bot', 'human']),
  name: z.string().trim().max(120).optional(),
  email: z.string().trim().max(254).optional(),
});

export const inboundInput = z.strictObject({
  companyId: z.uuid(),
  channel: z.enum(MESSAGE_CHANNELS),
  connectionId: z.uuid().nullable().default(null),
  from: z.string().trim().min(3).max(254).nullable().default(null).describe("The person's number or address (outbound: the business's, when known)"),
  to: z.string().trim().max(254).nullable().default(null).describe('Our number or inbox (outbound: the person)'),
  contactName: z.string().trim().max(200).nullable().default(null),
  text: z.string().max(20_000).nullable().default(null),
  subject: z.string().max(998).nullable().default(null),
  media: z.array(mediaRef).max(20).default([]),
  providerMessageId: z.string().trim().min(1).max(300),
  occurredAt: z.coerce.date(),
  source: z.enum(['provider', 'whatsapp_tool']).default('provider'),
  direction: z.enum(['inbound', 'outbound']).default('inbound'),
  agent: agentSchema.nullable().default(null),
  template: z.strictObject({ name: z.string().max(100), language: z.string().max(15).optional() }).nullable().default(null),
  replyToProviderMessageId: z.string().max(300).nullable().default(null),
  meta: z.record(z.string(), z.unknown()).default({}),
});

/** Normalise a person's number or address for a channel. Null when it can't be read. Pure. */
export function normalizeAddress(channel, value, defaultCountry = 'IN') {
  if (channel === 'email') return normalizeEmail(value);
  return normalizePhone(value, defaultCountry)?.e164 ?? null;
}

const summaryOfMedia = (media) => media.map((m) => `[${m.type}${m.caption ? `: ${m.caption}` : ''}]`).join(' ');

/**
 * The company an inbound event belongs to, from its connection. A company's own connection is
 * easy. On a connection shared by several companies (the group WhatsApp helpline): the company
 * the sender last talked to on it, else the hint the sender gave (the WhatsApp tool may send
 * companyId), else null: the caller emits message.unrouted and intake routes it.
 * @returns {Promise<string | null>}
 */
export async function resolveInboundCompany({ connectionId, channel, address, hint = null }, trx = db) {
  if (!connectionId) return hint;
  const companyIds = await trx('integration_connection_companies').where({ connection_id: connectionId }).pluck('company_id');
  if (companyIds.length === 1) return companyIds[0];
  if (hint && companyIds.includes(hint)) return hint;
  if (address) {
    const recent = await trx('conversations')
      .where({ connection_id: connectionId, contact_address: address, channel })
      .whereIn('company_id', companyIds)
      .orderBy([{ column: 'last_message_at', order: 'desc', nulls: 'last' }])
      .first('company_id');
    if (recent) return recent.company_id;
  }
  return null;
}

/** A person who owns a number or address, preferring one the company knows, then the most recently updated. */
async function contactByAddress(trx, { groupId, companyId, address }) {
  return trx('contact_methods as m')
    .join('contacts as c', 'c.id', 'm.contact_id')
    .leftJoin('contact_companies as cc', function joinLink() {
      this.on('cc.contact_id', 'c.id').andOnVal('cc.company_id', '=', companyId);
    })
    .where({ 'm.group_id': groupId, 'm.normalized': address })
    .whereNull('c.merged_into_id')
    .whereNull('c.erased_at')
    .orderByRaw('(cc.id is null), c.updated_at desc')
    .first('c.*', 'cc.id as link_id');
}

/** The open deal a message is about: the thread's own, else the person's most recently active one in the company. */
async function openDealFor(trx, { companyId, contactId, conversationDealId }) {
  if (conversationDealId) {
    const deal = await trx('deals').where({ id: conversationDealId, company_id: companyId, status: 'open' }).whereNull('archived_at').first();
    if (deal) return deal;
  }
  return trx('deals as d')
    .where({ 'd.company_id': companyId, 'd.status': 'open' })
    .whereNull('d.archived_at')
    .where((where) =>
      where
        .where('d.primary_contact_id', contactId)
        .orWhereExists(trx('deal_contacts as dc').whereRaw('dc.deal_id = d.id').where('dc.contact_id', contactId)),
    )
    .orderBy([{ column: 'd.last_activity_at', order: 'desc' }, { column: 'd.id', order: 'desc' }])
    .first('d.*');
}

/**
 * Find (or create) the person behind an address, make sure the company knows them, and open the
 * conversation. Inside the caller's transaction.
 * @returns {Promise<{ company: object, contact: object, conversation: object | null, link: object, contactCreated: boolean, linkCreated: boolean }>}
 */
async function openThread(trx, { companyId, channel, connectionId, address, contactName, businessAddress = null }) {
  const company = await trx('org_units').where({ id: companyId }).first();
  if (!company || company.type !== 'company') throw errors.notFound('Company');
  const connectionKey = connectionId ?? 'fallback';
  let conversation = await trx('conversations')
    .where({ company_id: companyId, channel, connection_key: connectionKey, contact_address: address })
    .forUpdate()
    .first();

  let contact = conversation ? await trx('contacts').where({ id: conversation.contact_id }).first() : null;
  if (contact?.merged_into_id) contact = await trx('contacts').where({ id: contact.merged_into_id }).first();
  if (contact && (contact.erased_at || contact.merged_into_id)) contact = null;
  let linkId = null;
  if (!contact) {
    const found = await contactByAddress(trx, { groupId: company.root_id, companyId, address });
    if (found) {
      linkId = found.link_id;
      delete found.link_id;
      contact = found;
    }
  } else {
    linkId = (await trx('contact_companies').where({ contact_id: contact.id, company_id: companyId }).first('id'))?.id ?? null;
  }

  let contactCreated = false;
  let linkCreated = false;
  let link;
  if (!contact || !linkId) {
    // Unknown sender, or a person the company doesn't know yet: the CRM's de-duplicating find-or-create.
    const methods = channel === 'email' ? { emails: [address] } : { phones: [{ value: address, kind: channel === 'whatsapp' ? 'whatsapp' : 'phone' }] };
    const result = await findOrCreateContact(trx, {
      groupId: company.root_id,
      companyId,
      unitId: companyId,
      fullName: (contact ? [contact.first_name, contact.last_name].filter(Boolean).join(' ') : contactName) || undefined,
      ...methods,
      source: { channel },
      actorType: 'system',
      invalidMethods: 'skip',
    });
    contact = result.contact;
    link = result.link;
    contactCreated = result.created;
    linkCreated = result.linkCreated;
  } else {
    link = await trx('contact_companies').where({ id: linkId }).first();
  }

  if (!conversation) {
    [conversation] = await trx('conversations')
      .insert({
        group_id: company.root_id,
        company_id: companyId,
        unit_id: link.unit_id,
        contact_id: contact.id,
        channel,
        connection_id: connectionId,
        connection_key: connectionKey,
        contact_address: address,
        business_address: businessAddress,
      })
      .onConflict(['company_id', 'channel', 'connection_key', 'contact_address'])
      .merge({ updated_at: trx.fn.now() })
      .returning('*');
  } else if (conversation.contact_id !== contact.id) {
    [conversation] = await trx('conversations').where({ id: conversation.id }).update({ contact_id: contact.id, updated_at: trx.fn.now() }).returning('*');
  }
  return { company, contact, conversation, link, contactCreated, linkCreated };
}

async function matchUser(trx, groupId, email) {
  if (!email) return null;
  const row = await trx('users as u')
    .join('role_assignments as ra', 'ra.user_id', 'u.id')
    .join('org_units as o', 'o.id', 'ra.unit_id')
    .whereRaw('lower(u.email) = ?', [email.toLowerCase()])
    .where('o.root_id', groupId)
    .where('u.status', 'active')
    .first('u.id');
  return row?.id ?? null;
}

/**
 * Withdraw a person's marketing consent on a channel for a company, written like the contacts
 * service writes consent (docs/crm/PHASE2_CONTRACT.md §11.2): an append-only record, a timeline
 * entry and consent.recorded. Nothing is written when marketing is already withdrawn.
 */
async function withdrawMarketing(trx, { company, contactId, channel, unitId, source, evidence, at }) {
  const records = await loadConsentRecords(contactId, company.id, trx);
  if (effectiveConsent(records, { companyId: company.id, channel, purpose: 'marketing' }).status === 'withdrawn') return null;
  const [record] = await trx('consents')
    .insert({
      group_id: company.root_id,
      contact_id: contactId,
      company_id: company.id,
      channel,
      purpose: 'marketing',
      status: 'withdrawn',
      source,
      evidence: json(evidence),
      captured_at: at,
    })
    .returning('*');
  await addTimelineEvent(trx, {
    groupId: company.root_id,
    companyId: company.id,
    unitId,
    contactId,
    kind: 'system',
    title: `${CHANNEL_LABELS[channel]} marketing consent withdrawn`,
    meta: { action: 'consent.recorded', consentId: record.id, channel, purpose: 'marketing', status: 'withdrawn', source },
    actorType: 'contact',
    sourceEventId: `consent:${record.id}`,
    occurredAt: at,
  });
  await emitEvent(trx, {
    type: 'consent.recorded',
    groupId: company.root_id,
    unitId,
    aggregateType: 'contact',
    aggregateId: contactId,
    payload: { consentId: record.id, contactId, companyId: company.id, channel, purpose: 'marketing', status: 'withdrawn', source },
  });
  return record;
}

/** A reply that is exactly an opt-out keyword (the messaging.optOutKeywords setting) withdraws marketing consent. */
async function withdrawOnKeyword(trx, { company, contact, channel, message, unitId }) {
  const keywords = parseKeywords(await getSetting(company, optOutKeywordsSetting, trx));
  if (!isOptOutText(message.body, keywords)) return null;
  return withdrawMarketing(trx, {
    company,
    contactId: contact.id,
    channel,
    unitId,
    source: channel === 'email' ? 'email' : channel,
    evidence: { messageId: message.id, keyword: message.body.trim().slice(0, 40) },
    at: message.occurred_at,
  });
}

export const unsubscribeInput = z.strictObject({
  channel: z.enum(MESSAGE_CHANNELS),
  providerMessageId: z.string().trim().min(1).max(300),
  connectionId: z.uuid().nullable().default(null),
  reason: z.enum(['unsubscribed', 'spam_reported']),
  occurredAt: z.coerce.date(),
});

/**
 * The person used a provider's unsubscribe link (or reported spam) on a message we sent: withdraw
 * their marketing consent on that channel for the message's company. Idempotent.
 * @returns {Promise<{ found: boolean, consent: object | null }>}
 */
export async function recordUnsubscribe(rawInput) {
  const input = parseOrThrow(unsubscribeInput, rawInput, 'input');
  return db.transaction(async (trx) => {
    const query = trx('messages').where({ provider_message_id: input.providerMessageId, channel: input.channel });
    if (input.connectionId) query.where({ connection_id: input.connectionId });
    const message = await query.first();
    if (!message) return { found: false, consent: null };
    const company = await trx('org_units').where({ id: message.company_id }).first();
    const consent = await withdrawMarketing(trx, {
      company,
      contactId: message.contact_id,
      channel: input.channel,
      unitId: message.unit_id,
      source: 'unsubscribe_link',
      evidence: { messageId: message.id, reason: input.reason },
      at: input.occurredAt,
    });
    return { found: true, consent };
  });
}

const inboundTitle = ({ channel, direction, subject, agent, template }) => {
  if (channel === 'email') return subject || (direction === 'inbound' ? 'Email received' : 'Email sent');
  if (direction === 'inbound') return `${CHANNEL_LABELS[channel]} message received`;
  const who = agent?.type === 'bot' ? 'the bot' : agent?.name || 'an agent';
  return template?.name ? `${CHANNEL_LABELS[channel]} template "${template.name}" sent by ${who}` : `${CHANNEL_LABELS[channel]} reply by ${who}`;
};

/**
 * Record a message that reached us, or one the WhatsApp tool sent outside the CRM.
 * Finds the person by their normalised number or address (creating them when unknown, linked to
 * the company), opens or updates the conversation (inbound messages open the 24-hour window),
 * attaches the message to their open deal, writes the timeline entry and emits message.received
 * (outbound from the tool: message.sent with source "whatsapp_tool").
 *
 * @param {z.input<typeof inboundInput>} rawInput
 * @returns {Promise<{ created: boolean, message: object, conversation: object, contact: object | null, contactCreated: boolean }>}
 */
export async function recordInboundMessage(rawInput, { now = Date.now, log = logger } = {}) {
  const input = parseOrThrow(inboundInput, rawInput, 'input');
  const { companyId, channel } = input;
  const duplicateOf = async (trx) => {
    const existing = await trx('messages').where({ company_id: companyId, channel, provider_message_id: input.providerMessageId }).first();
    if (!existing) return null;
    const conversation = await trx('conversations').where({ id: existing.conversation_id }).first();
    return { created: false, message: existing, conversation, contact: null, contactCreated: false };
  };
  try {
    return await db.transaction(async (trx) => (await duplicateOf(trx)) ?? recordNewMessage(trx, input, { now, log }));
  } catch (err) {
    // The same message delivered twice at once (provider and WhatsApp tool): the second insert loses
    // the race on messages_provider_uq and reports the first one as a duplicate.
    if (err?.code === '23505' && err.constraint === 'messages_provider_uq') {
      const duplicate = await duplicateOf(db);
      if (duplicate) return duplicate;
    }
    throw err;
  }
}

async function recordNewMessage(trx, input, { now, log }) {
  const { companyId, channel, direction } = input;
  const company = await trx('org_units').where({ id: companyId }).first();
  if (!company) throw errors.notFound('Company');
  const defaultCountry = await getSetting(company, defaultCountrySetting, trx);
  const personRaw = direction === 'inbound' ? input.from : input.to;
  const address = personRaw ? normalizeAddress(channel, personRaw, defaultCountry) : null;
  if (!address) throw errors.validation([{ path: `input.${direction === 'inbound' ? 'from' : 'to'}`, message: 'Not a phone number or email address we can read' }]);
  const businessRaw = direction === 'inbound' ? input.to : input.from;
  const businessAddress = businessRaw ? normalizeAddress(channel, businessRaw, defaultCountry) : null;

  const thread = await openThread(trx, {
    companyId,
    channel,
    connectionId: input.connectionId,
    address,
    contactName: direction === 'inbound' ? input.contactName : null,
    businessAddress,
  });
  const { contact } = thread;
  const deal = await openDealFor(trx, { companyId, contactId: contact.id, conversationDealId: thread.conversation.deal_id });
  const unitId = deal?.unit_id ?? thread.conversation.unit_id;
  const occurredAt = input.occurredAt;
  const body = input.text ?? (input.media.length ? summaryOfMedia(input.media) : null);
  const actorUserId = direction === 'outbound' && input.agent?.type === 'human' ? await matchUser(trx, company.root_id, input.agent.email) : null;
  const actorType = direction === 'inbound' ? 'contact' : input.agent?.type === 'bot' ? 'ai' : 'user';

  const [message] = await trx('messages')
    .insert({
      id: randomUUID(),
      group_id: company.root_id,
      company_id: companyId,
      unit_id: unitId,
      conversation_id: thread.conversation.id,
      contact_id: contact.id,
      deal_id: deal?.id ?? null,
      channel,
      direction,
      status: direction === 'inbound' ? 'received' : 'sent',
      template_name: input.template?.name ?? null,
      subject: input.subject,
      body,
      media: json(input.media),
      from_address: direction === 'inbound' ? address : businessAddress,
      to_address: direction === 'inbound' ? businessAddress : address,
      connection_id: input.connectionId,
      provider_message_id: input.providerMessageId,
      source: input.source,
      actor_type: actorType,
      sent_by_user_id: actorUserId,
      agent: input.agent ? json({ type: input.agent.type, name: input.agent.name ?? null }) : null,
      meta: json({ ...input.meta, ...(input.replyToProviderMessageId ? { replyToProviderMessageId: input.replyToProviderMessageId } : {}) }),
      occurred_at: occurredAt,
      received_at: direction === 'inbound' ? occurredAt : null,
      sent_at: direction === 'outbound' ? occurredAt : null,
    })
    .returning('*');

  const stamp = direction === 'inbound' ? 'last_inbound_at' : 'last_outbound_at';
  const [conversation] = await trx('conversations')
    .where({ id: thread.conversation.id })
    .update({
      last_message_at: trx.raw('greatest(last_message_at, ?)', [occurredAt]),
      [stamp]: trx.raw(`greatest(${stamp}, ?)`, [occurredAt]),
      deal_id: deal?.id ?? thread.conversation.deal_id,
      ...(businessAddress && !thread.conversation.business_address ? { business_address: businessAddress } : {}),
      ...(input.source === 'whatsapp_tool' && direction === 'outbound' && input.agent ? { handled_by: input.agent.type } : {}),
      updated_at: trx.fn.now(),
    })
    .returning('*');

  await addTimelineEvent(trx, {
    groupId: company.root_id,
    companyId,
    unitId,
    dealId: deal?.id ?? null,
    contactId: contact.id,
    accountId: deal?.account_id ?? null,
    kind: TIMELINE_KIND_OF_CHANNEL[channel],
    channel,
    direction,
    title: inboundTitle({ channel, direction, subject: input.subject, agent: input.agent, template: input.template }),
    body,
    meta: {
      messageId: message.id,
      conversationId: conversation.id,
      providerMessageId: input.providerMessageId,
      ...(input.subject ? { subject: input.subject } : {}),
      ...(input.template ? { templateKey: input.template.name } : {}),
      ...(input.media.length ? { media: input.media.map((m) => m.type) } : {}),
      ...(direction === 'inbound' ? { from: address } : { to: address, status: 'sent' }),
      ...(input.source === 'whatsapp_tool' ? { source: 'whatsapp_tool' } : {}),
      ...(input.agent ? { agent: { type: input.agent.type, name: input.agent.name ?? null } } : {}),
    },
    actorType,
    actorUserId,
    sourceEventId: `message:${message.id}`,
    occurredAt,
  });

  const optOut = direction === 'inbound' ? await withdrawOnKeyword(trx, { company, contact, channel, message, unitId }) : null;
  const window = channel === 'whatsapp' ? customerServiceWindow(conversation.last_inbound_at, { now: now() }) : null;

  await emitEvent(trx, {
    type: direction === 'inbound' ? 'message.received' : 'message.sent',
    groupId: company.root_id,
    unitId,
    aggregateType: 'message',
    aggregateId: message.id,
    actorUserId,
    payload: {
      messageId: message.id,
      conversationId: conversation.id,
      companyId,
      contactId: contact.id,
      dealId: deal?.id ?? null,
      channel,
      direction,
      source: input.source,
      connectionId: input.connectionId,
      providerMessageId: input.providerMessageId,
      ...(direction === 'inbound'
        ? {
            contactCreated: thread.contactCreated,
            linkCreated: thread.linkCreated,
            // No open deal: the next wave's intake turns this enquiry into a lead.
            isNewEnquiry: !deal,
            optedOut: Boolean(optOut),
            windowExpiresAt: window?.expiresAt ?? null,
          }
        : { templateName: input.template?.name ?? null }),
    },
  });
  log.debug?.({ messageId: message.id, channel, direction }, 'Message recorded');
  return { created: true, message, conversation, contact, contactCreated: thread.contactCreated };
}

export const statusInput = z.strictObject({
  channel: z.enum(MESSAGE_CHANNELS),
  providerMessageId: z.string().trim().min(1).max(300),
  status: z.enum(DELIVERY_STATUSES),
  occurredAt: z.coerce.date(),
  connectionId: z.uuid().nullable().default(null),
  companyId: z.uuid().nullable().default(null),
  errorCode: z.string().max(100).nullable().default(null),
  errorMessage: z.string().max(500).nullable().default(null),
});

/**
 * Apply a delivery receipt. Idempotent and monotonic (core/messaging/status.js): a repeated or
 * out-of-date status changes nothing. Updates the message, the status on its timeline entry, and
 * emits message.status_changed (message.failed for failures) when the status moved.
 * @returns {Promise<{ found: boolean, changed: boolean, message: object | null }>}
 */
export async function recordMessageStatus(rawInput) {
  const input = parseOrThrow(statusInput, rawInput, 'input');
  return db.transaction(async (trx) => {
    const query = trx('messages').where({ provider_message_id: input.providerMessageId, channel: input.channel }).forUpdate();
    if (input.connectionId) query.where({ connection_id: input.connectionId });
    if (input.companyId) query.where({ company_id: input.companyId });
    const message = await query.first();
    if (!message) return { found: false, changed: false, message: null };

    const { changed, patch } = applyStatus(message, {
      status: input.status,
      at: input.occurredAt,
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
    });
    if (Object.keys(patch).length === 0) return { found: true, changed: false, message };
    const [updated] = await trx('messages')
      .where({ id: message.id })
      .update({ ...patch, updated_at: trx.fn.now() })
      .returning('*');
    if (!changed) return { found: true, changed: false, message: updated };

    // The timeline entry shows the latest status (✓ sent, ✓✓ delivered, read, failed).
    await trx('timeline_events')
      .where({ source_event_id: `message:${message.id}` })
      .update({ meta: trx.raw("meta || jsonb_build_object('status', ?::text)", [updated.status]) });
    await emitEvent(trx, {
      type: updated.status === 'failed' ? 'message.failed' : 'message.status_changed',
      groupId: updated.group_id,
      unitId: updated.unit_id,
      aggregateType: 'message',
      aggregateId: updated.id,
      payload: {
        messageId: updated.id,
        conversationId: updated.conversation_id,
        companyId: updated.company_id,
        contactId: updated.contact_id,
        dealId: updated.deal_id,
        channel: updated.channel,
        status: updated.status,
        ...(updated.status === 'failed' ? { errorCode: updated.error_code, retryable: false } : {}),
      },
    });
    return { found: true, changed: true, message: updated };
  });
}

export const handoverInput = z.strictObject({
  companyId: z.uuid(),
  connectionId: z.uuid().nullable().default(null),
  eventId: z.string().trim().min(1).max(300),
  from: z.string().trim().min(3).max(254).describe("The person's WhatsApp number"),
  to: z.enum(['human', 'bot', 'crm']),
  reason: z.string().trim().max(300).nullable().default(null),
  summary: z.string().trim().max(4000).nullable().default(null),
  agent: agentSchema.nullable().default(null),
  occurredAt: z.coerce.date(),
});

const HANDOVER_TITLE = {
  human: 'WhatsApp chat handed over to a person',
  bot: 'WhatsApp chat handed back to the bot',
  crm: 'WhatsApp chat handed over to the CRM team',
};

/**
 * The WhatsApp tool handed a chat over: its bot to a person, back to the bot, or to the CRM team.
 * Updates the conversation, writes a system timeline entry (with the bot's summary) and emits
 * conversation.handover, so the next wave can create a task for the deal owner. Idempotent on eventId.
 */
export async function recordHandover(rawInput) {
  const input = parseOrThrow(handoverInput, rawInput, 'input');
  return db.transaction(async (trx) => {
    const company = await trx('org_units').where({ id: input.companyId }).first();
    if (!company) throw errors.notFound('Company');
    const defaultCountry = await getSetting(company, defaultCountrySetting, trx);
    const address = normalizeAddress('whatsapp', input.from, defaultCountry);
    if (!address) throw errors.validation([{ path: 'input.from', message: 'Not a phone number we can read' }]);
    const thread = await openThread(trx, { companyId: input.companyId, channel: 'whatsapp', connectionId: input.connectionId, address, contactName: null });
    const deal = await openDealFor(trx, { companyId: input.companyId, contactId: thread.contact.id, conversationDealId: thread.conversation.deal_id });
    const unitId = deal?.unit_id ?? thread.conversation.unit_id;
    const { created } = await addTimelineEvent(trx, {
      groupId: company.root_id,
      companyId: input.companyId,
      unitId,
      dealId: deal?.id ?? null,
      contactId: thread.contact.id,
      accountId: deal?.account_id ?? null,
      kind: 'system',
      channel: 'whatsapp',
      title: input.reason ? `${HANDOVER_TITLE[input.to]}: ${input.reason}` : HANDOVER_TITLE[input.to],
      body: input.summary,
      meta: { action: 'conversation.handover', conversationId: thread.conversation.id, to: input.to, agent: input.agent ? { type: input.agent.type, name: input.agent.name ?? null } : null },
      actorType: 'system',
      sourceEventId: `whatsapp_tool:${input.eventId}`,
      occurredAt: input.occurredAt,
    });
    if (!created) return { created: false, conversation: thread.conversation };
    const [conversation] = await trx('conversations')
      .where({ id: thread.conversation.id })
      .update({ handled_by: input.to, handover_at: input.occurredAt, deal_id: deal?.id ?? thread.conversation.deal_id, updated_at: trx.fn.now() })
      .returning('*');
    await emitEvent(trx, {
      type: 'conversation.handover',
      groupId: company.root_id,
      unitId,
      aggregateType: 'conversation',
      aggregateId: conversation.id,
      payload: {
        conversationId: conversation.id,
        companyId: input.companyId,
        contactId: thread.contact.id,
        dealId: deal?.id ?? null,
        to: input.to,
        reason: input.reason,
        ownerUserId: deal?.owner_user_id ?? null,
      },
    });
    return { created: true, conversation };
  });
}
