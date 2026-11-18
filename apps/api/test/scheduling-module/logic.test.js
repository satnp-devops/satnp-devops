import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccessContext } from '../../src/core/accessContext.js';
import { generateSlots, parseContentLines, unfold } from '../../src/core/scheduling/index.js';
import { bookingLevel } from '../../src/modules/scheduling/access.js';
import { buildEngineHosts, engineEventType } from '../../src/modules/scheduling/availability.js';
import { attendanceJob, checkAnswers, planReminders, reminderJobs } from '../../src/modules/scheduling/bookings.js';
import { buildInviteFor } from '../../src/modules/scheduling/invites.js';
import { brandingOf, presentBooking } from '../../src/modules/scheduling/present.js';
import { availabilityBody, createEventTypeBody, publicBookBody, slotsQuery } from '../../src/modules/scheduling/schemas.js';

const MINUTE = 60_000;

// ---------- Engine glue ----------

test('bookings count against the daily limit on the host-local date', () => {
  const hosts = buildEngineHosts({
    eventTypeId: 'et',
    hostRows: [{ user_id: 'kabir', time_zone: 'Asia/Kolkata', weekly: { mon: ['09:00-17:00'] }, overrides: {} }],
    bookings: [
      // 19:00 UTC on Monday is 00:30 Tuesday in India.
      { host_user_id: 'kabir', event_type_id: 'et', start_at: '2026-11-09T19:00:00Z', end_at: '2026-11-09T19:30:00Z', buffer_before_min: 0, buffer_after_min: 15 },
      // Another event type blocks time but doesn't count.
      { host_user_id: 'kabir', event_type_id: 'other', start_at: '2026-11-09T05:00:00Z', end_at: '2026-11-09T05:30:00Z' },
      { host_user_id: 'ritika', event_type_id: 'et', start_at: '2026-11-09T06:00:00Z', end_at: '2026-11-09T06:30:00Z' },
    ],
    external: [{ userId: 'kabir', start: '2026-11-09T08:00:00Z', end: '2026-11-09T09:00:00Z' }, { userId: 'kabir', start: '2026-11-09T10:00:00Z', end: '2026-11-09T09:00:00Z' }],
  });
  assert.equal(hosts.length, 1);
  assert.deepEqual(hosts[0].bookedCountByDate, { '2026-11-10': 1 });
  assert.equal(hosts[0].busy.length, 3, 'own bookings and valid external intervals');
  assert.equal(hosts[0].busy[0].bufferAfterMin, 15, 'the booking keeps its own buffers');
});

test('event type rows map to engine input and busy time blocks slots', () => {
  const eventType = engineEventType({ duration_min: 30, slot_interval_min: null, buffer_before_min: 0, buffer_after_min: 10, min_notice_min: 0, max_per_day: null, horizon_days: 30, align_time_zone: null });
  assert.equal(eventType.slotIntervalMin, undefined, 'null interval = the duration');
  const hosts = buildEngineHosts({
    eventTypeId: 'et',
    hostRows: [{ user_id: 'kabir', time_zone: 'Asia/Kolkata', weekly: { tue: ['10:00-12:00'] }, overrides: {} }],
    bookings: [{ host_user_id: 'kabir', event_type_id: 'et', start_at: '2026-11-10T05:30:00Z', end_at: '2026-11-10T06:00:00Z', buffer_before_min: 0, buffer_after_min: 10 }],
  });
  const slots = generateSlots({ eventType, hosts, range: { from: '2026-11-10T00:00:00Z', to: '2026-11-11T00:00:00Z' }, now: Date.parse('2026-11-01T00:00:00Z') });
  // A booking 11:00–11:30 IST with 10 minutes after it; new slots also need 10 minutes after them.
  const starts = slots.map((s) => s.start);
  assert.ok(starts.includes('2026-11-10T04:30:00.000Z'), '10:00 IST is free (its buffer ends 10:40)');
  assert.ok(!starts.includes('2026-11-10T05:00:00.000Z'), '10:30 IST: its own buffer runs into the booking');
  assert.ok(!starts.includes('2026-11-10T05:30:00.000Z'), '11:00 IST is booked');
  assert.ok(!starts.includes('2026-11-10T06:00:00.000Z'), "11:30 IST is inside the booking's buffer");
});

// ---------- Booking page answers ----------

const eventType = {
  questions: [
    { key: 'grade', label: 'Grade', type: 'select', required: true, options: [{ value: '11', label: '11' }, { value: '12', label: '12' }] },
    { key: 'school', label: 'School', type: 'text', required: false },
    { key: 'alt_email', label: 'Other email', type: 'email', required: false },
  ],
  attendees: { ask: true, options: [{ value: 'parent', label: 'Parent' }, { value: 'both', label: 'Both' }], maxGuests: 1 },
};

