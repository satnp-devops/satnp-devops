// Phase 8 (admissions and delivery): batches, enrollments, waitlists, withdrawals and refund
// requests, website checkout sessions, onboarding checklists (B2C), implementation projects (B2B)
// and the renewals read model (fed by the money module's subscription events).
// docs/delivery/DELIVERY.md describes every table; keep the two in step.
//
// Conventions as in phase 2: UUID keys, timestamptz in UTC, calendar dates as `date`, money as
// bigint minor units plus an ISO currency. Company-owned rows carry group_id, company_id, unit_id
// and (where "own" scope applies) owner_user_id, so core/crm/scope.js filters them like deals.
// Ids that belong to the money module (payments, subscriptions, contracts, refunds) are text
// without foreign keys: those tables live in another module and may be partitioned or external.

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

function owned(knex, t) {
  unitRef(t, 'group_id');
  unitRef(t, 'company_id');
  unitRef(t, 'unit_id');
}

const inList = (values) => values.map((v) => `'${v}'`).join(', ');
const check = (knex, table, name, sql) => knex.raw(`alter table ${table} add constraint ${table}_${name}_chk check (${sql})`);

const BATCH_MODES = ['online', 'centre', 'hybrid'];
const BATCH_STATUSES = ['planned', 'open', 'closed', 'completed', 'cancelled'];
const REFUND_UNITS = ['days', 'classes'];
const ENROLLMENT_STATUSES = ['active', 'paused', 'withdrawn', 'completed'];
const SEAT_STATUSES = ['seated', 'waitlisted', 'unassigned'];
const ACCESS_STATUSES = ['not_required', 'pending', 'granted', 'suspended', 'revoked'];
const ENROLLMENT_SOURCES = ['checkout', 'payment', 'manual'];
const WAITLIST_STATUSES = ['waiting', 'promoted', 'removed'];
const WITHDRAWAL_CHANNELS = ['form', 'whatsapp', 'email', 'phone', 'counter', 'portal', 'other'];
const REFUND_STATUSES = ['requested', 'processing', 'paid', 'not_applicable', 'failed'];
const CHECKOUT_STATUSES = ['pending', 'paid', 'completed', 'expired', 'failed'];
const TEMPLATE_KINDS = ['b2c', 'b2b'];
const OWNER_ROLES = ['record_owner', 'batch_teacher', 'unassigned'];
const ITEM_STATUSES = ['pending', 'done', 'skipped'];
const PROJECT_STATUSES = ['planned', 'in_progress', 'live', 'on_hold', 'cancelled'];
const PHASE_STATUSES = ['pending', 'in_progress', 'done'];
const RENEWAL_STATUSES = ['active', 'cancelled', 'ended'];
const CHURN_LEVELS = ['low', 'medium', 'high'];

