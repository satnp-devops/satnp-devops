// Institutes (accounts slice): lookups used by de-duplication and the list filters.
//
//   accounts_group_phone_idx  exact phone match (POST /accounts de-duplication, GET /accounts?q=<phone>)
//   accounts_group_email_idx  exact email match (de-duplication, q=<email>)
//   accounts_group_city_idx   GET /accounts?city=… (case-insensitive)
//
// The name + city match uses accounts_group_name_idx from the phase 2 migration; the domain match
// uses accounts_domain_idx. All partial on merged_into_id is null, like the other account indexes.

const INDEXES = [
  ['accounts_group_phone_idx', 'accounts (group_id, primary_phone) where primary_phone is not null and merged_into_id is null'],
  ['accounts_group_email_idx', 'accounts (group_id, primary_email) where primary_email is not null and merged_into_id is null'],
  ['accounts_group_city_idx', 'accounts (group_id, lower(city)) where city is not null and merged_into_id is null'],
];

export async function up(knex) {
  for (const [name, definition] of INDEXES) await knex.raw(`create index if not exists ${name} on ${definition}`);
}

export async function down(knex) {
  for (const [name] of INDEXES) await knex.raw(`drop index if exists ${name}`);
}
