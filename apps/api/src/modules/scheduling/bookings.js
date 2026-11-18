import { db, json } from '../../lib/db.js';
import { AppError, errors } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { writeAudit } from '../../core/audit.js';
import { emitEvent } from '../../core/events.js';
import { getEffectiveSettings } from '../../core/settings.js';
import { addTimelineEvent } from '../../core/crm/timeline.js';
import { findOrCreateContact } from '../../core/crm/contacts.js';
import { normalizePhone } from '../../core/crm/normalize.js';
import { chooseHost, computeReminders, formatInZone, reminderJobId } from '../../core/scheduling/index.js';
import { checkStart, fairnessStats, loadHostRows, lockHosts } from './availability.js';
import { ACTIVE_STATUSES } from './schemas.js';
import { callPort } from './ports.js';
import { managePageUrl, manageTokenFor, newNonce } from './tokens.js';
import { buildInviteFor } from './invites.js';
import {
  attendanceCheckSetting,
  fairnessWindowSetting,
  personalLinkDaysSetting,
  quietHoursEndSetting,
  quietHoursStartSetting,
} from './settings.js';

// Bookings: create (public page and personal links), reschedule, cancel, reassign, outcomes.
// Every write is one transaction with the audit entry, the domain event and the timeline entry;
// meeting links, emails and reminder jobs go through the ports after the commit.

const MINUTE = 60_000;

export const slotTaken = () => new AppError(409, 'slot_unavailable', 'That time was just taken. Pick another time.');
const isExclusionViolation = (err) => err?.code === '23P01';

const SETTING_DEFS = [
  quietHoursStartSetting,
  quietHoursEndSetting,
  fairnessWindowSetting,
  personalLinkDaysSetting,
  attendanceCheckSetting,
  { key: 'branding.primaryColor', default: '#2840D8' },
  { key: 'branding.logoUrl', default: null },
  { key: 'locale.timeZone', default: 'Asia/Kolkata' },
];

/** Settings scheduling reads at a company (one query). */
export async function companySettings(company, trx = db) {
  const resolved = await getEffectiveSettings(company, SETTING_DEFS, trx);
  const value = (key) => resolved[key].value;
  return {
    quietHours: { start: value('scheduling.quietHoursStart'), end: value('scheduling.quietHoursEnd') },
    fairnessWindowDays: value('scheduling.fairnessWindowDays'),
    personalLinkDays: value('scheduling.personalLinkDays'),
    attendanceCheckMinutes: value('scheduling.attendanceCheckMinutes'),
    branding: { color: value('branding.primaryColor'), logoUrl: value('branding.logoUrl') },
    timeZone: value('locale.timeZone') || 'Asia/Kolkata',
  };
}

export const whenLabel = (start, zone) =>
  formatInZone(start, zone, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });

/** Validate the booking page's answers against the event type (422 with body paths). Returns what to store. */
export function checkAnswers(eventType, { answers = {}, attending, guests = [], phone }) {
  const issues = [];
  const stored = {};
  for (const question of eventType.questions ?? []) {
    const value = typeof answers[question.key] === 'string' ? answers[question.key].trim() : '';
    if (!value) {
      if (question.required) issues.push({ path: `body.answers.${question.key}`, message: 'Fill this in' });
      continue;
    }
    if (question.type === 'select' && !(question.options ?? []).some((o) => o.value === value)) {
      issues.push({ path: `body.answers.${question.key}`, message: 'Pick one of the choices' });
      continue;
    }
    if (question.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      issues.push({ path: `body.answers.${question.key}`, message: 'Enter a valid email address' });
      continue;
    }
    stored[question.key] = value.slice(0, 2000);
  }
  const policy = eventType.attendees ?? {};
  if (policy.ask) {
    if (!attending) issues.push({ path: 'body.attending', message: 'Tell us who will attend' });
    else if (!(policy.options ?? []).some((o) => o.value === attending)) issues.push({ path: 'body.attending', message: 'Pick one of the choices' });
  }
  if (guests.length > (policy.maxGuests ?? 0)) issues.push({ path: 'body.guests', message: `Add at most ${policy.maxGuests ?? 0} more people` });
  let phoneE164 = null;
  if (phone) {
    const parsed = normalizePhone(phone, 'IN');
    if (!parsed) issues.push({ path: 'body.phone', message: 'Enter a phone number like +91 98765 43210' });
    else phoneE164 = parsed.e164;
  }
  if (issues.length) throw errors.validation(issues);
  return { answers: stored, attending: policy.ask ? attending : (attending ?? null), phone: phoneE164 };
}