export async function up(knex) {
  // ---------- Batches ----------
  await knex.schema.createTable('batches', (t) => {
    id(knex, t);
    owned(knex, t);
    t.uuid('product_line_id').references('id').inTable('product_lines').onDelete('RESTRICT');
    t.uuid('product_id').notNullable().references('id').inTable('products').onDelete('RESTRICT');
    t.specificType('code', 'citext'); // "SAT-JAN27-EVE", unique per company when set
    t.text('name').notNullable();
    t.text('mode').notNullable().defaultTo('online');
    // { days: ['mon','wed'], startTime: '17:00', endTime: '19:00', timeZone: 'Asia/Kolkata', notes }
    t.jsonb('schedule').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
    t.date('starts_on').notNullable();
    t.date('ends_on').notNullable();
    t.integer('capacity').notNullable();
    t.boolean('waitlist_enabled').notNullable().defaultTo(true);
    t.integer('waitlist_limit'); // null = no limit
    t.integer('seats_taken').notNullable().defaultTo(0); // active + paused enrollments seated here
    t.integer('waitlist_count').notNullable().defaultTo(0);
    t.bigInteger('fee_minor'); // the published fee for this batch (the checkout price, locked per enrollment)
    t.specificType('currency', 'char(3)');
    t.boolean('checkout_enabled').notNullable().defaultTo(false);
    userRef(t, 'teacher_user_id');
    t.text('teacher_name'); // a visiting teacher without an account
    t.text('location');
    t.text('status').notNullable().defaultTo('open');
    t.text('refund_unit').notNullable().defaultTo('days'); // pro-rata basis: calendar days or classes
    t.integer('total_classes'); // required when refund_unit = classes
    userRef(t, 'created_by');
    timestamps(knex, t);
  });
  await check(knex, 'batches', 'mode', `mode in (${inList(BATCH_MODES)})`);
  await check(knex, 'batches', 'status', `status in (${inList(BATCH_STATUSES)})`);
  await check(knex, 'batches', 'refund_unit', `refund_unit in (${inList(REFUND_UNITS)})`);
  await check(knex, 'batches', 'capacity', 'capacity > 0 and capacity <= 100000');
  await check(knex, 'batches', 'seats', 'seats_taken >= 0 and waitlist_count >= 0');
  await check(knex, 'batches', 'dates', 'ends_on >= starts_on');
  await check(knex, 'batches', 'fee', "(fee_minor is null or fee_minor >= 0) and (currency is null or currency ~ '^[A-Z]{3}$')");
  await check(knex, 'batches', 'checkout', 'not checkout_enabled or (fee_minor is not null and currency is not null)');
  await check(knex, 'batches', 'classes', "refund_unit <> 'classes' or (total_classes is not null and total_classes > 0)");
  await knex.raw('create unique index batches_code_uq on batches (company_id, code) where code is not null');
  await knex.raw('create index batches_company_start_idx on batches (company_id, starts_on desc, id desc)');
  await knex.raw('create index batches_group_start_idx on batches (group_id, starts_on desc, id desc)');
  await knex.raw('create index batches_unit_idx on batches (unit_id)');
  await knex.raw('create index batches_product_idx on batches (product_id, starts_on)');
  await knex.raw('create index batches_teacher_idx on batches (teacher_user_id) where teacher_user_id is not null');

  // ---------- Checkout sessions (public website checkout) ----------
  await knex.schema.createTable('checkout_sessions', (t) => {
    id(knex, t);
    owned(knex, t); // the batch's unit
    t.uuid('batch_id').notNullable().references('id').inTable('batches').onDelete('RESTRICT');
    t.uuid('product_id').notNullable().references('id').inTable('products').onDelete('RESTRICT');
    t.text('token_hash').notNullable(); // sha256 of the token the browser holds to poll its status
    t.text('status').notNullable().defaultTo('pending');
    t.bigInteger('amount_minor').notNullable();
    t.specificType('currency', 'char(3)').notNullable();
    t.jsonb('details').notNullable().defaultTo(knex.raw("'{}'::jsonb")); // parent + student (personal data, purged on expiry)
    t.jsonb('consent').notNullable().defaultTo(knex.raw("'{}'::jsonb")); // acknowledgement, policy version, marketing opt-ins, evidence
    t.text('payment_link_id');
    t.text('payment_link_url');
    t.text('payment_provider');
    t.text('payment_id');
    t.timestamp('paid_at', { useTz: true });
    t.uuid('enrollment_id'); // set when the enrollment is created (no FK: enrollments point back here)
    t.timestamp('expires_at', { useTz: true }).notNullable();
    t.timestamp('purged_at', { useTz: true });
    timestamps(knex, t);
  });
  await check(knex, 'checkout_sessions', 'status', `status in (${inList(CHECKOUT_STATUSES)})`);
  await check(knex, 'checkout_sessions', 'amount', "amount_minor > 0 and currency ~ '^[A-Z]{3}$'");
  await knex.raw('create index checkout_sessions_expiry_idx on checkout_sessions (expires_at) where status = \'pending\'');
  await knex.raw('create index checkout_sessions_company_idx on checkout_sessions (company_id, created_at desc)');
  await knex.raw('create unique index checkout_sessions_payment_uq on checkout_sessions (payment_id) where payment_id is not null');

  // ---------- Enrollments ----------
  await knex.schema.createTable('enrollments', (t) => {
    id(knex, t);
    owned(knex, t);
    t.bigInteger('number').notNullable(); // per company (crm_sequences name 'enrollment')
    t.text('ref').notNullable(); // "SP-E1001", fixed at creation
    t.uuid('student_contact_id').notNullable().references('id').inTable('contacts').onDelete('RESTRICT');
    t.uuid('payer_contact_id').references('id').inTable('contacts').onDelete('RESTRICT');
    t.uuid('household_id').references('id').inTable('households').onDelete('RESTRICT');
    t.uuid('deal_id').references('id').inTable('deals').onDelete('RESTRICT');
    t.uuid('product_line_id').references('id').inTable('product_lines').onDelete('RESTRICT');
    t.uuid('product_id').notNullable().references('id').inTable('products').onDelete('RESTRICT');
    t.uuid('batch_id').references('id').inTable('batches').onDelete('RESTRICT');
    userRef(t, 'owner_user_id');
    t.text('status').notNullable().defaultTo('active');
    t.text('seat_status').notNullable().defaultTo('unassigned');
    t.text('access_status').notNullable().defaultTo('pending');
    t.timestamp('access_updated_at', { useTz: true });
    t.text('source').notNullable().defaultTo('manual');
    t.text('source_key'); // idempotency key (payment:<id>:<student>, checkout:<session>)
    t.uuid('checkout_session_id').references('id').inTable('checkout_sessions').onDelete('SET NULL');
    t.bigInteger('fee_minor'); // fee locked at enrollment
    t.specificType('currency', 'char(3)');
    t.bigInteger('paid_minor').notNullable().defaultTo(0); // sum of enrollment_payments
    t.timestamp('enrolled_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.date('starts_on');
    t.date('ends_on');
    t.timestamp('paused_at', { useTz: true });
    t.date('resume_on');
    t.text('pause_reason');
    t.timestamp('withdrawn_at', { useTz: true });
    t.timestamp('completed_at', { useTz: true });
    userRef(t, 'created_by');
    timestamps(knex, t);
  });
  await check(knex, 'enrollments', 'status', `status in (${inList(ENROLLMENT_STATUSES)})`);
  await check(knex, 'enrollments', 'seat', `seat_status in (${inList(SEAT_STATUSES)})`);
  await check(knex, 'enrollments', 'seated', "(seat_status = 'seated') = (batch_id is not null)");
  await check(knex, 'enrollments', 'access', `access_status in (${inList(ACCESS_STATUSES)})`);
  await check(knex, 'enrollments', 'source', `source in (${inList(ENROLLMENT_SOURCES)})`);
  await check(knex, 'enrollments', 'money', "paid_minor >= 0 and (fee_minor is null or fee_minor >= 0) and (currency is null or currency ~ '^[A-Z]{3}$')");
  await check(knex, 'enrollments', 'paused', "(status = 'paused') = (paused_at is not null)");
  await knex.raw('create unique index enrollments_number_uq on enrollments (company_id, number)');
  await knex.raw('create unique index enrollments_source_uq on enrollments (source_key) where source_key is not null');
  await knex.raw(
    'create unique index enrollments_deal_student_uq on enrollments (deal_id, student_contact_id, product_id) where deal_id is not null',
  );
  await knex.raw('create index enrollments_company_created_idx on enrollments (company_id, created_at desc, id desc)');
  await knex.raw('create index enrollments_group_created_idx on enrollments (group_id, created_at desc, id desc)');
  await knex.raw('create index enrollments_owner_created_idx on enrollments (owner_user_id, created_at desc, id desc)');
  await knex.raw('create index enrollments_unit_idx on enrollments (unit_id)');
  await knex.raw('create index enrollments_batch_idx on enrollments (batch_id, status) where batch_id is not null');
  await knex.raw('create index enrollments_student_idx on enrollments (student_contact_id)');
  await knex.raw('create index enrollments_payer_idx on enrollments (payer_contact_id) where payer_contact_id is not null');
  await knex.raw('create index enrollments_deal_idx on enrollments (deal_id) where deal_id is not null');
  await knex.raw('create index enrollments_household_idx on enrollments (household_id) where household_id is not null');
  await knex.raw("create index enrollments_resume_idx on enrollments (resume_on) where status = 'paused' and resume_on is not null");

  await knex.schema.createTable('enrollment_payments', (t) => {
    id(knex, t);
    t.uuid('enrollment_id').notNullable().references('id').inTable('enrollments').onDelete('CASCADE');
    t.text('payment_id').notNullable(); // the money module's payment id
    t.bigInteger('amount_minor').notNullable();
    t.specificType('currency', 'char(3)').notNullable();
    t.timestamp('paid_at', { useTz: true }).notNullable();
    t.text('source_event_id');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw('create unique index enrollment_payments_uq on enrollment_payments (enrollment_id, payment_id)');
  await knex.raw('create index enrollment_payments_payment_idx on enrollment_payments (payment_id)');

  // ---------- Waitlist ----------
  await knex.schema.createTable('waitlist_entries', (t) => {
    id(knex, t);
    owned(knex, t); // the batch's
    t.uuid('batch_id').notNullable().references('id').inTable('batches').onDelete('CASCADE');
    t.uuid('enrollment_id').notNullable().references('id').inTable('enrollments').onDelete('CASCADE');
    // Order of admission: free seats go first come, first served (a business rule; placement never looks at
    // marks, in line with MoE guidelines 2024 cl. 12(vii), which forbid segregating batches by performance).
    t.specificType('queued_seq', 'bigint generated always as identity');
    t.timestamp('queued_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.text('status').notNullable().defaultTo('waiting');
    t.timestamp('resolved_at', { useTz: true });
    t.text('resolution'); // promoted | moved | withdrawn | removed
    timestamps(knex, t);
  });
  await check(knex, 'waitlist_entries', 'status', `status in (${inList(WAITLIST_STATUSES)})`);
  await knex.raw("create unique index waitlist_entries_waiting_uq on waitlist_entries (enrollment_id) where status = 'waiting'");
  await knex.raw("create index waitlist_entries_queue_idx on waitlist_entries (batch_id, queued_seq) where status = 'waiting'");

  // ---------- Withdrawals (and the refund they request) ----------
  await knex.schema.createTable('enrollment_withdrawals', (t) => {
    id(knex, t);
    owned(knex, t);
    t.uuid('enrollment_id').notNullable().references('id').inTable('enrollments').onDelete('RESTRICT');
    t.timestamp('received_at', { useTz: true }).notNullable(); // the refund clock starts here
    t.text('channel').notNullable();
    t.text('reason'); // optional: never required before the clock starts
    t.uuid('requested_by_contact_id').references('id').inTable('contacts').onDelete('RESTRICT');
    t.date('effective_on').notNullable(); // the last day the student attends
    t.jsonb('refund_basis').notNullable().defaultTo(knex.raw("'{}'::jsonb")); // computation inputs (audit evidence)
    t.bigInteger('refund_minor').notNullable().defaultTo(0);
    t.specificType('currency', 'char(3)');
    t.timestamp('refund_due_at', { useTz: true }).notNullable();
    t.text('refund_status').notNullable().defaultTo('requested');
    t.text('refund_reference'); // the money module's refund id or payout UTR
    t.timestamp('refund_paid_at', { useTz: true });
    userRef(t, 'recorded_by');
    timestamps(knex, t);
  });
  await check(knex, 'enrollment_withdrawals', 'channel', `channel in (${inList(WITHDRAWAL_CHANNELS)})`);
  await check(knex, 'enrollment_withdrawals', 'refund_status', `refund_status in (${inList(REFUND_STATUSES)})`);
  await check(knex, 'enrollment_withdrawals', 'refund', 'refund_minor >= 0');
  await knex.raw('create unique index enrollment_withdrawals_enrollment_uq on enrollment_withdrawals (enrollment_id)');
  await knex.raw(
    "create index enrollment_withdrawals_due_idx on enrollment_withdrawals (company_id, refund_due_at) where refund_status in ('requested', 'processing')",
  );

  // ---------- Onboarding templates (configuration per company and product) ----------
  await knex.schema.createTable('onboarding_templates', (t) => {
    id(knex, t);
    unitRef(t, 'group_id');
    unitRef(t, 'company_id');
    t.text('kind').notNullable(); // b2c checklist for an enrollment, b2b implementation project
    t.text('name').notNullable();
    t.uuid('product_line_id').references('id').inTable('product_lines').onDelete('RESTRICT');
    t.uuid('product_id').references('id').inTable('products').onDelete('RESTRICT');
    // b2b: the project's phases in order [{ key, name, offsetDays }]
    t.jsonb('phases').notNullable().defaultTo(knex.raw("'[]'::jsonb"));
    t.boolean('active').notNullable().defaultTo(true);
    userRef(t, 'created_by');
    timestamps(knex, t);
  });
  await check(knex, 'onboarding_templates', 'kind', `kind in (${inList(TEMPLATE_KINDS)})`);
  await knex.raw('create index onboarding_templates_company_idx on onboarding_templates (company_id, kind)');

  await knex.schema.createTable('onboarding_template_items', (t) => {
    id(knex, t);
    t.uuid('template_id').notNullable().references('id').inTable('onboarding_templates').onDelete('CASCADE');
    t.text('phase_key'); // b2b only: which phase the task belongs to
    t.text('title').notNullable();
    t.text('description');
    t.text('owner_role').notNullable().defaultTo('record_owner');
    t.integer('due_offset_days').notNullable().defaultTo(0); // from the enrollment's start or the project's kickoff
    t.integer('position').notNullable().defaultTo(0);
  });
  await check(knex, 'onboarding_template_items', 'owner_role', `owner_role in (${inList(OWNER_ROLES)})`);
  await knex.raw('create index onboarding_template_items_idx on onboarding_template_items (template_id, position)');

  // ---------- B2C checklists (one per enrollment) ----------
  await knex.schema.createTable('onboarding_checklists', (t) => {
    id(knex, t);
    owned(knex, t);
    t.uuid('enrollment_id').notNullable().references('id').inTable('enrollments').onDelete('CASCADE');
    t.uuid('template_id').references('id').inTable('onboarding_templates').onDelete('SET NULL');
    t.text('name').notNullable();
    userRef(t, 'owner_user_id');
    t.text('status').notNullable().defaultTo('open');
    t.integer('items_total').notNullable().defaultTo(0);
    t.integer('items_done').notNullable().defaultTo(0); // done or skipped
    t.timestamp('completed_at', { useTz: true });
    timestamps(knex, t);
  });
  await check(knex, 'onboarding_checklists', 'status', "status in ('open', 'done')");
  await knex.raw('create unique index onboarding_checklists_enrollment_uq on onboarding_checklists (enrollment_id)');
  await knex.raw('create index onboarding_checklists_company_idx on onboarding_checklists (company_id, created_at desc, id desc)');
  await knex.raw('create index onboarding_checklists_group_idx on onboarding_checklists (group_id, created_at desc, id desc)');
  await knex.raw('create index onboarding_checklists_owner_idx on onboarding_checklists (owner_user_id, created_at desc, id desc)');
  await knex.raw('create index onboarding_checklists_unit_idx on onboarding_checklists (unit_id)');

  await knex.schema.createTable('onboarding_checklist_items', (t) => {
    id(knex, t);
    t.uuid('checklist_id').notNullable().references('id').inTable('onboarding_checklists').onDelete('CASCADE');
    t.text('title').notNullable();
    t.text('description');
    t.text('status').notNullable().defaultTo('pending');
    userRef(t, 'owner_user_id');
    t.date('due_on');
    t.integer('position').notNullable().defaultTo(0);
    t.timestamp('completed_at', { useTz: true });
    userRef(t, 'completed_by');
    timestamps(knex, t);
  });
  await check(knex, 'onboarding_checklist_items', 'status', `status in (${inList(ITEM_STATUSES)})`);
  await knex.raw('create index onboarding_checklist_items_idx on onboarding_checklist_items (checklist_id, position)');
  await knex.raw(
    "create index onboarding_checklist_items_owner_idx on onboarding_checklist_items (owner_user_id, due_on) where status = 'pending'",
  );

  // ---------- B2B implementation projects ----------
  await knex.schema.createTable('implementation_projects', (t) => {
    id(knex, t);
    owned(knex, t);
    t.uuid('account_id').notNullable().references('id').inTable('accounts').onDelete('RESTRICT');
    t.uuid('deal_id').references('id').inTable('deals').onDelete('RESTRICT');
    t.text('subscription_id'); // money module ids (no FK)
    t.text('contract_id');
    t.uuid('product_line_id').references('id').inTable('product_lines').onDelete('RESTRICT');
    t.uuid('product_id').references('id').inTable('products').onDelete('RESTRICT');
    t.uuid('template_id').references('id').inTable('onboarding_templates').onDelete('SET NULL');
    t.text('name').notNullable();
    t.text('status').notNullable().defaultTo('planned');
    userRef(t, 'owner_user_id');
    t.date('kickoff_on');
    t.date('target_go_live_on');
    t.timestamp('went_live_at', { useTz: true });
    t.text('source_key').notNullable(); // deal:<id> | subscription:<id> | contract:<id> | manual:<uuid>
    t.integer('tasks_total').notNullable().defaultTo(0);
    t.integer('tasks_done').notNullable().defaultTo(0);
    userRef(t, 'created_by');
    timestamps(knex, t);
  });
  await check(knex, 'implementation_projects', 'status', `status in (${inList(PROJECT_STATUSES)})`);
  await knex.raw('create unique index implementation_projects_source_uq on implementation_projects (source_key)');
  await knex.raw('create unique index implementation_projects_deal_uq on implementation_projects (deal_id) where deal_id is not null');
  await knex.raw(
    'create index implementation_projects_subscription_idx on implementation_projects (subscription_id) where subscription_id is not null',
  );
  await knex.raw('create index implementation_projects_company_idx on implementation_projects (company_id, created_at desc, id desc)');
  await knex.raw('create index implementation_projects_group_idx on implementation_projects (group_id, created_at desc, id desc)');
  await knex.raw('create index implementation_projects_owner_idx on implementation_projects (owner_user_id, created_at desc, id desc)');
  await knex.raw('create index implementation_projects_unit_idx on implementation_projects (unit_id)');
  await knex.raw('create index implementation_projects_account_idx on implementation_projects (account_id)');

  await knex.schema.createTable('implementation_phases', (t) => {
    id(knex, t);
    t.uuid('project_id').notNullable().references('id').inTable('implementation_projects').onDelete('CASCADE');
    t.text('key').notNullable(); // kickoff, data_import, training, go_live (from the template)
    t.text('name').notNullable();
    t.integer('position').notNullable().defaultTo(0);
    t.text('status').notNullable().defaultTo('pending');
    userRef(t, 'owner_user_id');
    t.date('due_on');
    t.timestamp('completed_at', { useTz: true });
    timestamps(knex, t);
  });
  await check(knex, 'implementation_phases', 'status', `status in (${inList(PHASE_STATUSES)})`);
  await knex.raw('create unique index implementation_phases_key_uq on implementation_phases (project_id, key)');

  await knex.schema.createTable('implementation_tasks', (t) => {
    id(knex, t);
    t.uuid('project_id').notNullable().references('id').inTable('implementation_projects').onDelete('CASCADE');
    t.uuid('phase_id').notNullable().references('id').inTable('implementation_phases').onDelete('CASCADE');
    t.text('title').notNullable();
    t.text('description');
    t.text('status').notNullable().defaultTo('pending');
    userRef(t, 'owner_user_id');
    t.date('due_on');
    t.integer('position').notNullable().defaultTo(0);
    t.timestamp('completed_at', { useTz: true });
    userRef(t, 'completed_by');
    timestamps(knex, t);
  });
  await check(knex, 'implementation_tasks', 'status', `status in (${inList(ITEM_STATUSES)})`);
  await knex.raw('create index implementation_tasks_project_idx on implementation_tasks (project_id, phase_id, position)');
  await knex.raw("create index implementation_tasks_owner_idx on implementation_tasks (owner_user_id, due_on) where status = 'pending'");

  // ---------- Renewals (read model of the money module's subscriptions) ----------
  await knex.schema.createTable('renewals', (t) => {
    id(knex, t);
    owned(knex, t);
    t.text('subscription_id').notNullable(); // money module id (no FK)
    t.uuid('account_id').references('id').inTable('accounts').onDelete('RESTRICT');
    t.uuid('contact_id').references('id').inTable('contacts').onDelete('RESTRICT'); // B2C subscriptions (test series)
    t.uuid('deal_id').references('id').inTable('deals').onDelete('RESTRICT');
    t.uuid('product_line_id').references('id').inTable('product_lines').onDelete('RESTRICT');
    t.uuid('product_id').references('id').inTable('products').onDelete('RESTRICT');
    t.text('plan_name');
    t.text('status').notNullable().defaultTo('active');
    t.date('term_start');
    t.date('term_end').notNullable(); // the renewal date
    t.boolean('auto_renew').notNullable().defaultTo(false);
    t.bigInteger('amount_minor').notNullable().defaultTo(0); // per term
    t.specificType('currency', 'char(3)').notNullable().defaultTo('INR');
    t.integer('seats');
    userRef(t, 'owner_user_id');
    t.date('reminder_term_end'); // the term the sent reminders belong to
    t.specificType('reminders_sent', 'integer[]').notNullable().defaultTo(knex.raw("'{}'::integer[]"));
    t.integer('churn_score').notNullable().defaultTo(0); // 0-100
    t.text('churn_level').notNullable().defaultTo('low');
    t.jsonb('churn_signals').notNullable().defaultTo(knex.raw("'[]'::jsonb"));
    t.jsonb('upsell_flags').notNullable().defaultTo(knex.raw("'[]'::jsonb"));
    t.timestamp('scored_at', { useTz: true });
    t.timestamp('last_event_at', { useTz: true });
    timestamps(knex, t);
  });
  await check(knex, 'renewals', 'status', `status in (${inList(RENEWAL_STATUSES)})`);
  await check(knex, 'renewals', 'churn', `churn_level in (${inList(CHURN_LEVELS)}) and churn_score between 0 and 100`);
  await check(knex, 'renewals', 'money', "amount_minor >= 0 and currency ~ '^[A-Z]{3}$'");
  await knex.raw('create unique index renewals_subscription_uq on renewals (subscription_id)');
  await knex.raw('create index renewals_company_due_idx on renewals (company_id, term_end, id)');
  await knex.raw('create index renewals_group_due_idx on renewals (group_id, term_end, id)');
  await knex.raw('create index renewals_owner_due_idx on renewals (owner_user_id, term_end, id)');
  await knex.raw('create index renewals_company_risk_idx on renewals (company_id, churn_score desc, id desc)');
  await knex.raw("create index renewals_active_due_idx on renewals (term_end) where status = 'active'");
  await knex.raw('create index renewals_account_idx on renewals (account_id) where account_id is not null');
}

export async function down(knex) {
  for (const table of [
    'renewals',
    'implementation_tasks',
    'implementation_phases',
    'implementation_projects',
    'onboarding_checklist_items',
    'onboarding_checklists',
    'onboarding_template_items',
    'onboarding_templates',
    'enrollment_withdrawals',
    'waitlist_entries',
    'enrollment_payments',
    'enrollments',
    'checkout_sessions',
    'batches',
  ]) {
    await knex.schema.dropTableIfExists(table);
  }
}
