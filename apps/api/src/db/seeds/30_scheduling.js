import { addDays, localToUtc, toZonedParts } from '../../core/scheduling/index.js';
import { addTimelineEvent } from '../../core/crm/timeline.js';
import { developmentPorts } from '../../modules/scheduling/ports.js';
import { planReminders } from '../../modules/scheduling/bookings.js';
import { newNonce } from '../../modules/scheduling/tokens.js';

// Demo scheduling data (phase 6): event types for SatnPaper, Pi Vector and Excel with hosts and
// public booking pages, weekly availability for the hosts, and bookings around today on seeded
// deals: one live now, upcoming ones (one with a reschedule request), attended, no-shows, a
// cancellation and one waiting for its outcome, with meetings, attendance and reminders.
//
// Idempotent: event types upsert on (company, slug), hosts and availability on their keys, and
// bookings are keyed by source_event_id 'seed:scheduling:<n>' (an existing one is left alone).
// Times are relative to the first run, in India time.

const MINUTE = 60_000;
const IST = 'Asia/Kolkata';
const GROUP_CODE = 'phoenix';

const EVENT_TYPES = [
  {
    company: 'satnpaper',
    unit: 'sat-admissions',
    slug: 'sat-counselling',
    name: 'SAT counselling call',
    description: 'A 30-minute call with a SAT counsellor about your target score, test dates and our batches.',
    duration_min: 30,
    slot_interval_min: 30,
    buffer_after_min: 10,
    min_notice_min: 120,
    max_per_day: 6,
    horizon_days: 21,
    location_kind: 'zoom',
    attendance_threshold_min: 10,
    hosts: [
      { email: 'kabir@phoenix.test', weight: 1, languages: ['en', 'hi'] },
      { email: 'ritika@phoenix.test', weight: 1, languages: ['en', 'hi', 'ar'] },
    ],
    questions: [
      {
        key: 'grade',
        label: "Student's current grade",
        type: 'select',
        required: true,
        options: [
          { value: '9', label: 'Grade 9' },
          { value: '10', label: 'Grade 10' },
          { value: '11', label: 'Grade 11' },
          { value: '12', label: 'Grade 12' },
          { value: 'gap', label: 'Gap year' },
        ],
      },
      { key: 'target_date', label: 'When do you plan to take the SAT?', type: 'text', required: false, help: 'A month is enough, like March 2027' },
    ],
    attendees: { ask: true, label: 'Who will attend?', options: [{ value: 'parent', label: 'Parent' }, { value: 'student', label: 'Student' }, { value: 'both', label: 'Parent and student' }], maxGuests: 2 },
    branding: { headline: 'Talk to a SAT counsellor', confirmationMessage: 'We have sent the joining link to your email. Keep your target colleges list handy.' },
    deal_kind: 'b2c',
  },
  {
    company: 'satnpaper',
    unit: 'online',
    slug: 'parent-orientation',
    name: 'Parent orientation',
    description: 'How our online SAT programme works, for parents.',
    duration_min: 45,
    min_notice_min: 240,
    max_per_day: 3,
    horizon_days: 30,
    location_kind: 'google_meet',
    attendance_threshold_min: 15,
    hosts: [{ email: 'kabir@phoenix.test', weight: 1 }],
    attendees: { ask: false, options: [{ value: 'parent', label: 'Parent' }], maxGuests: 1 },
    deal_kind: 'b2c',
  },
  {
    company: 'satnpaper',
    unit: 'software-sales',
    slug: 'software-demo',
    name: 'Test software demo for institutes',
    description: 'A live demo of the SatnPaper test platform for coaching institutes.',
    duration_min: 45,
    buffer_before_min: 5,
    buffer_after_min: 15,
    min_notice_min: 720,
    horizon_days: 30,
    location_kind: 'teams',
    attendance_threshold_min: 15,
    hosts: [{ email: 'sales.satnpaper@phoenix.test', weight: 1 }],
    questions: [
      { key: 'institute', label: 'Institute name', type: 'text', required: true },
      { key: 'students', label: 'How many students?', type: 'select', required: false, options: [{ value: 'lt200', label: 'Under 200' }, { value: '200_1000', label: '200 to 1,000' }, { value: 'gt1000', label: 'Over 1,000' }] },
    ],
    deal_kind: 'b2b',
  },
  {
    company: 'pivector',
    unit: null,
    slug: 'product-demo',
    name: 'Pi Vector ERP demo',
    description: 'See admissions, fees and timetables in Pi Vector ERP.',
    duration_min: 45,
    buffer_after_min: 15,
    min_notice_min: 480,
    horizon_days: 45,
    location_kind: 'zoom',
    attendance_threshold_min: 15,
    hosts: [{ email: 'admin.pivector@phoenix.test', weight: 1 }],
    branding: { color: '#0F766E', headline: 'Book your Pi Vector ERP demo' },
    deal_kind: 'b2b',
  },
  {
    company: 'pivector',
    unit: 'admissions',
    slug: 'admissions-counselling',
    name: 'Admissions counselling',
    duration_min: 30,
    min_notice_min: 180,
    horizon_days: 21,
    location_kind: 'phone',
    location_detail: 'We will call you on the number you give us.',
    attendance_threshold_min: 5,
    hosts: [{ email: 'admin.pivector@phoenix.test', weight: 1 }],
    attendees: { ask: true, options: [{ value: 'parent', label: 'Parent' }, { value: 'student', label: 'Student' }, { value: 'both', label: 'Parent and student' }], maxGuests: 0 },
    deal_kind: 'b2c',
  },
  {
    company: 'excel',
    unit: 'admissions',
    slug: 'campus-visit',
    name: 'Campus visit and counselling',
    duration_min: 60,
    buffer_after_min: 15,
    min_notice_min: 1440,
    max_per_day: 4,
    horizon_days: 30,
    location_kind: 'in_person',
    location_detail: 'Excel Mumbai centre, 3rd floor, Andheri West, Mumbai 400058',
    attendance_threshold_min: 0,
    hosts: [{ email: 'admin.excel@phoenix.test', weight: 1 }],
    attendees: { ask: true, options: [{ value: 'parent', label: 'Parent' }, { value: 'student', label: 'Student' }, { value: 'both', label: 'Parent and student' }], maxGuests: 3 },
    deal_kind: 'b2c',
  },
];