/** Reminder rows for a booking at its current sequence (pure apart from the settings passed in). */
export function planReminders(booking, eventType, { now, quietHours }) {
  const { reminders, skipped } = computeReminders({
    start: new Date(booking.start_at).getTime(),
    now,
    offsetsMin: eventType.reminder_offsets_min ?? [1440, 60],
    timeZone: booking.time_zone,
    quietHours: quietHours ? { ...quietHours, shift: 'auto' } : undefined,
  });
  return {
    rows: reminders.map((r) => ({
      booking_id: booking.id,
      sequence: booking.ics_sequence,
      offset_min: r.offsetMin,
      run_at: new Date(r.at),
      shifted: r.shifted,
      job_id: reminderJobId(booking.id, r.offsetMin, booking.ics_sequence),
    })),
    skipped,
  };
}

/** The jobs the background jobs module should enqueue for reminder rows. */
export function reminderJobs(rows, now = Date.now()) {
  return rows.map((row) => ({
    name: 'scheduling.reminder',
    jobId: row.job_id,
    runAt: new Date(row.run_at).toISOString(),
    delayMs: Math.max(0, new Date(row.run_at).getTime() - now),
    data: { bookingId: row.booking_id, sequence: row.sequence, offsetMin: row.offset_min },
  }));
}

/** The attendance check job for an online booking (fetch attendance when no "meeting ended" arrives). */
export function attendanceJob(booking, minutesAfterEnd, now = Date.now()) {
  if (!['zoom', 'google_meet', 'teams'].includes(booking.location_kind)) return null;
  const runAt = new Date(booking.end_at).getTime() + minutesAfterEnd * MINUTE;
  return {
    name: 'scheduling.attendance_check',
    jobId: `attendance-${booking.id}-s${booking.ics_sequence}`,
    runAt: new Date(runAt).toISOString(),
    delayMs: Math.max(0, runAt - now),
    data: { bookingId: booking.id, sequence: booking.ics_sequence },
  };
}

async function replanReminders(trx, booking, eventType, settings, now) {
  const cancelled = await trx('booking_reminders')
    .where({ booking_id: booking.id, status: 'scheduled' })
    .update({ status: 'cancelled', updated_at: trx.fn.now() })
    .returning('job_id');
  const { rows } = planReminders(booking, eventType, { now, quietHours: settings.quietHours });
  const inserted = rows.length ? await trx('booking_reminders').insert(rows).onConflict(['booking_id', 'sequence', 'offset_min']).ignore().returning('*') : [];
  return { cancelledJobIds: cancelled.map((r) => r.job_id), newRows: inserted };
}

/** Timeline entry for a booking change, on its deal and contact (skipped when it has neither). */
async function bookingTimeline(trx, booking, { action, title, actorType = 'system', actorUserId = null, kind = 'system', meta = {}, body = null }) {
  if (!booking.deal_id && !booking.contact_id) return;
  await addTimelineEvent(trx, {
    groupId: booking.group_id,
    companyId: booking.company_id,
    unitId: booking.unit_id,
    dealId: booking.deal_id,
    contactId: booking.contact_id,
    kind,
    direction: kind === 'meeting' ? 'outbound' : 'internal',
    title: title.slice(0, 300),
    body,
    meta: { action, bookingId: booking.id, eventTypeId: booking.event_type_id, startAt: new Date(booking.start_at).toISOString(), ...meta },
    actorType,
    actorUserId,
    sourceEventId: `${action}:${booking.id}:${booking.ics_sequence}`,
  });
}

/** The payload every booking.* event carries. */
export function bookingPayload(booking, extra = {}) {
  return {
    bookingId: booking.id,
    companyId: booking.company_id,
    unitId: booking.unit_id,
    eventTypeId: booking.event_type_id,
    dealId: booking.deal_id ?? null,
    contactId: booking.contact_id ?? null,
    hostUserId: booking.host_user_id ?? null,
    startAt: new Date(booking.start_at).toISOString(),
    endAt: new Date(booking.end_at).toISOString(),
    status: booking.status,
    source: booking.source,
    ...extra,
  };
}

