// Phase 9, automations: flows (with immutable versions), runs pinned to a version, the run step
// log, effects handed to executors (one row per idempotency key) and human approvals.
// The engine (core/automation) is pure; these tables are its persistence (AUTOMATION_CORE.md §10).
// docs/automations/AUTOMATIONS.md describes every table; keep the two in step.
//
// Conventions as in phases 1 and 2: UUID keys, timestamptz in UTC, JSONB for definitions and run
// state, text + check constraints for small fixed vocabularies. Flows are company configuration
// (group_id, company_id, unit_id = where in the company the flow applies). Runs and approvals are
// company-owned rows scoped by unit_id (the subject's unit, else the flow's). Subjects (deals,
// contacts) carry no foreign keys, like the timeline, so history outlives what it describes.

const unitRef = (t, column) => t.uuid(column).notNullable().references('id').inTable('org_units').onDelete('RESTRICT');
const userRef = (t, column) => t.uuid(column).references('id').inTable('users').onDelete('SET NULL');
const inList = (values) => values.map((v) => `'${v}'`).join(', ');

const FLOW_STATUSES = ['draft', 'active', 'paused', 'archived'];
const FLOW_KINDS = ['standard', 'nurture'];
const RUN_STATUSES = ['running', 'waiting', 'completed', 'failed', 'cancelled'];
const EFFECT_STATUSES = ['pending', 'running', 'done', 'recorded', 'failed', 'skipped'];
const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'expired', 'cancelled'];

