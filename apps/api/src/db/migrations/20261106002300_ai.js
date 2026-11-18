// The AI service (docs/platform/AI.md).
//
//   ai_actions              every AI call: company, agent, what it was about, input, output, confidence,
//                           guardrail results, model, tokens, latency, status and the reviewer's decision.
//                           Rows with status 'pending_review' are the review queue.
//   ai_knowledge_articles   the approved knowledge base the reply assistant answers from, per company,
//                           with a full-text vector (title and tags weigh more than the body)
//   ai_usage                tokens and calls per company and month, for the budgets

const userRef = (t, column) => t.uuid(column).references('id').inTable('users').onDelete('SET NULL');
const unitRef = (t, column) => t.uuid(column).notNullable().references('id').inTable('org_units').onDelete('RESTRICT');
const now = (knex, t, column) => t.timestamp(column, { useTz: true }).notNullable().defaultTo(knex.fn.now());

export async function up(knex) {
  await knex.raw('create extension if not exists pg_trgm');

  await knex.schema.createTable('ai_actions', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    unitRef(t, 'group_id');
    unitRef(t, 'company_id');
    unitRef(t, 'unit_id'); // the subject's unit (a deal's unit, the contact link's unit) or the company
    t.text('agent').notNullable(); // agents/index.js key, or extract | classify | generate | summarise
    t.text('trigger').notNullable().defaultTo('feature');
    t.text('reference'); // the caller's idempotency key, unique per company and agent
    // What it was about. No foreign keys, like the timeline: the log outlives what it describes.
    t.uuid('deal_id');
    t.uuid('contact_id');
    t.uuid('account_id');
    userRef(t, 'owner_user_id'); // the subject's owner when it ran: "own" reviewers see these
    t.text('status').notNullable();
    t.jsonb('input').notNullable();
    t.text('input_summary');
    t.jsonb('output');
    t.jsonb('final_output'); // what features may use: the output, or the reviewer's edit
    t.decimal('confidence', 4, 3);
    t.decimal('threshold', 4, 3);
    t.jsonb('guardrails').notNullable().defaultTo(knex.raw("'[]'::jsonb"));
    t.specificType('review_reasons', 'text[]').notNullable().defaultTo('{}');
    t.text('provider');
    t.text('model');
    t.boolean('mock').notNullable().defaultTo(false);
    t.uuid('connection_id').references('id').inTable('integration_connections').onDelete('SET NULL');
    t.integer('input_tokens').notNullable().defaultTo(0);
    t.integer('output_tokens').notNullable().defaultTo(0);
    t.integer('latency_ms').notNullable().defaultTo(0);
    t.smallint('attempts').notNullable().defaultTo(0);
    t.text('error_code');
    t.text('error_message');
    userRef(t, 'reviewer_user_id');
    t.timestamp('reviewed_at', { useTz: true });
    t.text('review_note');
    userRef(t, 'created_by');
    now(knex, t, 'created_at');
    now(knex, t, 'updated_at');
  });
  await knex.raw(
    "alter table ai_actions add constraint ai_actions_status_chk check (status in ('completed', 'pending_review', 'approved', 'edited', 'rejected', 'failed'))",
  );
  await knex.raw("alter table ai_actions add constraint ai_actions_trigger_chk check (trigger in ('feature', 'automation', 'test', 'seed'))");
  // The log, newest first, per company and across the group.
  await knex.raw('create index ai_actions_company_idx on ai_actions (company_id, created_at desc, id desc)');
  await knex.raw('create index ai_actions_group_idx on ai_actions (group_id, created_at desc, id desc)');
  // The review queue, oldest first.
  await knex.raw("create index ai_actions_review_idx on ai_actions (company_id, created_at, id) where status = 'pending_review'");
  await knex.raw("create index ai_actions_review_group_idx on ai_actions (group_id, created_at, id) where status = 'pending_review'");
  // A record's AI history.
  await knex.raw('create index ai_actions_deal_idx on ai_actions (deal_id, created_at desc) where deal_id is not null');
  await knex.raw('create index ai_actions_contact_idx on ai_actions (contact_id, created_at desc) where contact_id is not null');
  await knex.raw('create unique index ai_actions_reference_uq on ai_actions (company_id, agent, reference) where reference is not null');

  await knex.schema.createTable('ai_knowledge_articles', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    unitRef(t, 'group_id');
    unitRef(t, 'company_id');
    t.text('title').notNullable();
    t.text('body').notNullable();
    t.specificType('tags', 'text[]').notNullable().defaultTo('{}');
    t.text('status').notNullable().defaultTo('draft');
    userRef(t, 'owner_user_id');
    t.specificType('search_tsv', 'tsvector').notNullable();
    userRef(t, 'approved_by');
    t.timestamp('approved_at', { useTz: true });
    userRef(t, 'created_by');
    userRef(t, 'updated_by');
    now(knex, t, 'created_at');
    now(knex, t, 'updated_at');
  });
  await knex.raw("alter table ai_knowledge_articles add constraint ai_knowledge_status_chk check (status in ('draft', 'approved', 'archived'))");
  await knex.raw('create index ai_knowledge_company_idx on ai_knowledge_articles (company_id, status, updated_at desc, id desc)');
  await knex.raw('create index ai_knowledge_search_idx on ai_knowledge_articles using gin (search_tsv)');
  await knex.raw('create index ai_knowledge_title_trgm_idx on ai_knowledge_articles using gin (lower(title) gin_trgm_ops)');
  await knex.raw('create index ai_knowledge_tags_idx on ai_knowledge_articles using gin (tags)');

  await knex.schema.createTable('ai_usage', (t) => {
    unitRef(t, 'company_id');
    unitRef(t, 'group_id');
    t.date('period').notNullable(); // the first day of the month, UTC
    t.integer('calls').notNullable().defaultTo(0);
    t.bigInteger('input_tokens').notNullable().defaultTo(0);
    t.bigInteger('output_tokens').notNullable().defaultTo(0);
    now(knex, t, 'updated_at');
    t.primary(['company_id', 'period']);
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('ai_usage');
  await knex.schema.dropTableIfExists('ai_knowledge_articles');
  await knex.schema.dropTableIfExists('ai_actions');
}
