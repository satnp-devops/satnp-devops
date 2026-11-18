import { db, json } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { writeAudit } from '../../core/audit.js';
import { emitEvent } from '../../core/events.js';
import { consentMatrix } from '../../core/crm/consent.js';
import { loadVisibleContact, unitsIndex } from '../../core/crm/scope.js';
import { addTimelineEvent } from '../../core/crm/timeline.js';
import { actingLink, usersById } from './context.js';
import { presentConsent, presentConsentState } from './present.js';

// Consent and opt-out records (India's DPDP Act; docs/crm/PHASE2_CONTRACT.md §5.12, §9.1).
// Append-only: a change of mind is a new record; the latest applicable one is the effective state.

const CHANNEL_LABELS = { whatsapp: 'WhatsApp', sms: 'SMS', email: 'Email', voice: 'Voice call' };

/** "WhatsApp marketing consent withdrawn", "Service consent granted on every channel". */
export function consentTitle({ channel, purpose, status }) {
  if (channel === 'all') return `${purpose.charAt(0).toUpperCase()}${purpose.slice(1)} consent ${status} on every channel`;
  return `${CHANNEL_LABELS[channel] ?? channel} ${purpose} consent ${status}`;
}

/** GET /contacts/:id/consents */
export async function listConsents(req, id) {
  const loaded = await loadVisibleContact(req, id);
  const records = await db('consents')
    .where({ contact_id: id })
    .where((where) => {
      where.whereNull('company_id');
      if (loaded.companyIds.length) where.orWhereIn('company_id', loaded.companyIds);
    })
    .orderBy([
      { column: 'captured_at', order: 'desc' },
      { column: 'created_at', order: 'desc' },
    ]);
  const users = await usersById(records.map((row) => row.captured_by));
  const effective = [null, ...loaded.companyIds].flatMap((companyId) => consentMatrix(records, companyId).map(presentConsentState));
  return { records: records.map((row) => presentConsent(row, users)), effective };
}

/** POST /contacts/:id/consents */
export async function recordConsent(req, id, body) {
  const row = await db.transaction(async (trx) => {
    const unitsById = await unitsIndex(req, trx);
    const loaded = await loadVisibleContact(req, id, { trx, forUpdate: true });
    const { contact } = loaded;
    if (!loaded.canManage) throw errors.forbidden();
    if (contact.erased_at) throw errors.conflict('This contact was erased on request');
    if (body.companyId !== null && !loaded.companyIds.includes(body.companyId)) {
      throw errors.validation([{ path: 'body.companyId', message: "Pick a company that knows this person" }]);
    }
    if (body.companyId === null && body.status === 'granted') {
      const group = unitsById.get(contact.group_id);
      if (!group || !req.access.can('contacts.manage', group.path)) {
        throw errors.forbidden('Consent for the whole group is recorded by group admins. Record it for your company instead.');
      }
    }

    const userId = req.auth.user.id;
    const [record] = await trx('consents')
      .insert({
        group_id: contact.group_id,
        contact_id: id,
        company_id: body.companyId,
        channel: body.channel,
        purpose: body.purpose,
        status: body.status,
        source: body.source,
        evidence: json(body.evidence),
        captured_at: body.capturedAt ? new Date(body.capturedAt) : trx.fn.now(),
        captured_by: userId,
      })
      .returning('*');

    const companyLink = body.companyId ? loaded.links.find((link) => link.company_id === body.companyId) : null;
    const link = companyLink ?? actingLink(req, unitsById, loaded.visibleLinks);
    const unitId = companyLink?.unit_id ?? (body.companyId ? body.companyId : (link?.unit_id ?? contact.group_id));
    await addTimelineEvent(trx, {
      groupId: contact.group_id,
      companyId: body.companyId,
      unitId: body.companyId ? unitId : null,
      contactId: id,
      kind: 'system',
      title: consentTitle(body),
      meta: { action: 'consent.recorded', consentId: record.id, channel: body.channel, purpose: body.purpose, status: body.status },
      actorType: 'user',
      actorUserId: userId,
      occurredAt: record.captured_at,
    });
    const payload = {
      consentId: record.id,
      contactId: id,
      companyId: body.companyId,
      channel: body.channel,
      purpose: body.purpose,
      status: body.status,
      source: body.source,
    };
    await emitEvent(trx, {
      type: 'consent.recorded',
      groupId: contact.group_id,
      unitId,
      aggregateType: 'contact',
      aggregateId: id,
      actorUserId: userId,
      payload,
    });
    await writeAudit(trx, req, {
      action: 'consent.recorded',
      entityType: 'contact',
      entityId: id,
      unit: { id: unitId, root_id: contact.group_id },
      after: payload,
    });
    return record;
  });
  return presentConsent(row, await usersById([row.captured_by]));
}