async function emitBookingEvent(trx, type, booking, { actorUserId = null, extra = {} } = {}) {
  await emitEvent(trx, {
    type,
    groupId: booking.group_id,
    unitId: booking.unit_id,
    aggregateType: 'booking',
    aggregateId: booking.id,
    actorUserId,
    payload: bookingPayload(booking, extra),
  });
}

const auditUnit = (booking) => ({ id: booking.unit_id, root_id: booking.group_id });

/**
 * After a commit: create or update the online meeting, send the invitation (iTIP REQUEST or
 * CANCEL with the right sequence), and hand reminder jobs to the jobs module. Never throws.
 */
export async function afterCommit({ kind, booking, eventType, cancelledJobIds = [], newReminders = [], extraJobs = [], log = logger }) {
  let current = booking;
  try {
    if (kind === 'created' && ['zoom', 'google_meet', 'teams'].includes(booking.location_kind) && !booking.meeting_url) {
      const host = booking.host_user_id ? await db('users').where({ id: booking.host_user_id }).first('id', 'name', 'email') : null;
      const meeting = await callPort('createOnlineMeeting', { booking, eventType, host }, log);
      if (meeting?.url) {
        [current] = await db('bookings')
          .where({ id: booking.id })
          .update({ meeting_url: meeting.url, meeting_provider: meeting.provider ?? booking.location_kind, meeting_ref: meeting.ref ?? null, updated_at: db.fn.now() })
          .returning('*');
        await db('meetings').where({ booking_id: booking.id }).update({ provider_meeting_id: meeting.ref ?? null, updated_at: db.fn.now() });
      }
    } else if ((kind === 'rescheduled' || kind === 'reassigned') && booking.meeting_ref) {
      const host = booking.host_user_id ? await db('users').where({ id: booking.host_user_id }).first('id', 'name', 'email') : null;
      await callPort('updateOnlineMeeting', { booking, eventType, host }, log);
    } else if (kind === 'cancelled' && booking.meeting_ref) {
      await callPort('cancelOnlineMeeting', { booking }, log);
    }

    if (cancelledJobIds.length) await callPort('cancelJobs', cancelledJobIds, log);
    const jobs = [...reminderJobs(newReminders), ...extraJobs.filter(Boolean)];
    if (jobs.length) await callPort('scheduleJobs', jobs, log);

    const messageKind = { created: 'confirmation', rescheduled: 'rescheduled', cancelled: 'cancelled', reassigned: 'reassigned' }[kind];
    if (messageKind) {
      const [host, company] = await Promise.all([
        current.host_user_id ? db('users').where({ id: current.host_user_id }).first('id', 'name', 'email') : null,
        db('org_units').where({ id: current.company_id }).first(),
      ]);
      const { ics, method } = buildInviteFor({ booking: current, eventType, host, company });
      await callPort(
        'sendBookingMessage',
        { kind: messageKind, booking: current, eventType, company, host, ics, icsMethod: method, manageUrl: managePageUrl(manageTokenFor(current)) },
        log,
      );
    }
  } catch (err) {
    log.error({ err, bookingId: booking.id }, 'Scheduling after-commit work failed');
  }
  return current;
}

/**
 * Create a booking from a booking link (public page or personal link). Idempotent on
 * idempotencyKey per link. Runs: host locks → fresh availability check → host choice → contact →
 * insert (the exclusion constraint is the last guard) → reminders, audit, event, timeline.
 */
