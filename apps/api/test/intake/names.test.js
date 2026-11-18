import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalToken, compareNames, foldName, nameKey, nameTokens, phoneticToken } from '../../src/core/intake/names.js';

test('folding strips accents and punctuation but keeps other scripts', () => {
  assert.equal(foldName('José  D’Souza'), 'jose d souza');
  assert.equal(foldName('R.K. Sharma'), 'r k sharma');
  assert.equal(foldName('राहुल शर्मा'), 'राहुल शर्मा');
  assert.equal(foldName(null), '');
});

test('honorifics, a trailing "ji" and relation markers are removed', () => {
  assert.deepEqual(nameTokens('Mr. Rahul Sharma'), ['rahul', 'sharma']);
  assert.deepEqual(nameTokens('Smt. Sunita Devi'), ['sunita', 'devi']);
  assert.deepEqual(nameTokens('Dr Shri Anil Kumar'), ['anil', 'kumar']);
  assert.deepEqual(nameTokens('Sharma ji'), ['sharma']);
  assert.deepEqual(nameTokens('Rahul S/o Ramesh Sharma'), ['rahul']);
  assert.deepEqual(nameTokens('Priya D/O. Anil'), ['priya']);
  assert.deepEqual(nameTokens('Kumari'), ['kumari'], 'a lone honorific-looking word is kept as the name');
});

test('known spelling variants share a canonical token', () => {
  for (const spelling of ['mohammed', 'mohammad', 'muhammad', 'mohd', 'md', 'mohamed']) assert.equal(canonicalToken(spelling), 'muhammad');
  assert.equal(canonicalToken('aggarwal'), 'agarwal');
  assert.equal(canonicalToken('chowdhury'), 'chaudhary');
  assert.equal(canonicalToken('rahul'), 'rahul');
});

test('phonetic keys fold common transliteration differences', () => {
  const same = [
    ['lakshmi', 'laxmi'],
    ['pooja', 'puja'],
    ['deepak', 'dipak'],
    ['mohit', 'mohith'],
    ['vishal', 'wishal'],
    ['shreya', 'sreya'],
    ['gaurav', 'gourav'],
    ['vijay', 'vijai'],
    ['krishna', 'krishn'],
    ['priya', 'pria'],
    ['jyoti', 'jyothi'],
    ['sachin', 'sachhin'],
    ['zeenat', 'jeenat'],
    ['farhan', 'pharhan'],
    ['bhavna', 'bavna'],
    ['anna', 'ana'],
  ];
  for (const [a, b] of same) assert.equal(phoneticToken(a), phoneticToken(b), `${a} ~ ${b}`);
  assert.notEqual(phoneticToken('rahul'), phoneticToken('rohit'));
  assert.equal(phoneticToken('राहुल'), 'राहुल', 'other scripts pass through');
});

test('nameKey is order and spelling insensitive', () => {
  assert.equal(nameKey('Sharma, Rahul'), nameKey('Rahul Sarma'));
  assert.equal(nameKey('Mohd. Irfan Shaikh'), nameKey('Sheikh Mohammed Irfan'));
});

test('compareNames: exact, reordered, variant', () => {
  assert.deepEqual(compareNames('Rahul Sharma', 'RAHUL  SHARMA'), { score: 1, method: 'exact', detail: 'same name' });
  assert.equal(compareNames('Mr. Rahul Sharma', 'Rahul Sharma').method, 'exact', 'honorific ignored');
  assert.equal(compareNames('Sharma Rahul', 'Rahul Sharma').method, 'reordered');
  assert.equal(compareNames('Sharma Rahul', 'Rahul Sharma').score, 0.98);
  const variants = [
    ['Mohd. Irfan', 'MUHAMMAD IRFAN'],
    ['Lakshmi Iyer', 'Laxmi Aiyar'],
    ['Pooja Gupta', 'Puja Gupta'],
    ['Gaurav Chaudhary', 'Gourav Chowdhury'],
    ['Smt. Sunita Devi', 'Sunita Debi'],
    ['Rahul Sharma', 'Rahul Sarma'],
    ['Ankit Agrawal', 'Ankit Aggarwal'],
  ];
  for (const [a, b] of variants) {
    const result = compareNames(a, b);
    assert.equal(result.method, 'variant', `${a} ~ ${b}`);
    assert.equal(result.score, 0.95);
  }
});

test('compareNames: subset, initials and a single name', () => {
  assert.deepEqual(
    [compareNames('Rahul Sharma', 'Rahul Kumar Sharma').method, compareNames('Rahul Sharma', 'Rahul Kumar Sharma').score],
    ['subset', 0.88],
  );
  assert.equal(compareNames('R. Sharma', 'Rahul Sharma').method, 'initials');
  assert.equal(compareNames('R K Sharma', 'Rahul Kumar Sharma').score, 0.85);
  assert.equal(compareNames('Rahul', 'Rahul Sharma').method, 'single_name');
  assert.equal(compareNames('Rahul', 'Rahul Sharma').score, 0.7);
  // Initials alone are not enough.
  assert.notEqual(compareNames('R S', 'Rahul Sharma').method, 'initials');
  // An initial that matches nothing breaks the alignment.
  assert.notEqual(compareNames('P. Sharma', 'Rahul Sharma').method, 'initials');
});

test('compareNames: different people fall back to trigram similarity', () => {
  const siblings = compareNames('Rahul Sharma', 'Rohit Sharma');
  assert.equal(siblings.method, 'trigram');
  assert.ok(siblings.score > 0.3 && siblings.score < 0.7, String(siblings.score));
  assert.ok(compareNames('Rahul Sharma', 'Sunita Iyer').score < 0.2);
  assert.ok(compareNames('Priya', 'Priyanka').score < 0.7);
});

test('compareNames: missing names say so', () => {
  assert.deepEqual(compareNames('', 'Rahul'), { score: 0, method: 'missing', detail: 'a name is missing' });
  assert.equal(compareNames('Rahul', undefined).method, 'missing');
});

test('compareNames is symmetric for the common cases', () => {
  const pairs = [['R. Sharma', 'Rahul Sharma'], ['Rahul Sharma', 'Rahul Kumar Sharma'], ['Rahul Sharma', 'Rohit Sharma'], ['Laxmi', 'Lakshmi']];
  for (const [a, b] of pairs) assert.deepEqual(compareNames(a, b), compareNames(b, a), `${a} / ${b}`);
});
