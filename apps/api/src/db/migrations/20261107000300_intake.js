// Phase 4, capture and intake (modules/intake, engine docs/platform/INTAKE_CORE.md): website forms, the channel
// registry used for routing, enquiries (every inbound lead, with its raw payload and the routing,
// de-duplication and assignment decisions), the review queue, CSV imports, assignment pools with
// their round-robin state, and partner referral links.
//
// Conventions as in phase 2: UUID keys, timestamptz in UTC, company-owned rows carry group_id,
// company_id and unit_id. Enquiries hold personal data (phones, emails) in `raw` and `enquiry`;
// the API masks them like contacts.

function id(knex, t) {
  t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
}

function timestamps(knex, t) {
  t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
}

const unitRef = (t, column, { nullable = false } = {}) => {
  const col = t.uuid(column).references('id').inTable('org_units').onDelete('RESTRICT');
  if (!nullable) col.notNullable();
  return col;
};
const userRef = (t, column) => t.uuid(column).references('id').inTable('users').onDelete('SET NULL');
const inList = (values) => values.map((v) => `'${v}'`).join(', ');

const ENQUIRY_STATUSES = ['pending', 'needs_review', 'processed', 'discarded', 'failed'];
const OUTCOMES = ['created', 'merged', 'reopened'];
const REVIEW_KINDS = ['routing', 'duplicate', 'extraction'];
const IMPORT_STATUSES = ['uploaded', 'queued', 'running', 'completed', 'failed', 'cancelled'];
const ROW_STATUSES = ['created', 'merged', 'reopened', 'review', 'error', 'skipped'];

