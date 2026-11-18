import { z } from 'zod';
import { db } from '../../lib/db.js';
import { validate } from '../../lib/validate.js';
import { idParams } from '../../lib/schemas.js';
import { errors } from '../../lib/errors.js';
import { requireAuth } from '../../core/guards.js';
import { describe } from '../../core/openapi/describe.js';
import { loadEventType, loadVisibleBooking } from './access.js';
import { cancelBooking, markOutcome, reassignBooking, rescheduleBooking } from './bookings.js';
import {
  createEventType,
  getAvailability,
  getEventType,
  listEventTypes,
  listHostCandidates,
  putAvailability,
  replaceHosts,
  setArchived,
  updateEventType,
} from './eventTypes.js';
import { createPersonalLink, getLink, listLinks, revokeLink, sendLink } from './links.js';
import { bookingSummary, getBooking, listBookings, reassignCandidates } from './queries.js';
import { slotsForRange } from './public.js';
import {
  availabilityBody,
  bookingListQuery,
  createEventTypeBody,
  createLinkBody,
  eventTypeListQuery,
  hostsSchema,
  linkListQuery,
  outcomeBody,
  reassignBody,
  sendLinkBody,
  slotsQuery,
  staffCancelBody,
  staffRescheduleBody,
  summaryQuery,
  updateEventTypeBody,
  userParams,
} from './schemas.js';

// Staff endpoints (signed in). Public booking-page endpoints are in publicRoutes.js.

