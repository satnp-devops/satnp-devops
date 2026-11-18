/**
 * Trigram similarity with PostgreSQL pg_trgm semantics, so a score computed here matches
 * `similarity(a, b)` in the database (and the `%` operator's default 0.3 threshold).
 *
 * pg_trgm rules (https://www.postgresql.org/docs/current/pgtrgm.html):
 * - text is lower-cased;
 * - non-word characters (anything but letters and digits) separate words and are ignored;
 * - each word is padded with two spaces before and one after, then cut into every run of
 *   three consecutive characters ("cat" → "  c", " ca", "cat", "at ");
 * - trigrams form a set (duplicates count once);
 * - similarity = shared / (|A| + |B| − shared), 0 when either side has no trigrams.
 *
 * Differences that don't matter for names: Postgres uses float4 (we return a double) and
 * hashes trigrams of multi-byte characters (we compare them exactly). Combining marks count
 * as word characters, so Devanagari words with vowel signs stay whole as they do under a
 * UTF-8 locale.
 */

/** pg_trgm.similarity_threshold default. */
export const PG_TRGM_DEFAULT_THRESHOLD = 0.3;

const WORD = /[\p{L}\p{N}\p{M}]+/gu;

/**
 * The trigram set of a string, as pg_trgm's show_trgm() would list it (unordered).
 * @param {unknown} text
 * @returns {Set<string>}
 */
export function trigrams(text) {
  const set = new Set();
  const lower = String(text ?? '').toLowerCase();
  for (const match of lower.matchAll(WORD)) {
    const chars = Array.from(`  ${match[0]} `);
    for (let i = 0; i + 3 <= chars.length; i += 1) set.add(chars[i] + chars[i + 1] + chars[i + 2]);
  }
  return set;
}

/**
 * pg_trgm similarity between two strings, from 0 (nothing shared) to 1 (same trigram set).
 * @param {unknown} a
 * @param {unknown} b
 */
export function similarity(a, b) {
  return setSimilarity(trigrams(a), trigrams(b));
}

/**
 * Similarity of two precomputed trigram sets (lets callers cache sets for many comparisons).
 * @param {Set<string>} left
 * @param {Set<string>} right
 */
export function setSimilarity(left, right) {
  if (left.size === 0 || right.size === 0) return 0;
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  let shared = 0;
  for (const gram of small) if (large.has(gram)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/** The `a % b` operator: similarity above the threshold. */
export function isSimilar(a, b, threshold = PG_TRGM_DEFAULT_THRESHOLD) {
  return similarity(a, b) >= threshold;
}
