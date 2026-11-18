import { db, json } from '../../lib/db.js';
import { AppError, errors } from '../../lib/errors.js';
import { writeAudit } from '../../core/audit.js';
import { emitEvent } from '../../core/events.js';
import { getSetting } from '../../core/settings.js';
import { addTimelineEvent } from '../../core/crm/timeline.js';
import { canContact } from '../../core/crm/consent.js';
import { loadVisible, loadVisibleContact, recordLevel, unitsIndex } from '../../core/crm/scope.js';
import { loadEventType } from './access.js';
import { callPort } from './ports.js';
import { presentLink } from './present.js';
import { personalLinkDaysSetting } from './settings.js';
import { bookingPageUrl, linkTokenFor } from './tokens.js';

// Personal booking links: a signed link for one deal or contact (prefilled booking page, booked
// straight onto the deal, the deal's owner preferred as host). The send-link dialog on the deal
// profile creates one and sends it through the messaging port.

const DAY_MS = 86_400_000;
const auditUnit = (row) => ({ id: row.unit_id, root_id: row.group_id });

/**
 * The deal and/or contact a link is for, checked against the viewer:
 *   - a deal must be visible (deals.view) and the viewer must work bookings on it (scheduling.manage,
 *     own = deals they own), in the event type's company;
 *   - a contact alone must be visible, and the viewer must hold scheduling.manage where the event type lives.
 */
async function subjectsFor(req, { eventType, unit, dealId, contactId }, trx) {
  let deal = null;
  if (dealId) {
    ({ row: deal } = await loadVisible(req, { table: 'deals', id: dealId, permission: 'deals.view', notFound: 'Deal', trx }));
    if (deal.company_id !== eventType.company_id) {
      throw errors.validation([{ path: 'body.eventTypeId', message: 'Pick an event type of the same company as the deal' }]);
    }
    if (!(await recordLevel(req, 'scheduling.manage', deal, { trx }))) throw errors.forbidden('You cannot send booking links for this deal');
  }
  let contact = null;
  const wantedContactId = contactId ?? deal?.primary_contact_id ?? null;
  if (wantedContactId) {
    try {
      ({ contact } = await loadVisibleContact(req, wantedContactId, { trx }));
    } catch (err) {
      if (err instanceof AppError && (err.status === 404 || err.code === 'merged')) {
        throw errors.validation([{ path: contactId ? 'body.contactId' : 'body.dealId', message: 'Contact not found' }]);
      }
      throw err;
    }
    if (deal && contactId) {
      const involved =
        deal.primary_contact_id === contactId ||
        Boolean(await trx('deal_contacts').where({ deal_id: deal.id, contact_id: contactId }).first('contact_id'));
      if (!involved) throw errors.validation([{ path: 'body.contactId', message: 'This person is not on the deal' }]);
    }
  }
  if (!deal && !req.access.canAnywhereWithin('scheduling.manage', unit.path)) throw errors.forbidden();
  return { deal, contact };
}

/** Create a personal booking link for a deal or contact. */
export async function createPersonalLink(req, body) {
  const row = await db.transaction(async (trx) => {
    const { eventType, unit } = await loadEventType(req, body.eventTypeId, { trx });
    if (eventType.archived_at || !eventType.active) {
      throw errors.validation([{ path: 'body.eventTypeId', message: 'This event type is switched off' }]);
    }
    const { deal, contact } = await subjectsFor(req, { eventType, unit, dealId: body.dealId, contactId: body.contactId }, trx);
    const index = await unitsIndex(req, trx);
    const owningUnit = index.get(deal?.unit_id ?? eventType.unit_id) ?? unit;
    const days = body.expiresInDays ?? (await getSetting(owningUnit, personalLinkDaysSetting, trx));
    const hosts = await trx('scheduling_event_type_hosts').where({ event_type_id: eventType.id, active: true }).pluck('user_id');
    const preferred = [deal?.owner_user_id, req.auth.user.id].find((id) => id && hosts.includes(id)) ?? null;
    const [created] = await trx('scheduling_booking_links')
      .insert({
        group_id: eventType.group_id,
        company_id: eventType.company_id,
        unit_id: deal?.unit_id ?? eventType.unit_id,
        event_type_id: eventType.id,
        kind: 'personal',
        deal_id: deal?.id ?? null,
        contact_id: contact?.id ?? null,
        preferred_host_user_id: preferred,
        prefill: json({ name: contact?.display_name ?? null, attending: body.attending ?? null }),
        expires_at: new Date(Date.now() + days * DAY_MS),
        max_uses: body.maxUses === undefined ? 1 : body.maxUses,
        created_by: req.auth.user.id,
      })
      .returning('*');
    await writeAudit(trx, req, {
      action: 'booking_link.created',
      entityType: 'booking_link',
      entityId: created.id,
      unit: auditUnit(created),
      after: { eventTypeId: eventType.id, dealId: created.deal_id, contactId: created.contact_id, expiresAt: created.expires_at, maxUses: created.max_uses },
    });
    await emitEvent(trx, {
      type: 'booking_link.created',
      groupId: created.group_id,
      unitId: created.unit_id,
      aggregateType: 'booking_link',
      aggregateId: created.id,
      actorUserId: req.auth.user.id,
      payload: { bookingLinkId: created.id, companyId: created.company_id, eventTypeId: eventType.id, dealId: created.deal_id, contactId: created.contact_id },
    });
    return created;
  });
  return getLink(req, row.id);
}

