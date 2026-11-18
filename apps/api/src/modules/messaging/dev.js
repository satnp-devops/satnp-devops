import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { db } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { mocksAllowed } from '../../integrations/index.js';
import { applyListScope, listScope } from '../../core/crm/scope.js';
import {
  CHANNEL_METHOD_KINDS,
  companyMessagingConnections,
  pickConnection,
  pickMethod,
  recordInboundMessage,
  recordMessageStatus,
} from '../../core/messaging/index.js';
import { loadSubject } from './access.js';
import { presentMessage } from './present.js';

// Development helpers behind /messaging/dev/* (hidden from the API docs, 404 in production or
// when mocks are off): pick a deal to try the reply box on, pretend the person wrote back (which
// opens WhatsApp's 24-hour window), and pretend a provider reported delivery.

export function devOnly(_req, _res, next) {
  if (env.isProd || !mocksAllowed()) throw errors.notFound('Page');
  next();
}

/** Recent open deals in the working scope, with their primary contacts. */
export async function devDeals(req, { unitId }) {
  const scope = await listScope(req, 'deals.view', { unitId });
  const rows = await applyListScope(db('deals as d'), scope, {
    unitColumn: 'd.unit_id',
    ownerColumns: ['d.owner_user_id'],
    companyColumn: 'd.company_id',
    groupColumn: 'd.group_id',
  })
    .join('contacts as c', 'c.id', 'd.primary_contact_id')
    .join('org_units as co', 'co.id', 'd.company_id')
    .whereNull('d.archived_at')
    .where('d.status', 'open')
    .orderBy([{ column: 'd.last_activity_at', order: 'desc' }, { column: 'd.id', order: 'desc' }])
    .limit(30)
    .select('d.id', 'd.ref', 'd.title', 'd.company_id', 'co.name as company_name', 'c.id as contact_id', 'c.display_name as contact_name');
  return rows.map((row) => ({
    id: row.id,
    ref: row.ref,
    title: row.title,
    company: { id: row.company_id, name: row.company_name },
    contact: { id: row.contact_id, displayName: row.contact_name },
  }));
}

/** Pretend the person wrote to us on a channel. */
export async function devInbound(req, body) {
  const subject = await loadSubject(req, { dealId: body.dealId ?? null, contactId: body.contactId ?? null, companyId: body.companyId ?? null, permission: 'messaging.send', path: 'body' });
  const [methods, candidates] = await Promise.all([
    db('contact_methods').where({ contact_id: subject.contact.id }).whereIn('kind', CHANNEL_METHOD_KINDS[body.channel]),
    companyMessagingConnections(subject.company.id),
  ]);
  const method = pickMethod(methods, body.channel, body.methodId ?? null);
  if (!method) throw errors.validation([{ path: 'body.methodId', message: 'They have no number or address for this channel' }]);
  const recent = await db('conversations')
    .where({ company_id: subject.company.id, channel: body.channel, contact_address: method.normalized })
    .whereNotNull('connection_id')
    .orderBy([{ column: 'last_message_at', order: 'desc', nulls: 'last' }])
    .first('connection_id');
  const chosen = pickConnection({ candidates, channel: body.channel, preferredConnectionId: recent?.connection_id ?? null, companyName: subject.company.name });
  if (chosen.error) throw chosen.error;
  const { message } = await recordInboundMessage({
    companyId: subject.company.id,
    channel: body.channel,
    connectionId: chosen.connection?.id ?? null,
    from: method.normalized,
    text: body.text,
    subject: body.channel === 'email' ? 'Re: your enquiry' : null,
    providerMessageId: `dev_${randomUUID()}`,
    occurredAt: new Date(),
  });
  return presentMessage(message, { canViewPii: subject.canViewPii });
}

/** Pretend the provider reported a delivery status for a message. */
export async function devStatus(req, { messageId, status }) {
  const message = await db('messages').where({ id: messageId }).first();
  if (!message) throw errors.notFound('Message');
  const subject = await loadSubject(req, {
    dealId: message.deal_id,
    contactId: message.contact_id,
    companyId: message.company_id,
    permission: 'messaging.send',
    path: 'body',
  });
  if (message.direction !== 'outbound' || !message.provider_message_id) throw errors.conflict('Only sent messages get delivery statuses');
  const result = await recordMessageStatus({
    channel: message.channel,
    providerMessageId: message.provider_message_id,
    status,
    companyId: message.company_id,
    occurredAt: new Date(),
  });
  return presentMessage(result.message, { canViewPii: subject.canViewPii });
}
