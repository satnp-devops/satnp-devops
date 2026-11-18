import { db } from '../../lib/db.js';
import { AppError, errors } from '../../lib/errors.js';
import { addDays, groupSlotsByLocalDate, localToUtc } from '../../core/scheduling/index.js';
import { slotsFor } from './availability.js';
import { cancelBooking, companySettings, createBooking, requestReschedule, rescheduleBooking } from './bookings.js';
import { buildInviteFor } from './invites.js';
import { brandingOf, presentPublicBooking, presentPublicEventType } from './present.js';
import { verifyToken } from './tokens.js';

// The public booking page (no session). The signed token in the URL is the only credential; it is
// verified before any database read, and the row it names is checked again (revoked, used up,
// expired, switched off). Every failure looks the same to the visitor apart from "expired".

const DAY_MS = 86_400_000;

const invalidLink = () => new AppError(404, 'not_found', 'This booking link is not valid. Ask for a new one.');
const expiredLink = () => new AppError(410, 'link_expired', 'This booking link has expired. Ask for a new one.');
const usedLink = () => new AppError(410, 'link_used', 'This booking link has already been used. Ask for a new one.');
const closedPage = () => new AppError(410, 'unavailable', 'Bookings for this meeting are closed.');
const invalidManage = () => new AppError(404, 'not_found', 'This booking link is not valid.');

/** Verify a booking-page token and load what the page needs. */
export async function resolveLinkToken(token, { now = Date.now(), forBooking = false } = {}) {
  const verified = verifyToken(token, 'link', { now });
  if (!verified.ok) throw verified.reason === 'expired' ? expiredLink() : invalidLink();
  const link = await db('scheduling_booking_links').where({ id: verified.id }).first();
  if (!link || link.revoked_at) throw invalidLink();
  if (link.expires_at && new Date(link.expires_at).getTime() <= now) throw expiredLink();
  if (forBooking && link.max_uses != null && link.use_count >= link.max_uses) throw usedLink();
  const [eventType, company] = await Promise.all([
    db('scheduling_event_types').where({ id: link.event_type_id }).first(),
    db('org_units').where({ id: link.company_id }).first(),
  ]);
  if (!eventType || !company || company.status !== 'active') throw invalidLink();
  if (eventType.archived_at || !eventType.active) throw closedPage();
  return { link, eventType, company };
}

/** Verify a manage token (one booking) and load the booking; rotated nonces fail. */
export async function resolveManageToken(token, { now = Date.now() } = {}) {
  const verified = verifyToken(token, 'manage', { now });
  if (!verified.ok) throw verified.reason === 'expired' ? new AppError(410, 'link_expired', 'This link has expired.') : invalidManage();
  const booking = await db('bookings').where({ id: verified.id }).first();
  if (!booking || booking.token_nonce !== verified.nonce) throw invalidManage();
  const [eventType, company, host] = await Promise.all([
    db('scheduling_event_types').where({ id: booking.event_type_id }).first(),
    db('org_units').where({ id: booking.company_id }).first(),
    booking.host_user_id ? db('users').where({ id: booking.host_user_id }).first('id', 'name', 'email') : null,
  ]);
  return { booking, eventType, company, host };
}

async function brandingFor(company, eventType) {
  const settings = await companySettings(company);
  return { branding: brandingOf({ company, eventType, settings: settings.branding }), settings };
}

/** GET /public/booking/:token */
export async function publicPage(token) {
  const { link, eventType, company } = await resolveLinkToken(token);
  const { branding, settings } = await brandingFor(company, eventType);
  const host = link.preferred_host_user_id ? await db('users').where({ id: link.preferred_host_user_id }).first('name') : null;
  const usedUp = link.max_uses != null && link.use_count >= link.max_uses;
  return {
    eventType: presentPublicEventType(eventType),
    branding,
    companyTimeZone: settings.timeZone,
    personal: link.kind === 'personal',
    // Only the first name the team already knows; never contact details (a link can be forwarded).
    prefill: { name: link.prefill?.name ?? null, attending: link.prefill?.attending ?? null },
    hostName: host?.name ?? null,
    expiresAt: link.expires_at ? new Date(link.expires_at).toISOString() : null,
    usedUp,
  };
}