/** A link the viewer may see: through its deal (deals.view) or contact, else 404. */
async function loadVisibleLink(req, id, trx = db) {
  const link = await trx('scheduling_booking_links').where({ id, kind: 'personal' }).first();
  if (!link) throw errors.notFound('Booking link');
  if (link.deal_id) {
    const deal = await trx('deals').where({ id: link.deal_id }).first();
    if (!deal || !(await recordLevel(req, 'deals.view', deal, { trx }))) throw errors.notFound('Booking link');
    return { link, deal };
  }
  try {
    await loadVisibleContact(req, link.contact_id, { trx });
  } catch (err) {
    if (err instanceof AppError) throw errors.notFound('Booking link');
    throw err;
  }
  const index = await unitsIndex(req, trx);
  const unit = index.get(link.unit_id);
  if (!unit || !req.access.canAnywhereWithin('scheduling.view', unit.path)) throw errors.notFound('Booking link');
  return { link, deal: null };
}

/** Can the viewer send or revoke this link? */
async function canWorkLink(req, { link, deal }, trx = db) {
  if (deal) return Boolean(await recordLevel(req, 'scheduling.manage', deal, { trx }));
  const index = await unitsIndex(req, trx);
  const unit = index.get(link.unit_id);
  return Boolean(unit && req.access.canAnywhereWithin('scheduling.manage', unit.path));
}

async function presentLinks(rows, trx = db) {
  const eventTypeIds = [...new Set(rows.map((r) => r.event_type_id))];
  const userIds = [...new Set(rows.map((r) => r.created_by).filter(Boolean))];
  const [eventTypes, users] = await Promise.all([
    eventTypeIds.length ? trx('scheduling_event_types').whereIn('id', eventTypeIds).select('id', 'name', 'duration_min') : [],
    userIds.length ? trx('users').whereIn('id', userIds).select('id', 'name') : [],
  ]);
  const types = new Map(eventTypes.map((t) => [t.id, t]));
  const people = new Map(users.map((u) => [u.id, u]));
  return rows.map((row) => presentLink(row, { eventType: types.get(row.event_type_id), createdBy: people.get(row.created_by) }));
}

export async function getLink(req, id) {
  const { link } = await loadVisibleLink(req, id);
  const [presented] = await presentLinks([link]);
  return presented;
}

/** Personal links of a deal or a contact, newest first (at most 50). */
export async function listLinks(req, { dealId, contactId }) {
  const query = db('scheduling_booking_links').where({ kind: 'personal' });
  if (dealId) {
    await loadVisible(req, { table: 'deals', id: dealId, permission: 'deals.view', notFound: 'Deal' });
    query.where({ deal_id: dealId });
  } else {
    await loadVisibleContact(req, contactId);
    query.where({ contact_id: contactId });
    // Links on deals the viewer can't see stay hidden.
    const index = await unitsIndex(req);
    const unitIds = [...index.values()].filter((u) => u.type !== 'group' && req.access.canAnywhereWithin('scheduling.view', u.path)).map((u) => u.id);
    query.whereIn('unit_id', unitIds);
  }
  const rows = await query.orderBy([{ column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }]).limit(50);
  return presentLinks(rows);
}

