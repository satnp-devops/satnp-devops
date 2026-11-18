// Global search (search slice, docs/crm/PHASE2_CONTRACT.md §5.13 and §9.10): two additions to
// search_documents so GET /search stays exact, private and fast at 1 lakh+ records per company.
//
// 1. words_tsv: the same words as tsv minus personal data. tsv also holds the normalised phones and
//    emails from `keywords`, so a prefix query on it ("98123:*", "priyasharma19:*") would let someone
//    without contacts.view_pii rebuild a number or an address one character at a time. Prefix and
//    word matching use words_tsv; phones and emails match only as whole tokens (2).
// 2. search_documents_keyword_tokens_idx: GIN over the keyword tokens, so an exact phone, email or
//    reference lookup is one index probe: string_to_array(keywords, ' ') && array['+919812345678', ...].

// Keyword tokens that are personal data: anything with an @ (emails) and runs of 7+ digits (phones).
// ("{0,1}" rather than "?", which knex.raw would read as a binding.)
const PII_TOKENS = String.raw`(\S*@\S*|\+{0,1}\d{7,})`;

export async function up(knex) {
  await knex.raw(`
    alter table search_documents add column words_tsv tsvector generated always as (
      setweight(to_tsvector('simple'::regconfig, coalesce(title, '')), 'A') ||
      setweight(to_tsvector('simple'::regconfig, regexp_replace(coalesce(keywords, ''), '${PII_TOKENS}', ' ', 'g')), 'A') ||
      setweight(to_tsvector('simple'::regconfig, coalesce(subtitle, '')), 'B')
    ) stored`);
  await knex.raw('create index search_documents_words_tsv_idx on search_documents using gin (words_tsv)');
  await knex.raw(`create index search_documents_keyword_tokens_idx on search_documents using gin (string_to_array(keywords, ' '))`);
}

export async function down(knex) {
  await knex.raw('drop index if exists search_documents_keyword_tokens_idx');
  await knex.raw('drop index if exists search_documents_words_tsv_idx');
  await knex.raw('alter table search_documents drop column if exists words_tsv');
}