/**
 * Slots for the visitor's zone over local dates [from, to] (inclusive), grouped by local date.
 * The engine works in UTC; the range is the visitor's local days.
 */
export async function slotsForRange(eventType, { from, to, timeZone, now = Date.now(), excludeBookingId = null, log }) {
  const fromMs = localToUtc(from, '00:00', timeZone);
  const toMs = localToUtc(addDays(to, 1), '00:00', timeZone); // the next local midnight, so 23- and 25-hour days are whole
  const horizonEnd = now + eventType.horizon_days * DAY_MS;
  if (fromMs > horizonEnd) return { timeZone, days: [] };
  const { slots } = await slotsFor(eventType, { fromMs, toMs: Math.min(toMs, horizonEnd + DAY_MS), now, excludeBookingId, log });
  const days = groupSlotsByLocalDate(slots, timeZone)
    .filter((day) => day.date >= from && day.date <= to)
    .map((day) => ({ date: day.date, slots: day.slots.map((s) => ({ start: s.start, end: s.end, localTime: s.localTime })) }));
  return { timeZone, days };
}

export async function publicSlots(token, query, { log } = {}) {
  const { eventType } = await resolveLinkToken(token);
  return slotsForRange(eventType, { ...query, log });
}

/** POST /public/booking/:token/book → the confirmation. */
export async function publicBook(token, body, { log } = {}) {
  const now = Date.now();
  const { link, eventType, company } = await resolveLinkToken(token, { now, forBooking: !body.idempotencyKey });
  const booking = await createBooking({ link, eventType, company, input: body, now, log });
  return confirmation(booking, { eventType, company });
}

async function confirmation(booking, { eventType, company }) {
  const [{ branding }, host] = await Promise.all([
    brandingFor(company, eventType),
    booking.host_user_id ? db('users').where({ id: booking.host_user_id }).first('name') : null,
  ]);
  return presentPublicBooking(booking, { eventType, host, branding });
}

/** GET /public/bookings/:token */
export async function publicBooking(token) {
  const { booking, eventType, company } = await resolveManageToken(token);
  return confirmation(booking, { eventType, company });
}

export async function publicManageSlots(token, query, { log } = {}) {
  const { booking, eventType } = await resolveManageToken(token);
  if (!['booked', 'rescheduled'].includes(booking.status)) throw errors.conflict('This booking is no longer active');
  return slotsForRange(eventType, { ...query, excludeBookingId: booking.id, log });
}

export async function publicReschedule(token, body, { log } = {}) {
  const { booking, eventType, company } = await resolveManageToken(token);
  const updated = await rescheduleBooking({ bookingId: booking.id, startMs: new Date(body.start).getTime(), timeZone: body.timeZone, actor: 'invitee', log });
  return confirmation(updated, { eventType, company });
}

export async function publicCancel(token, body, { log } = {}) {
  const { booking, eventType, company } = await resolveManageToken(token);
  const updated = await cancelBooking({ bookingId: booking.id, reason: body.reason ?? null, actor: 'invitee', log });
  return confirmation(updated, { eventType, company });
}

export async function publicRescheduleRequest(token, body) {
  const { booking, eventType, company } = await resolveManageToken(token);
  const updated = await requestReschedule({ bookingId: booking.id, note: body.note ?? null });
  return confirmation(updated, { eventType, company });
}

/** The .ics for "Add to calendar" (REQUEST while active, CANCEL once cancelled). */
export async function publicIcs(token) {
  const { booking, eventType, company, host } = await resolveManageToken(token);
  const { ics, method } = buildInviteFor({
    booking: { ...booking, invitee_email: booking.invitee_email || null },
    eventType,
    host,
    company,
  });
  if (!ics) throw errors.notFound('Calendar file');
  return { ics, method, filename: `${eventType.slug || 'meeting'}.ics` };
}
