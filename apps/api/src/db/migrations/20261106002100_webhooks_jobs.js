// Phase 3: inbound webhooks and background jobs (docs/platform/WEBHOOKS_AND_JOBS.md).
//
//   webhook_events    every event a provider delivered to POST /api/v1/webhooks/:provider/:connectionId,
//                     unique per (provider, connection, provider event id) so a redelivery is
//                     acknowledged and ignored; its processing status, attempts, last error and the
//                     handlers that already ran. Rejected deliveries (bad signature, unreadable body)
//                     are kept too, without their body, so admins can see a misconfigured secret.
//   background_jobs   user-visible job records (bulk actions, imports: status, progress, result,
//                     errors, created_by), plus a dead-letter row for any untracked job that failed
//                     its last attempt, so every failure is visible and can be retried.

const now = (knex, t, column) => t.timestamp(column, { useTz: true }).notNullable().defaultTo(knex.fn.now());
const userRef = (t, column) => t.uuid(column).references('id').inTable('users').onDelete('SET NULL');

export async function up(knex) {
  await knex.schema.createTable('webhook_events', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('group_id').notNullable().references('id').inTable('org_units').onDelete('CASCADE');
    t.uuid('unit_id').notNullable().references('id').inTable('org_units').onDelete('CASCADE'); // the connection's owner
    t.uuid('connection_id').notNullable().references('id').inTable('integration_connections').onDelete('CASCADE');
    t.text('provider').notNullable();
    t.text('kind').notNullable();
    t.text('external_event_id'); // the provider's event id; null only for rejected deliveries
    t.text('type'); // normalised event type (payment.captured); null only for rejected deliveries
    t.timestamp('occurred_at', { useTz: true });
    t.text('reference'); // our own id echoed back by the provider (a deal, invoice or booking id)
    t.jsonb('payload').notNullable().defaultTo(knex.raw("'{}'::jsonb")); // the normalised event data
    t.text('status').notNullable().defaultTo('queued');
    t.integer('attempts').notNullable().defaultTo(0);
    t.integer('max_attempts').notNullable().defaultTo(1);
    t.text('last_error');
    t.specificType('completed_handlers', 'text[]').notNullable().defaultTo(knex.raw("'{}'::text[]"));
    t.integer('handler_count');
    t.integer('duplicates').notNullable().defaultTo(0); // redeliveries acknowledged and ignored
    t.text('source_ip');
    t.text('request_id');
    now(knex, t, 'received_at');
    t.timestamp('last_received_at', { useTz: true });
    t.timestamp('last_attempt_at', { useTz: true });
    t.timestamp('next_attempt_at', { useTz: true });
    t.timestamp('processed_at', { useTz: true });
    t.timestamp('failed_at', { useTz: true });
    t.integer('replay_count').notNullable().defaultTo(0);
    t.timestamp('replayed_at', { useTz: true });
    userRef(t, 'replayed_by');
    now(knex, t, 'updated_at');
  });
  await knex.raw(
    "alter table webhook_events add constraint webhook_events_status_chk check (status in ('queued', 'processing', 'retrying', 'processed', 'failed', 'rejected'))",
  );
  await knex.raw(
    "alter table webhook_events add constraint webhook_events_event_chk check (status = 'rejected' or (external_event_id is not null and type is not null))",
  );
  // De-duplication: nulls are distinct, so rejected rows never collide.
  await knex.raw('create unique index webhook_events_dedupe_uq on webhook_events (provider, connection_id, external_event_id)');
  // The delivery log (newest first per owner) and its status filter (dead letters = failed).
  await knex.raw('create index webhook_events_unit_idx on webhook_events (unit_id, received_at desc, id desc)');
  await knex.raw('create index webhook_events_unit_status_idx on webhook_events (unit_id, status, received_at desc, id desc)');
  await knex.raw('create index webhook_events_connection_idx on webhook_events (connection_id, received_at desc, id desc)');
  // The sweeper re-queues events whose queue job was lost; the pruner removes old processed rows.
  await knex.raw(
    "create index webhook_events_pending_idx on webhook_events (updated_at) where status in ('queued', 'processing', 'retrying')",
  );
  await knex.raw("create index webhook_events_prune_idx on webhook_events (received_at) where status in ('processed', 'rejected')");

  await knex.schema.createTable('background_jobs', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.text('name').notNullable(); // the registered job, e.g. deals.bulk
    t.text('label');
    t.uuid('group_id').references('id').inTable('org_units').onDelete('CASCADE');
    t.uuid('unit_id').references('id').inTable('org_units').onDelete('CASCADE'); // where it was started (scoping)
    t.boolean('tracked').notNullable().defaultTo(true); // false: an untracked job recorded when it dead-lettered
    t.text('status').notNullable().defaultTo('queued');
    t.jsonb('data').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
    t.jsonb('progress'); // { done, total, message }
    t.jsonb('result');
    t.jsonb('errors').notNullable().defaultTo(knex.raw("'[]'::jsonb")); // [{ message, item? }], capped
    t.integer('error_count').notNullable().defaultTo(0);
    t.integer('attempts').notNullable().defaultTo(0);
    t.integer('max_attempts').notNullable().defaultTo(1);
    t.integer('failures').notNullable().defaultTo(0); // how often this dead letter failed (repeating jobs fold into one row)
    t.text('last_error');
    t.text('queue_job_id'); // the queue job currently carrying it (changes on retry)
    t.text('dedupe_key'); // schedule:<name> for repeating jobs, so a failing schedule keeps one dead letter
    t.timestamp('run_at', { useTz: true });
    t.timestamp('next_attempt_at', { useTz: true });
    t.timestamp('started_at', { useTz: true });
    t.timestamp('finished_at', { useTz: true });
    userRef(t, 'created_by');
    now(knex, t, 'created_at');
    now(knex, t, 'updated_at');
    t.integer('replay_count').notNullable().defaultTo(0);
    t.timestamp('replayed_at', { useTz: true });
    userRef(t, 'replayed_by');
  });
  await knex.raw(
    "alter table background_jobs add constraint background_jobs_status_chk check (status in ('queued', 'running', 'retrying', 'completed', 'failed', 'cancelled'))",
  );
  await knex.raw('create index background_jobs_unit_idx on background_jobs (unit_id, created_at desc, id desc)');
  await knex.raw('create index background_jobs_unit_status_idx on background_jobs (unit_id, status, created_at desc, id desc)');
  await knex.raw('create index background_jobs_creator_idx on background_jobs (created_by, created_at desc, id desc)');
  await knex.raw("create index background_jobs_pending_idx on background_jobs (updated_at) where status in ('queued', 'running', 'retrying')");
  await knex.raw("create unique index background_jobs_dead_letter_uq on background_jobs (dedupe_key) where status = 'failed'");
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('background_jobs');
  await knex.schema.dropTableIfExists('webhook_events');
}