export async function createBooking({ link, eventType, company, input, now = Date.now(), log = logger }) {
  const startMs = new Date(input.start).getTime();
  const checked = checkAnswers(eventType, input);
  const sourceEventId = input.idempotencyKey ? `public:${link.id}:${input.idempotencyKey}` : null;
  const settings = await companySettings(company);

  const result = await db
    .transaction(async (trx) => {
      if (sourceEventId) {
        const existing = await trx('bookings').where({ source_event_id: sourceEventId }).first();
        if (existing) return { booking: existing, replay: true };
      }
      const lockedLink = await trx('scheduling_booking_links').where({ id: link.id }).forUpdate().first();
      if (!lockedLink || lockedLink.revoked_at) throw errors.notFound('Booking link');
      if (lockedLink.max_uses != null && lockedLink.use_count >= lockedLink.max_uses) {
        throw new AppError(410, 'link_used', 'This booking link has already been used. Ask for a new one.');
      }

      const hostRows = await loadHostRows(eventType, trx);
      await lockHosts(
        trx,
        hostRows.map((h) => h.user_id),
      );
      const check = await checkStart(eventType, startMs, { now, trx, log });
      if (!check.available || check.hostIds.length === 0) throw slotTaken();

      const deal = lockedLink.deal_id ? await trx('deals').where({ id: lockedLink.deal_id }).first() : null;
      const preferredHostIds = [lockedLink.preferred_host_user_id, deal?.owner_user_id].filter(Boolean);
      const stats = await fairnessStats(eventType.id, check.hostIds, { windowDays: settings.fairnessWindowDays, now, trx });
      const choice = chooseHost({
        candidateIds: check.hostIds,
        hosts: check.hostRows.map((h) => ({
          id: h.user_id,
          weight: h.weight,
          priority: h.priority,
          bookingCount: stats.get(h.user_id)?.count ?? 0,
          lastBookedAt: stats.get(h.user_id)?.lastAt ? new Date(stats.get(h.user_id).lastAt).getTime() : null,
          languages: h.languages ?? [],
          timeZone: h.time_zone,
        })),
        slotStart: startMs,
        preferredHostIds,
        fallback: 'round_robin',
      });
      if (!choice.hostId) throw slotTaken();

      let contactId = lockedLink.contact_id ?? deal?.primary_contact_id ?? null;
      if (!contactId) {
        const { contact } = await findOrCreateContact(
          trx,
          {
            groupId: eventType.group_id,
            companyId: eventType.company_id,
            unitId: eventType.unit_id,
            fullName: input.name,
            emails: [input.email],
            phones: checked.phone ? [checked.phone] : [],
            timeZone: input.timeZone,
            ownerUserId: choice.hostId,
            source: { channel: 'website_form', landingUrl: undefined },
            actorType: 'system',
            invalidMethods: 'skip',
          },
          { req: null },
        );
        contactId = contact.id;
      }

      const unitId = deal?.unit_id ?? lockedLink.unit_id ?? eventType.unit_id;
      const [booking] = await trx('bookings')
        .insert({
          group_id: eventType.group_id,
          company_id: eventType.company_id,
          unit_id: unitId,
          event_type_id: eventType.id,
          booking_link_id: lockedLink.id,
          deal_id: deal?.id ?? null,
          contact_id: contactId,
          host_user_id: choice.hostId,
          owner_user_id: deal?.owner_user_id ?? null,
          status: 'booked',
          start_at: new Date(startMs),
          end_at: new Date(startMs + eventType.duration_min * MINUTE),
          buffer_before_min: eventType.buffer_before_min,
          buffer_after_min: eventType.buffer_after_min,
          time_zone: input.timeZone,
          invitee_name: input.name,
          invitee_email: input.email,
          invitee_phone: checked.phone,
          attending: checked.attending,
          guests: json(input.guests ?? []),
          answers: json(checked.answers),
          notes: input.notes ?? null,
          location_kind: eventType.location_kind,
          location_detail: eventType.location_detail ?? null,
          token_nonce: newNonce(),
          source: lockedLink.kind === 'personal' ? 'personal_link' : 'booking_page',
          assignment_reason: choice.explanation?.slice(0, 500) ?? choice.reason,
          source_event_id: sourceEventId,
        })
        .returning('*');
      await trx('meetings').insert({
        booking_id: booking.id,
        group_id: booking.group_id,
        company_id: booking.company_id,
        provider: booking.location_kind,
        threshold_min: eventType.attendance_threshold_min,
      });
      await trx('scheduling_booking_links')
        .where({ id: lockedLink.id })
        .update({ use_count: trx.raw('use_count + 1'), updated_at: trx.fn.now() });
      const { rows } = planReminders(booking, eventType, { now, quietHours: settings.quietHours });
      const reminders = rows.length ? await trx('booking_reminders').insert(rows).returning('*') : [];

      await writeAudit(trx, null, {
        action: 'booking.created',
        entityType: 'booking',
        entityId: booking.id,
        unit: auditUnit(booking),
        actorType: 'contact',
        after: { eventTypeId: eventType.id, startAt: booking.start_at, hostUserId: booking.host_user_id, dealId: booking.deal_id, source: booking.source },
      });
      await emitBookingEvent(trx, 'booking.created', booking, { extra: { assignmentReason: choice.reason, bookingLinkId: lockedLink.id } });
      await bookingTimeline(trx, booking, {
        action: 'booking.created',
        title: `Booked: ${eventType.name}, ${whenLabel(startMs, settings.timeZone)}`,
        actorType: 'contact',
        meta: { hostUserId: booking.host_user_id, locationKind: booking.location_kind },
      });
      return { booking, reminders, replay: false };
    })
    .catch((err) => {
      if (isExclusionViolation(err)) throw slotTaken();
      throw err;
    });

  if (result.replay) return result.booking;
  return afterCommit({
    kind: 'created',
    booking: result.booking,
    eventType,
    newReminders: result.reminders,
    extraJobs: [attendanceJob(result.booking, settings.attendanceCheckMinutes)],
    log,
  });
}

