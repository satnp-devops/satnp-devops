import { env } from '../../config/env.js';
import { buildInvite } from '../../core/scheduling/index.js';
import { managePageUrl, manageTokenFor } from './tokens.js';

// Calendar invitations (iTIP) for bookings: a REQUEST while the booking is active (a reschedule
// repeats the UID with a higher SEQUENCE), a CANCEL once it is cancelled. Times are UTC, so no
// VTIMEZONE is needed and every calendar shows the meeting in its own zone.

const LOCATION_LABELS = { zoom: 'Zoom', google_meet: 'Google Meet', teams: 'Microsoft Teams', phone: 'Phone call', in_person: 'In person' };

/** The address in MAIL_FROM ("Name <address>" or a bare address). */
function mailFromAddress() {
  const match = /<([^>]+)>/.exec(env.MAIL_FROM);
  return (match ? match[1] : env.MAIL_FROM).trim();
}

const looksLikeEmail = (value) => typeof value === 'string' && /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(value);

/**
 * @param {{ booking: object, eventType: object, host?: { name?: string, email?: string } | null, company?: object | null, now?: number }} input
 * @returns {{ ics: string | null, method: 'REQUEST' | 'CANCEL' }}
 */
export function buildInviteFor({ booking, eventType, host = null, company = null, now = Date.now() }) {
  const method = booking.status === 'cancelled' ? 'CANCEL' : 'REQUEST';
  const attendees = [];
  if (looksLikeEmail(booking.invitee_email)) attendees.push({ email: booking.invitee_email, name: booking.invitee_name });
  for (const guest of booking.guests ?? []) {
    if (looksLikeEmail(guest.email) && !attendees.some((a) => a.email.toLowerCase() === guest.email.toLowerCase())) {
      attendees.push({ email: guest.email, name: guest.name, role: 'OPT-PARTICIPANT' });
    }
  }
  if (attendees.length === 0) return { ics: null, method };

  const companyName = company?.profile?.brandName || company?.name || 'Phoenix';
  const organizer = looksLikeEmail(host?.email) ? { email: host.email, name: host.name } : { email: mailFromAddress(), name: companyName };
  const manageUrl = method === 'REQUEST' ? managePageUrl(manageTokenFor(booking)) : null;
  const location =
    booking.meeting_url ||
    [LOCATION_LABELS[booking.location_kind] ?? booking.location_kind, booking.location_detail].filter(Boolean).join(': ') ||
    undefined;
  const description = [
    eventType.description || null,
    host?.name ? `With ${host.name} (${companyName}).` : `With ${companyName}.`,
    booking.meeting_url ? `Join: ${booking.meeting_url}` : null,
    manageUrl ? `Reschedule or cancel: ${manageUrl}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  const ics = buildInvite({
    method,
    uid: booking.ics_uid,
    sequence: booking.ics_sequence,
    dtstamp: now,
    created: booking.created_at ?? undefined,
    lastModified: booking.updated_at ?? undefined,
    start: new Date(booking.start_at).getTime(),
    end: new Date(booking.end_at).getTime(),
    summary: `${eventType.name} · ${companyName}`,
    description,
    location,
    url: booking.meeting_url && /^https?:\/\//.test(booking.meeting_url) ? booking.meeting_url : undefined,
    organizer,
    attendees,
  });
  return { ics, method };
}
