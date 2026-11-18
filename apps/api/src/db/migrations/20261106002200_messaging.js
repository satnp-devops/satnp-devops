// Phase 5 foundations: messaging (docs/platform/MESSAGING.md).
//
//   message_templates           a company's WhatsApp, email and SMS templates: identity (channel, name,
//                               language), category, the latest version's status and the live version
//   message_template_versions   every version's content (header, subject, body, footer, buttons, sample
//                               variables, provider names) and its approval: draft > submitted > approved | rejected
//   conversations               one thread per company, channel, connection and customer address; holds the
//                               WhatsApp 24-hour customer-service window (last_inbound_at)
//   messages                    every message sent or received, with its template and variables, media
//                               references, provider ids and delivery status timestamps

const id = (knex, t) => t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
const userRef = (t, column) => t.uuid(column).references('id').inTable('users').onDelete('SET NULL');
const unitRef = (t, column) => t.uuid(column).references('id').inTable('org_units').onDelete('RESTRICT');
const now = (knex, t, column) => t.timestamp(column, { useTz: true }).notNullable().defaultTo(knex.fn.now());
const at = (t, column) => t.timestamp(column, { useTz: true });

const CHANNELS = "('whatsapp', 'email', 'sms')";

export async function up(knex) {
  // ---------- Templates ----------
  await knex.schema.createTable('message_templates', (t) => {
    id(knex, t);
    unitRef(t, 'group_id').notNullable();
    unitRef(t, 'company_id').notNullable();
    t.text('channel').notNullable();
    t.text('name').notNullable(); // booking_link: lower-case letters, digits and underscores (WhatsApp's rule)
    t.text('language').notNullable(); // en, hi, en_US
    t.text('category').notNullable(); // utility | marketing | authentication
    t.text('description');
    t.integer('latest_version').notNullable().defaultTo(1);
    t.text('status').notNullable().defaultTo('draft'); // the latest version's status, for lists
    t.integer('approved_version'); // the version sends use: the latest approved one
    userRef(t, 'created_by');
    userRef(t, 'updated_by');
    now(knex, t, 'created_at');
    now(knex, t, 'updated_at');
    at(t, 'archived_at');
  });
  await knex.raw(`alter table message_templates add constraint message_templates_channel_chk check (channel in ${CHANNELS})`);
  await knex.raw(
    "alter table message_templates add constraint message_templates_category_chk check (category in ('utility', 'marketing', 'authentication'))",
  );
  await knex.raw(
    "alter table message_templates add constraint message_templates_status_chk check (status in ('draft', 'submitted', 'approved', 'rejected'))",
  );
  await knex.raw(
    'create unique index message_templates_name_uq on message_templates (company_id, channel, name, language) where archived_at is null',
  );
  await knex.raw('create index message_templates_company_idx on message_templates (company_id, channel, name) where archived_at is null');

  await knex.schema.createTable('message_template_versions', (t) => {
    id(knex, t);
    t.uuid('template_id').notNullable().references('id').inTable('message_templates').onDelete('CASCADE');
    t.integer('version').notNullable();
    t.text('status').notNullable().defaultTo('draft');
    t.jsonb('header'); // { type: 'text', text } (WhatsApp)
    t.text('subject'); // email
    t.text('body').notNullable();
    t.text('footer'); // WhatsApp
    t.jsonb('buttons').notNullable().defaultTo(knex.raw("'[]'::jsonb")); // WhatsApp: quick_reply | url | phone
    t.jsonb('samples').notNullable().defaultTo(knex.raw("'{}'::jsonb")); // { variable: 'sample value' }
    t.text('provider_template_name'); // the name registered with the provider, when it differs
    t.text('provider_template_id'); // the provider's id (MSG91 DLT template id, Meta template id)
    t.text('rejection_reason');
    userRef(t, 'created_by');
    now(knex, t, 'created_at');
    now(knex, t, 'updated_at');
    at(t, 'submitted_at');
    userRef(t, 'submitted_by');
    at(t, 'decided_at'); // approved or rejected
    t.unique(['template_id', 'version']);
  });
  await knex.raw(
    "alter table message_template_versions add constraint message_template_versions_status_chk check (status in ('draft', 'submitted', 'approved', 'rejected'))",
  );
  // template.status webhooks find the version by the provider's name.
  await knex.raw(
    'create index message_template_versions_provider_idx on message_template_versions (provider_template_name) where provider_template_name is not null',
  );

  // ---------- Conversations ----------
  await knex.schema.createTable('conversations', (t) => {
    id(knex, t);
    unitRef(t, 'group_id').notNullable();
    unitRef(t, 'company_id').notNullable();
    unitRef(t, 'unit_id').notNullable(); // the contact's link unit in the company when the thread started
    t.uuid('contact_id').notNullable().references('id').inTable('contacts').onDelete('RESTRICT');
    t.text('channel').notNullable();
    t.uuid('connection_id').references('id').inTable('integration_connections').onDelete('SET NULL');
    t.text('connection_key').notNullable(); // the connection id, or "fallback" for the built-in mock
    t.text('contact_address').notNullable(); // the customer's E.164 number or lower-case email. PII
    t.text('business_address'); // our number or inbox, when the provider tells us
    t.uuid('deal_id').references('id').inTable('deals').onDelete('SET NULL'); // the deal the thread was last about
    at(t, 'last_message_at');
    at(t, 'last_inbound_at'); // the WhatsApp 24-hour window opens here
    at(t, 'last_outbound_at');
    t.text('handled_by'); // the WhatsApp tool: 'bot' | 'human' | 'crm' after a handover
    at(t, 'handover_at');
    now(knex, t, 'created_at');
    now(knex, t, 'updated_at');
  });
  await knex.raw(`alter table conversations add constraint conversations_channel_chk check (channel in ${CHANNELS})`);
  await knex.raw(
    "alter table conversations add constraint conversations_handled_by_chk check (handled_by is null or handled_by in ('bot', 'human', 'crm'))",
  );
  await knex.raw(
    'create unique index conversations_thread_uq on conversations (company_id, channel, connection_key, contact_address)',
  );
  await knex.raw('create index conversations_contact_idx on conversations (contact_id, last_message_at desc)');
  await knex.raw('create index conversations_company_recent_idx on conversations (company_id, last_message_at desc, id desc)');
  await knex.raw('create index conversations_connection_address_idx on conversations (connection_id, contact_address) where connection_id is not null');

  // ---------- Messages ----------
  await knex.schema.createTable('messages', (t) => {
    id(knex, t);
    unitRef(t, 'group_id').notNullable();
    unitRef(t, 'company_id').notNullable();
    unitRef(t, 'unit_id').notNullable(); // the deal's unit, else the conversation's
    t.uuid('conversation_id').notNullable().references('id').inTable('conversations').onDelete('CASCADE');
    t.uuid('contact_id').notNullable().references('id').inTable('contacts').onDelete('RESTRICT');
    t.uuid('deal_id').references('id').inTable('deals').onDelete('SET NULL');
    t.text('channel').notNullable();
    t.text('direction').notNullable(); // inbound | outbound
    t.text('status').notNullable(); // queued | sent | delivered | read | failed | received
    t.text('purpose'); // outbound: marketing | transactional | service
    t.uuid('template_id').references('id').inTable('message_templates').onDelete('SET NULL');
    t.integer('template_version');
    t.text('template_name');
    t.jsonb('variables').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
    t.text('subject');
    t.text('body'); // the rendered text. PII, never in audit or events
    t.jsonb('media').notNullable().defaultTo(knex.raw("'[]'::jsonb")); // [{ type, url?, fileId?, mimeType?, caption?, fileName? }]
    t.text('to_address'); // PII
    t.text('from_address'); // PII
    t.uuid('connection_id').references('id').inTable('integration_connections').onDelete('SET NULL');
    t.text('provider');
    t.text('provider_message_id');
    t.text('reference'); // the caller's idempotency key (automation step, client retry id)
    t.text('source').notNullable().defaultTo('crm'); // crm | provider | whatsapp_tool
    t.text('actor_type').notNullable().defaultTo('system'); // user | system | ai | contact
    userRef(t, 'sent_by_user_id');
    t.jsonb('agent'); // the WhatsApp tool's bot or agent: { type, name }
    t.text('error_code');
    t.text('error_message');
    t.jsonb('meta').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
    t.timestamp('occurred_at', { useTz: true }).notNullable().defaultTo(knex.fn.now()); // sort key
    at(t, 'sent_at');
    at(t, 'delivered_at');
    at(t, 'read_at');
    at(t, 'failed_at');
    at(t, 'received_at');
    now(knex, t, 'created_at');
    now(knex, t, 'updated_at');
  });
  await knex.raw(`alter table messages add constraint messages_channel_chk check (channel in ${CHANNELS})`);
  await knex.raw("alter table messages add constraint messages_direction_chk check (direction in ('inbound', 'outbound'))");
  await knex.raw(
    "alter table messages add constraint messages_status_chk check (status in ('queued', 'sent', 'delivered', 'read', 'failed', 'received'))",
  );
  await knex.raw(
    "alter table messages add constraint messages_purpose_chk check (purpose is null or purpose in ('marketing', 'transactional', 'service'))",
  );
  await knex.raw("alter table messages add constraint messages_source_chk check (source in ('crm', 'provider', 'whatsapp_tool'))");
  await knex.raw("alter table messages add constraint messages_actor_chk check (actor_type in ('user', 'system', 'ai', 'contact'))");
  // Idempotency: one row per provider message and per caller reference.
  await knex.raw(
    'create unique index messages_provider_uq on messages (company_id, channel, provider_message_id) where provider_message_id is not null',
  );
  await knex.raw('create unique index messages_reference_uq on messages (company_id, reference) where reference is not null');
  // Status webhooks look messages up by provider id on their connection.
  await knex.raw('create index messages_provider_lookup_idx on messages (provider_message_id) where provider_message_id is not null');
  // Lists: per deal, per contact, per conversation, newest first.
  await knex.raw('create index messages_deal_idx on messages (deal_id, occurred_at desc, id desc) where deal_id is not null');
  await knex.raw('create index messages_contact_idx on messages (contact_id, occurred_at desc, id desc)');
  await knex.raw('create index messages_conversation_idx on messages (conversation_id, occurred_at desc, id desc)');
  // Sends that never reached the provider (a crash between the two transactions).
  await knex.raw("create index messages_queued_idx on messages (created_at) where status = 'queued'");
}

export async function down(knex) {
  for (const table of ['messages', 'conversations', 'message_template_versions', 'message_templates']) {
    await knex.schema.dropTableIfExists(table);
  }
}