/**
 * Move an active booking (the invitee from the manage link, or staff). Keeps the host when they're
 * free at the new time, otherwise picks another free host. Bumps the ICS sequence.
 */
export async function rescheduleBooking({ bookingId, startMs, timeZone = null, actor, req = null, now = Date.now(), log = logger }) {
  const result = await db
    .transaction(async (trx) => {
      const booking = await trx('bookings').where({ id: bookingId }).forUpdate().first();
      if (!booking) throw errors.notFound('Booking');
      if (!ACTIVE_STATUSES.includes(booking.status)) throw errors.conflict('This booking is no longer active');
      if (actor === 'invitee' && new Date(booking.start_at).getTime() <= now) throw errors.conflict('This meeting has already started');
      if (startMs === new Date(booking.start_at).getTime()) throw errors.conflict('That is the current time of the booking');
      if (startMs <= now) throw slotTaken();
      const eventType = await trx('scheduling_event_types').where({ id: booking.event_type_id }).first();
      const company = await trx('org_units').where({ id: booking.company_id }).first();
      const settings = await companySettings(company, trx);

      const hostRows = await loadHostRows(eventType, trx);
      await lockHosts(trx, [...hostRows.map((h) => h.user_id), booking.host_user_id].filter(Boolean));
      // Staff may move a booking inside the minimum notice; the visitor may not.
      const checkNow = actor === 'staff' ? Math.min(now, startMs - eventType.min_notice_min * MINUTE) : now;
      const check = await checkStart(eventType, startMs, { now: checkNow, excludeBookingId: booking.id, trx, log });
      if (!check.available || check.hostIds.length === 0) throw slotTaken();

      let hostId = booking.host_user_id;
      let reason = booking.assignment_reason;
      if (!check.hostIds.includes(hostId)) {
        const stats = await fairnessStats(eventType.id, check.hostIds, { windowDays: settings.fairnessWindowDays, now, trx });
        const choice = chooseHost({
          candidateIds: check.hostIds,
          hosts: check.hostRows.map((h) => ({
            id: h.user_id,
            weight: h.weight,
            priority: h.priority,
            bookingCount: stats.get(h.user_id)?.count ?? 0,
            languages: h.languages ?? [],
          })),
          slotStart: startMs,
          preferredHostIds: [booking.owner_user_id].filter(Boolean),
          fallback: 'round_robin',
        });
        if (!choice.hostId) throw slotTaken();
        hostId = choice.hostId;
        reason = `Rescheduled: ${choice.explanation ?? choice.reason}`.slice(0, 500);
      }

      const [after] = await trx('bookings')
        .where({ id: booking.id })
        .update({
          start_at: new Date(startMs),
          end_at: new Date(startMs + eventType.duration_min * MINUTE),
          buffer_before_min: eventType.buffer_before_min,
          buffer_after_min: eventType.buffer_after_min,
          status: 'rescheduled',
          host_user_id: hostId,
          assignment_reason: reason,
          time_zone: timeZone ?? booking.time_zone,
          ics_sequence: booking.ics_sequence + 1,
          reschedule_count: booking.reschedule_count + 1,
          reschedule_requested_at: null,
          reschedule_request_note: null,
          updated_at: trx.fn.now(),
        })
        .returning('*');
      const plan = await replanReminders(trx, after, eventType, settings, now);

      await writeAudit(trx, req, {
        action: 'booking.rescheduled',
        entityType: 'booking',
        entityId: booking.id,
        unit: auditUnit(after),
        actorType: req ? undefined : 'contact',
        before: { startAt: booking.start_at, hostUserId: booking.host_user_id },
        after: { startAt: after.start_at, hostUserId: after.host_user_id },
      });
      await emitBookingEvent(trx, 'booking.rescheduled', after, {
        actorUserId: req?.auth?.user?.id ?? null,
        extra: {
          fromStartAt: new Date(booking.start_at).toISOString(),
          fromHostUserId: booking.host_user_id,
          by: actor,
        },
      });
      await bookingTimeline(trx, after, {
        action: 'booking.rescheduled',
        title: `Rescheduled: ${eventType.name}, now ${whenLabel(startMs, settings.timeZone)}`,
        actorType: req ? 'user' : 'contact',
        actorUserId: req?.auth?.user?.id ?? null,
        meta: { fromStartAt: new Date(booking.start_at).toISOString() },
      });
      return { booking: after, eventType, settings, plan };
    })
    .catch((err) => {
      if (isExclusionViolation(err)) throw slotTaken();
      throw err;
    });

  return afterCommit({
    kind: 'rescheduled',
    booking: result.booking,
    eventType: result.eventType,
    cancelledJobIds: [...result.plan.cancelledJobIds, `attendance-${result.booking.id}-s${result.booking.ics_sequence - 1}`],
    newReminders: result.plan.newRows,
    extraJobs: [attendanceJob(result.booking, result.settings.attendanceCheckMinutes)],
    log,
  });
}