export function schedulingRoutes(router) {
  // ---------- Event types ----------
  router.get('/scheduling/event-types', describe({ summary: "List event types for a working unit", permission: 'scheduling.view' }), requireAuth(), validate({ query: eventTypeListQuery }), async (req, res) => {
    res.json({ data: await listEventTypes(req, req.valid.query) });
  });

  router.post('/scheduling/event-types', describe({ summary: "Create an event type", permission: 'scheduling.configure', status: 201, description: 'Creates its public booking link too. Hosts need scheduling.manage at, above or inside the unit. Emits event_type.created.' }), requireAuth(), validate({ body: createEventTypeBody }), async (req, res) => {
    res.status(201).json({ data: await createEventType(req, req.valid.body) });
  });

  router.get('/scheduling/event-types/:id', describe({ summary: "Get an event type", permission: 'scheduling.view' }), requireAuth(), validate({ params: idParams }), async (req, res) => {
    res.json({ data: await getEventType(req, req.valid.params.id) });
  });

  router.patch('/scheduling/event-types/:id', describe({ summary: "Change an event type", permission: 'scheduling.configure', description: 'Emits event_type.updated.' }), requireAuth(), validate({ params: idParams, body: updateEventTypeBody }), async (req, res) => {
    res.json({ data: await updateEventType(req, req.valid.params.id, req.valid.body) });
  });

  router.post('/scheduling/event-types/:id/archive', describe({ summary: "Switch an event type off", permission: 'scheduling.configure', description: 'Its booking page and personal links stop taking bookings. Emits event_type.archived.' }), requireAuth(), validate({ params: idParams }), async (req, res) => {
    res.json({ data: await setArchived(req, req.valid.params.id, true) });
  });

  router.post('/scheduling/event-types/:id/restore', describe({ summary: "Switch an event type back on", permission: 'scheduling.configure' }), requireAuth(), validate({ params: idParams }), async (req, res) => {
    res.json({ data: await setArchived(req, req.valid.params.id, false) });
  });

  router.put('/scheduling/event-types/:id/hosts', describe({ summary: "Replace the hosts of an event type", permission: 'scheduling.configure' }), requireAuth(), validate({ params: idParams, body: hostsSchema }), async (req, res) => {
    res.json({ data: await replaceHosts(req, req.valid.params.id, req.valid.body) });
  });

  /** Staff preview of an event type's slots (same engine and data as the public page). */
  router.get('/scheduling/event-types/:id/slots', describe({ summary: "Preview free times of an event type", permission: 'scheduling.view' }), requireAuth(), validate({ params: idParams, query: slotsQuery }), async (req, res) => {
    const { eventType } = await loadEventType(req, req.valid.params.id);
    res.json({ data: await slotsForRange(eventType, { ...req.valid.query, log: req.log }) });
  });

  router.get('/scheduling/host-candidates', describe({ summary: "People who can host event types of a unit", permission: 'scheduling.view' }), requireAuth(), validate({ query: z.strictObject({ unitId: z.uuid() }) }), async (req, res) => {
    res.json({ data: await listHostCandidates(req, req.valid.query.unitId) });
  });

  // ---------- Availability ----------
  router.get('/scheduling/availability/:userId', describe({ summary: "Get a person's weekly hours", permission: 'scheduling.view' }), requireAuth(), validate({ params: userParams }), async (req, res) => {
    res.json({ data: await getAvailability(req, req.valid.params.userId) });
  });

  router.put('/scheduling/availability/:userId', describe({ summary: "Set a person's weekly hours", permission: 'scheduling.configure', description: 'Anyone may set their own (me); others need scheduling.configure over every place the person works. Emits availability.updated.' }), requireAuth(), validate({ params: userParams, body: availabilityBody }), async (req, res) => {
    res.json({ data: await putAvailability(req, req.valid.params.userId, req.valid.body) });
  });

  // ---------- Bookings ----------
  router.get('/scheduling/bookings', describe({ summary: "List bookings (calendar and views)", permission: 'scheduling.view', list: true, description: 'Views: upcoming, live, past, no_shows, reschedule_requests, cancelled, all (with from/to for the calendar). Own level: bookings the user hosts or whose deal they own.' }), requireAuth(), validate({ query: bookingListQuery }), async (req, res) => {
    res.json(await listBookings(req, req.valid.query));
  });

  router.get('/scheduling/bookings/summary', describe({ summary: "Booking counts for a working unit", permission: 'scheduling.view' }), requireAuth(), validate({ query: summaryQuery }), async (req, res) => {
    res.json({ data: await bookingSummary(req, req.valid.query) });
  });

  router.get('/scheduling/bookings/:id', describe({ summary: "Get a booking", permission: 'scheduling.view' }), requireAuth(), validate({ params: idParams }), async (req, res) => {
    res.json({ data: await getBooking(req, req.valid.params.id) });
  });

  /** Free times for moving a booking (its own slot excluded from busy time). */
  router.get('/scheduling/bookings/:id/slots', describe({ summary: "Free times for moving a booking", permission: 'scheduling.manage' }), requireAuth(), validate({ params: idParams, query: slotsQuery }), async (req, res) => {
    const { booking } = await loadVisibleBooking(req, req.valid.params.id, { permission: 'scheduling.manage' });
    const eventType = await loadEventTypeRow(booking.event_type_id);
    res.json({ data: await slotsForRange(eventType, { ...req.valid.query, excludeBookingId: booking.id, log: req.log }) });
  });

  router.post(
    '/scheduling/bookings/:id/reschedule',
    describe({ summary: 'Move a booking to another time', permission: 'scheduling.manage', errors: [409], description: 'Keeps the host when free, else picks another. Sends an updated invitation (same UID, higher SEQUENCE). Emits booking.rescheduled.' }),
    requireAuth(),
    validate({ params: idParams, body: staffRescheduleBody }),
    async (req, res) => {
      const { booking } = await loadVisibleBooking(req, req.valid.params.id, { permission: 'scheduling.manage' });
      await rescheduleBooking({ bookingId: booking.id, startMs: new Date(req.valid.body.start).getTime(), actor: 'staff', req, log: req.log });
      res.json({ data: await getBooking(req, booking.id) });
    },
  );

  router.post('/scheduling/bookings/:id/cancel', describe({ summary: "Cancel a booking", permission: 'scheduling.manage', errors: [409], description: 'Sends an iTIP CANCEL. Emits booking.cancelled.' }), requireAuth(), validate({ params: idParams, body: staffCancelBody }), async (req, res) => {
    const { booking } = await loadVisibleBooking(req, req.valid.params.id, { permission: 'scheduling.manage' });
    await cancelBooking({ bookingId: booking.id, reason: req.valid.body.reason ?? null, actor: 'staff', req, log: req.log });
    res.json({ data: await getBooking(req, booking.id) });
  });

  router.get('/scheduling/bookings/:id/reassign-candidates', describe({ summary: "Hosts a booking can be given to", permission: 'scheduling.assign' }), requireAuth(), validate({ params: idParams }), async (req, res) => {
    res.json({ data: await reassignCandidates(req, req.valid.params.id) });
  });

  router.post('/scheduling/bookings/:id/reassign', describe({ summary: "Give a booking to another host", permission: 'scheduling.assign', errors: [409], description: 'The new host must be a host of the event type and free. Emits booking.reassigned.' }), requireAuth(), validate({ params: idParams, body: reassignBody }), async (req, res) => {
    const { booking } = await loadVisibleBooking(req, req.valid.params.id, { permission: 'scheduling.assign' });
    await reassignBooking({ req, booking, hostUserId: req.valid.body.hostUserId, log: req.log });
    res.json({ data: await getBooking(req, booking.id) });
  });

  for (const [path, outcome] of [
    ['no-show', 'no_show'],
    ['attended', 'attended'],
  ]) {
    router.post(
      `/scheduling/bookings/:id/${path}`,
      describe({
        summary: outcome === 'no_show' ? 'Mark a booking as a no-show' : 'Mark a booking as attended',
        permission: 'scheduling.manage',
        errors: [409],
        description: `Only once the meeting has started. Emits booking.${outcome === 'no_show' ? 'no_show' : 'attended'}.`,
      }),
      requireAuth(), validate({ params: idParams, body: outcomeBody }), async (req, res) => {
      const { booking } = await loadVisibleBooking(req, req.valid.params.id, { permission: 'scheduling.manage' });
      await markOutcome({ req, bookingId: booking.id, outcome, note: req.valid.body.note ?? null });
      res.json({ data: await getBooking(req, booking.id) });
    });
  }

  // ---------- Personal booking links ----------
  router.post('/scheduling/links', describe({ summary: "Create a personal booking link for a deal or contact", permission: 'scheduling.manage', status: 201, description: 'Prefilled, signed, expiring and single-use by default; bookings land on the deal with its owner preferred as host. Emits booking_link.created.' }), requireAuth(), validate({ body: createLinkBody }), async (req, res) => {
    res.status(201).json({ data: await createPersonalLink(req, req.valid.body) });
  });

  router.get('/scheduling/links', describe({ summary: "List personal booking links of a deal or contact", permission: 'deals.view' }), requireAuth(), validate({ query: linkListQuery }), async (req, res) => {
    res.json({ data: await listLinks(req, req.valid.query) });
  });

  router.get('/scheduling/links/:id', describe({ summary: "Get a personal booking link", permission: 'deals.view' }), requireAuth(), validate({ params: idParams }), async (req, res) => {
    res.json({ data: await getLink(req, req.valid.params.id) });
  });

  router.post('/scheduling/links/:id/send', describe({ summary: "Send a personal booking link", permission: 'scheduling.manage', errors: [409, 502], description: 'Through the messaging port (WhatsApp, SMS or email); writes a timeline entry. Emits booking_link.sent.' }), requireAuth(), validate({ params: idParams, body: sendLinkBody }), async (req, res) => {
    res.json({ data: await sendLink(req, req.valid.params.id, req.valid.body) });
  });

  router.post('/scheduling/links/:id/revoke', describe({ summary: "Revoke a personal booking link", permission: 'scheduling.manage' }), requireAuth(), validate({ params: idParams }), async (req, res) => {
    res.json({ data: await revokeLink(req, req.valid.params.id) });
  });
}

async function loadEventTypeRow(id) {
  const row = await db('scheduling_event_types').where({ id }).first();
  if (!row) throw errors.notFound('Event type');
  return row;
}
