import { db } from '../../lib/db.js';
import { effectiveConsent, loadConsentRecords } from '../../core/crm/consent.js';
import { maskEmail, maskPhone } from '../../core/crm/pii.js';
import {
  CHANNEL_LABELS,
  CHANNEL_METHOD_KINDS,
  MESSAGE_CHANNELS,
  MESSAGE_PURPOSES,
  companyMessagingConnections,
  customerServiceWindow,
  pickConnection,
  standardVariables,
} from '../../core/messaging/index.js';
import { loadSubject } from './access.js';
import { presentReplyTemplate } from './present.js';
import { templateQuery } from './templates.js';

// GET /messaging/context: everything the reply box needs in one request: which channels can reach
// the person (numbers and addresses, masked without contacts.view_pii), the connection each would
// use, WhatsApp's 24-hour window per number, consent per purpose, the company's approved templates
// and default values for the standard variables.

const methodRank = (channel, method) => CHANNEL_METHOD_KINDS[channel].indexOf(method.kind) * 2 + (method.is_primary ? 0 : 1);

const connectionView = (chosen) => {
  if (chosen.error) return null;
  if (chosen.fallback) return { id: null, name: 'Built-in mock', provider: 'mock', mock: true, fallback: true };
  return { ...chosen.connection, fallback: false };
};

export async function buildReplyContext(req, { dealId, contactId, companyId, now = Date.now() }) {
  const subject = await loadSubject(req, { dealId, contactId, companyId, permission: 'messaging.view' });
  const { company, deal, contact, canViewPii } = subject;

  const [methods, consents, candidates, conversations, templates, owner] = await Promise.all([
    db('contact_methods').where({ contact_id: contact.id }).orderBy([{ column: 'is_primary', order: 'desc' }, { column: 'created_at' }]),
    loadConsentRecords(contact.id, company.id),
    companyMessagingConnections(company.id),
    db('conversations')
      .where({ company_id: company.id })
      .whereIn('contact_address', db('contact_methods').where({ contact_id: contact.id }).select('normalized'))
      .orderBy([{ column: 'last_message_at', order: 'desc', nulls: 'last' }]),
    templateQuery().where('t.company_id', company.id).whereNotNull('t.approved_version').whereNull('t.archived_at').orderBy(['t.channel', 't.name', 't.language']),
    deal?.owner_user_id ? db('users').where({ id: deal.owner_user_id }).first('id', 'name') : null,
  ]);

  const channels = MESSAGE_CHANNELS.map((channel) => {
    const usable = methods.filter((m) => CHANNEL_METHOD_KINDS[channel].includes(m.kind)).sort((a, b) => methodRank(channel, a) - methodRank(channel, b));
    const addresses = usable.map((method) => {
      const threads = conversations.filter((c) => c.channel === channel && c.contact_address === method.normalized);
      const chosen = pickConnection({ candidates, channel, preferredConnectionId: threads.find((c) => c.connection_id)?.connection_id ?? null, companyName: company.name });
      const thread = threads.find((c) => c.connection_key === chosen.key) ?? null;
      const masked = channel === 'email' ? maskEmail(method.normalized) : maskPhone(method.normalized);
      return {
        methodId: method.id,
        kind: method.kind,
        value: canViewPii ? method.value : masked,
        label: method.label ?? null,
        isPrimary: method.is_primary === true,
        optedOut: Boolean(method.opted_out_at),
        conversationId: thread?.id ?? null,
        handledBy: thread?.handled_by ?? null,
        connection: connectionView(chosen),
        connectionError: chosen.error ? chosen.error.message : null,
        window: channel === 'whatsapp' ? customerServiceWindow(thread?.last_inbound_at ?? null, { now }) : null,
      };
    });
    const consent = Object.fromEntries(MESSAGE_PURPOSES.map((purpose) => [purpose, effectiveConsent(consents, { companyId: company.id, channel, purpose }).status]));
    const first = addresses.find((a) => !a.optedOut) ?? addresses[0] ?? null;
    let unavailable = null;
    if (addresses.length === 0) unavailable = channel === 'email' ? 'No email address' : 'No phone number';
    else if (addresses.every((a) => a.optedOut)) unavailable = 'Opted out';
    else if (first && !first.connection) unavailable = first.connectionError ?? `No ${CHANNEL_LABELS[channel]} connection`;
    return {
      channel,
      label: CHANNEL_LABELS[channel],
      freeText: channel !== 'sms',
      available: unavailable === null,
      unavailableReason: unavailable,
      defaultMethodId: first?.methodId ?? null,
      addresses,
      consent,
    };
  });

  return {
    company: { id: company.id, name: company.name, code: company.code },
    contact: {
      id: contact.id,
      displayName: contact.erased_at ? 'Erased contact' : contact.display_name,
      firstName: contact.erased_at ? null : (contact.first_name ?? null),
      kind: contact.kind,
      erased: Boolean(contact.erased_at),
      piiMasked: !canViewPii,
    },
    deal: deal ? { id: deal.id, ref: deal.ref, title: deal.title, status: deal.status, owner: owner ? { id: owner.id, name: owner.name } : null } : null,
    can: { send: !contact.erased_at && subject.can('messaging.send') },
    channels,
    templates: templates.map(presentReplyTemplate),
    defaults: standardVariables({ contact, company, deal, ownerName: owner?.name ?? null }),
  };
}
