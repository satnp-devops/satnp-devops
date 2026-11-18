import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseContactMatch, normalizeMethods } from '../../src/core/crm/contacts.js';
import { normalizeName, normalizePhone } from '../../src/core/crm/normalize.js';
import { anyNamePairAlike, rankDuplicates, scoreDuplicate } from '../../src/modules/contacts/duplicates.js';

// De-duplication of people (docs/crm/PHASE2_CONTRACT.md §5.2): normalisation makes the same number
// or address compare equal, chooseContactMatch decides sure matches on create, and scoreDuplicate
// ranks the suggestions a person reviews before merging.

const stored = (overrides) => ({
  id: 'c1',
  kind: 'parent',
  first_name: 'Priya',
  last_name: 'Sharma',
  updated_at: '2026-10-01T00:00:00Z',
  matchedEmails: [],
  matchedPhones: [],
  ...overrides,
});

test('the same Indian mobile typed five ways normalises to one value', () => {
  const typed = ['98100 12345', '+91 98100-12345', '098100 12345', '(+91) 9810012345', 'tel:+919810012345'];
  const { methods, invalid } = normalizeMethods({ phones: typed });
  assert.deepEqual(invalid, []);
  assert.equal(methods.length, 1, 'duplicates collapse into one method');
  assert.equal(methods[0].normalized, '+919810012345');
});

test('the default country decides how a national number is read', () => {
  assert.equal(normalizePhone('020 7946 0958', 'GB')?.e164, '+442079460958');
  assert.equal(normalizePhone('9810012345', 'IN')?.e164, '+919810012345');
  assert.equal(normalizePhone('12'), null);
});

test('emails match regardless of case and spaces', () => {
  const { methods } = normalizeMethods({ emails: [' Priya.Sharma@Example.com ', 'priya.sharma@example.com'] });
  assert.equal(methods.length, 1);
  assert.equal(methods[0].normalized, 'priya.sharma@example.com');
});

test('names normalise for matching: case, accents, punctuation and honorifics', () => {
  assert.equal(normalizeName('Mrs. Priyá  SHARMA'), normalizeName('priya sharma'));
  assert.equal(normalizeName('Dr. R. K. Mehta'), normalizeName('R K Mehta'));
});

test('a shared phone with a compatible name is the same person (sure match)', () => {
  const match = chooseContactMatch([stored({ matchedPhones: ['+919810012345'] })], { kind: 'parent', name: 'Priya S' });
  assert.equal(match?.candidate.id, 'c1');
  assert.equal(match.matchedBy, 'phone');
});

test('the other parent sharing the family number is a different person', () => {
  const match = chooseContactMatch([stored({ matchedPhones: ['+919810012345'] })], { kind: 'parent', name: 'Rahul Sharma' });
  assert.equal(match, null);
});

test('a student sharing the parent number is a different person', () => {
  const match = chooseContactMatch([stored({ matchedPhones: ['+919810012345'] })], { kind: 'student', name: 'Priya Sharma' });
  assert.equal(match, null);
});

test('an email match wins over a phone match, and no name means "trust the number"', () => {
  const byPhone = stored({ id: 'phone', matchedPhones: ['+919810012345'], updated_at: '2026-11-01T00:00:00Z' });
  const byEmail = stored({ id: 'email', matchedEmails: ['priya@example.com'] });
  assert.equal(chooseContactMatch([byPhone, byEmail], { name: '' })?.candidate.id, 'email');
});

test('suggestions: a shared number between parent and child scores low', () => {
  const result = scoreDuplicate({ name: 'Priya Sharma', kind: 'parent' }, { name: 'Aarav Sharma', kind: 'student', sharedPhones: 1 });
  assert.deepEqual(result.reasons, ['phone']);
  assert.ok(result.score < 0.4, String(result.score));
});

test('suggestions: the same name and email is almost certainly the same person', () => {
  const result = scoreDuplicate({ name: 'Priya Sharma', kind: 'parent' }, { name: 'Priya Sharma', kind: 'parent', sharedEmails: 1, sharedPhones: 1 });
  assert.deepEqual(result.reasons, ['email', 'phone', 'name']);
  assert.ok(result.score >= 0.95, String(result.score));
});

test('suggestions: a similar name alone is not enough, unless something else is shared', () => {
  const target = { name: 'Priya Sharma', kind: 'parent', city: 'Pune', householdIds: ['h1'] };
  assert.equal(scoreDuplicate(target, { name: 'Priya Sharmaa', kind: 'parent', city: 'Delhi' }), null);
  const sameCity = scoreDuplicate(target, { name: 'Priya Sharmaa', kind: 'parent', city: ' pune ' });
  assert.deepEqual(sameCity.reasons, ['name']);
  const sameHousehold = scoreDuplicate(target, { name: 'Priya Sharmaa', kind: 'parent', householdIds: ['h1'] });
  assert.deepEqual(sameHousehold.reasons, ['name']);
  assert.equal(scoreDuplicate(target, { name: 'Rohan Mehta', kind: 'parent', city: 'Pune' }), null, 'different names never match');
});

test('suggestions: the create form shows similar names on their own', () => {
  const result = scoreDuplicate({ name: 'Asha Verma' }, { name: 'Asha Varma', kind: 'parent' }, { nameAlone: true });
  assert.deepEqual(result.reasons, ['name']);
  assert.ok(result.score > 0.2);
});

test('suggestions: a family entered twice (parent and student names match another household)', () => {
  const target = { name: 'Priya Sharma', kind: 'parent', householdIds: ['h1'], householdNames: ['Aarav Sharma'] };
  const twin = { name: 'Priya Sharma', kind: 'parent', householdIds: ['h2'], householdNames: ['Aarav S'] };
  const result = scoreDuplicate(target, twin);
  assert.ok(result.reasons.includes('household'), JSON.stringify(result));
  assert.ok(result.score >= 0.85, String(result.score));
  const otherFamily = { ...twin, householdNames: ['Kabir Malhotra'] };
  assert.ok(!(scoreDuplicate(target, otherFamily)?.reasons ?? []).includes('household'));
});

test('a family match needs two different households and alike names on both sides', () => {
  assert.equal(anyNamePairAlike(['Aarav Sharma'], ['Aarav S.'], 0.5), true);
  assert.equal(anyNamePairAlike(['Aarav Sharma'], ['Diya Sharma'], 0.5), false);
  assert.equal(anyNamePairAlike([], ['Aarav'], 0.5), false);
  const sameHousehold = scoreDuplicate(
    { name: 'Priya Sharma', householdIds: ['h1'], householdNames: ['Aarav Sharma'] },
    { name: 'Priya Sharma', householdIds: ['h1'], householdNames: ['Aarav Sharma'] },
  );
  assert.ok(!sameHousehold.reasons.includes('household'));
});

test('a stricter threshold drops looser name matches', () => {
  const loose = scoreDuplicate({ name: 'Priya Sharma', city: 'Pune' }, { name: 'Priyanka Sharma', city: 'Pune' }, { threshold: 0.4 });
  const strict = scoreDuplicate({ name: 'Priya Sharma', city: 'Pune' }, { name: 'Priyanka Sharma', city: 'Pune' }, { threshold: 0.9 });
  assert.ok(loose, 'similar enough at 0.4');
  assert.equal(strict, null);
});

test('suggestions rank best first, then by name', () => {
  const ranked = rankDuplicates([
    { name: 'B', score: 0.4 },
    { name: 'A', score: 0.9 },
    { name: 'C', score: 0.4 },
  ]);
  assert.deepEqual(ranked.map((r) => r.name), ['A', 'B', 'C']);
});
