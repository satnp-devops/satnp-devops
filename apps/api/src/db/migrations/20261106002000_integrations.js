// Phase 3: the integration framework (docs/platform/INTEGRATIONS.md).
//
//   integration_connections            a connected provider account: kind, provider, non-secret config,
//                                      AES-256-GCM encrypted credentials, status and health
//   integration_connection_companies   which companies use a connection (several for a shared group
//                                      connection) and which one is a company's default for its kind
//   channel_identities                 WhatsApp numbers, inboxes, form ids, lead-ad pages, call numbers
//                                      and partner link prefixes, mapped to their company or shared
//                                      (the registry core/intake/routing.js routes enquiries with)
//   integration_sandbox_messages       what mock adapters "sent" (the sandbox outbox)
//   api_keys                           machine access: hashed keys with permission scopes at a unit

const id = (knex, t) => t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
const userRef = (t, column) => t.uuid(column).references('id').inTable('users').onDelete('SET NULL');
const unitRef = (t, column) => t.uuid(column).references('id').inTable('org_units');
const now = (knex, t, column) => t.timestamp(column, { useTz: true }).notNullable().defaultTo(knex.fn.now());

export async function up(knex) {
  await knex.schema.createTable('integration_connections', (t) => {
    id(knex, t);
    unitRef(t, 'group_id').notNullable().onDelete('CASCADE');
    unitRef(t, 'unit_id').notNullable().onDelete('CASCADE'); // the owner: a company, or the group for shared connections
    t.text('kind').notNullable();
    t.text('provider').notNullable();
    t.text('name').notNullable();
    t.jsonb('config').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
    t.text('credentials_enc'); // AES-256-GCM, see integrations/framework/credentials.js
    t.jsonb('credential_hints').notNullable().defaultTo(knex.raw("'{}'::jsonb")); // { field: '••••abcd' }, never values
    t.text('status').notNullable().defaultTo('active');
    t.text('health_status').notNullable().defaultTo('unknown');
    t.text('health_message');
    t.timestamp('last_checked_at', { useTz: true });
    t.text('last_error');
    userRef(t, 'created_by');
    userRef(t, 'updated_by');
    now(knex, t, 'created_at');
    now(knex, t, 'updated_at');
    t.timestamp('disconnected_at', { useTz: true });
    userRef(t, 'disconnected_by');
  });
  await knex.raw("alter table integration_connections add constraint integration_connections_status_chk check (status in ('active', 'disabled'))");
  await knex.raw(
    "alter table integration_connections add constraint integration_connections_health_chk check (health_status in ('unknown', 'healthy', 'failing'))",
  );
  await knex.raw('create index integration_connections_group_kind_idx on integration_connections (group_id, kind) where disconnected_at is null');
  await knex.raw('create index integration_connections_unit_idx on integration_connections (unit_id) where disconnected_at is null');
  await knex.raw(
    'create unique index integration_connections_name_uq on integration_connections (unit_id, lower(name)) where disconnected_at is null',
  );

  await knex.schema.createTable('integration_connection_companies', (t) => {
    t.uuid('connection_id').notNullable().references('id').inTable('integration_connections').onDelete('CASCADE');
    unitRef(t, 'company_id').notNullable().onDelete('CASCADE');
    t.text('kind').notNullable(); // copied from the connection so "one default per company and kind" is a constraint
    t.boolean('is_default').notNullable().defaultTo(false);
    now(knex, t, 'created_at');
    t.primary(['connection_id', 'company_id']);
  });
  await knex.raw('create index integration_connection_companies_company_idx on integration_connection_companies (company_id, kind)');
  await knex.raw(
    'create unique index integration_connection_companies_default_uq on integration_connection_companies (company_id, kind) where is_default',
  );

  await knex.schema.createTable('channel_identities', (t) => {
    id(knex, t);
    unitRef(t, 'group_id').notNullable().onDelete('CASCADE');
    t.uuid('connection_id').references('id').inTable('integration_connections').onDelete('SET NULL');
    t.text('type').notNullable(); // core/intake/enquiry.js CHANNEL_TYPES
    t.text('identity').notNullable(); // as entered: +91 98765 43210, Admissions@SatnPaper.in
    t.text('identity_normalized').notNullable(); // normalizeIdentity(type, identity)
    t.text('label');
    unitRef(t, 'company_id').onDelete('CASCADE'); // the owning company; null when shared
    t.uuid('product_line_id').references('id').inTable('product_lines').onDelete('SET NULL');
    t.boolean('shared').notNullable().defaultTo(false);
    t.specificType('company_ids', 'uuid[]').notNullable().defaultTo(knex.raw("'{}'::uuid[]")); // shared: the companies it may route to
    userRef(t, 'created_by');
    userRef(t, 'updated_by');
    now(knex, t, 'created_at');
    now(knex, t, 'updated_at');
    t.timestamp('archived_at', { useTz: true });
  });
  await knex.raw(
    'alter table channel_identities add constraint channel_identities_owner_chk check ((shared and company_id is null and cardinality(company_ids) >= 2) or (not shared and company_id is not null))',
  );
  await knex.raw(
    'create unique index channel_identities_identity_uq on channel_identities (group_id, type, identity_normalized) where archived_at is null',
  );
  await knex.raw('create index channel_identities_company_idx on channel_identities (company_id) where archived_at is null');
  await knex.raw('create index channel_identities_shared_idx on channel_identities using gin (company_ids) where archived_at is null and shared');
  await knex.raw('create index channel_identities_connection_idx on channel_identities (connection_id) where archived_at is null');

  await knex.schema.createTable('integration_sandbox_messages', (t) => {
    t.bigIncrements('id');
    t.uuid('group_id').notNullable();
    t.uuid('company_id');
    t.uuid('connection_id').references('id').inTable('integration_connections').onDelete('CASCADE');
    t.text('kind').notNullable();
    t.text('provider').notNullable();
    t.text('operation').notNullable();
    t.text('recipient');
    t.text('subject');
    t.text('body');
    t.text('provider_ref');
    t.text('reference');
    t.text('status');
    t.jsonb('payload').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
    now(knex, t, 'created_at');
  });
  await knex.raw('create index integration_sandbox_company_idx on integration_sandbox_messages (company_id, id desc)');
  await knex.raw('create index integration_sandbox_group_idx on integration_sandbox_messages (group_id, id desc)');
  await knex.raw('create index integration_sandbox_ref_idx on integration_sandbox_messages (connection_id, provider_ref)');
  await knex.raw('create index integration_sandbox_op_idx on integration_sandbox_messages (connection_id, operation, id desc)');

  await knex.schema.createTable('api_keys', (t) => {
    id(knex, t);
    unitRef(t, 'group_id').notNullable().onDelete('CASCADE');
    unitRef(t, 'unit_id').notNullable().onDelete('CASCADE'); // the group or a company: where the scopes apply
    t.text('name').notNullable();
    t.text('prefix').notNullable(); // first characters of the key, shown so people can tell keys apart
    t.text('key_hash').notNullable().unique(); // sha256 of the whole key; the key itself is shown once
    t.specificType('scopes', 'text[]').notNullable();
    t.uuid('service_user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    userRef(t, 'created_by');
    now(knex, t, 'created_at');
    t.timestamp('expires_at', { useTz: true });
    t.timestamp('last_used_at', { useTz: true });
    t.text('last_used_ip');
    t.timestamp('revoked_at', { useTz: true });
    userRef(t, 'revoked_by');
  });
  await knex.raw('create index api_keys_unit_idx on api_keys (unit_id, created_at desc, id desc)');
  await knex.raw('create index api_keys_group_idx on api_keys (group_id, created_at desc, id desc)');
}

export async function down(knex) {
  // Service users belong to their keys; remove them with the keys.
  if (await knex.schema.hasTable('api_keys')) {
    const serviceUsers = await knex('api_keys').pluck('service_user_id');
    await knex.schema.dropTable('api_keys');
    if (serviceUsers.length) await knex('users').whereIn('id', serviceUsers).delete();
  }
  for (const table of ['integration_sandbox_messages', 'channel_identities', 'integration_connection_companies', 'integration_connections']) {
    await knex.schema.dropTableIfExists(table);
  }
}