export async function cancelBooking({ bookingId, reason = null, actor, req = null, now = Date.now(), log = logger }) {
  const result = await db.transaction(async (trx) => {
    const booking = await trx('bookings').where({ id: bookingId }).forUpdate().first();
    if (!booking) throw errors.notFound('Booking');
    if (!ACTIVE_STATUSES.includes(booking.status)) throw errors.conflict('This booking is no longer active');
    if (actor === 'invitee' && new Date(booking.start_at).getTime() <= now) throw errors.conflict('This meeting has already started');
    const eventType = await trx('scheduling_event_types').where({ id: booking.event_type_id }).first();
    const [after] = await trx('bookings')
      .where({ id: booking.id })
      .update({
        status: 'cancelled',
        cancelled_at: trx.fn.now(),
        cancelled_by: actor === 'invitee' ? 'invitee' : 'host',
        cancel_reason: reason,
        ics_sequence: booking.ics_sequence + 1,
        updated_at: trx.fn.now(),
      })
      .returning('*');
    const cancelled = await trx('booking_reminders')
      .where({ booking_id: booking.id, status: 'scheduled' })
      .update({ status: 'cancelled', updated_at: trx.fn.now() })
      .returning('job_id');
    await writeAudit(trx, req, {
      action: 'booking.cancelled',
      entityType: 'booking',
      entityId: booking.id,
      unit: auditUnit(after),
      actorType: req ? undefined : 'contact',
      after: { status: 'cancelled', by: after.cancelled_by },
    });
    await emitBookingEvent(trx, 'booking.cancelled', after, {
      actorUserId: req?.auth?.user?.id ?? null,
      extra: { by: after.cancelled_by, reason: reason ?? null },
    });
    const company = await trx('org_units').where({ id: booking.company_id }).first();
    const settings = await companySettings(company, trx);
    await bookingTimeline(trx, after, {
      action: 'booking.cancelled',
      title: `Cancelled${after.cancelled_by === 'invitee' ? ' by the family' : ''}: ${eventType.name}, ${whenLabel(after.start_at, settings.timeZone)}`,
      body: reason,
      actorType: req ? 'user' : 'contact',
      actorUserId: req?.auth?.user?.id ?? null,
    });
    return { booking: after, eventType, cancelledJobIds: cancelled.map((r) => r.job_id) };
  });
  return afterCommit({
    kind: 'cancelled',
    booking: result.booking,
    eventType: result.eventType,
    cancelledJobIds: [...result.cancelledJobIds, `attendance-${result.booking.id}-s${result.booking.ics_sequence - 1}`],
    log,
  });
}