const AVAILABILITY = {
  'kabir@phoenix.test': {
    time_zone: IST,
    weekly: { mon: ['10:00-13:00', '14:00-19:00'], tue: ['10:00-13:00', '14:00-19:00'], wed: ['10:00-13:00', '14:00-19:00'], thu: ['10:00-13:00', '14:00-19:00'], fri: ['10:00-13:00', '14:00-19:00'], sat: ['10:00-14:00'] },
  },
  'ritika@phoenix.test': {
    // Works with Gulf families from Dubai.
    time_zone: 'Asia/Dubai',
    weekly: { mon: ['09:00-17:00'], tue: ['09:00-17:00'], wed: ['09:00-17:00'], thu: ['09:00-17:00'], sat: ['10:00-15:00'], sun: ['10:00-15:00'] },
  },
  'sales.satnpaper@phoenix.test': {
    time_zone: IST,
    weekly: { mon: ['09:30-18:30'], tue: ['09:30-18:30'], wed: ['09:30-18:30'], thu: ['09:30-18:30'], fri: ['09:30-18:30'] },
  },
  'admin.pivector@phoenix.test': {
    time_zone: IST,
    weekly: { mon: ['10:00-18:00'], tue: ['10:00-18:00'], wed: ['10:00-18:00'], thu: ['10:00-18:00'], fri: ['10:00-18:00'] },
  },
  'admin.excel@phoenix.test': {
    time_zone: IST,
    weekly: { mon: ['10:00-17:00'], tue: ['10:00-17:00'], wed: ['10:00-17:00'], thu: ['10:00-17:00'], fri: ['10:00-17:00'], sat: ['10:00-16:00'] },
  },
};

