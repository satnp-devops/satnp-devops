import { db } from '../../lib/db.js';
import { levelForRecord } from '../../core/crm/scope.js';
import { maskEmail, maskPhone } from '../../core/crm/pii.js';
import { bookingLevel } from './access.js';
import { ACTIVE_STATUSES, rangeText } from './schemas.js';
import { bookingPageUrl, linkTokenFor, managePageUrl, manageTokenFor } from './tokens.js';

// Row → API shapes (apps/web/src/lib/scheduling/types.ts). Times are ISO strings in UTC.

const iso = (value) => (value ? new Date(value).toISOString() : null);
const userRef = (user) => (user ? { id: user.id, name: user.name } : null);
const unitRef = (unit) => (unit ? { id: unit.id, name: unit.name, type: unit.type } : null);

export function presentEventType(row, { hosts = [], publicLink = null, unit = null, can = { configure: false, book: false } } = {}) {
  return {
    id: row.id,
    companyId: row.company_id,
    unit: unitRef(unit) ?? { id: row.unit_id, name: '', type: '' },
    slug: row.slug,
    name: row.name,
    description: row.description ?? null,
    durationMin: row.duration_min,
    slotIntervalMin: row.slot_interval_min ?? null,
    bufferBeforeMin: row.buffer_before_min,
    bufferAfterMin: row.buffer_after_min,
    minNoticeMin: row.min_notice_min,
    maxPerDay: row.max_per_day ?? null,
    horizonDays: row.horizon_days,
    alignTimeZone: row.align_time_zone ?? null,
    locationKind: row.location_kind,
    locationDetail: row.location_detail ?? null,
    assignment: row.assignment,
    attendanceThresholdMin: row.attendance_threshold_min,
    reminderOffsetsMin: row.reminder_offsets_min ?? [],
    questions: row.questions ?? [],
    attendees: row.attendees ?? {},
    branding: row.branding ?? {},
    dealKind: row.deal_kind ?? null,
    active: row.active,
    archivedAt: iso(row.archived_at),
    hosts: hosts.map((h) => ({
      user: { id: h.user_id, name: h.name },
      weight: h.weight,
      priority: h.priority,
      languages: h.languages ?? [],
      active: h.active,
      hasAvailability: Boolean(h.has_availability),
    })),
    publicLink,
    can,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function publicLinkOf(link) {
  if (!link) return null;
  const token = linkTokenFor(link);
  return { id: link.id, url: bookingPageUrl(token), token };
}

export function presentAvailability(row, user) {
  return {
    user: userRef(user),
    timeZone: row?.time_zone ?? null,
    weekly: Object.fromEntries(Object.entries(row?.weekly ?? {}).map(([day, ranges]) => [day, (ranges ?? []).map(rangeText)])),
    overrides: Object.fromEntries(
      Object.entries(row?.overrides ?? {}).map(([date, value]) => [date, Array.isArray(value) ? value.map(rangeText) : value]),
    ),
    configured: Boolean(row),
    updatedAt: iso(row?.updated_at),
  };
}

export function presentMeeting(meeting) {
  if (!meeting) return null;
  return {
    provider: meeting.provider,
    status: meeting.status,
    result: meeting.result,
    thresholdMin: meeting.threshold_min,
    inviteeSeconds: meeting.invitee_seconds,
    hostSeconds: meeting.host_seconds,
    startedAt: iso(meeting.started_at),
    endedAt: iso(meeting.ended_at),
    evaluatedAt: iso(meeting.evaluated_at),
    recording: meeting.recording && Object.keys(meeting.recording).length ? meeting.recording : null,
    aiSummary: meeting.ai_summary ?? null,
    aiSummaryStatus: meeting.ai_summary_status,
  };
}

/** Related rows for a page of bookings, one query per relation. */
export async function loadBookingRelations(rows, trx = db) {
  const ids = (key) => [...new Set(rows.map((r) => r[key]).filter(Boolean))];
  const userIds = [...new Set([...ids('host_user_id'), ...ids('owner_user_id')])];
  const [users, eventTypes, deals, contacts, meetings] = await Promise.all([
    userIds.length ? trx('users').whereIn('id', userIds).select('id', 'name') : [],
    ids('event_type_id').length
      ? trx('scheduling_event_types').whereIn('id', ids('event_type_id')).select('id', 'name', 'slug', 'duration_min', 'location_kind', 'attendance_threshold_min', 'questions', 'attendees')
      : [],
    ids('deal_id').length ? trx('deals').whereIn('id', ids('deal_id')).select('id', 'ref', 'title', 'status', 'unit_id', 'owner_user_id') : [],
    ids('contact_id').length ? trx('contacts').whereIn('id', ids('contact_id')).select('id', 'display_name', 'kind') : [],
    rows.length ? trx('meetings').whereIn('booking_id', rows.map((r) => r.id)) : [],
  ]);
  const byId = (list) => new Map(list.map((item) => [item.id, item]));
  return {
    users: byId(users),
    eventTypes: byId(eventTypes),
    deals: byId(deals),
    contacts: byId(contacts),
    meetings: new Map(meetings.map((m) => [m.booking_id, m])),
  };
}

export function isLive(row, now = Date.now()) {
  return ACTIVE_STATUSES.includes(row.status) && new Date(row.start_at).getTime() <= now && new Date(row.end_at).getTime() > now;
}

function answerList(answers, questions) {
  const known = questions.filter((q) => answers[q.key] !== undefined).map((q) => {
    const value = answers[q.key];
    const choice = q.type === 'select' ? (q.options ?? []).find((o) => o.value === value)?.label : null;
    return { key: q.key, label: q.label, value: choice ?? value };
  });
  const rest = Object.keys(answers)
    .filter((key) => !questions.some((q) => q.key === key))
    .map((key) => ({ key, label: key.replace(/_/g, ' '), value: answers[key] }));
  return [...known, ...rest];
}

/**
 * A booking for staff. Personal details (email, phone, guests' emails) are masked unless the viewer
 * holds contacts.view_pii at the booking's unit or hosts it.
 */
export function presentBooking(row, rel, { access, unitsById, userId, now = Date.now() }) {
  const unit = unitsById.get(row.unit_id);
  const isHost = row.host_user_id === userId;
  const canViewPii = isHost || (unit ? access.can('contacts.view_pii', unit.path) : false);
  const eventType = rel.eventTypes.get(row.event_type_id);
  const deal = row.deal_id ? rel.deals.get(row.deal_id) : null;
  const dealVisible = deal ? Boolean(levelForRecord(access, unitsById, 'deals.view', deal, { userId })) : false;
  const contact = row.contact_id ? rel.contacts.get(row.contact_id) : null;
  const active = ACTIVE_STATUSES.includes(row.status);
  const manage = Boolean(bookingLevel(access, unitsById, 'scheduling.manage', row, userId));
  const company = unitsById.get(row.company_id);
  const assign = Boolean(company && unit && access.can('scheduling.assign', unit.path));
  const started = new Date(row.start_at).getTime() <= now;
  return {
    id: row.id,
    status: row.status,
    startAt: iso(row.start_at),
    endAt: iso(row.end_at),
    timeZone: row.time_zone,
    companyId: row.company_id,
    unit: unitRef(unit),
    eventType: eventType
      ? { id: eventType.id, name: eventType.name, slug: eventType.slug, durationMin: eventType.duration_min, locationKind: eventType.location_kind }
      : null,
    host: userRef(rel.users.get(row.host_user_id)),
    owner: userRef(rel.users.get(row.owner_user_id)),
    invitee: {
      name: row.invitee_name,
      email: canViewPii ? (row.invitee_email ?? null) : maskEmail(row.invitee_email),
      phone: canViewPii ? (row.invitee_phone ?? null) : maskPhone(row.invitee_phone),
      piiMasked: !canViewPii && Boolean(row.invitee_email || row.invitee_phone),
    },
    attending: row.attending ?? null,
    attendingLabel: row.attending ? ((eventType?.attendees?.options ?? []).find((o) => o.value === row.attending)?.label ?? row.attending) : null,
    guests: (row.guests ?? []).map((g) => ({ name: g.name, email: g.email ? (canViewPii ? g.email : maskEmail(g.email)) : null })),
    answers: row.answers ?? {},
    // The answers with their questions' labels, in the event type's order (unknown keys last).
    answerList: answerList(row.answers ?? {}, eventType?.questions ?? []),
    notes: row.notes ?? null,
    location: { kind: row.location_kind, detail: row.location_detail ?? null, meetingUrl: row.meeting_url ?? null, provider: row.meeting_provider ?? null },
    deal: deal && dealVisible ? { id: deal.id, ref: deal.ref, title: deal.title, status: deal.status } : null,
    contact: contact ? { id: contact.id, displayName: contact.display_name, kind: contact.kind } : null,
    source: row.source,
    assignmentReason: row.assignment_reason ?? null,
    rescheduleCount: row.reschedule_count,
    rescheduleRequest: row.reschedule_requested_at ? { at: iso(row.reschedule_requested_at), note: row.reschedule_request_note ?? null } : null,
    cancelledAt: iso(row.cancelled_at),
    cancelledBy: row.cancelled_by ?? null,
    cancelReason: row.cancel_reason ?? null,
    completedAt: iso(row.completed_at),
    noShowAt: iso(row.no_show_at),
    meeting: presentMeeting(rel.meetings.get(row.id)),
    live: isLive(row, now),
    can: {
      manage: manage && active,
      reschedule: manage && active,
      cancel: manage && active,
      assign: assign && active,
      markOutcome: manage && active && started,
    },
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

/** Branding for public pages: the event type's own, else the company profile (brand colour, logo), else the branding settings. */
export function brandingOf({ company, eventType, settings }) {
  const own = eventType?.branding ?? {};
  const profile = company?.profile ?? {};
  return {
    companyName: profile.brandName || company?.name || 'Phoenix',
    color: own.color || profile.brandColor || settings.color || '#2840D8',
    logoUrl: own.logoUrl || profile.logoUrl || settings.logoUrl || null,
    headline: own.headline ?? null,
    confirmationMessage: own.confirmationMessage ?? null,
  };
}

/** The public view of an event type for the booking page. */
export function presentPublicEventType(eventType) {
  const attendees = eventType.attendees ?? {};
  return {
    name: eventType.name,
    description: eventType.description ?? null,
    durationMin: eventType.duration_min,
    locationKind: eventType.location_kind,
    // In-person addresses are public (where to come); phone instructions too.
    locationDetail: eventType.location_detail ?? null,
    questions: (eventType.questions ?? []).map((q) => ({ key: q.key, label: q.label, type: q.type, required: Boolean(q.required), options: q.options ?? null, help: q.help ?? null })),
    attendees: {
      ask: Boolean(attendees.ask),
      label: attendees.label ?? 'Who will attend?',
      options: attendees.options ?? [],
      maxGuests: attendees.maxGuests ?? 0,
    },
    horizonDays: eventType.horizon_days,
  };
}

/** The public view of a booking (manage page and confirmation). Shows the invitee's own name only. */
export function presentPublicBooking(row, { eventType, host, branding, now = Date.now() }) {
  const active = ACTIVE_STATUSES.includes(row.status);
  const notStarted = new Date(row.start_at).getTime() > now;
  const token = manageTokenFor(row);
  return {
    id: row.id,
    status: row.status,
    startAt: iso(row.start_at),
    endAt: iso(row.end_at),
    timeZone: row.time_zone,
    inviteeName: row.invitee_name,
    attending: row.attending ?? null,
    eventType: presentPublicEventType(eventType),
    host: host ? { name: host.name } : null,
    location: { kind: row.location_kind, detail: row.location_detail ?? null, meetingUrl: active ? (row.meeting_url ?? null) : null },
    branding,
    rescheduleRequested: Boolean(row.reschedule_requested_at),
    manageToken: token,
    manageUrl: managePageUrl(token),
    icsPath: `/api/v1/public/bookings/${token}/invite.ics`,
    can: { reschedule: active && notStarted, cancel: active && notStarted, requestReschedule: active && notStarted && !row.reschedule_requested_at },
  };
}

export function presentLink(row, { eventType = null, createdBy = null } = {}) {
  const token = linkTokenFor(row);
  const revoked = Boolean(row.revoked_at);
  const expired = row.expires_at ? new Date(row.expires_at).getTime() <= Date.now() : false;
  const usedUp = row.max_uses != null && row.use_count >= row.max_uses;
  return {
    id: row.id,
    kind: row.kind,
    url: bookingPageUrl(token),
    token,
    eventType: eventType ? { id: eventType.id, name: eventType.name, durationMin: eventType.duration_min } : null,
    dealId: row.deal_id ?? null,
    contactId: row.contact_id ?? null,
    expiresAt: iso(row.expires_at),
    maxUses: row.max_uses ?? null,
    useCount: row.use_count,
    lastSentAt: iso(row.last_sent_at),
    revokedAt: iso(row.revoked_at),
    status: revoked ? 'revoked' : expired ? 'expired' : usedUp ? 'used' : 'active',
    createdBy: userRef(createdBy),
    createdAt: iso(row.created_at),
  };
}