test('answers are checked against the event type', () => {
  const ok = checkAnswers(eventType, { answers: { grade: '12', school: '  DPS  ', unknown: 'dropped' }, attending: 'both', guests: [{ name: 'A' }], phone: '98765 43210' });
  assert.deepEqual(ok.answers, { grade: '12', school: 'DPS' });
  assert.equal(ok.attending, 'both');
  assert.equal(ok.phone, '+919876543210');

  const paths = (input) => {
    try {
      checkAnswers(eventType, input);
      return [];
    } catch (err) {
      assert.equal(err.status, 422);
      return err.details.map((d) => d.path);
    }
  };
  assert.deepEqual(paths({ answers: {}, attending: 'parent' }), ['body.answers.grade']);
  assert.deepEqual(paths({ answers: { grade: '9' }, attending: 'parent' }), ['body.answers.grade']);
  assert.deepEqual(paths({ answers: { grade: '11', alt_email: 'nope' }, attending: 'parent' }), ['body.answers.alt_email']);
  assert.deepEqual(paths({ answers: { grade: '11' } }), ['body.attending']);
  assert.deepEqual(paths({ answers: { grade: '11' }, attending: 'cousin' }), ['body.attending']);
  assert.deepEqual(paths({ answers: { grade: '11' }, attending: 'parent', guests: [{ name: 'A' }, { name: 'B' }] }), ['body.guests']);
  assert.deepEqual(paths({ answers: { grade: '11' }, attending: 'parent', phone: '12' }), ['body.phone']);
});

test('input schemas refuse naive times, bad zones and oversized ranges', () => {
  const book = { start: '2026-11-10T10:00:00+05:30', timeZone: 'asia/calcutta', name: 'Priya', email: 'p@example.com' };
  assert.equal(publicBookBody.parse(book).timeZone, 'Asia/Kolkata');
  assert.equal(publicBookBody.safeParse({ ...book, start: '2026-11-10T10:00:00' }).success, false);
  assert.equal(publicBookBody.safeParse({ ...book, timeZone: 'IST' }).success, false);
  assert.equal(publicBookBody.safeParse({ ...book, extra: 1 }).success, false, 'unknown fields are refused');
  assert.equal(slotsQuery.safeParse({ from: '2026-11-10', to: '2026-11-09', timeZone: 'UTC' }).success, false);
  assert.equal(slotsQuery.safeParse({ from: '2026-11-01', to: '2026-12-31', timeZone: 'UTC' }).success, false);
  assert.equal(availabilityBody.safeParse({ timeZone: 'Asia/Kolkata', weekly: { mon: ['09:00-17:00'] }, overrides: { '2026-11-14': 'unavailable', '2026-11-15': ['10:00-12:00'] } }).success, true);
  assert.equal(availabilityBody.safeParse({ timeZone: 'Asia/Kolkata', weekly: { funday: [] } }).success, false);
  assert.equal(availabilityBody.safeParse({ timeZone: 'Asia/Kolkata', weekly: {}, overrides: { tomorrow: [] } }).success, false);
  const base = { unitId: '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b', name: 'Call', slug: 'call', durationMin: 30, locationKind: 'zoom' };
  assert.equal(createEventTypeBody.safeParse(base).success, true);
  assert.equal(createEventTypeBody.safeParse({ ...base, locationKind: 'skype' }).success, false);
  assert.equal(createEventTypeBody.safeParse({ ...base, hosts: [{ userId: base.unitId }, { userId: base.unitId }] }).success, false, 'each host once');
  assert.equal(createEventTypeBody.safeParse({ ...base, questions: [{ key: 'q', label: 'Q', type: 'select' }] }).success, false, 'select needs choices');
});

// ---------- Reminders and jobs ----------

