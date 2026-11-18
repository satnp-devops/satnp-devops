// Phase 1 foundation: multi-level organisation tree, people, sessions, roles,
// inherited settings, audit log and the transactional outbox.
// Requires PostgreSQL 13+ (gen_random_uuid is built in).

const ZERO_UUID = "'00000000-0000-0000-0000-000000000000'::uuid";

function id(knex, t) {
  t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
}

function timestamps(knex, t) {
  t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
}

export async function up(knex) {
  // ---------- Organisation tree (group → company → region → branch → team → ...) ----------
  await knex.schema.createTable('org_units', (t) => {
    id(knex, t);
    t.uuid('parent_id').references('id').inTable('org_units').onDelete('RESTRICT');
    t.uuid('root_id').notNullable(); // the group this unit belongs to (equals id for a group)
    t.text('type').notNullable(); // validated against the unit type registry
    t.text('name').notNullable();
    t.text('code').notNullable();
    t.text('path').notNullable(); // "/<root>/<...>/<id>/"
    t.integer('depth').notNullable();
    t.text('status').notNullable().defaultTo('active');
    t.jsonb('profile').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
    timestamps(knex, t);
    t.timestamp('archived_at', { useTz: true });
  });
  await knex.raw("alter table org_units add constraint org_units_status_chk check (status in ('active', 'archived'))");
  await knex.raw('alter table org_units add constraint org_units_depth_chk check (depth >= 0)');
  await knex.raw('create unique index org_units_path_uq on org_units (path)');
  await knex.raw('create index org_units_path_prefix_idx on org_units (path text_pattern_ops)');
  await knex.raw(`create unique index org_units_sibling_code_uq on org_units (coalesce(parent_id, ${ZERO_UUID}), lower(code))`);
  await knex.raw('create index org_units_parent_idx on org_units (parent_id)');
  await knex.raw('create index org_units_root_type_idx on org_units (root_id, type)');

  // ---------- People ----------
  await knex.schema.createTable('users', (t) => {
    id(knex, t);
    t.text('email').notNullable();
    t.text('name').notNullable();
    t.text('phone');
    t.text('password_hash');
    t.text('status').notNullable().defaultTo('invited');
    t.boolean('mfa_enabled').notNullable().defaultTo(false);
    t.text('mfa_secret'); // AES-256-GCM encrypted
    t.text('mfa_pending_secret');
    t.specificType('mfa_recovery_codes', 'text[]').notNullable().defaultTo(knex.raw("'{}'::text[]"));
    t.text('time_zone');
    t.timestamp('last_login_at', { useTz: true });
    timestamps(knex, t);
  });
  await knex.raw("alter table users add constraint users_status_chk check (status in ('invited', 'active', 'disabled'))");
  await knex.raw('create unique index users_email_uq on users (lower(email))');

  await knex.schema.createTable('sessions', (t) => {
    id(knex, t);
    t.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.text('token_hash').notNullable().unique();
    t.boolean('mfa_verified').notNullable().defaultTo(false);
    t.text('ip');
    t.text('user_agent');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('last_seen_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('expires_at', { useTz: true }).notNullable();
    t.timestamp('revoked_at', { useTz: true });
    t.index(['user_id']);
  });

  await knex.schema.createTable('user_tokens', (t) => {
    id(knex, t);
    t.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.text('type').notNullable();
    t.text('token_hash').notNullable().unique();
    t.timestamp('expires_at', { useTz: true }).notNullable();
    t.timestamp('used_at', { useTz: true });
    t.uuid('created_by').references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['user_id', 'type']);
  });
  await knex.raw("alter table user_tokens add constraint user_tokens_type_chk check (type in ('invite', 'password_reset'))");

  // ---------- Roles and where people hold them ----------
  await knex.schema.createTable('roles', (t) => {
    id(knex, t);
    t.uuid('group_id').references('id').inTable('org_units').onDelete('CASCADE'); // null = built-in
    t.text('key').notNullable();
    t.text('name').notNullable();
    t.text('description');
    t.specificType('permissions', 'text[]').notNullable().defaultTo(knex.raw("'{}'::text[]"));
    t.boolean('is_system').notNullable().defaultTo(false);
    timestamps(knex, t);
  });
  await knex.raw(`create unique index roles_key_uq on roles (coalesce(group_id, ${ZERO_UUID}), key)`);

  await knex.schema.createTable('role_assignments', (t) => {
    id(knex, t);
    t.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.uuid('role_id').notNullable().references('id').inTable('roles').onDelete('CASCADE');
    t.uuid('org_unit_id').notNullable().references('id').inTable('org_units').onDelete('CASCADE');
    t.uuid('created_by').references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['user_id', 'role_id', 'org_unit_id']);
    t.index(['org_unit_id']);
    t.index(['role_id']);
  });

  // ---------- Settings, inherited down the tree ----------
  await knex.schema.createTable('settings', (t) => {
    t.uuid('org_unit_id').notNullable().references('id').inTable('org_units').onDelete('CASCADE');
    t.text('key').notNullable();
    t.jsonb('value').notNullable();
    t.uuid('updated_by').references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.primary(['org_unit_id', 'key']);
  });

  // ---------- Audit log (no foreign keys: history outlives what it describes) ----------
  await knex.schema.createTable('audit_logs', (t) => {
    t.bigIncrements('id');
    t.uuid('group_id');
    t.uuid('org_unit_id');
    t.uuid('actor_user_id');
    t.text('actor_type').notNullable().defaultTo('user');
    t.text('action').notNullable();
    t.text('entity_type');
    t.text('entity_id');
    t.jsonb('before');
    t.jsonb('after');
    t.jsonb('meta');
    t.text('ip');
    t.text('user_agent');
    t.text('request_id');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw('create index audit_logs_unit_idx on audit_logs (org_unit_id, id desc)');
  await knex.raw('create index audit_logs_group_idx on audit_logs (group_id, id desc)');
  await knex.raw('create index audit_logs_entity_idx on audit_logs (entity_type, entity_id)');
  await knex.raw('create index audit_logs_actor_idx on audit_logs (actor_user_id, id desc)');

  // ---------- Transactional outbox for domain events ----------
  await knex.schema.createTable('outbox_events', (t) => {
    t.bigIncrements('id');
    t.uuid('event_id').notNullable().unique().defaultTo(knex.raw('gen_random_uuid()'));
    t.text('type').notNullable();
    t.uuid('group_id');
    t.uuid('org_unit_id');
    t.text('aggregate_type');
    t.text('aggregate_id');
    t.jsonb('payload').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
    t.uuid('actor_user_id');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('published_at', { useTz: true });
  });
  await knex.raw('create index outbox_events_unpublished_idx on outbox_events (id) where published_at is null');
}

export async function down(knex) {
  for (const table of [
    'outbox_events',
    'audit_logs',
    'settings',
    'role_assignments',
    'roles',
    'user_tokens',
    'sessions',
    'users',
    'org_units',
  ]) {
    await knex.schema.dropTableIfExists(table);
  }
}
