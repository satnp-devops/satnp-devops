import { db } from '../../lib/db.js';
import { keywords } from './text.js';
import { articleRelevance } from './mock/writers.js';

// The approved knowledge base the reply assistant answers from (ai_knowledge_articles).
// Retrieval: Postgres full text (english, OR of the question's content words) plus a trigram
// match on the title, then re-ranked in code by how many of the question's words each article covers.

/** The tsvector expression written with every article (title and tags weigh more than the body). */
export function searchVector(knex, { title, body, tags }) {
  return knex.raw(
    "setweight(to_tsvector('english', ?), 'A') || setweight(to_tsvector('english', ?), 'A') || setweight(to_tsvector('english', ?), 'B')",
    [title, (tags ?? []).join(' '), body],
  );
}

/** "fee | sat | weekend": the question's content words, safe for to_tsquery. */
export function orQuery(text) {
  return keywords(text)
    .filter((word) => /^[\p{L}\p{N}]+$/u.test(word))
    .slice(0, 12)
    .join(' | ');
}

/**
 * Approved articles of a company that may answer a question, best first, each with a
 * `relevance` from 0 to 1. One query on the company's articles.
 */
export async function retrieveArticles({ companyId, query, limit = 4, trx = db }) {
  const terms = orQuery(query);
  if (!terms) return [];
  const { rows } = await trx.raw(
    `select a.id, a.title, a.body, a.tags, a.updated_at, ts_rank_cd(a.search_tsv, q) as rank
       from ai_knowledge_articles a, to_tsquery('english', ?) q
      where a.company_id = ? and a.status = 'approved'
        and (a.search_tsv @@ q or word_similarity(lower(a.title), lower(?)) >= 0.6)
      order by rank desc, a.updated_at desc, a.id
      limit ?`,
    [terms, companyId, String(query).slice(0, 300), limit * 3],
  );
  return rows
    .map((row) => ({ id: row.id, title: row.title, body: row.body, tags: row.tags ?? [], relevance: articleRelevance(query, row) }))
    .sort((a, b) => b.relevance - a.relevance || a.title.localeCompare(b.title))
    .slice(0, limit);
}