// Bookings: [n, event type slug, host, day offset from today (IST) | 'live' (started 10 minutes ago), HH:MM IST, outcome, invitee zone]
const BOOKINGS = [
  [1, 'sat-counselling', 'kabir@phoenix.test', 'live', null, 'live', 'Asia/Kolkata'],
  [2, 'sat-counselling', 'kabir@phoenix.test', 1, '11:00', 'booked', 'Asia/Kolkata'],
  [3, 'sat-counselling', 'ritika@phoenix.test', 1, '11:00', 'booked', 'Asia/Dubai'],
  [4, 'sat-counselling', 'kabir@phoenix.test', 2, '15:30', 'rescheduled', 'America/New_York'],
  [5, 'sat-counselling', 'kabir@phoenix.test', 3, '12:00', 'reschedule_request', 'Asia/Kolkata'],
  [6, 'sat-counselling', 'ritika@phoenix.test', 2, '17:00', 'booked', 'Europe/London'],
  [7, 'parent-orientation', 'kabir@phoenix.test', 5, '16:00', 'booked', 'Asia/Kolkata'],
  [8, 'sat-counselling', 'kabir@phoenix.test', -1, '11:00', 'attended', 'Asia/Kolkata'],
  [9, 'sat-counselling', 'kabir@phoenix.test', -2, '15:00', 'no_show', 'Asia/Kolkata'],
  [10, 'sat-counselling', 'ritika@phoenix.test', -2, '11:00', 'attended', 'Asia/Dubai'],
  [11, 'sat-counselling', 'ritika@phoenix.test', -4, '13:00', 'cancelled', 'Asia/Kolkata'],
  [12, 'sat-counselling', 'ritika@phoenix.test', -1, '18:00', 'no_show', 'Asia/Dubai'],
  [13, 'sat-counselling', 'kabir@phoenix.test', -1, '16:00', 'awaiting', 'Asia/Kolkata'],
  [14, 'software-demo', 'sales.satnpaper@phoenix.test', 2, '12:00', 'booked', 'Asia/Kolkata'],
  [15, 'software-demo', 'sales.satnpaper@phoenix.test', -3, '16:00', 'attended', 'Asia/Kolkata'],
  [16, 'product-demo', 'admin.pivector@phoenix.test', 1, '16:00', 'booked', 'Asia/Kolkata'],
  [17, 'product-demo', 'admin.pivector@phoenix.test', 3, '11:00', 'booked', 'Asia/Kolkata'],
  [18, 'product-demo', 'admin.pivector@phoenix.test', -2, '16:00', 'attended', 'Asia/Kolkata'],
  [19, 'admissions-counselling', 'admin.pivector@phoenix.test', 2, '11:00', 'booked', 'Asia/Kolkata'],
  [20, 'admissions-counselling', 'admin.pivector@phoenix.test', -1, '12:00', 'no_show', 'Asia/Kolkata'],
  [21, 'campus-visit', 'admin.excel@phoenix.test', 1, '12:00', 'booked', 'Asia/Kolkata'],
  [22, 'campus-visit', 'admin.excel@phoenix.test', -1, '11:00', 'attended', 'Asia/Kolkata'],
];

const json = (value) => JSON.stringify(value);

