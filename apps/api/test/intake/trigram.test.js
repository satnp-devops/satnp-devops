import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PG_TRGM_DEFAULT_THRESHOLD, isSimilar, setSimilarity, similarity, trigrams } from '../../src/core/intake/trigram.js';

const sorted = (set) => [...set].sort();

test('trigrams pad each word with two spaces before and one after (pg_trgm show_trgm)', () => {
  // SELECT show_trgm('cat') → {"  c"," ca","at ",cat}
  assert.deepEqual(sorted(trigrams('cat')), sorted(['  c', ' ca', 'cat', 'at ']));
  // SELECT show_trgm('foo|bar') → {"  b","  f"," ba"," fo","ar ",bar,foo,"oo "}
  assert.deepEqual(sorted(trigrams('foo|bar')), sorted(['  b', '  f', ' ba', ' fo', 'ar ', 'bar', 'foo', 'oo ']));
});

test('case is folded and punctuation separates words', () => {
  assert.deepEqual(sorted(trigrams('CAT')), sorted(trigrams('cat')));
  assert.deepEqual(sorted(trigrams('R.K. Sharma')), sorted(trigrams('r k sharma')));
});

test('short words and empty strings', () => {
  assert.deepEqual(sorted(trigrams('a')), sorted(['  a', ' a ']));
  assert.deepEqual(sorted(trigrams('ab')), sorted(['  a', ' ab', 'ab ']));
  assert.equal(trigrams('').size, 0);
  assert.equal(trigrams('  ,.; ').size, 0);
  assert.equal(trigrams(null).size, 0);
});

test('trigrams are a set: repeated words count once', () => {
  assert.equal(trigrams('aaa aaa').size, trigrams('aaa').size);
});

test('similarity matches pg_trgm reference values', () => {
  // The pg_trgm docs: similarity('word', 'two words') = 0.363636 (4 shared of 11).
  assert.ok(Math.abs(similarity('word', 'two words') - 4 / 11) < 1e-9);
  // cat vs cats: 3 shared ("  c", " ca", "cat") of 6.
  assert.equal(similarity('cat', 'cats'), 0.5);
  assert.equal(similarity('Rahul Sharma', 'rahul sharma'), 1);
  assert.equal(similarity('abc', 'xyz'), 0);
});

test('word order does not matter, as in pg_trgm', () => {
  assert.equal(similarity('Sharma Rahul', 'Rahul Sharma'), 1);
});

test('either side empty gives 0, including both', () => {
  assert.equal(similarity('', ''), 0);
  assert.equal(similarity('rahul', ''), 0);
});

test('similarity is symmetric', () => {
  const pairs = [['Priya', 'Priyanka'], ['Mohammed Irfan', 'Mohd Irfan'], ['Aarav', 'Arav']];
  for (const [a, b] of pairs) assert.equal(similarity(a, b), similarity(b, a));
});

test('non-Latin scripts are compared by code point, keeping vowel signs inside words', () => {
  assert.equal(similarity('राहुल शर्मा', 'राहुल शर्मा'), 1);
  assert.ok(trigrams('राहुल').size >= 3);
  assert.ok(similarity('राहुल', 'राहुल शर्मा') > 0.3);
});

test('the % operator default threshold is 0.3', () => {
  assert.equal(PG_TRGM_DEFAULT_THRESHOLD, 0.3);
  assert.ok(isSimilar('word', 'two words'));
  assert.ok(!isSimilar('abc', 'xyz'));
  assert.ok(!isSimilar('word', 'two words', 0.5));
});

test('setSimilarity works on precomputed sets', () => {
  assert.equal(setSimilarity(trigrams('cat'), trigrams('cats')), 0.5);
  assert.equal(setSimilarity(new Set(), trigrams('cats')), 0);
});