export async function up(knex) {
  await knex.raw('create extension if not exists citext');

  // ---------- Website forms (per company) ----------
  await knex.schema.createTable('intake_forms', (t) => {
    id(knex, t);
    unitRef(t, 'group_id');
    unitRef(t, 'company_id');
    unitRef(t, 'unit_id'); // where leads from the form land unless an assignment pool decides
    t.specificType('key', 'citext').notNullable().unique(); // public id in the embed snippet and the hosted page
    t.text('name').notNullable();
    t.text('kind').notNullable().defaultTo('enquiry'); // enquiry | checkout (signed server hand-off)
    t.text('audience').notNullable().defaultTo('b2c');
    t.uuid('product_line_id').references('id').inTable('product_lines').onDelete('SET NULL');
    t.jsonb('fields').notNullable().defaultTo(knex.raw("'[]'::jsonb")); // [{ key, label, type, required, maps, options, placeholder }]
    t.jsonb('consent').notNullable().defaultTo(knex.raw("'{}'::jsonb")); // { text, required, channels }
    t.jsonb('spam').notNullable().defaultTo(knex.raw("'{}'::jsonb")); // { honeypot, minSeconds, captcha, allowedOrigins, perIpPerHour }
    t.jsonb('thank_you').notNullable().defaultTo(knex.raw("'{}'::jsonb")); // { mode, message, redirectUrl }
    t.text('signing_secret_enc'); // checkout forms: AES-256-GCM, for the HMAC hand-off signature
    t.boolean('active').notNullable().defaultTo(true);
    t.integer('submission_count').notNullable().defaultTo(0);
    t.integer('spam_count').notNullable().defaultTo(0);
    t.timestamp('last_submission_at', { useTz: true });
    userRef(t, 'created_by');
    timestamps(knex, t);
  });
  await knex.raw(`alter table intake_forms add constraint intake_forms_kind_chk check (kind in ('enquiry', 'checkout'))`);
  await knex.raw(`alter table intake_forms add constraint intake_forms_audience_chk check (audience in ('b2c', 'b2b'))`);
  await knex.raw('create index intake_forms_company_idx on intake_forms (company_id, created_at desc, id desc)');

  // ---------- Channel registry (routing) ----------
  await knex.schema.createTable('intake_channel_identities', (t) => {
    id(knex, t);
    unitRef(t, 'group_id');
    t.text('type').notNullable(); // core/intake CHANNEL_TYPES
    t.text('identity').notNullable(); // as entered: number, inbox, form id, host or page
    t.text('identity_normalized').notNullable(); // normalizeIdentity(type, identity)
    unitRef(t, 'company_id', { nullable: true }); // owner (owned channels)
    unitRef(t, 'unit_id', { nullable: true }); // landing unit inside the company
    t.uuid('product_line_id').references('id').inTable('product_lines').onDelete('SET NULL');
    t.boolean('shared').notNullable().defaultTo(false);
    t.specificType('company_ids', 'uuid[]').notNullable().defaultTo('{}'); // shared: companies it may route to
    t.text('label');
    t.boolean('active').notNullable().defaultTo(true);
    userRef(t, 'created_by');
    timestamps(knex, t);
  });
  await knex.raw(
    'alter table intake_channel_identities add constraint intake_identities_owner_chk check (shared or company_id is not null)',
  );
  await knex.raw(
    'create unique index intake_identities_uq on intake_channel_identities (group_id, type, identity_normalized)',
  );
  await knex.raw('create index intake_identities_company_idx on intake_channel_identities (company_id)');
  await knex.raw('create index intake_identities_shared_idx on intake_channel_identities using gin (company_ids)');

  // ---------- Assignment pools ----------
  await knex.schema.createTable('intake_assignment_pools', (t) => {
    id(knex, t);
    unitRef(t, 'group_id');
    unitRef(t, 'company_id');
    unitRef(t, 'unit_id'); // the team new leads land in
    t.text('name').notNullable();
    t.text('kind'); // b2c | b2b | null (both)
    t.specificType('product_line_ids', 'uuid[]').notNullable().defaultTo('{}'); // empty = any
    t.boolean('is_default').notNullable().defaultTo(false);
    t.text('language_match').notNullable().defaultTo('prefer'); // prefer | require | ignore
    t.text('working_hours').notNullable().defaultTo('prefer'); // prefer | require | ignore
    t.text('time_zone_match').notNullable().defaultTo('prefer'); // prefer | ignore
    t.integer('position').notNullable().defaultTo(0);
    t.boolean('active').notNullable().defaultTo(true);
    userRef(t, 'created_by');
    timestamps(knex, t);
  });
  await knex.raw(`alter table intake_assignment_pools add constraint intake_pools_kind_chk check (kind is null or kind in ('b2c', 'b2b'))`);
  await knex.raw(
    `alter table intake_assignment_pools add constraint intake_pools_modes_chk check (language_match in ('prefer', 'require', 'ignore') and working_hours in ('prefer', 'require', 'ignore') and time_zone_match in ('prefer', 'ignore'))`,
  );
  await knex.raw('create index intake_pools_company_idx on intake_assignment_pools (company_id, position)');

  await knex.schema.createTable('intake_pool_members', (t) => {
    t.uuid('pool_id').notNullable().references('id').inTable('intake_assignment_pools').onDelete('CASCADE');
    t.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.integer('capacity'); // open-lead cap; null = no cap
    t.specificType('languages', 'text[]').notNullable().defaultTo('{}');
    t.text('time_zone'); // falls back to the user's time zone
    t.boolean('active').notNullable().defaultTo(true);
    t.timestamp('away_until', { useTz: true }); // on leave until
    timestamps(knex, t);
    t.primary(['pool_id', 'user_id']);
  });
  await knex.raw('alter table intake_pool_members add constraint intake_pool_members_capacity_chk check (capacity is null or capacity >= 0)');
  await knex.raw('create index intake_pool_members_user_idx on intake_pool_members (user_id)');

  // Round-robin fairness state per pool, read FOR UPDATE so concurrent intakes take turns.
  await knex.schema.createTable('intake_assignment_state', (t) => {
    t.uuid('pool_id').primary().references('id').inTable('intake_assignment_pools').onDelete('CASCADE');
    t.jsonb('state').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  // ---------- Partner referral links ----------
  // Partners themselves arrive with the partners module (phase 10); partner_id refers to it.
  await knex.schema.createTable('intake_partner_links', (t) => {
    id(knex, t);
    unitRef(t, 'group_id');
    unitRef(t, 'company_id');
    t.specificType('code', 'citext').notNullable();
    t.uuid('partner_id').notNullable(); // defined by the partners module; no FK yet
    t.text('partner_name').notNullable();
    userRef(t, 'owner_user_id'); // the partner's counsellor: their leads stay with them
    t.uuid('product_line_id').references('id').inTable('product_lines').onDelete('SET NULL');
    t.uuid('form_id').references('id').inTable('intake_forms').onDelete('SET NULL'); // the form the link opens
    t.integer('click_count').notNullable().defaultTo(0);
    t.boolean('active').notNullable().defaultTo(true);
    userRef(t, 'created_by');
    timestamps(knex, t);
  });
  await knex.raw('create unique index intake_partner_links_code_uq on intake_partner_links (group_id, code)');
  await knex.raw('create index intake_partner_links_company_idx on intake_partner_links (company_id, created_at desc)');

  // ---------- Stored files (development storage behind the files port) ----------
  await knex.schema.createTable('intake_files', (t) => {
    id(knex, t);
    unitRef(t, 'group_id');
    t.text('name').notNullable();
    t.text('content_type').notNullable();
    t.integer('size').notNullable();
    t.text('body').notNullable();
    userRef(t, 'created_by');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  // ---------- CSV imports ----------
  await knex.schema.createTable('intake_import_jobs', (t) => {
    id(knex, t);
    unitRef(t, 'group_id');
    unitRef(t, 'company_id');
    unitRef(t, 'unit_id');
    t.text('file_ref').notNullable();
    t.text('file_name').notNullable();
    t.integer('file_size').notNullable();
    t.text('delimiter');
    t.jsonb('headers').notNullable().defaultTo(knex.raw("'[]'::jsonb"));
    t.jsonb('sample').notNullable().defaultTo(knex.raw("'[]'::jsonb")); // first rows, for the mapping screen
    t.jsonb('suggestions').notNullable().defaultTo(knex.raw("'[]'::jsonb"));
    t.jsonb('mapping').notNullable().defaultTo(knex.raw("'{}'::jsonb")); // column index → enquiry field
    t.jsonb('defaults').notNullable().defaultTo(knex.raw("'{}'::jsonb")); // { audience, productLineId, campaign, dateOrder }
    t.text('status').notNullable().defaultTo('uploaded');
    t.integer('total_rows').notNullable().defaultTo(0);
    t.integer('processed_rows').notNullable().defaultTo(0);
    t.integer('created_count').notNullable().defaultTo(0);
    t.integer('merged_count').notNullable().defaultTo(0);
    t.integer('reopened_count').notNullable().defaultTo(0);
    t.integer('review_count').notNullable().defaultTo(0);
    t.integer('error_count').notNullable().defaultTo(0);
    t.integer('warning_count').notNullable().defaultTo(0);
    t.jsonb('file_issues').notNullable().defaultTo(knex.raw("'[]'::jsonb"));
    t.text('error_report_ref');
    t.text('failure');
    t.timestamp('queued_at', { useTz: true });
    t.timestamp('started_at', { useTz: true });
    t.timestamp('finished_at', { useTz: true });
    userRef(t, 'created_by');
    timestamps(knex, t);
  });
  await knex.raw(`alter table intake_import_jobs add constraint intake_import_jobs_status_chk check (status in (${inList(IMPORT_STATUSES)}))`);
  await knex.raw('create index intake_import_jobs_company_idx on intake_import_jobs (company_id, created_at desc, id desc)');
  await knex.raw('create index intake_import_jobs_group_idx on intake_import_jobs (group_id, created_at desc, id desc)');

  // ---------- Enquiries ----------
  await knex.schema.createTable('intake_enquiries', (t) => {
    id(knex, t);
    unitRef(t, 'group_id');
    unitRef(t, 'company_id', { nullable: true }); // null until routed
    unitRef(t, 'unit_id', { nullable: true });
    t.text('channel_type').notNullable(); // core/intake channel type (website_form, whatsapp…)
    t.text('channel_identity'); // the number, inbox, form or host it arrived on
    t.text('deal_channel').notNullable(); // CRM channel key for the lead (website_form, voice_call…)
    t.uuid('identity_id').references('id').inTable('intake_channel_identities').onDelete('SET NULL');
    t.uuid('form_id').references('id').inTable('intake_forms').onDelete('SET NULL');
    t.uuid('import_job_id').references('id').inTable('intake_import_jobs').onDelete('SET NULL');
    t.uuid('partner_link_id').references('id').inTable('intake_partner_links').onDelete('SET NULL');
    t.uuid('partner_id');
    t.text('external_id');
    t.text('idempotency_key'); // channel + identity + external id, or the caller's key
    t.text('status').notNullable().defaultTo('pending');
    t.text('outcome'); // created | merged | reopened
    t.jsonb('raw').notNullable().defaultTo(knex.raw("'{}'::jsonb")); // original payload (personal data)
    t.jsonb('enquiry'); // normalised enquiry (personal data)
    t.jsonb('warnings').notNullable().defaultTo(knex.raw("'[]'::jsonb"));
    t.jsonb('ingest_options').notNullable().defaultTo(knex.raw("'{}'::jsonb")); // how it was ingested (owned company, unit, partner code), for retries
    t.jsonb('routing'); // route() result
    t.text('routing_reason');
    t.jsonb('dedup'); // findDuplicates() result (ids and scores only)
    t.text('dedup_decision'); // merge | suggest | new
    t.jsonb('assignment'); // assignOwner() result
    t.uuid('contact_id').references('id').inTable('contacts').onDelete('SET NULL');
    t.uuid('deal_id').references('id').inTable('deals').onDelete('SET NULL');
    t.text('failure');
    t.timestamp('received_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('processed_at', { useTz: true });
    userRef(t, 'created_by');
    timestamps(knex, t);
  });
  await knex.raw(`alter table intake_enquiries add constraint intake_enquiries_status_chk check (status in (${inList(ENQUIRY_STATUSES)}))`);
  await knex.raw(`alter table intake_enquiries add constraint intake_enquiries_outcome_chk check (outcome is null or outcome in (${inList(OUTCOMES)}))`);
  await knex.raw('create unique index intake_enquiries_idem_uq on intake_enquiries (idempotency_key)');
  await knex.raw('create index intake_enquiries_company_idx on intake_enquiries (company_id, received_at desc, id desc)');
  await knex.raw('create index intake_enquiries_group_idx on intake_enquiries (group_id, received_at desc, id desc)');
  await knex.raw('create index intake_enquiries_contact_idx on intake_enquiries (contact_id) where contact_id is not null');
  await knex.raw('create index intake_enquiries_deal_idx on intake_enquiries (deal_id) where deal_id is not null');
  await knex.raw('create index intake_enquiries_import_idx on intake_enquiries (import_job_id) where import_job_id is not null');

  // ---------- Review queue ----------
  await knex.schema.createTable('intake_review_items', (t) => {
    id(knex, t);
    unitRef(t, 'group_id');
    unitRef(t, 'company_id', { nullable: true }); // null: routing not decided yet
    unitRef(t, 'unit_id', { nullable: true }); // duplicates: the lead's unit
    t.specificType('candidate_company_ids', 'uuid[]').notNullable().defaultTo('{}'); // routing: companies it may belong to
    t.text('kind').notNullable(); // routing | duplicate | extraction
    t.text('status').notNullable().defaultTo('open'); // open | resolved
    t.uuid('enquiry_id').notNullable().references('id').inTable('intake_enquiries').onDelete('CASCADE');
    t.uuid('contact_id').references('id').inTable('contacts').onDelete('SET NULL'); // the enquiry's person
    t.uuid('candidate_contact_id').references('id').inTable('contacts').onDelete('SET NULL'); // the possible duplicate
    t.uuid('deal_id').references('id').inTable('deals').onDelete('SET NULL');
    t.text('reason').notNullable(); // routing reason, possible_duplicate, low_extraction_confidence
    t.text('message');
    t.decimal('confidence', 5, 4);
    t.jsonb('suggestion').notNullable().defaultTo(knex.raw("'{}'::jsonb")); // best guess or the duplicate's rules
    t.text('resolution'); // approved | overridden | discarded | merged | kept_separate | dismissed
    t.text('resolution_note');
    userRef(t, 'resolved_by');
    t.timestamp('resolved_at', { useTz: true });
    timestamps(knex, t);
  });
  await knex.raw(`alter table intake_review_items add constraint intake_review_kind_chk check (kind in (${inList(REVIEW_KINDS)}))`);
  await knex.raw(`alter table intake_review_items add constraint intake_review_status_chk check (status in ('open', 'resolved'))`);
  await knex.raw(
    'create unique index intake_review_items_uq on intake_review_items (enquiry_id, kind, candidate_contact_id) nulls not distinct',
  );
  await knex.raw('create index intake_review_group_idx on intake_review_items (group_id, status, created_at desc, id desc)');
  await knex.raw('create index intake_review_company_idx on intake_review_items (company_id, status, created_at desc, id desc)');
  await knex.raw('create index intake_review_candidates_idx on intake_review_items using gin (candidate_company_ids) where status = \'open\'');

  // A reviewer said "these are different people": not suggested again.
  await knex.schema.createTable('intake_not_duplicates', (t) => {
    unitRef(t, 'group_id');
    t.uuid('contact_a').notNullable(); // the smaller id
    t.uuid('contact_b').notNullable();
    userRef(t, 'created_by');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.primary(['contact_a', 'contact_b']);
  });
  await knex.raw('alter table intake_not_duplicates add constraint intake_not_duplicates_order_chk check (contact_a < contact_b)');
  await knex.raw('create index intake_not_duplicates_b_idx on intake_not_duplicates (contact_b)');

  // ---------- Per-row import results ----------
  await knex.schema.createTable('intake_import_rows', (t) => {
    t.uuid('job_id').notNullable().references('id').inTable('intake_import_jobs').onDelete('CASCADE');
    t.integer('row').notNullable();
    t.integer('line');
    t.text('status').notNullable();
    t.uuid('enquiry_id').references('id').inTable('intake_enquiries').onDelete('SET NULL');
    t.uuid('contact_id');
    t.uuid('deal_id');
    t.jsonb('issues').notNullable().defaultTo(knex.raw("'[]'::jsonb"));
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.primary(['job_id', 'row']);
  });
  await knex.raw(`alter table intake_import_rows add constraint intake_import_rows_status_chk check (status in (${inList(ROW_STATUSES)}))`);
  await knex.raw('create index intake_import_rows_status_idx on intake_import_rows (job_id, status, row)');
}

export async function down(knex) {
  for (const table of [
    'intake_import_rows',
    'intake_not_duplicates',
    'intake_review_items',
    'intake_enquiries',
    'intake_import_jobs',
    'intake_files',
    'intake_partner_links',
    'intake_assignment_state',
    'intake_pool_members',
    'intake_assignment_pools',
    'intake_channel_identities',
    'intake_forms',
  ]) {
    await knex.schema.dropTableIfExists(table);
  }
}
