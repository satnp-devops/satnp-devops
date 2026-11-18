// Deals slice additions to the phase 2 schema (docs/crm/PHASE2_CONTRACT.md §5.8, reported as a
// contract change by the deals slice):
//
//   deals.owner_seen_at  when the current owner first opened the lead (POST /deals/:id/seen). The
//                        Leads list highlights open leads from the last 7 days that their owner
//                        hasn't opened yet ("New"). Cleared whenever the owner changes.
//   deals_company_title_idx     keyset index for sort=title / -title (lower(title), id)
//   deals_company_campaign_idx  the campaign filter (first-touch campaign, else the UTM campaign)

export async function up(knex) {
  await knex.schema.alterTable('deals', (t) => {
    t.timestamp('owner_seen_at', { useTz: true });
  });
  await knex.raw('create index deals_company_title_idx on deals (company_id, lower(title), id) where archived_at is null');
  await knex.raw(
    `create index deals_company_campaign_idx on deals (company_id, (coalesce(first_touch->>'campaign', first_touch->'utm'->>'campaign')))
       where archived_at is null`,
  );
}

export async function down(knex) {
  await knex.raw('drop index if exists deals_company_campaign_idx');
  await knex.raw('drop index if exists deals_company_title_idx');
  await knex.schema.alterTable('deals', (t) => {
    t.dropColumn('owner_seen_at');
  });
}