export async function up(knex) {
  await knex.raw('create extension if not exists citext');

  // ---------- Flows ----------
  await knex.schema.createTable('automation_flows', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    unitRef(t, 'group_id');
    unitRef(t, 'company_id');
    unitRef(t, 'unit_id'); // the flow applies to subjects owned by this unit or below (the company by default)
    t.specificType('key', 'citext').notNullable();
    t.text('name').notNullable();
    t.text('description');
    t.text('kind').notNullable().defaultTo('standard');
    t.text('status').notNullable().defaultTo('draft');
    t.text('trigger_type').notNullable(); // trigger of the latest version (router index)
    t.integer('version').notNullable().defaultTo(1); // latest saved version
    t.integer('active_version'); // version new runs start on (follows saves while active)
    t.jsonb('definition').notNullable(); // copy of the latest version's normalised definition
    t.text('template_key');
    t.timestamp('next_fire_at', { useTz: true }); // schedule trigger: next firing
    t.jsonb('trigger_state').notNullable().defaultTo(knex.raw("'{}'::jsonb")); // no_activity scan cursor
    userRef(t, 'created_by');
    userRef(t, 'updated_by');
    t.timestamp('activated_at', { useTz: true });
    t.timestamp('paused_at', { useTz: true });
    t.timestamp('archived_at', { useTz: true });
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(`alter table automation_flows add constraint automation_flows_status_chk check (status in (${inList(FLOW_STATUSES)}))`);
  await knex.raw(`alter table automation_flows add constraint automation_flows_kind_chk check (kind in (${inList(FLOW_KINDS)}))`);
  await knex.raw('alter table automation_flows add constraint automation_flows_version_chk check (version >= 1 and (active_version is null or active_version between 1 and version))');
  await knex.raw('create unique index automation_flows_key_uq on automation_flows (company_id, key)');
  await knex.raw('create index automation_flows_company_idx on automation_flows (company_id, lower(name), id)');
  // Event router: active flows listening to a trigger at one of the event unit's ancestors.
  await knex.raw("create index automation_flows_router_idx on automation_flows (trigger_type, unit_id) where status = 'active'");
  await knex.raw("create index automation_flows_fire_idx on automation_flows (next_fire_at) where status = 'active' and next_fire_at is not null");

  await knex.schema.createTable('automation_flow_versions', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('flow_id').notNullable().references('id').inTable('automation_flows').onDelete('CASCADE');
    unitRef(t, 'company_id');
    t.integer('version').notNullable();
    t.text('trigger_type').notNullable();
    t.jsonb('definition').notNullable(); // immutable: the normalised flow from validateFlow()
    t.jsonb('warnings').notNullable().defaultTo(knex.raw("'[]'::jsonb"));
    t.jsonb('stats').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
    t.text('note');
    userRef(t, 'created_by');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw('create unique index automation_flow_versions_uq on automation_flow_versions (flow_id, version)');

  // ---------- Runs ----------
  await knex.schema.createTable('automation_runs', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    unitRef(t, 'group_id');
    unitRef(t, 'company_id');
    unitRef(t, 'unit_id');
    t.uuid('flow_id').notNullable().references('id').inTable('automation_flows').onDelete('RESTRICT');
    t.uuid('flow_version_id').notNullable().references('id').inTable('automation_flow_versions').onDelete('RESTRICT');
    t.integer('flow_version').notNullable();
    t.text('subject_type'); // deal | contact | null (schedule runs)
    t.uuid('subject_id');
    t.uuid('deal_id');
    t.text('status').notNullable();
    t.jsonb('state').notNullable(); // the interpreter's RunState
    t.jsonb('trigger').notNullable(); // the engine event that started it
    t.text('trigger_event_id'); // idempotency: one run per flow and triggering event
    t.text('waiting_kind'); // timer | event | effect | approval
    t.text('waiting_event');
    t.text('waiting_key');
    t.timestamp('next_wake_at', { useTz: true });
    t.integer('step_count').notNullable().defaultTo(0);
    t.jsonb('error');
    t.text('end_reason');
    t.timestamp('started_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('ended_at', { useTz: true });
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(`alter table automation_runs add constraint automation_runs_status_chk check (status in (${inList(RUN_STATUSES)}))`);
  await knex.raw("alter table automation_runs add constraint automation_runs_subject_chk check (subject_type is null or subject_type in ('deal', 'contact', 'account'))");
  await knex.raw('create unique index automation_runs_trigger_uq on automation_runs (flow_id, trigger_event_id)' /* nulls are distinct */);
  // Timer worker.
  await knex.raw("create index automation_runs_wake_idx on automation_runs (next_wake_at) where status = 'waiting' and next_wake_at is not null");
  // Event router: runs paused on an event for a subject; effect results and approvals by key.
  await knex.raw("create index automation_runs_waiting_event_idx on automation_runs (waiting_event, subject_id) where status = 'waiting' and waiting_kind = 'event'");
  await knex.raw("create index automation_runs_waiting_key_idx on automation_runs (waiting_key) where status = 'waiting' and waiting_key is not null");
  // Lists.
  await knex.raw('create index automation_runs_company_idx on automation_runs (company_id, started_at desc, id desc)');
  await knex.raw('create index automation_runs_flow_idx on automation_runs (flow_id, started_at desc, id desc)');
  await knex.raw('create index automation_runs_deal_idx on automation_runs (deal_id, started_at desc, id desc) where deal_id is not null');
  // Re-entry rules (active and total runs per flow and subject).
  await knex.raw('create index automation_runs_subject_idx on automation_runs (flow_id, subject_id, status)');

  await knex.raw(`
    create table automation_run_steps (
      id bigint generated always as identity primary key,
      run_id uuid not null references automation_runs (id) on delete cascade,
      seq integer not null,
      step_id text,
      step_type text,
      phase text,
      outcome text,
      next_step_id text,
      detail jsonb,
      at timestamptz not null
    )
  `);
  await knex.raw('create unique index automation_run_steps_uq on automation_run_steps (run_id, seq)');

  // ---------- Effects (what the executor performs, once per idempotency key) ----------
  await knex.schema.createTable('automation_effects', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.text('idempotency_key').notNullable();
    t.uuid('run_id').notNullable().references('id').inTable('automation_runs').onDelete('CASCADE');
    unitRef(t, 'company_id');
    t.text('step_id').notNullable();
    t.text('action').notNullable();
    t.jsonb('params').notNullable();
    t.boolean('awaited').notNullable().defaultTo(false);
    t.text('subject_type');
    t.uuid('subject_id');
    t.text('status').notNullable().defaultTo('pending');
    t.text('executor'); // development | webhook | internal | the module that performed it
    t.jsonb('output');
    t.jsonb('error');
    t.integer('attempts').notNullable().defaultTo(0);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('completed_at', { useTz: true });
  });
  await knex.raw(`alter table automation_effects add constraint automation_effects_status_chk check (status in (${inList(EFFECT_STATUSES)}))`);
  await knex.raw('create unique index automation_effects_key_uq on automation_effects (idempotency_key)');
  await knex.raw('create index automation_effects_run_idx on automation_effects (run_id, created_at)');
  await knex.raw("create index automation_effects_pending_idx on automation_effects (created_at) where status = 'pending'");

  // ---------- Approvals ----------
  await knex.schema.createTable('automation_approvals', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.text('idempotency_key').notNullable();
    unitRef(t, 'group_id');
    unitRef(t, 'company_id');
    unitRef(t, 'unit_id');
    t.uuid('run_id').notNullable().references('id').inTable('automation_runs').onDelete('CASCADE');
    t.uuid('flow_id').notNullable().references('id').inTable('automation_flows').onDelete('RESTRICT');
    t.text('step_id').notNullable();
    t.text('subject_type');
    t.uuid('subject_id');
    t.uuid('deal_id');
    t.text('title').notNullable();
    t.text('body');
    t.jsonb('data'); // what the flow proposed (e.g. { draft })
    t.jsonb('decision_data'); // what the approver sent (edited) or null
    t.specificType('approver_user_ids', 'uuid[]').notNullable().defaultTo(knex.raw("'{}'::uuid[]"));
    t.text('approver_permission');
    t.uuid('owner_user_id'); // the subject's owner when requested (approvers.owner)
    t.text('status').notNullable().defaultTo('pending');
    t.boolean('edited').notNullable().defaultTo(false);
    t.text('comment');
    userRef(t, 'decided_by');
    t.timestamp('decided_at', { useTz: true });
    t.timestamp('expires_at', { useTz: true });
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(`alter table automation_approvals add constraint automation_approvals_status_chk check (status in (${inList(APPROVAL_STATUSES)}))`);
  await knex.raw("alter table automation_approvals add constraint automation_approvals_decided_chk check ((status in ('approved', 'rejected')) = (decided_at is not null))");
  await knex.raw('create unique index automation_approvals_key_uq on automation_approvals (idempotency_key)');
  await knex.raw('create index automation_approvals_company_idx on automation_approvals (company_id, status, created_at desc, id desc)');
  await knex.raw('create index automation_approvals_run_idx on automation_approvals (run_id)');
  await knex.raw("create index automation_approvals_owner_idx on automation_approvals (owner_user_id) where status = 'pending'");
  await knex.raw("create index automation_approvals_users_idx on automation_approvals using gin (approver_user_ids) where status = 'pending'");
}

export async function down(knex) {
  for (const table of ['automation_approvals', 'automation_effects', 'automation_run_steps', 'automation_runs', 'automation_flow_versions', 'automation_flows']) {
    await knex.schema.dropTableIfExists(table);
  }
}
