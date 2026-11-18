import { ACTIVE_STATUSES } from './schemas.js';

// Domain events from other modules that scheduling follows. All are idempotent (plain "set" updates).
//   deal.owner_changed  active bookings of the deal follow the new owner (scoping "own" = host or deal owner)
//   deal.unit_changed   active bookings and live personal links move with the deal (scoping by unit)
//   contact.merged      bookings and links point at the surviving contact
//   contact.erased      personal data on the person's bookings is blanked (DPDP erasure)

export const schedulingEventHandlers = {
  'deal.owner_changed': async (event, { db }) => {
    const { dealId, toUserId = null } = event.payload ?? {};
    if (!dealId) return;
    await db('bookings')
      .where({ deal_id: dealId })
      .whereIn('status', ACTIVE_STATUSES)
      .update({ owner_user_id: toUserId, updated_at: db.fn.now() });
  },

  'deal.unit_changed': async (event, { db }) => {
    const { dealId, toUnitId } = event.payload ?? {};
    if (!dealId || !toUnitId) return;
    await db('bookings').where({ deal_id: dealId }).whereIn('status', ACTIVE_STATUSES).update({ unit_id: toUnitId, updated_at: db.fn.now() });
    await db('scheduling_booking_links').where({ deal_id: dealId }).whereNull('revoked_at').update({ unit_id: toUnitId, updated_at: db.fn.now() });
  },

  'contact.merged': async (event, { db }) => {
    const { targetId, sourceId } = event.payload ?? {};
    if (!targetId || !sourceId) return;
    await db('bookings').where({ contact_id: sourceId }).update({ contact_id: targetId, updated_at: db.fn.now() });
    await db('scheduling_booking_links').where({ contact_id: sourceId }).update({ contact_id: targetId, updated_at: db.fn.now() });
  },

  'contact.erased': async (event, { db }) => {
    const { contactId } = event.payload ?? {};
    if (!contactId) return;
    const bookingIds = await db('bookings').where({ contact_id: contactId }).pluck('id');
    if (bookingIds.length === 0) return;
    await db('bookings')
      .whereIn('id', bookingIds)
      .update({
        invitee_name: 'Erased contact',
        invitee_email: null,
        invitee_phone: null,
        guests: db.raw("'[]'::jsonb"),
        answers: db.raw("'{}'::jsonb"),
        notes: null,
        updated_at: db.fn.now(),
      });
    const meetingIds = await db('meetings').whereIn('booking_id', bookingIds).pluck('id');
    if (meetingIds.length) {
      await db('meeting_participants').whereIn('meeting_id', meetingIds).whereNot('role', 'host').update({ name: null, email: null });
      await db('meeting_events').whereIn('meeting_id', meetingIds).update({ data: db.raw(`data - 'participant'`) });
    }
    await db('scheduling_booking_links').where({ contact_id: contactId }).update({ prefill: db.raw("'{}'::jsonb"), updated_at: db.fn.now() });
  },
};