/** The visitor can't find a time: flag the booking so the team calls them (Bookings › Reschedule requests). */
export async function requestReschedule({ bookingId, note = null, now = Date.now() }) {
  return db.transaction(async (trx) => {
    const booking = await trx('bookings').where({ id: bookingId }).forUpdate().first();
    if (!booking) throw errors.notFound('Booking');
    if (!ACTIVE_STATUSES.includes(booking.status) || new Date(booking.start_at).getTime() <= now) throw errors.conflict('This booking can no longer be changed');
    if (booking.reschedule_requested_at) return booking;
    const [after] = await trx('bookings')
      .where({ id: booking.id })
      .update({ reschedule_requested_at: trx.fn.now(), reschedule_request_note: note, updated_at: trx.fn.now() })
      .returning('*');
    await writeAudit(trx, null, { action: 'booking.reschedule_requested', entityType: 'booking', entityId: booking.id, unit: auditUnit(after), actorType: 'contact' });
    await emitBookingEvent(trx, 'booking.reschedule_requested', after, { extra: { note: note ?? null } });
    await bookingTimeline(trx, after, {
      action: 'booking.reschedule_requested',
      title: 'Asked for another time',
      body: note,
      actorType: 'contact',
      meta: {},
    });
    return after;
  });
}

/** Give a booking to another host of the event type who is free at that time (scheduling.assign). */
export async function reassignBooking({ req, booking: visible, hostUserId, now = Date.now(), log = logger }) {
  const result = await db
    .transaction(async (trx) => {
      const booking = await trx('bookings').where({ id: visible.id }).forUpdate().first();
      if (!ACTIVE_STATUSES.includes(booking.status)) throw errors.conflict('This booking is no longer active');
      if (booking.host_user_id === hostUserId) throw errors.conflict('This person already hosts the booking');
      const eventType = await trx('scheduling_event_types').where({ id: booking.event_type_id }).first();
      const hostRows = await loadHostRows(eventType, trx);
      if (!hostRows.some((h) => h.user_id === hostUserId)) {
        throw errors.validation([{ path: 'body.hostUserId', message: 'Pick an active host of this event type (with saved availability)' }]);
      }
      await lockHosts(trx, [hostUserId]);
      const startMs = new Date(booking.start_at).getTime();
      const check = await checkStart(eventType, startMs, {
        now: Math.min(now, startMs - eventType.min_notice_min * MINUTE),
        excludeBookingId: booking.id,
        onlyHostIds: [hostUserId],
        trx,
        log,
      });
      if (!check.available) throw new AppError(409, 'host_unavailable', 'That person is not free at this time');
      const actor = await trx('users').where({ id: req.auth.user.id }).first('name');
      const [after] = await trx('bookings')
        .where({ id: booking.id })
        .update({
          host_user_id: hostUserId,
          assignment_reason: `Reassigned by ${actor?.name ?? 'a manager'}`,
          ics_sequence: booking.ics_sequence + 1,
          updated_at: trx.fn.now(),
        })
        .returning('*');
      const company = await trx('org_units').where({ id: booking.company_id }).first();
      const settings = await companySettings(company, trx);
      const plan = await replanReminders(trx, after, eventType, settings, now);
      await writeAudit(trx, req, {
        action: 'booking.reassigned',
        entityType: 'booking',
        entityId: booking.id,
        unit: auditUnit(after),
        before: { hostUserId: booking.host_user_id },
        after: { hostUserId },
      });
      await emitBookingEvent(trx, 'booking.reassigned', after, { actorUserId: req.auth.user.id, extra: { fromHostUserId: booking.host_user_id, toHostUserId: hostUserId } });
      const host = await trx('users').where({ id: hostUserId }).first('name');
      await bookingTimeline(trx, after, {
        action: 'booking.reassigned',
        title: `${eventType.name} now with ${host?.name ?? 'another host'}`,
        actorType: 'user',
        actorUserId: req.auth.user.id,
      });
      return { booking: after, eventType, settings, plan };
    })
    .catch((err) => {
      if (isExclusionViolation(err)) throw new AppError(409, 'host_unavailable', 'That person is not free at this time');
      throw err;
    });
  return afterCommit({
    kind: 'reassigned',
    booking: result.booking,
    eventType: result.eventType,
    cancelledJobIds: result.plan.cancelledJobIds,
    newReminders: result.plan.newRows,
    log,
  });
}

