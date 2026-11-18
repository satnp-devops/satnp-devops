// Phase 6, scheduling: event types (bookable meetings per company), their hosts, people's weekly
// availability, signed booking links, bookings, reminders, and meetings with attendance.
// The engine that works out slots, hosts, invitations and reminder times is core/scheduling
// (docs/platform/SCHEDULING_CORE.md); docs/scheduling/SCHEDULING.md describes these tables.
//
// Conventions as in phases 1 and 2: UUID keys, timestamptz in UTC, company-owned rows carry
// group_id, company_id and unit_id, JSONB for typed shapes validated by zod before writing.
//
// Double booking is impossible in the database as well as in the service: an exclusion constraint
// (btree_gist) refuses two active bookings of one host whose times overlap.

const ACTIVE_STATUSES = ['booked', 'rescheduled'];
const BOOKING_STATUSES = ['booked', 'rescheduled', 'cancelled', 'completed', 'no_show'];
const LOCATION_KINDS = ['zoom', 'google_meet', 'teams', 'phone', 'in_person'];
const ASSIGNMENTS = ['round_robin', 'single'];

const inList = (values) => values.map((v) => `'${v}'`).join(', ');

function id(knex, t) {
  t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
}

function timestamps(knex, t) {
  t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
}

const unitRef = (t, column) => t.uuid(column).notNullable().references('id').inTable('org_units').onDelete('RESTRICT');
const userRef = (t, column) => t.uuid(column).references('id').inTable('users').onDelete('SET NULL');