test('reminders respect quiet hours in the invitee zone and carry the sequence in their job ids', () => {
  const booking = { id: 'b1', ics_sequence: 2, time_zone: 'Asia/Kolkata', start_at: '2026-11-11T03:30:00Z' }; // 09:00 IST
  const now = Date.parse('2026-11-08T00:00:00Z');
  const { rows } = planReminders(booking, { reminder_offsets_min: [1440, 60] }, { now, quietHours: { start: '21:00', end: '08:00' } });
  assert.equal(rows.length, 2);
  const hourBefore = rows.find((r) => r.offset_min === 60);
  // 08:00 IST would be the boundary; 60 minutes before 09:00 is 08:00 exactly (allowed).
  assert.equal(hourBefore.run_at.toISOString(), '2026-11-11T02:30:00.000Z');
  assert.equal(hourBefore.job_id, 'reminder-b1-s2-m60');
  const jobs = reminderJobs(rows, now);
  assert.equal(jobs[0].name, 'scheduling.reminder');
  assert.deepEqual(jobs[0].data, { bookingId: 'b1', sequence: 2, offsetMin: rows[0].offset_min });
  assert.ok(jobs.every((j) => j.delayMs > 0));

  const late = planReminders(booking, { reminder_offsets_min: [1440, 60] }, { now: Date.parse('2026-11-10T20:00:00Z') });
  assert.deepEqual(late.rows.map((r) => r.offset_min), [60], 'the 24-hour reminder is already past');
});

test('attendance checks only for online meetings', () => {
  assert.equal(attendanceJob({ id: 'b', ics_sequence: 0, location_kind: 'phone', end_at: '2026-11-10T10:00:00Z' }, 30), null);
  const job = attendanceJob({ id: 'b', ics_sequence: 1, location_kind: 'zoom', end_at: '2026-11-10T10:00:00Z' }, 30, Date.parse('2026-11-10T09:00:00Z'));
  assert.equal(job.jobId, 'attendance-b-s1');
  assert.equal(job.delayMs, 90 * MINUTE);
});

// ---------- Invitations ----------

const icsBooking = {
  id: '5e1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b',
  ics_uid: '7d0c4b8e-1f2a-4c3d-9e8f-0a1b2c3d4e5f',
  ics_sequence: 0,
  status: 'booked',
  start_at: '2026-11-10T04:30:00Z',
  end_at: '2026-11-10T05:00:00Z',
  invitee_name: 'Priya, "Mom"; Sharma',
  invitee_email: 'priya@example.com',
  guests: [{ name: 'Aarav', email: 'aarav@example.com' }, { name: 'No email' }, { name: 'Dup', email: 'PRIYA@example.com' }],
  location_kind: 'zoom',
  meeting_url: 'https://zoom.us/j/91234567890',
  token_nonce: 'a1b2c3d4e5f6',
};

test('invitations: REQUEST while active, CANCEL once cancelled, guests included once', () => {
  const { ics, method } = buildInviteFor({ booking: icsBooking, eventType: { name: 'SAT counselling call' }, host: { name: 'Kabir', email: 'kabir@phoenix.test' }, company: { name: 'SatnPaper', profile: {} } });
  assert.equal(method, 'REQUEST');
  const lines = parseContentLines(ics);
  assert.equal(lines.filter((l) => l.name === 'ATTENDEE').length, 2);
  assert.ok(unfold(ics).includes('ORGANIZER;CN=Kabir:mailto:kabir@phoenix.test'));
  assert.ok(unfold(ics).includes('DTSTART:20261110T043000Z'));
  assert.ok(unfold(ics).includes('/book/manage/'), 'the manage link is in the description');

  const cancelled = buildInviteFor({ booking: { ...icsBooking, status: 'cancelled', ics_sequence: 1 }, eventType: { name: 'Call' }, company: { name: 'SatnPaper' } });
  assert.equal(cancelled.method, 'CANCEL');
  assert.match(cancelled.ics, /STATUS:CANCELLED/);
  assert.match(cancelled.ics, /SEQUENCE:1\r\n/);
  assert.ok(!unfold(cancelled.ics).includes('/book/manage/'));

  assert.equal(buildInviteFor({ booking: { ...icsBooking, invitee_email: null, guests: [] }, eventType: { name: 'Call' } }).ics, null, 'nobody to invite');
});

// ---------- Access and presentation ----------

const unit = (id, type, path) => ({ id, type, path, root_id: 'g', name: id, status: 'active' });
const UNITS = new Map([unit('g', 'group', '/g/'), unit('sp', 'company', '/g/sp/'), unit('online', 'branch', '/g/sp/online/'), unit('sat', 'team', '/g/sp/online/sat/'), unit('pv', 'company', '/g/pv/')].map((u) => [u.id, u]));
const ritika = new AccessContext({ userId: 'ritika', assignments: [{ unitPath: '/g/sp/online/sat/', groupId: 'g', permissions: ['scheduling.view:own', 'scheduling.manage:own', 'deals.view:own'] }] });
const kabir = new AccessContext({ userId: 'kabir', assignments: [{ unitPath: '/g/sp/online/', groupId: 'g', permissions: ['scheduling.view', 'scheduling.manage', 'scheduling.assign', 'contacts.view_pii', 'deals.view'] }] });
const pvAdmin = new AccessContext({ userId: 'pv', assignments: [{ unitPath: '/g/pv/', groupId: 'g', permissions: ['scheduling.view', 'scheduling.manage', 'contacts.view_pii'] }] });
const row = (extra) => ({ id: 'b', unit_id: 'sat', company_id: 'sp', group_id: 'g', status: 'booked', start_at: '2026-11-10T04:30:00Z', end_at: '2026-11-10T05:00:00Z', ...extra });