/**
 * Record the outcome of a booking (shared by the attendance ingestion and the manual buttons):
 * completed → booking.attended, no_show → booking.no_show. Does nothing when the booking is no
 * longer active, so a retried webhook or a second click emits nothing twice.
 * @returns {Promise<object | null>} the updated booking, or null when nothing changed
 */
export async function recordOutcome(trx, booking, { outcome, source, inviteeSeconds = null, hostSeconds = null, actorUserId = null, req = null, note = null }) {
  if (!ACTIVE_STATUSES.includes(booking.status)) return null;
  const status = outcome === 'attended' ? 'completed' : 'no_show';
  const [after] = await trx('bookings')
    .where({ id: booking.id })
    .whereIn('status', ACTIVE_STATUSES)
    .update({
      status,
      completed_at: status === 'completed' ? trx.fn.now() : null,
      no_show_at: status === 'no_show' ? trx.fn.now() : null,
      updated_at: trx.fn.now(),
    })
    .returning('*');
  if (!after) return null;
  const meetingUpdate = { result: outcome, evaluated_at: trx.fn.now(), updated_at: trx.fn.now() };
  if (inviteeSeconds !== null) meetingUpdate.invitee_seconds = inviteeSeconds;
  if (hostSeconds !== null) meetingUpdate.host_seconds = hostSeconds;
  const [meeting] = await trx('meetings').where({ booking_id: booking.id }).update(meetingUpdate).returning('*');
  await trx('booking_reminders').where({ booking_id: booking.id, status: 'scheduled' }).update({ status: 'cancelled', updated_at: trx.fn.now() });

  const type = outcome === 'attended' ? 'booking.attended' : 'booking.no_show';
  await writeAudit(trx, req, {
    action: type,
    entityType: 'booking',
    entityId: booking.id,
    unit: auditUnit(after),
    actorUserId,
    after: { status, source, inviteeSeconds },
    meta: note ? { note } : undefined,
  });
  await emitBookingEvent(trx, type, after, {
    actorUserId,
    extra: { source, inviteeSeconds: meeting?.invitee_seconds ?? inviteeSeconds, thresholdMin: meeting?.threshold_min ?? null },
  });
  const eventType = await trx('scheduling_event_types').where({ id: booking.event_type_id }).first('name');
  const minutes = inviteeSeconds !== null ? Math.round(inviteeSeconds / 60) : null;
  await bookingTimeline(trx, after, {
    action: type,
    kind: outcome === 'attended' ? 'meeting' : 'system',
    title: outcome === 'attended' ? `Attended: ${eventType?.name ?? 'meeting'}${minutes !== null ? ` (${minutes} min)` : ''}` : `No-show: ${eventType?.name ?? 'meeting'}`,
    body: note,
    actorType: actorUserId ? 'user' : 'system',
    actorUserId,
    meta: { source, durationSeconds: inviteeSeconds ?? undefined },
  });
  return after;
}

/** Staff marks a booking that has started as attended or a no-show. */
export async function markOutcome({ req, bookingId, outcome, note = null, now = Date.now() }) {
  return db.transaction(async (trx) => {
    const booking = await trx('bookings').where({ id: bookingId }).forUpdate().first();
    if (!ACTIVE_STATUSES.includes(booking.status)) throw errors.conflict('This booking already has an outcome');
    if (new Date(booking.start_at).getTime() > now) throw errors.conflict('The meeting has not started yet');
    return recordOutcome(trx, booking, { outcome, source: 'manual', actorUserId: req.auth.user.id, req, note });
  });
}