export async function revokeLink(req, id) {
  await db.transaction(async (trx) => {
    const visible = await loadVisibleLink(req, id, trx);
    if (!(await canWorkLink(req, visible, trx))) throw errors.forbidden();
    if (visible.link.revoked_at) return;
    const [after] = await trx('scheduling_booking_links').where({ id }).update({ revoked_at: trx.fn.now(), updated_at: trx.fn.now() }).returning('*');
    await writeAudit(trx, req, { action: 'booking_link.revoked', entityType: 'booking_link', entityId: id, unit: auditUnit(after) });
    await emitEvent(trx, {
      type: 'booking_link.revoked',
      groupId: after.group_id,
      unitId: after.unit_id,
      aggregateType: 'booking_link',
      aggregateId: id,
      actorUserId: req.auth.user.id,
      payload: { bookingLinkId: id, companyId: after.company_id, dealId: after.deal_id, contactId: after.contact_id },
    });
  });
  return getLink(req, id);
}

const CONSENT_CHANNEL = { whatsapp: 'whatsapp', sms: 'sms', email: 'email' };

/**
 * Send a personal link to its contact through the messaging port (WhatsApp, SMS or email). The
 * message is a service message: allowed unless the person withdrew consent or opted out.
 * Writes the timeline entry ("Booking link sent"), the audit entry and booking_link.sent.
 */
export async function sendLink(req, id, { channel, message }) {
  const { link, deal } = await loadVisibleLink(req, id);
  if (!(await canWorkLink(req, { link, deal }))) throw errors.forbidden();
  if (link.revoked_at) throw errors.conflict('This link was revoked. Create a new one.');
  if (link.expires_at && new Date(link.expires_at).getTime() <= Date.now()) throw errors.conflict('This link has expired. Create a new one.');
  if (link.max_uses != null && link.use_count >= link.max_uses) throw errors.conflict('This link has been used. Create a new one.');
  if (!link.contact_id) throw errors.validation([{ path: 'body.channel', message: 'The deal has no contact to send to' }]);
  const contact = await db('contacts').where({ id: link.contact_id }).first('id', 'display_name', 'primary_phone', 'primary_email', 'erased_at');
  const to = channel === 'email' ? contact?.primary_email : contact?.primary_phone;
  if (!contact || contact.erased_at || !to) {
    throw errors.validation([{ path: 'body.channel', message: channel === 'email' ? 'This person has no email address' : 'This person has no phone number' }]);
  }
  const consent = await canContact({ contactId: contact.id, companyId: link.company_id, channel: CONSENT_CHANNEL[channel], purpose: 'service', normalized: to });
  if (!consent.allowed) {
    throw new AppError(409, 'consent_withdrawn', consent.optedOut ? 'This number or address has opted out of messages' : 'This person has withdrawn consent for this channel');
  }

  const eventType = await db('scheduling_event_types').where({ id: link.event_type_id }).first();
  const url = bookingPageUrl(linkTokenFor(link));
  const result = await callPort(
    'sendBookingLink',
    { link, url, channel, to, contact, deal, message: message ?? null, eventType, actorUserId: req.auth.user.id, companyId: link.company_id },
    req.log,
  );
  if (!result) throw new AppError(502, 'send_failed', 'The message could not be sent. Try again or copy the link.');

  await db.transaction(async (trx) => {
    const [after] = await trx('scheduling_booking_links').where({ id }).update({ last_sent_at: trx.fn.now(), updated_at: trx.fn.now() }).returning('*');
    await writeAudit(trx, req, {
      action: 'booking_link.sent',
      entityType: 'booking_link',
      entityId: id,
      unit: auditUnit(after),
      meta: { channel, status: result.status ?? null },
    });
    await emitEvent(trx, {
      type: 'booking_link.sent',
      groupId: after.group_id,
      unitId: after.unit_id,
      aggregateType: 'booking_link',
      aggregateId: id,
      actorUserId: req.auth.user.id,
      payload: { bookingLinkId: id, companyId: after.company_id, dealId: after.deal_id, contactId: after.contact_id, channel, status: result.status ?? null },
    });
    await addTimelineEvent(trx, {
      groupId: after.group_id,
      companyId: after.company_id,
      unitId: after.unit_id,
      dealId: after.deal_id,
      contactId: after.contact_id,
      kind: 'system',
      direction: 'internal',
      title: `Booking link sent: ${eventType?.name ?? 'meeting'} (${channel === 'whatsapp' ? 'WhatsApp' : channel === 'sms' ? 'SMS' : 'email'})`.slice(0, 300),
      meta: { action: 'booking_link.sent', bookingLinkId: id, eventTypeId: link.event_type_id, channel },
      actorType: 'user',
      actorUserId: req.auth.user.id,
    });
  });
  return { ...(await getLink(req, id)), delivery: { status: result.status ?? 'queued', channel: result.channel ?? channel } };
}