export async function seed(knex) {
  const group = await knex('org_units').whereNull('parent_id').where({ code: GROUP_CODE }).first();
  if (!group) {
    console.log('Scheduling demo data needs the Phoenix group: run the foundation seed first.');
    return;
  }
  if (!(await knex.schema.hasTable('scheduling_event_types'))) return;
  const units = await knex('org_units').where({ root_id: group.id });
  const CODES = { satnpaper: 'satnpaper', pivector: 'pi-vector', excel: 'excel' };
  const companyOf = (key) => units.find((u) => u.type === 'company' && u.code === CODES[key]);
  const unitOf = (key, code) => {
    const company = companyOf(key);
    if (!company) return null;
    return code ? units.find((u) => u.code === code && u.path.startsWith(company.path) && u.id !== company.id) : company;
  };
  const emails = [...new Set([...EVENT_TYPES.flatMap((e) => e.hosts.map((h) => h.email)), ...Object.keys(AVAILABILITY)])];
  const users = await knex('users').whereIn('email', emails).select('id', 'email', 'name');
  const userId = (email) => users.find((u) => u.email === email)?.id ?? null;

  // ---------- Availability ----------
  for (const [email, availability] of Object.entries(AVAILABILITY)) {
    const id = userId(email);
    if (!id) continue;
    await knex('scheduling_availability')
      .insert({ user_id: id, time_zone: availability.time_zone, weekly: json(availability.weekly), overrides: json({}) })
      .onConflict('user_id')
      .ignore();
  }

  // ---------- Event types, hosts, public links ----------
  const eventTypes = new Map();
  for (const spec of EVENT_TYPES) {
    const company = companyOf(spec.company);
    const unit = unitOf(spec.company, spec.unit);
    if (!company || !unit) continue;
    const { hosts, company: _c, unit: _u, ...columns } = spec;
    let row = await knex('scheduling_event_types').where({ company_id: company.id, slug: spec.slug }).first();
    if (!row) {
      [row] = await knex('scheduling_event_types')
        .insert({
          ...columns,
          group_id: group.id,
          company_id: company.id,
          unit_id: unit.id,
          questions: json(columns.questions ?? []),
          attendees: json(columns.attendees ?? {}),
          branding: json(columns.branding ?? {}),
        })
        .returning('*');
    }
    eventTypes.set(spec.slug, row);
    for (const host of hosts) {
      const id = userId(host.email);
      if (!id) continue;
      await knex('scheduling_event_type_hosts')
        .insert({ event_type_id: row.id, user_id: id, weight: host.weight ?? 1, priority: host.priority ?? 0, languages: host.languages ?? [], active: true })
        .onConflict(['event_type_id', 'user_id'])
        .ignore();
    }
    const link = await knex('scheduling_booking_links').where({ event_type_id: row.id, kind: 'public' }).whereNull('revoked_at').first();
    if (!link) {
      await knex('scheduling_booking_links').insert({ group_id: row.group_id, company_id: row.company_id, unit_id: row.unit_id, event_type_id: row.id, kind: 'public' });
    }
  }

  // ---------- Bookings ----------
  const now = Date.now();
  const todayIst = toZonedParts(now, IST).date;
  const usedDeals = new Set(
    await knex('bookings').whereNotNull('deal_id').where('source_event_id', 'like', 'seed:scheduling:%').pluck('deal_id'),
  );
  let created = 0;
  for (const [n, slug, hostEmail, dayOffset, time, outcome, zone] of BOOKINGS) {
    const sourceEventId = `seed:scheduling:${n}`;
    if (await knex('bookings').where({ source_event_id: sourceEventId }).first('id')) continue;
    const eventType = eventTypes.get(slug);
    const hostId = userId(hostEmail);
    if (!eventType || !hostId) continue;

    let startMs;
    if (dayOffset === 'live') startMs = Math.floor(now / (5 * MINUTE)) * 5 * MINUTE - 10 * MINUTE;
    else startMs = localToUtc(addDays(todayIst, dayOffset), time, IST);
    const endMs = startMs + eventType.duration_min * MINUTE;
    const overlap = await knex('bookings')
      .where({ host_user_id: hostId })
      .whereIn('status', ['booked', 'rescheduled'])
      .where('start_at', '<', new Date(endMs))
      .where('end_at', '>', new Date(startMs))
      .first('id');
    const active = ['live', 'booked', 'rescheduled', 'reschedule_request', 'awaiting'].includes(outcome);
    if (overlap && active) continue;

    // A deal of the event type's company and kind inside its unit, owned by the host when possible.
    const unit = units.find((u) => u.id === eventType.unit_id);
    const deal = await knex('deals as d')
      .join('org_units as o', 'o.id', 'd.unit_id')
      .where('d.company_id', eventType.company_id)
      .where('o.path', 'like', `${unit.path}%`)
      .where('d.kind', eventType.deal_kind ?? 'b2c')
      .where('d.status', 'open')
      .whereNull('d.archived_at')
      .whereNotNull('d.primary_contact_id')
      .modify((q) => {
        if (usedDeals.size) q.whereNotIn('d.id', [...usedDeals]);
      })
      .orderByRaw('(d.owner_user_id = ?) desc, d.number', [hostId])
      .first('d.*');
    if (!deal) continue;
    usedDeals.add(deal.id);
    const contact = await knex('contacts').where({ id: deal.primary_contact_id }).first('id', 'display_name', 'primary_email', 'primary_phone');

    const status = { live: 'booked', booked: 'booked', rescheduled: 'rescheduled', reschedule_request: 'booked', awaiting: 'booked', attended: 'completed', no_show: 'no_show', cancelled: 'cancelled' }[outcome];
    const id = (await knex.raw('select gen_random_uuid() as id')).rows[0].id;
    const online = ['zoom', 'google_meet', 'teams'].includes(eventType.location_kind);
    const meeting = online ? await developmentPorts.createOnlineMeeting({ booking: { id, location_kind: eventType.location_kind } }) : null;
    const sequence = outcome === 'rescheduled' ? 1 : outcome === 'cancelled' ? 1 : 0;
    const [booking] = await knex('bookings')
      .insert({
        id,
        group_id: eventType.group_id,
        company_id: eventType.company_id,
        unit_id: deal.unit_id,
        event_type_id: eventType.id,
        deal_id: deal.id,
        contact_id: contact?.id ?? null,
        host_user_id: hostId,
        owner_user_id: deal.owner_user_id,
        status,
        start_at: new Date(startMs),
        end_at: new Date(endMs),
        buffer_before_min: eventType.buffer_before_min,
        buffer_after_min: eventType.buffer_after_min,
        time_zone: zone,
        invitee_name: contact?.display_name ?? 'Guest',
        invitee_email: contact?.primary_email ?? null,
        invitee_phone: contact?.primary_phone ?? null,
        attending: eventType.attendees?.ask ? (n % 3 === 0 ? 'student' : n % 3 === 1 ? 'both' : 'parent') : null,
        guests: json([]),
        answers: json(slug === 'sat-counselling' ? { grade: String(10 + (n % 3)), target_date: 'March 2027' } : slug === 'software-demo' ? { institute: 'Seeded institute' } : {}),
        location_kind: eventType.location_kind,
        location_detail: eventType.location_detail ?? null,
        meeting_url: meeting?.url ?? null,
        meeting_provider: meeting?.provider ?? null,
        meeting_ref: meeting?.ref ?? null,
        ics_sequence: sequence,
        token_nonce: newNonce(),
        source: n % 2 === 0 ? 'personal_link' : 'booking_page',
        assignment_reason: 'Seeded booking',
        reschedule_count: outcome === 'rescheduled' ? 1 : 0,
        reschedule_requested_at: outcome === 'reschedule_request' ? new Date(now - 3 * 60 * MINUTE) : null,
        reschedule_request_note: outcome === 'reschedule_request' ? 'Can we do the weekend instead? School exams this week.' : null,
        cancelled_at: status === 'cancelled' ? new Date(startMs - 26 * 60 * MINUTE) : null,
        cancelled_by: status === 'cancelled' ? 'invitee' : null,
        cancel_reason: status === 'cancelled' ? 'Travelling that week' : null,
        completed_at: status === 'completed' ? new Date(endMs) : null,
        no_show_at: status === 'no_show' ? new Date(endMs + 30 * MINUTE) : null,
        source_event_id: sourceEventId,
        created_at: new Date(Math.min(now, startMs) - 2 * 24 * 60 * MINUTE),
      })
      .returning('*');

    const host = users.find((u) => u.id === hostId);
    const attendedSeconds = outcome === 'attended' ? Math.round(eventType.duration_min * 0.85 * 60) : outcome === 'no_show' ? (n % 2 ? 0 : 180) : outcome === 'live' ? 8 * 60 : 0;
    const [meetingRow] = await knex('meetings')
      .insert({
        booking_id: booking.id,
        group_id: booking.group_id,
        company_id: booking.company_id,
        provider: booking.location_kind,
        provider_meeting_id: meeting?.ref ?? null,
        status: outcome === 'live' ? 'live' : ['attended', 'no_show'].includes(outcome) && online ? 'ended' : 'scheduled',
        started_at: ['live', 'attended', 'no_show'].includes(outcome) && online ? new Date(startMs + 60_000) : null,
        ended_at: ['attended', 'no_show'].includes(outcome) && online ? new Date(endMs) : null,
        threshold_min: eventType.attendance_threshold_min,
        result: outcome === 'attended' ? 'attended' : outcome === 'no_show' ? 'no_show' : 'pending',
        invitee_seconds: attendedSeconds,
        host_seconds: ['live', 'attended', 'no_show'].includes(outcome) && online ? (outcome === 'live' ? 9 * 60 : eventType.duration_min * 60) : 0,
        evaluated_at: ['attended', 'no_show'].includes(outcome) ? new Date(endMs + 30 * MINUTE) : null,
      })
      .returning('*');
    if (online && ['live', 'attended', 'no_show'].includes(outcome)) {
      const joined = startMs + 2 * MINUTE;
      const participants = [
        {
          meeting_id: meetingRow.id,
          key: `host:${host.email}`,
          role: 'host',
          name: host.name,
          email: host.email,
          user_id: host.id,
          intervals: json([{ start: new Date(startMs + MINUTE).toISOString(), end: new Date(outcome === 'live' ? now : endMs).toISOString() }]),
          attended_seconds: meetingRow.host_seconds,
          session_count: 1,
          first_joined_at: new Date(startMs + MINUTE),
          last_left_at: outcome === 'live' ? null : new Date(endMs),
          still_in_meeting: outcome === 'live',
          meets_threshold: false,
        },
      ];
      if (attendedSeconds > 0) {
        participants.push({
          meeting_id: meetingRow.id,
          key: `invitee:${booking.invitee_email ?? booking.id}`,
          role: 'invitee',
          name: booking.invitee_name,
          email: booking.invitee_email,
          user_id: null,
          intervals: json([{ start: new Date(joined).toISOString(), end: new Date(joined + attendedSeconds * 1000).toISOString() }]),
          attended_seconds: attendedSeconds,
          session_count: outcome === 'attended' ? 2 : 1,
          first_joined_at: new Date(joined),
          last_left_at: outcome === 'live' ? null : new Date(joined + attendedSeconds * 1000),
          still_in_meeting: outcome === 'live',
          meets_threshold: attendedSeconds >= eventType.attendance_threshold_min * 60,
        });
      }
      await knex('meeting_participants').insert(participants).onConflict(['meeting_id', 'key']).ignore();
    }

    if (['booked', 'rescheduled'].includes(status) && startMs > now) {
      const { rows } = planReminders(booking, eventType, { now, quietHours: { start: '21:00', end: '08:00' } });
      if (rows.length) await knex('booking_reminders').insert(rows).onConflict(['booking_id', 'sequence', 'offset_min']).ignore();
    }

    const when = new Date(startMs).toLocaleString('en-IN', { timeZone: IST, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    const entries = [{ action: 'booking.created', kind: 'system', title: `Booked: ${eventType.name}, ${when} IST`, at: new Date(booking.created_at) }];
    if (status === 'completed') entries.push({ action: 'booking.attended', kind: 'meeting', title: `Attended: ${eventType.name} (${Math.round(attendedSeconds / 60)} min)`, at: new Date(endMs) });
    if (status === 'no_show') entries.push({ action: 'booking.no_show', kind: 'system', title: `No-show: ${eventType.name}`, at: new Date(endMs + 30 * MINUTE) });
    if (status === 'cancelled') entries.push({ action: 'booking.cancelled', kind: 'system', title: `Cancelled by the family: ${eventType.name}, ${when} IST`, at: booking.cancelled_at });
    for (const entry of entries) {
      await addTimelineEvent(knex, {
        groupId: booking.group_id,
        companyId: booking.company_id,
        unitId: booking.unit_id,
        dealId: booking.deal_id,
        contactId: booking.contact_id,
        kind: entry.kind,
        direction: entry.kind === 'meeting' ? 'outbound' : 'internal',
        title: entry.title,
        meta: { action: entry.action, bookingId: booking.id, eventTypeId: eventType.id, startAt: new Date(startMs).toISOString(), durationSeconds: entry.kind === 'meeting' ? attendedSeconds : undefined },
        actorType: 'system',
        sourceEventId: `${entry.action}:${booking.id}:${booking.ics_sequence}`,
        occurredAt: entry.at,
        touchDeal: false,
      });
    }
    created += 1;
  }
  console.log(`Scheduling demo data: ${eventTypes.size} event types, ${created} new bookings.`);
}
