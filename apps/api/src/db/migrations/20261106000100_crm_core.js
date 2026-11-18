// Phase 2, core CRM: contacts, households, institutes, product lines and products, pipelines and
// stages, lost reasons, custom fields, deals (a lead is a deal), stage history, timeline, tasks,
// saved views, consents and the search index. docs/crm/PHASE2_CONTRACT.md §5 describes every
// table; keep the two in step.
//
// Conventions (as in phase 1): UUID keys, timestamptz in UTC, money as bigint minor units plus an
// ISO currency, JSONB for typed profiles. Company-owned rows carry group_id, company_id and unit_id.
// Append-only tables (timeline, stage history) use bigint identities. The timeline has no foreign
// keys on its subjects, so it can be archived or partitioned and history outlives what it describes.
// People, institutes and deals are never hard-deleted (merge, erase and archive keep the rows).

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

const CONTACT_KINDS = ['parent', 'student', 'staff', 'other'];
const LINK_STATUSES = ['lead', 'customer', 'former'];
const DEAL_KINDS = ['b2c', 'b2b'];

export async function up(knex) {
  // Both live in the public schema of shared databases; creating them again is a no-op.
  await knex.raw('create extension if not exists pg_trgm');
  await knex.raw('create extension if not exists citext');

  // ---------- People (stored once per group) ----------
  await knex.schema.createTable('contacts', (t) => {
    id(knex, t);
    unitRef(t, 'group_id');
    t.text('kind').notNullable().defaultTo('other');
    t.text('first_name');
    t.text('last_name');
    t.text('display_name').notNullable(); // "Priya Sharma", or "Unnamed contact"
    t.text('name_normalized').notNullable().defaultTo(''); // core/crm/normalize.js normalizeName
    t.text('primary_phone'); // E.164, copied from contact_methods (personal data)
    t.text('primary_email'); // lower-case, copied from contact_methods (personal data)
    t.date('date_of_birth'); // personal data
    t.jsonb('address').notNullable().defaultTo(knex.raw("'{}'::jsonb")); // personal data
    t.text('city');
    t.specificType('country_code', 'char(2)');
    t.text('time_zone');
    t.text('language');
    t.jsonb('student_profile').notNullable().defaultTo(knex.raw("'{}'::jsonb")); // grade, school, board, targetExam, targetDate...
    t.uuid('merged_into_id').references('id').inTable('contacts').onDelete('RESTRICT');
    t.timestamp('merged_at', { useTz: true });
    t.timestamp('erased_at', { useTz: true });
    userRef(t, 'created_by');
    timestamps(knex, t);
  });
  await knex.raw(`alter table contacts add constraint contacts_kind_chk check (kind in (${inList(CONTACT_KINDS)}))`);
  await knex.raw('create index contacts_group_updated_idx on contacts (group_id, updated_at desc, id desc) where merged_into_id is null');
  await knex.raw('create index contacts_group_created_idx on contacts (group_id, created_at desc, id desc) where merged_into_id is null');
  await knex.raw('create index contacts_group_name_idx on contacts (group_id, name_normalized, id) where merged_into_id is null');
  await knex.raw('create index contacts_name_trgm_idx on contacts using gin (name_normalized gin_trgm_ops)');
  await knex.raw(
    "create index contacts_student_profile_idx on contacts using gin (student_profile jsonb_path_ops) where kind = 'student'",
  );
  await knex.raw('create index contacts_merged_into_idx on contacts (merged_into_id) where merged_into_id is not null');

  await knex.schema.createTable('contact_methods', (t) => {
    id(knex, t);
    t.uuid('contact_id').notNullable().references('id').inTable('contacts').onDelete('CASCADE');
    unitRef(t, 'group_id'); // copied from the contact, for group-wide exact lookups
    t.text('kind').notNullable();
    t.text('value').notNullable(); // as entered
    t.text('normalized').notNullable(); // E.164 or lower-case email
    t.text('label'); // "Mobile", "Father's WhatsApp"
    t.boolean('is_primary').notNullable().defaultTo(false);
    t.timestamp('verified_at', { useTz: true });
    t.timestamp('opted_out_at', { useTz: true }); // the person asked not to be contacted on this number/address
    timestamps(knex, t);
  });
  await knex.raw("alter table contact_methods add constraint contact_methods_kind_chk check (kind in ('phone', 'email', 'whatsapp'))");
  await knex.raw('create unique index contact_methods_value_uq on contact_methods (contact_id, kind, normalized)');
  await knex.raw('create unique index contact_methods_primary_uq on contact_methods (contact_id, kind) where is_primary');
  await knex.raw('create index contact_methods_lookup_idx on contact_methods (group_id, normalized)');

  await knex.schema.createTable('contact_companies', (t) => {
    id(knex, t);
    t.uuid('contact_id').notNullable().references('id').inTable('contacts').onDelete('CASCADE');
    unitRef(t, 'group_id');
    unitRef(t, 'company_id');
    unitRef(t, 'unit_id'); // the owning unit inside the company
    userRef(t, 'owner_user_id');
    t.text('status').notNullable().defaultTo('lead');
    t.timestamp('first_seen_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.jsonb('source'); // touch source of the first enquiry with this company
    t.specificType('tags', 'text[]').notNullable().defaultTo(knex.raw("'{}'::text[]"));
    t.jsonb('custom').notNullable().defaultTo(knex.raw("'{}'::jsonb")); // the company's custom contact fields
    t.timestamp('archived_at', { useTz: true }); // hidden from this company's lists
    userRef(t, 'created_by');
    timestamps(knex, t);
  });
  await knex.raw(`alter table contact_companies add constraint contact_companies_status_chk check (status in (${inList(LINK_STATUSES)}))`);
  await knex.raw('create unique index contact_companies_uq on contact_companies (contact_id, company_id)');
  await knex.raw('create index contact_companies_company_unit_idx on contact_companies (company_id, unit_id)');
  await knex.raw('create index contact_companies_unit_idx on contact_companies (unit_id)');
  await knex.raw('create index contact_companies_owner_idx on contact_companies (owner_user_id) where owner_user_id is not null');
  await knex.raw('create index contact_companies_tags_idx on contact_companies using gin (tags)');

  await knex.schema.createTable('households', (t) => {
    id(knex, t);
    unitRef(t, 'group_id');
    t.text('name').notNullable(); // "Sharma family"
    t.text('city');
    t.timestamp('archived_at', { useTz: true });
    userRef(t, 'created_by');
    timestamps(knex, t);
  });
  await knex.raw('create index households_group_idx on households (group_id, lower(name), id)');

  await knex.schema.createTable('household_members', (t) => {
    t.uuid('household_id').notNullable().references('id').inTable('households').onDelete('CASCADE');
    t.uuid('contact_id').notNullable().references('id').inTable('contacts').onDelete('CASCADE');
    t.text('role').notNullable();
    t.text('relation'); // "Mother", "Father", "Uncle"
    t.boolean('is_primary').notNullable().defaultTo(false); // the household's main contact
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.primary(['household_id', 'contact_id']);
  });
  await knex.raw(
    "alter table household_members add constraint household_members_role_chk check (role in ('parent', 'guardian', 'student', 'other'))",
  );
  await knex.raw('create index household_members_contact_idx on household_members (contact_id)');

  // ---------- Institutes (B2B accounts, stored once per group) ----------
  await knex.schema.createTable('accounts', (t) => {
    id(knex, t);
    unitRef(t, 'group_id');
    t.text('kind').notNullable(); // core/crm/constants.js ACCOUNT_KINDS
    t.text('name').notNullable();
    t.text('name_normalized').notNullable().defaultTo('');
    t.text('legal_name');
    t.text('website');
    t.specificType('domain', 'citext'); // normalised host, for de-duplication
    t.text('primary_phone'); // E.164 (masked like personal data)
    t.text('primary_email');
    t.text('city');
    t.text('state');
    t.specificType('country_code', 'char(2)');
    t.jsonb('address').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
    t.integer('branch_count');
    t.integer('student_count');
    t.text('current_software');
    t.jsonb('profile').notNullable().defaultTo(knex.raw("'{}'::jsonb")); // boards, exams, budget band...
    t.uuid('merged_into_id').references('id').inTable('accounts').onDelete('RESTRICT');
    t.timestamp('merged_at', { useTz: true });
    userRef(t, 'created_by');
    timestamps(knex, t);
  });
  await knex.raw('alter table accounts add constraint accounts_counts_chk check (coalesce(branch_count, 0) >= 0 and coalesce(student_count, 0) >= 0)');
  await knex.raw('create index accounts_group_updated_idx on accounts (group_id, updated_at desc, id desc) where merged_into_id is null');
  await knex.raw('create index accounts_group_created_idx on accounts (group_id, created_at desc, id desc) where merged_into_id is null');
  await knex.raw('create index accounts_group_name_idx on accounts (group_id, name_normalized, id) where merged_into_id is null');
  await knex.raw('create index accounts_name_trgm_idx on accounts using gin (name_normalized gin_trgm_ops)');
  await knex.raw('create index accounts_domain_idx on accounts (group_id, domain) where domain is not null');

  await knex.schema.createTable('account_companies', (t) => {
    id(knex, t);
    t.uuid('account_id').notNullable().references('id').inTable('accounts').onDelete('CASCADE');
    unitRef(t, 'group_id');
    unitRef(t, 'company_id');
    unitRef(t, 'unit_id');
    userRef(t, 'owner_user_id');
    t.text('status').notNullable().defaultTo('lead');
    t.timestamp('first_seen_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.jsonb('source');
    t.specificType('tags', 'text[]').notNullable().defaultTo(knex.raw("'{}'::text[]"));
    t.jsonb('custom').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
    t.timestamp('archived_at', { useTz: true });
    userRef(t, 'created_by');
    timestamps(knex, t);
  });
  await knex.raw(`alter table account_companies add constraint account_companies_status_chk check (status in (${inList(LINK_STATUSES)}))`);
  await knex.raw('create unique index account_companies_uq on account_companies (account_id, company_id)');
  await knex.raw('create index account_companies_company_unit_idx on account_companies (company_id, unit_id)');
  await knex.raw('create index account_companies_unit_idx on account_companies (unit_id)');
  await knex.raw('create index account_companies_owner_idx on account_companies (owner_user_id) where owner_user_id is not null');
  await knex.raw('create index account_companies_tags_idx on account_companies using gin (tags)');

  await knex.schema.createTable('account_contacts', (t) => {
    t.uuid('account_id').notNullable().references('id').inTable('accounts').onDelete('CASCADE');
    t.uuid('contact_id').notNullable().references('id').inTable('contacts').onDelete('CASCADE');
    t.text('title'); // job title: "Director", "Academic head"
    t.text('role').notNullable().defaultTo('other');
    t.boolean('is_primary').notNullable().defaultTo(false);
    timestamps(knex, t);
    t.primary(['account_id', 'contact_id']);
  });
  await knex.raw(
    "alter table account_contacts add constraint account_contacts_role_chk check (role in ('decision_maker', 'influencer', 'champion', 'user', 'billing', 'other'))",
  );
  await knex.raw('create index account_contacts_contact_idx on account_contacts (contact_id)');

  // ---------- Company configuration: catalog, pipelines, lost reasons, custom fields ----------
  await knex.schema.createTable('product_lines', (t) => {
    id(knex, t);
    unitRef(t, 'group_id');
    unitRef(t, 'company_id');
    t.specificType('key', 'citext').notNullable();
    t.text('name').notNullable();
    t.text('kind').notNullable(); // core/crm/constants.js PRODUCT_KINDS
    t.text('audience').notNullable(); // b2c | b2b, from the kind
    t.text('description');
    t.integer('position').notNullable().defaultTo(0);
    t.boolean('active').notNullable().defaultTo(true);
    userRef(t, 'created_by');
    timestamps(knex, t);
  });
  await knex.raw(`alter table product_lines add constraint product_lines_audience_chk check (audience in (${inList(DEAL_KINDS)}))`);
  await knex.raw('create unique index product_lines_key_uq on product_lines (company_id, key)');
  await knex.raw('create index product_lines_company_idx on product_lines (company_id, position)');

  await knex.schema.createTable('products', (t) => {
    id(knex, t);
    unitRef(t, 'group_id');
    unitRef(t, 'company_id');
    t.uuid('product_line_id').notNullable().references('id').inTable('product_lines').onDelete('RESTRICT');
    t.specificType('code', 'citext'); // short code / SKU, unique in the company
    t.text('name').notNullable();
    t.text('description');
    t.jsonb('attributes').notNullable().defaultTo(knex.raw("'{}'::jsonb")); // mode, sessions, durationWeeks...
    t.integer('position').notNullable().defaultTo(0);
    t.boolean('active').notNullable().defaultTo(true);
    userRef(t, 'created_by');
    timestamps(knex, t);
  });
  await knex.raw('create unique index products_code_uq on products (company_id, code) where code is not null');
  await knex.raw('create index products_line_idx on products (product_line_id, position)');
  await knex.raw('create index products_company_idx on products (company_id, position)');

  await knex.schema.createTable('pipelines', (t) => {
    id(knex, t);
    unitRef(t, 'group_id');
    unitRef(t, 'company_id');
    t.specificType('key', 'citext').notNullable();
    t.text('name').notNullable();
    t.text('kind').notNullable(); // b2c | b2b
    t.boolean('is_default').notNullable().defaultTo(false); // default pipeline for its kind
    t.specificType('product_line_ids', 'uuid[]').notNullable().defaultTo(knex.raw("'{}'::uuid[]")); // empty = any product line
    t.integer('position').notNullable().defaultTo(0);
    t.timestamp('archived_at', { useTz: true });
    userRef(t, 'created_by');
    timestamps(knex, t);
  });
  await knex.raw(`alter table pipelines add constraint pipelines_kind_chk check (kind in (${inList(DEAL_KINDS)}))`);
  await knex.raw('create unique index pipelines_key_uq on pipelines (company_id, key)');
  await knex.raw('create unique index pipelines_default_uq on pipelines (company_id, kind) where is_default and archived_at is null');
  await knex.raw('create index pipelines_company_idx on pipelines (company_id, position)');

  await knex.schema.createTable('pipeline_stages', (t) => {
    id(knex, t);
    t.uuid('pipeline_id').notNullable().references('id').inTable('pipelines').onDelete('CASCADE');
    unitRef(t, 'company_id');
    t.specificType('key', 'citext').notNullable();
    t.text('name').notNullable();
    t.text('category').notNullable(); // open | won | lost; a deal's status follows its stage
    t.integer('position').notNullable().defaultTo(0);
    t.integer('probability').notNullable().defaultTo(0); // 0..100, for weighted forecasts
    t.integer('sla_hours'); // time allowed in the stage; null = no target
    t.specificType('required_fields', 'text[]').notNullable().defaultTo(knex.raw("'{}'::text[]")); // to ENTER the stage
    t.jsonb('entry_rules').notNullable().defaultTo(knex.raw("'{}'::jsonb")); // { allowedFrom: [stage keys] }
    t.text('colour');
    t.timestamp('archived_at', { useTz: true });
    timestamps(knex, t);
  });
  await knex.raw("alter table pipeline_stages add constraint pipeline_stages_category_chk check (category in ('open', 'won', 'lost'))");
  await knex.raw('alter table pipeline_stages add constraint pipeline_stages_probability_chk check (probability between 0 and 100)');
  await knex.raw('alter table pipeline_stages add constraint pipeline_stages_sla_chk check (sla_hours is null or sla_hours > 0)');
  await knex.raw("alter table pipeline_stages add constraint pipeline_stages_colour_chk check (colour is null or colour ~ '^#[0-9A-Fa-f]{6}$')");
  await knex.raw('create unique index pipeline_stages_key_uq on pipeline_stages (pipeline_id, key)');
  await knex.raw('create index pipeline_stages_order_idx on pipeline_stages (pipeline_id, position)');

  await knex.schema.createTable('lost_reasons', (t) => {
    id(knex, t);
    unitRef(t, 'group_id');
    unitRef(t, 'company_id');
    t.specificType('label', 'citext').notNullable();
    t.text('kind'); // b2c | b2b | null for both
    t.boolean('requires_note').notNullable().defaultTo(false);
    t.integer('position').notNullable().defaultTo(0);
    t.boolean('active').notNullable().defaultTo(true);
    timestamps(knex, t);
  });
  await knex.raw(`alter table lost_reasons add constraint lost_reasons_kind_chk check (kind is null or kind in (${inList(DEAL_KINDS)}))`);
  await knex.raw('create unique index lost_reasons_label_uq on lost_reasons (company_id, label)');

  await knex.schema.createTable('custom_field_definitions', (t) => {
    id(knex, t);
    unitRef(t, 'group_id');
    unitRef(t, 'company_id');
    t.text('entity').notNullable(); // deal | contact | account
    t.specificType('key', 'citext').notNullable();
    t.text('label').notNullable();
    t.text('type').notNullable();
    t.jsonb('options').notNullable().defaultTo(knex.raw("'[]'::jsonb")); // [{ value, label }] for select types
    t.boolean('required').notNullable().defaultTo(false);
    t.text('applies_to'); // deal fields only: b2c | b2b | null for both
    t.text('help');
    t.integer('position').notNullable().defaultTo(0);
    t.boolean('active').notNullable().defaultTo(true);
    userRef(t, 'created_by');
    timestamps(knex, t);
  });
  await knex.raw(
    "alter table custom_field_definitions add constraint custom_field_definitions_entity_chk check (entity in ('deal', 'contact', 'account'))",
  );
  await knex.raw(
    "alter table custom_field_definitions add constraint custom_field_definitions_type_chk check (type in ('text', 'textarea', 'number', 'date', 'select', 'multiselect', 'boolean', 'phone', 'email', 'url'))",
  );
  await knex.raw(
    `alter table custom_field_definitions add constraint custom_field_definitions_applies_chk check (applies_to is null or (entity = 'deal' and applies_to in (${inList(DEAL_KINDS)})))`,
  );
  await knex.raw('create unique index custom_field_definitions_key_uq on custom_field_definitions (company_id, entity, key)');
  await knex.raw('create index custom_field_definitions_order_idx on custom_field_definitions (company_id, entity, position)');

  // Per-company counters, e.g. deal numbers (SP-1042).
  await knex.schema.createTable('crm_sequences', (t) => {
    unitRef(t, 'company_id');
    t.text('name').notNullable();
    t.bigInteger('value').notNullable().defaultTo(0);
    t.primary(['company_id', 'name']);
  });

  // ---------- Deals (a lead is a deal) ----------
  await knex.schema.createTable('deals', (t) => {
    id(knex, t);
    unitRef(t, 'group_id');
    unitRef(t, 'company_id');
    unitRef(t, 'unit_id');
    t.bigInteger('number').notNullable(); // per company, from crm_sequences
    t.text('ref').notNullable(); // "SP-1042": prefix at creation + number, never changes
    t.text('title').notNullable();
    t.text('kind').notNullable(); // b2c | b2b
    t.uuid('pipeline_id').notNullable().references('id').inTable('pipelines').onDelete('RESTRICT');
    t.uuid('stage_id').notNullable().references('id').inTable('pipeline_stages').onDelete('RESTRICT');
    t.text('status').notNullable().defaultTo('open'); // follows the stage category
    t.uuid('product_line_id').references('id').inTable('product_lines').onDelete('RESTRICT');
    t.uuid('product_id').references('id').inTable('products').onDelete('RESTRICT');
    userRef(t, 'owner_user_id');
    t.bigInteger('value_minor').notNullable().defaultTo(0);
    t.specificType('currency', 'char(3)').notNullable();
    t.uuid('primary_contact_id').references('id').inTable('contacts').onDelete('RESTRICT');
    t.uuid('household_id').references('id').inTable('households').onDelete('RESTRICT');
    t.uuid('account_id').references('id').inTable('accounts').onDelete('RESTRICT');
    t.text('channel').notNullable(); // enquiry channel key (module registry)
    t.jsonb('first_touch'); // { channel, campaign, utm, referrer, partnerId, landingUrl, formId, adId, at }
    t.jsonb('last_touch');
    t.jsonb('original_message'); // { channel, text, subject, receivedAt, from }
    t.jsonb('ai_fields').notNullable().defaultTo(knex.raw("'{}'::jsonb")); // filled by the intake agent (phase 4)
    t.jsonb('custom').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
    t.specificType('tags', 'text[]').notNullable().defaultTo(knex.raw("'{}'::text[]"));
    t.uuid('lost_reason_id').references('id').inTable('lost_reasons').onDelete('RESTRICT');
    t.text('lost_note');
    t.boolean('nurture').notNullable().defaultTo(false);
    t.timestamp('stage_entered_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('sla_due_at', { useTz: true }); // stage_entered_at + stage.sla_hours while open
    t.timestamp('sla_breached_at', { useTz: true }); // set once by the SLA sweep; cleared on every stage change
    t.timestamp('first_reply_due_at', { useTz: true });
    t.timestamp('first_replied_at', { useTz: true });
    t.timestamp('first_reply_breached_at', { useTz: true }); // set once by the SLA sweep
    t.date('expected_close_on');
    t.timestamp('closed_at', { useTz: true }); // set when won or lost
    t.timestamp('last_activity_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.text('source_event_id'); // idempotency key of the intake event that created it
    t.timestamp('archived_at', { useTz: true }); // soft delete
    userRef(t, 'created_by');
    timestamps(knex, t);
  });
  await knex.raw(`alter table deals add constraint deals_kind_chk check (kind in (${inList(DEAL_KINDS)}))`);
  await knex.raw("alter table deals add constraint deals_status_chk check (status in ('open', 'won', 'lost'))");
  await knex.raw('alter table deals add constraint deals_value_chk check (value_minor >= 0)');
  await knex.raw("alter table deals add constraint deals_currency_chk check (currency ~ '^[A-Z]{3}$')");
  await knex.raw("alter table deals add constraint deals_closed_chk check ((status = 'open') = (closed_at is null))");
  await knex.raw("alter table deals add constraint deals_lost_reason_chk check (status <> 'lost' or lost_reason_id is not null)");
  await knex.raw('alter table deals add constraint deals_subject_chk check (primary_contact_id is not null or account_id is not null)');
  await knex.raw('create unique index deals_number_uq on deals (company_id, number)');
  await knex.raw('create unique index deals_source_event_uq on deals (source_event_id) where source_event_id is not null');
  // Keyset indexes for every list sort (the id tie-breaker runs in the same direction; btree scans both ways).
  const live = 'where archived_at is null';
  await knex.raw(`create index deals_company_updated_idx on deals (company_id, updated_at desc, id desc) ${live}`);
  await knex.raw(`create index deals_group_updated_idx on deals (group_id, updated_at desc, id desc) ${live}`);
  await knex.raw(`create index deals_company_created_idx on deals (company_id, created_at desc, id desc) ${live}`);
  await knex.raw(`create index deals_company_activity_idx on deals (company_id, last_activity_at desc, id desc) ${live}`);
  await knex.raw(`create index deals_company_value_idx on deals (company_id, value_minor desc, id desc) ${live}`);
  await knex.raw(
    `create index deals_company_close_idx on deals (company_id, (coalesce(expected_close_on, 'infinity'::date)), id) ${live}`,
  );
  await knex.raw(
    `create index deals_company_sla_idx on deals (company_id, (coalesce(sla_due_at, 'infinity'::timestamptz)), id) ${live}`,
  );
  await knex.raw(`create index deals_company_stage_entered_idx on deals (company_id, stage_entered_at, id) ${live}`);
  // Own-scope lists ("my leads"), team lists and pipeline board columns.
  await knex.raw(`create index deals_owner_updated_idx on deals (owner_user_id, updated_at desc, id desc) ${live}`);
  await knex.raw(`create index deals_unit_updated_idx on deals (unit_id, updated_at desc, id desc) ${live}`);
  await knex.raw(`create index deals_stage_updated_idx on deals (pipeline_id, stage_id, updated_at desc, id desc) ${live}`);
  // First-reply targets still waiting for an answer.
  await knex.raw(
    `create index deals_first_reply_idx on deals (company_id, first_reply_due_at) where first_replied_at is null and status = 'open' and archived_at is null`,
  );
  // The SLA sweep: open deals past a target that haven't been flagged yet.
  await knex.raw(
    `create index deals_sla_sweep_idx on deals (sla_due_at) where status = 'open' and archived_at is null and sla_breached_at is null and sla_due_at is not null`,
  );
  await knex.raw(
    `create index deals_first_reply_sweep_idx on deals (first_reply_due_at) where status = 'open' and archived_at is null and first_replied_at is null and first_reply_breached_at is null and first_reply_due_at is not null`,
  );
  await knex.raw('create index deals_contact_idx on deals (primary_contact_id) where primary_contact_id is not null');
  await knex.raw('create index deals_account_idx on deals (account_id) where account_id is not null');
  await knex.raw('create index deals_household_idx on deals (household_id) where household_id is not null');
  await knex.raw('create index deals_tags_idx on deals using gin (tags)');
  await knex.raw('create index deals_title_trgm_idx on deals using gin (title gin_trgm_ops)');

  await knex.schema.createTable('deal_contacts', (t) => {
    t.uuid('deal_id').notNullable().references('id').inTable('deals').onDelete('CASCADE');
    t.uuid('contact_id').notNullable().references('id').inTable('contacts').onDelete('RESTRICT');
    t.text('role').notNullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.primary(['deal_id', 'contact_id']);
  });
  await knex.raw(
    "alter table deal_contacts add constraint deal_contacts_role_chk check (role in ('parent', 'student', 'guardian', 'decision_maker', 'influencer', 'other'))",
  );
  await knex.raw('create index deal_contacts_contact_idx on deal_contacts (contact_id, deal_id)');

  await knex.schema.createTable('deal_stage_history', (t) => {
    t.bigIncrements('id');
    t.uuid('deal_id').notNullable().references('id').inTable('deals').onDelete('CASCADE');
    t.uuid('group_id').notNullable();
    t.uuid('company_id').notNullable();
    t.uuid('pipeline_id').notNullable();
    t.uuid('from_stage_id'); // null when the deal was created
    t.uuid('to_stage_id').notNullable();
    t.text('from_status');
    t.text('to_status').notNullable();
    t.uuid('lost_reason_id');
    t.uuid('moved_by_user_id');
    t.bigInteger('seconds_in_from_stage');
    t.timestamp('moved_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw('create index deal_stage_history_deal_idx on deal_stage_history (deal_id, moved_at desc, id desc)');
  await knex.raw('create index deal_stage_history_company_idx on deal_stage_history (company_id, moved_at desc)');

  // ---------- Saved views ----------
  await knex.schema.createTable('saved_views', (t) => {
    id(knex, t);
    unitRef(t, 'group_id');
    unitRef(t, 'company_id', { nullable: true }); // null for a view on the whole group
    unitRef(t, 'unit_id'); // listed when working in this unit or below
    t.uuid('owner_user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.text('entity').notNullable().defaultTo('deals');
    t.text('name').notNullable();
    t.text('visibility').notNullable().defaultTo('personal');
    t.jsonb('filters').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
    t.text('sort').notNullable().defaultTo('-updatedAt');
    t.specificType('columns', 'text[]').notNullable().defaultTo(knex.raw("'{}'::text[]"));
    t.integer('position').notNullable().defaultTo(0);
    timestamps(knex, t);
  });
  await knex.raw("alter table saved_views add constraint saved_views_entity_chk check (entity in ('deals'))");
  await knex.raw("alter table saved_views add constraint saved_views_visibility_chk check (visibility in ('personal', 'shared'))");
  await knex.raw("create index saved_views_owner_idx on saved_views (owner_user_id, entity, position) where visibility = 'personal'");
  await knex.raw("create index saved_views_unit_idx on saved_views (unit_id, entity, position) where visibility = 'shared'");

  // ---------- Timeline (append-only, millions of rows) ----------
  await knex.raw(`
    create table timeline_events (
      id bigint generated always as identity primary key,
      group_id uuid not null,
      company_id uuid,            -- null: a group-level fact about a person
      unit_id uuid,
      deal_id uuid,
      contact_id uuid,
      account_id uuid,
      kind text not null,         -- core/crm/constants.js TIMELINE_KINDS (not constrained: later phases add kinds)
      channel text,
      direction text,
      title text,
      body text,
      meta jsonb not null default '{}'::jsonb,
      actor_type text not null default 'system',
      actor_user_id uuid,
      source_event_id text,       -- idempotency key for handlers and webhooks
      occurred_at timestamptz not null default now(),
      created_at timestamptz not null default now(),
      edited_at timestamptz,
      pinned_at timestamptz,
      deleted_at timestamptz,
      constraint timeline_events_subject_chk check (deal_id is not null or contact_id is not null or account_id is not null),
      constraint timeline_events_direction_chk check (direction is null or direction in ('inbound', 'outbound', 'internal')),
      constraint timeline_events_actor_chk check (actor_type in ('user', 'system', 'ai', 'contact'))
    )`);
  await knex.raw(
    'create index timeline_events_deal_idx on timeline_events (deal_id, occurred_at desc, id desc) where deal_id is not null',
  );
  await knex.raw(
    'create index timeline_events_contact_idx on timeline_events (contact_id, occurred_at desc, id desc) where contact_id is not null',
  );
  await knex.raw(
    'create index timeline_events_account_idx on timeline_events (account_id, occurred_at desc, id desc) where account_id is not null',
  );
  await knex.raw(
    'create unique index timeline_events_source_uq on timeline_events (source_event_id) where source_event_id is not null',
  );
  await knex.raw('create index timeline_events_occurred_brin on timeline_events using brin (occurred_at)');

  // Same shape, for entries moved out of the hot table (see the partitioning plan in the contract).
  await knex.raw(`
    create table timeline_events_archive (
      like timeline_events including defaults including constraints,
      archived_at timestamptz not null default now(),
      primary key (id)
    )`);
  await knex.raw(
    'create index timeline_events_archive_deal_idx on timeline_events_archive (deal_id, occurred_at desc, id desc) where deal_id is not null',
  );
  await knex.raw(
    'create index timeline_events_archive_contact_idx on timeline_events_archive (contact_id, occurred_at desc, id desc) where contact_id is not null',
  );
  await knex.raw(
    'create index timeline_events_archive_account_idx on timeline_events_archive (account_id, occurred_at desc, id desc) where account_id is not null',
  );

  // ---------- Tasks ----------
  await knex.schema.createTable('tasks', (t) => {
    id(knex, t);
    unitRef(t, 'group_id');
    unitRef(t, 'company_id');
    unitRef(t, 'unit_id');
    t.text('title').notNullable();
    t.text('notes');
    t.text('kind').notNullable().defaultTo('follow_up');
    t.text('priority').notNullable().defaultTo('normal');
    t.text('status').notNullable().defaultTo('open');
    t.timestamp('due_at', { useTz: true });
    t.timestamp('reminder_at', { useTz: true });
    t.timestamp('reminder_sent_at', { useTz: true });
    userRef(t, 'assignee_user_id');
    t.uuid('deal_id').references('id').inTable('deals').onDelete('RESTRICT');
    t.uuid('contact_id').references('id').inTable('contacts').onDelete('RESTRICT');
    t.uuid('account_id').references('id').inTable('accounts').onDelete('RESTRICT');
    userRef(t, 'created_by');
    t.timestamp('completed_at', { useTz: true });
    userRef(t, 'completed_by');
    timestamps(knex, t);
  });
  await knex.raw(
    "alter table tasks add constraint tasks_kind_chk check (kind in ('call', 'message', 'email', 'meeting', 'follow_up', 'other'))",
  );
  await knex.raw("alter table tasks add constraint tasks_priority_chk check (priority in ('low', 'normal', 'high'))");
  await knex.raw("alter table tasks add constraint tasks_status_chk check (status in ('open', 'done', 'cancelled'))");
  await knex.raw("alter table tasks add constraint tasks_completed_chk check ((status = 'done') = (completed_at is not null))");
  await knex.raw(
    "create index tasks_assignee_open_idx on tasks (assignee_user_id, (coalesce(due_at, 'infinity'::timestamptz)), id) where status = 'open'",
  );
  await knex.raw("create index tasks_assignee_done_idx on tasks (assignee_user_id, completed_at desc, id desc) where status = 'done'");
  await knex.raw(
    "create index tasks_company_open_idx on tasks (company_id, (coalesce(due_at, 'infinity'::timestamptz)), id) where status = 'open'",
  );
  await knex.raw('create index tasks_company_created_idx on tasks (company_id, created_at desc, id desc)');
  await knex.raw('create index tasks_unit_idx on tasks (unit_id)');
  await knex.raw('create index tasks_created_by_idx on tasks (created_by)');
  await knex.raw('create index tasks_deal_idx on tasks (deal_id, created_at desc) where deal_id is not null');
  await knex.raw('create index tasks_contact_idx on tasks (contact_id, created_at desc) where contact_id is not null');
  await knex.raw('create index tasks_account_idx on tasks (account_id, created_at desc) where account_id is not null');
  await knex.raw(
    "create index tasks_reminder_idx on tasks (reminder_at) where status = 'open' and reminder_at is not null and reminder_sent_at is null",
  );

  // ---------- Consent and opt-out (DPDP Act) ----------
  await knex.schema.createTable('consents', (t) => {
    id(knex, t);
    unitRef(t, 'group_id');
    t.uuid('contact_id').notNullable().references('id').inTable('contacts').onDelete('RESTRICT');
    unitRef(t, 'company_id', { nullable: true }); // null = for the whole group
    t.text('channel').notNullable();
    t.text('purpose').notNullable();
    t.text('status').notNullable();
    t.text('source').notNullable(); // core/crm/constants.js CONSENT_SOURCES
    t.jsonb('evidence').notNullable().defaultTo(knex.raw("'{}'::jsonb")); // form URL, IP, message id, wording shown...
    t.timestamp('captured_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    userRef(t, 'captured_by');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(
    "alter table consents add constraint consents_channel_chk check (channel in ('whatsapp', 'sms', 'email', 'voice', 'all'))",
  );
  await knex.raw("alter table consents add constraint consents_purpose_chk check (purpose in ('marketing', 'transactional', 'service'))");
  await knex.raw("alter table consents add constraint consents_status_chk check (status in ('granted', 'withdrawn'))");
  await knex.raw('create index consents_contact_idx on consents (contact_id, channel, purpose, captured_at desc)');

  // ---------- Search index ----------
  await knex.raw(`
    create table search_documents (
      entity_type text not null,
      entity_id uuid not null,
      group_id uuid not null,
      company_id uuid,
      unit_id uuid,
      owner_user_id uuid,
      title text not null,
      subtitle text,
      keywords text not null default '',
      tsv tsvector generated always as (
        setweight(to_tsvector('simple'::regconfig, coalesce(title, '')), 'A') ||
        setweight(to_tsvector('simple'::regconfig, coalesce(keywords, '')), 'A') ||
        setweight(to_tsvector('simple'::regconfig, coalesce(subtitle, '')), 'B')
      ) stored,
      updated_at timestamptz not null default now(),
      primary key (entity_type, entity_id),
      constraint search_documents_type_chk check (entity_type in ('deal', 'contact', 'account'))
    )`);
  await knex.raw('create index search_documents_tsv_idx on search_documents using gin (tsv)');
  await knex.raw('create index search_documents_title_trgm_idx on search_documents using gin (title gin_trgm_ops)');
  await knex.raw('create index search_documents_keywords_trgm_idx on search_documents using gin (keywords gin_trgm_ops)');
  await knex.raw('create index search_documents_scope_idx on search_documents (group_id, entity_type, company_id)');

}

export async function down(knex) {
  // The pg_trgm and citext extensions stay: other schemas and databases on the server use them.
  for (const table of [
    'search_documents',
    'consents',
    'tasks',
    'timeline_events_archive',
    'timeline_events',
    'saved_views',
    'deal_stage_history',
    'deal_contacts',
    'deals',
    'crm_sequences',
    'custom_field_definitions',
    'lost_reasons',
    'pipeline_stages',
    'pipelines',
    'products',
    'product_lines',
    'account_contacts',
    'account_companies',
    'accounts',
    'household_members',
    'households',
    'contact_companies',
    'contact_methods',
    'contacts',
  ]) {
    await knex.schema.dropTableIfExists(table);
  }
}