test('booking levels: own = host or deal owner; other companies see nothing', () => {
  assert.equal(bookingLevel(ritika, UNITS, 'scheduling.view', row({ host_user_id: 'ritika' }), 'ritika'), 'own');
  assert.equal(bookingLevel(ritika, UNITS, 'scheduling.view', row({ host_user_id: 'kabir', owner_user_id: 'ritika' }), 'ritika'), 'own');
  assert.equal(bookingLevel(ritika, UNITS, 'scheduling.view', row({ host_user_id: 'kabir', owner_user_id: 'kabir' }), 'ritika'), null);
  // A company-wide event type hosted by the counsellor: the booking sits above her team.
  assert.equal(bookingLevel(ritika, UNITS, 'scheduling.view', row({ unit_id: 'sp', host_user_id: 'ritika' }), 'ritika'), 'own');
  assert.equal(bookingLevel(ritika, UNITS, 'scheduling.assign', row({ host_user_id: 'ritika' }), 'ritika'), null);
  assert.equal(bookingLevel(kabir, UNITS, 'scheduling.view', row({ host_user_id: 'ritika' }), 'kabir'), 'all');
  assert.equal(bookingLevel(pvAdmin, UNITS, 'scheduling.view', row({ host_user_id: 'ritika' }), 'pv'), null);
  assert.equal(bookingLevel(pvAdmin, UNITS, 'scheduling.view', row({ host_user_id: 'pv' }), 'pv'), null, 'hosting does not cross companies');
});

test('personal details are masked unless the viewer may see them or hosts the booking', () => {
  const booking = row({ host_user_id: 'ritika', owner_user_id: 'ritika', invitee_name: 'Priya', invitee_email: 'priya.sharma@example.com', invitee_phone: '+919876543210', guests: [{ name: 'A', email: 'aarav@example.com' }], location_kind: 'zoom', event_type_id: 'et', source: 'booking_page', reschedule_count: 0 });
  const rel = { users: new Map(), eventTypes: new Map(), deals: new Map(), contacts: new Map(), meetings: new Map() };
  const analyst = new AccessContext({ userId: 'ana', assignments: [{ unitPath: '/g/', groupId: 'g', permissions: ['scheduling.view'] }] });
  const masked = presentBooking(booking, rel, { access: analyst, unitsById: UNITS, userId: 'ana', now: Date.parse('2026-11-01T00:00:00Z') });
  assert.equal(masked.invitee.piiMasked, true);
  assert.notEqual(masked.invitee.email, booking.invitee_email);
  assert.notEqual(masked.guests[0].email, 'aarav@example.com');
  assert.equal(masked.can.manage, false);
  const host = presentBooking(booking, rel, { access: ritika, unitsById: UNITS, userId: 'ritika', now: Date.parse('2026-11-01T00:00:00Z') });
  assert.equal(host.invitee.email, booking.invitee_email);
  assert.equal(host.can.reschedule, true);
  assert.equal(host.can.assign, false);
  assert.equal(host.can.markOutcome, false, 'not started yet');
  const manager = presentBooking(booking, rel, { access: kabir, unitsById: UNITS, userId: 'kabir', now: Date.parse('2026-11-10T04:40:00Z') });
  assert.equal(manager.live, true);
  assert.equal(manager.can.assign, true);
  assert.equal(manager.can.markOutcome, true);
});

test('branding: the event type first, then the company profile, then settings', () => {
  const company = { name: 'SatnPaper', profile: { brandName: 'SatnPaper Online', brandColor: '#123456' } };
  assert.equal(brandingOf({ company, eventType: { branding: { color: '#ABCDEF' } }, settings: { color: '#2840D8' } }).color, '#ABCDEF');
  assert.equal(brandingOf({ company, eventType: { branding: {} }, settings: { color: '#2840D8' } }).color, '#123456');
  assert.equal(brandingOf({ company: { name: 'X', profile: {} }, eventType: {}, settings: { color: '#2840D8', logoUrl: null } }).companyName, 'X');
});