export async function up(knex) {
  // Shared databases keep extensions in public (like pg_trgm and citext); creating it again is a no-op.
  await knex.raw('create extension if not exists btree_gist with schema public');

  // ---------- Event types: what can be booked ----------
  await knex.schema.createTable('scheduling_event_types', (t) => {
    id(knex, t);
    unitRef(t, 'group_id');
    unitRef(t, 'company_id');
    unitRef(t, 'unit_id'); // owning unit inside the company (scoping and who may host)
    t.specificType('slug', 'citext').notNullable(); // unique per company
    t.text('name').notNullable();
    t.text('description');
    t.integer('duration_min').notNullable();
    t.integer('slot_interval_min'); // null = the duration
    t.integer('buffer_before_min').notNullable().defaultTo(0);
    t.integer('buffer_after_min').notNullable().defaultTo(0);
    t.integer('min_notice_min').notNullable().defaultTo(240);
    t.integer('max_per_day'); // per host and local day; null = no limit
    t.integer('horizon_days').notNullable().defaultTo(30);
    t.text('align_time_zone'); // one slot grid for mixed-offset teams (Kolkata + Kathmandu)
    t.text('location_kind').notNullable().defaultTo('zoom');
    t.text('location_detail'); // address for in-person, instructions for phone
    t.text('assignment').notNullable().defaultTo('round_robin');
    t.integer('attendance_threshold_min').notNullable().defaultTo(10); // minutes the invitee must attend
    t.specificType('reminder_offsets_min', 'integer[]').notNullable().defaultTo(knex.raw("'{1440,60}'"));
    t.jsonb('questions').notNullable().defaultTo(knex.raw("'[]'::jsonb")); // [{ key, label, type, required, options? }]
    t.jsonb('attendees').notNullable().defaultTo(knex.raw("'{}'::jsonb")); // who will attend: { ask, options, maxGuests }
    t.jsonb('branding').notNullable().defaultTo(knex.raw("'{}'::jsonb")); // { color?, logoUrl?, headline?, confirmationMessage? }
    t.text('deal_kind'); // b2c | b2b | null (any): which deals the event type is meant for
    t.boolean('active').notNullable().defaultTo(true);
    t.timestamp('archived_at', { useTz: true });
    userRef(t, 'created_by');
    timestamps(knex, t);
    t.unique(['company_id', 'slug']);
    t.index(['company_id', 'archived_at']);
    t.index(['unit_id']);
  });
  await knex.raw(`
    alter table scheduling_event_types
      add constraint scheduling_event_types_duration_ck check (duration_min between 5 and 1440),
      add constraint scheduling_event_types_interval_ck check (slot_interval_min is null or slot_interval_min between 5 and 1440),
      add constraint scheduling_event_types_buffers_ck check (buffer_before_min between 0 and 1440 and buffer_after_min between 0 and 1440),
      add constraint scheduling_event_types_notice_ck check (min_notice_min between 0 and 43200),
      add constraint scheduling_event_types_max_ck check (max_per_day is null or max_per_day between 1 and 100),
      add constraint scheduling_event_types_horizon_ck check (horizon_days between 1 and 365),
      add constraint scheduling_event_types_threshold_ck check (attendance_threshold_min between 0 and 1440),
      add constraint scheduling_event_types_location_ck check (location_kind in (${inList(LOCATION_KINDS)})),
      add constraint scheduling_event_types_assignment_ck check (assignment in (${inList(ASSIGNMENTS)})),
      add constraint scheduling_event_types_deal_kind_ck check (deal_kind is null or deal_kind in ('b2c', 'b2b'))
  `);

  await knex.schema.createTable('scheduling_event_type_hosts', (t) => {
    t.uuid('event_type_id').notNullable().references('id').inTable('scheduling_event_types').onDelete('CASCADE');
    t.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.integer('weight').notNullable().defaultTo(1); // round-robin share
    t.integer('priority').notNullable().defaultTo(0); // higher tier first
    t.specificType('languages', 'text[]').notNullable().defaultTo('{}');
    t.boolean('active').notNullable().defaultTo(true);
    timestamps(knex, t);
    t.primary(['event_type_id', 'user_id']);
    t.index(['user_id']);
  });
  await knex.raw(`
    alter table scheduling_event_type_hosts
      add constraint scheduling_event_type_hosts_weight_ck check (weight between 0 and 100),
      add constraint scheduling_event_type_hosts_priority_ck check (priority between -10 and 10)
  `);

  // ---------- Availability: one row per person (their own zone, weekly hours and date overrides) ----------
  await knex.schema.createTable('scheduling_availability', (t) => {
    t.uuid('user_id').primary().references('id').inTable('users').onDelete('CASCADE');
    t.text('time_zone').notNullable(); // normalised IANA name
    t.jsonb('weekly').notNullable().defaultTo(knex.raw("'{}'::jsonb")); // { mon: ['09:00-13:00', ...], ... }
    t.jsonb('overrides').notNullable().defaultTo(knex.raw("'{}'::jsonb")); // { '2026-11-14': 'unavailable' | ['10:00-12:00'] }
    userRef(t, 'updated_by');
    timestamps(knex, t);
  });

  // ---------- Signed booking links (the public page, and personal links for a deal or contact) ----------
  await knex.schema.createTable('scheduling_booking_links', (t) => {
    id(knex, t);
    unitRef(t, 'group_id');
    unitRef(t, 'company_id');
    unitRef(t, 'unit_id');
    t.uuid('event_type_id').notNullable().references('id').inTable('scheduling_event_types').onDelete('CASCADE');
    t.text('kind').notNullable(); // public | personal
    t.uuid('deal_id').references('id').inTable('deals').onDelete('RESTRICT');
    t.uuid('contact_id').references('id').inTable('contacts').onDelete('RESTRICT');
    t.uuid('preferred_host_user_id').references('id').inTable('users').onDelete('SET NULL');
    t.jsonb('prefill').notNullable().defaultTo(knex.raw("'{}'::jsonb")); // { name?, attending? }; contact details are read at booking time
    t.timestamp('expires_at', { useTz: true }); // null = never (public links)
    t.integer('max_uses'); // null = unlimited
    t.integer('use_count').notNullable().defaultTo(0);
    t.timestamp('last_sent_at', { useTz: true });
    t.timestamp('revoked_at', { useTz: true });
    userRef(t, 'created_by');
    timestamps(knex, t);
    t.index(['event_type_id', 'kind']);
    t.index(['deal_id', 'created_at']);
    t.index(['contact_id', 'created_at']);
  });
  await knex.raw(`
    alter table scheduling_booking_links
      add constraint scheduling_booking_links_kind_ck check (kind in ('public', 'personal')),
      add constraint scheduling_booking_links_uses_ck check (max_uses is null or max_uses >= 1)
  `);
  // One live public link per event type.
  await knex.raw(
    `create unique index scheduling_booking_links_public_uq on scheduling_booking_links (event_type_id) where kind = 'public' and revoked_at is null`,
  );

  // ---------- Bookings ----------
  await knex.schema.createTable('bookings', (t) => {
    id(knex, t);
    unitRef(t, 'group_id');
    unitRef(t, 'company_id');
    unitRef(t, 'unit_id'); // the deal's unit when booked for a deal, else the event type's unit
    t.uuid('event_type_id').notNullable().references('id').inTable('scheduling_event_types').onDelete('RESTRICT');
    t.uuid('booking_link_id').references('id').inTable('scheduling_booking_links').onDelete('SET NULL');
    t.uuid('deal_id').references('id').inTable('deals').onDelete('RESTRICT');
    t.uuid('contact_id').references('id').inTable('contacts').onDelete('RESTRICT');
    t.uuid('host_user_id').references('id').inTable('users').onDelete('SET NULL');
    userRef(t, 'owner_user_id'); // the deal's owner (kept in step by the deal.owner_changed handler)
    t.text('status').notNullable().defaultTo('booked');
    t.timestamp('start_at', { useTz: true }).notNullable();
    t.timestamp('end_at', { useTz: true }).notNullable();
    t.integer('buffer_before_min').notNullable().defaultTo(0); // copied from the event type at booking time
    t.integer('buffer_after_min').notNullable().defaultTo(0);
    t.text('time_zone').notNullable(); // the invitee's zone (reminder quiet hours, emails)
    t.text('invitee_name').notNullable();
    t.text('invitee_email'); // personal data
    t.text('invitee_phone'); // personal data, E.164
    t.text('attending'); // who will attend: parent | student | both | <option value>
    t.jsonb('guests').notNullable().defaultTo(knex.raw("'[]'::jsonb")); // [{ name, email?, role? }] personal data
    t.jsonb('answers').notNullable().defaultTo(knex.raw("'{}'::jsonb")); // { questionKey: value }
    t.text('notes');
    t.text('location_kind').notNullable();
    t.text('location_detail');
    t.text('meeting_url');
    t.text('meeting_provider'); // zoom | google_meet | teams | null
    t.text('meeting_ref'); // provider meeting id or code (attendance)
    t.uuid('ics_uid').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    t.integer('ics_sequence').notNullable().defaultTo(0);
    t.text('token_nonce').notNullable(); // part of the signed manage link; rotate to revoke it
    t.text('source').notNullable().defaultTo('booking_page'); // booking_page | personal_link | staff
    t.text('assignment_reason');
    t.integer('reschedule_count').notNullable().defaultTo(0);
    t.timestamp('reschedule_requested_at', { useTz: true });
    t.text('reschedule_request_note');
    t.timestamp('cancelled_at', { useTz: true });
    t.text('cancelled_by'); // invitee | host | system
    t.text('cancel_reason');
    t.timestamp('completed_at', { useTz: true });
    t.timestamp('no_show_at', { useTz: true });
    t.text('source_event_id'); // idempotency key for staff and public creates (unique when set)
    userRef(t, 'created_by');
    timestamps(knex, t);
  });
  await knex.raw(`
    alter table bookings
      add constraint bookings_status_ck check (status in (${inList(BOOKING_STATUSES)})),
      add constraint bookings_times_ck check (end_at > start_at),
      add constraint bookings_location_ck check (location_kind in (${inList(LOCATION_KINDS)})),
      add constraint bookings_cancelled_ck check ((status = 'cancelled') = (cancelled_at is not null)),
      add constraint bookings_no_overlap exclude using gist (
        host_user_id with =,
        tstzrange(start_at, end_at, '[)') with &&
      ) where (status in (${inList(ACTIVE_STATUSES)}) and host_user_id is not null)
  `);
  await knex.raw('create unique index bookings_source_event_uq on bookings (source_event_id) where source_event_id is not null');
  await knex.raw('create index bookings_company_start_idx on bookings (company_id, start_at, id)');
  await knex.raw('create index bookings_group_start_idx on bookings (group_id, start_at, id)');
  await knex.raw('create index bookings_host_start_idx on bookings (host_user_id, start_at)');
  await knex.raw('create index bookings_owner_start_idx on bookings (owner_user_id, start_at) where owner_user_id is not null');
  await knex.raw('create index bookings_unit_start_idx on bookings (unit_id, start_at)');
  await knex.raw('create index bookings_deal_idx on bookings (deal_id, start_at desc) where deal_id is not null');
  await knex.raw('create index bookings_contact_idx on bookings (contact_id, start_at desc) where contact_id is not null');
  await knex.raw('create index bookings_event_type_start_idx on bookings (event_type_id, start_at)');
  await knex.raw(
    `create index bookings_reschedule_requested_idx on bookings (company_id, reschedule_requested_at) where reschedule_requested_at is not null and status in (${inList(ACTIVE_STATUSES)})`,
  );

  // ---------- Reminders (one row per booking, sequence and offset; the job id is derived from them) ----------
  await knex.schema.createTable('booking_reminders', (t) => {
    t.bigIncrements('id').primary();
    t.uuid('booking_id').notNullable().references('id').inTable('bookings').onDelete('CASCADE');
    t.integer('sequence').notNullable(); // the booking's ics_sequence when it was planned
    t.integer('offset_min').notNullable();
    t.timestamp('run_at', { useTz: true }).notNullable();
    t.text('shifted'); // later | earlier (quiet hours) | null
    t.text('job_id').notNullable();
    t.text('status').notNullable().defaultTo('scheduled'); // scheduled | sent | skipped | cancelled
    t.timestamp('sent_at', { useTz: true });
    t.text('skip_reason');
    timestamps(knex, t);
    t.unique(['booking_id', 'sequence', 'offset_min']);
    t.unique(['job_id']);
  });
  await knex.raw(`alter table booking_reminders add constraint booking_reminders_status_ck check (status in ('scheduled', 'sent', 'skipped', 'cancelled'))`);
  await knex.raw(`create index booking_reminders_due_idx on booking_reminders (run_at) where status = 'scheduled'`);

  // ---------- Meetings and attendance ----------
  await knex.schema.createTable('meetings', (t) => {
    id(knex, t);
    t.uuid('booking_id').notNullable().unique().references('id').inTable('bookings').onDelete('CASCADE');
    unitRef(t, 'group_id');
    unitRef(t, 'company_id');
    t.text('provider').notNullable(); // zoom | google_meet | teams | phone | in_person
    t.text('provider_meeting_id'); // Zoom meeting id, Meet code, Teams online meeting id
    t.text('provider_meeting_uuid'); // Zoom instance uuid (last seen)
    t.text('status').notNullable().defaultTo('scheduled'); // scheduled | live | ended
    t.timestamp('started_at', { useTz: true });
    t.timestamp('ended_at', { useTz: true });
    t.integer('threshold_min').notNullable(); // copied from the event type when the result was decided
    t.text('result').notNullable().defaultTo('pending'); // pending | attended | no_show
    t.integer('invitee_seconds').notNullable().defaultTo(0);
    t.integer('host_seconds').notNullable().defaultTo(0);
    t.timestamp('evaluated_at', { useTz: true });
    t.jsonb('recording').notNullable().defaultTo(knex.raw("'{}'::jsonb")); // { provider, ref, url? } once recordings are fetched
    t.text('ai_summary'); // placeholder for the AI phase
    t.text('ai_summary_status').notNullable().defaultTo('none'); // none | pending | ready | failed
    timestamps(knex, t);
  });
  await knex.raw(`
    alter table meetings
      add constraint meetings_status_ck check (status in ('scheduled', 'live', 'ended')),
      add constraint meetings_result_ck check (result in ('pending', 'attended', 'no_show')),
      add constraint meetings_ai_ck check (ai_summary_status in ('none', 'pending', 'ready', 'failed'))
  `);
  await knex.raw('create index meetings_provider_ref_idx on meetings (provider, provider_meeting_id) where provider_meeting_id is not null');

  await knex.schema.createTable('meeting_participants', (t) => {
    id(knex, t);
    t.uuid('meeting_id').notNullable().references('id').inTable('meetings').onDelete('CASCADE');
    t.text('key').notNullable(); // the attendance grouping key (email, registrant, name)
    t.text('role').notNullable().defaultTo('guest'); // host | invitee | guest
    t.text('name');
    t.text('email'); // personal data
    t.uuid('user_id').references('id').inTable('users').onDelete('SET NULL');
    t.jsonb('intervals').notNullable().defaultTo(knex.raw("'[]'::jsonb")); // merged [{ start, end }] UTC
    t.integer('attended_seconds').notNullable().defaultTo(0);
    t.integer('session_count').notNullable().defaultTo(0);
    t.timestamp('first_joined_at', { useTz: true });
    t.timestamp('last_left_at', { useTz: true });
    t.boolean('still_in_meeting').notNullable().defaultTo(false);
    t.boolean('meets_threshold').notNullable().defaultTo(false);
    timestamps(knex, t);
    t.unique(['meeting_id', 'key']);
  });
  await knex.raw(`alter table meeting_participants add constraint meeting_participants_role_ck check (role in ('host', 'invitee', 'guest'))`);

  // Raw join and leave notifications (normalised), kept for recomputing attendance; idempotent on the provider's event id.
  await knex.schema.createTable('meeting_events', (t) => {
    t.bigIncrements('id').primary();
    t.uuid('meeting_id').notNullable().references('id').inTable('meetings').onDelete('CASCADE');
    t.text('provider_event_id').notNullable().unique();
    t.text('type').notNullable(); // participant.joined | participant.left | meeting.started | meeting.ended
    t.timestamp('occurred_at', { useTz: true }).notNullable();
    t.jsonb('data').notNullable().defaultTo(knex.raw("'{}'::jsonb")); // { meeting, participant } as normalised by the provider client
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['meeting_id', 'occurred_at']);
  });
}

export async function down(knex) {
  for (const table of [
    'meeting_events',
    'meeting_participants',
    'meetings',
    'booking_reminders',
    'bookings',
    'scheduling_booking_links',
    'scheduling_availability',
    'scheduling_event_type_hosts',
    'scheduling_event_types',
  ]) {
    await knex.schema.dropTableIfExists(table);
  }
  // btree_gist stays: other schemas in a shared database may use it.
}
