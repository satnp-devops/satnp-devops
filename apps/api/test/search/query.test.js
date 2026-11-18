import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTsQuery,
  compareHits,
  escapeLike,
  matchedOnFor,
  parseSearchQuery,
  snippetFor,
  tokenContaining,
  wordsMatch,
} from '../../src/modules/search/query.js';
import { presentHit } from '../../src/modules/search/present.js';
import { searchQuerySchema } from '../../src/modules/search/routes.js';

const UNIT = '00000000-0000-4000-8000-000000000001';

test('a phone number in any typed form becomes the exact keyword tokens', () => {
  for (const typed of ['98123 45678', '+91 98123-45678', '098123 45678', '(+91) 9812345678', '919812345678']) {
    const parsed = parseSearchQuery(typed);
    assert.equal(parsed.exactKind, 'phone', typed);
    assert.equal(parsed.phone, '+919812345678');
    assert.deepEqual(parsed.exactTokens, ['+919812345678', '919812345678', '9812345678']);
    assert.equal(parsed.tsquery, null, 'numbers never go to the word match');
  }
});

test('numbers without a country code use the working company country', () => {
  const parsed = parseSearchQuery('(415) 555-0123', { defaultCountry: 'US' });
  assert.equal(parsed.phone, '+14155550123');
});

test('an email matches exactly, lower-cased', () => {
  const parsed = parseSearchQuery('Priya.Sharma@Example.com');
  assert.equal(parsed.exactKind, 'email');
  assert.deepEqual(parsed.exactTokens, ['priya.sharma@example.com']);
  assert.equal(parsed.partial, null);
  assert.equal(parsed.tsquery, null);
});

test('a deal reference or a bare deal number matches the reference tokens', () => {
  assert.deepEqual(parseSearchQuery('sp-1042').exactTokens, ['sp-1042']);
  assert.equal(parseSearchQuery('SP-1042').exactKind, 'ref');
  const number = parseSearchQuery('1042');
  assert.equal(number.exactKind, 'code');
  assert.deepEqual(number.exactTokens, ['1042']);
  // Short numbers can also be words in a subtitle ("Grade 11").
  assert.equal(parseSearchQuery('11').tsquery, '11:*');
});

test('a run of digits that is not a whole number is a phone fragment', () => {
  const parsed = parseSearchQuery('0001234');
  assert.equal(parsed.exactKind, null);
  assert.equal(parsed.partial, '0001234');
  assert.equal(parsed.partialKind, 'phone');
  assert.equal(parsed.tsquery, null, 'long digit runs are never word prefixes (they would match phone numbers)');
  assert.equal(parseSearchQuery('1234').partial, null, 'four digits are too short for a fragment');
});

test('part of an email address is an email fragment', () => {
  const parsed = parseSearchQuery('sharma@exa');
  assert.equal(parsed.partial, 'sharma@exa');
  assert.equal(parsed.partialKind, 'email');
  assert.deepEqual(parsed.words, ['sharma', 'exa']);
});

test('a website matches the institute domain token', () => {
  const parsed = parseSearchQuery('www.AimHighClasses.example');
  assert.equal(parsed.exactKind, 'domain');
  assert.deepEqual(parsed.exactTokens, ['aimhighclasses.example']);
});

test('words become a safe prefix query', () => {
  const parsed = parseSearchQuery('  Mrs. Priya   Sha ');
  assert.equal(parsed.text, 'Mrs. Priya Sha');
  assert.deepEqual(parsed.words, ['priya', 'sha']);
  assert.equal(parsed.tsquery, 'priya:* & sha:*');
  assert.equal(parseSearchQuery("D'Souza & co | !(x)").tsquery, 'dsouza:* & co:* & x:*');
  assert.equal(buildTsQuery(['a:b', '&', '']), 'ab:*');
  assert.equal(parseSearchQuery('!!').tsquery, null);
  assert.equal(parseSearchQuery('a b c d e f g h').words.length, 6, 'at most six words');
});

test('LIKE wildcards are escaped', () => {
  assert.equal(escapeLike('50%_off\\'), '50\\%\\_off\\\\');
});

test('matchedOn says why a document matched', () => {
  const phone = parseSearchQuery('9812345678');
  assert.equal(matchedOnFor({ exact: true }, phone), 'phone');
  assert.equal(matchedOnFor({ exact: true }, parseSearchQuery('a@b.example')), 'email');
  assert.equal(matchedOnFor({ exact: true }, parseSearchQuery('SP-7')), 'ref');
  assert.equal(matchedOnFor({ exact: false, partial: true }, parseSearchQuery('12345')), 'phone');
  assert.equal(matchedOnFor({ exact: false, partial: true }, parseSearchQuery('ravi@sch')), 'email');
  const words = parseSearchQuery('priya sha');
  assert.equal(matchedOnFor({ title: 'Priya Sharma', sim: 0.2 }, words), 'name');
  assert.equal(matchedOnFor({ title: 'Aarav Shah – SAT batches', sim: 0.1 }, words), 'text', 'found by other words');
  assert.equal(matchedOnFor({ title: 'Sharmaa', sim: 0.45 }, parseSearchQuery('sharma')), 'name', 'close by trigrams');
  assert.ok(wordsMatch(['pri'], 'Mrs Priya'));
  assert.ok(!wordsMatch([], 'Priya'));
});

test('ranking: exact matches, then fragments, then trigram similarity, then full-text rank, then recency', () => {
  const row = (id, fields) => ({ id, exact: false, partial: false, sim: 0, rank: 0, updated_at: '2026-11-01T00:00:00Z', ...fields });
  const rows = [
    row('a', { sim: 0.9, rank: 0.9 }),
    row('b', { exact: true }),
    row('c', { sim: 0.5, rank: 0.99 }),
    row('d', { sim: 0.5, rank: 0.1, updated_at: '2026-11-05T00:00:00Z' }),
    row('e', { sim: 0.5, rank: 0.1 }),
    row('f', { partial: true }),
    row('g', { sim: 0.5, rank: 0.1 }),
  ];
  assert.deepEqual(rows.sort(compareHits).map((r) => r.id), ['b', 'f', 'a', 'c', 'd', 'e', 'g']);
});

test('the reason under a hit masks phones and emails for people without contacts.view_pii', () => {
  const phone = parseSearchQuery('9812345678');
  assert.deepEqual(snippetFor({ matchedOn: 'phone', row: { exact: true }, parsed: phone, canViewPii: true }), {
    snippet: 'Phone +91 9812345678',
    masked: false,
  });
  assert.deepEqual(snippetFor({ matchedOn: 'phone', row: { exact: true }, parsed: phone, canViewPii: false }), {
    snippet: 'Phone +91 •••••••678',
    masked: true,
  });
  const fragment = parseSearchQuery('45678');
  const keywords = '+919812345678 919812345678 9812345678 priya@example.com sp-1 1 priya';
  assert.equal(tokenContaining(keywords, '45678', 'phone'), '+919812345678');
  assert.equal(
    snippetFor({ matchedOn: 'phone', row: { partial: true, keywords }, parsed: fragment, canViewPii: true }).snippet,
    'Phone +91 9812345678',
  );
  const email = parseSearchQuery('priya@example.com');
  assert.equal(snippetFor({ matchedOn: 'email', row: { exact: true }, parsed: email, canViewPii: false }).snippet, 'Email p•••@example.com');
  assert.equal(snippetFor({ matchedOn: 'ref', row: {}, parsed: parseSearchQuery('1'), canViewPii: false, ref: 'SP-1' }).snippet, 'Ref SP-1');
  const words = parseSearchQuery('priya');
  assert.equal(
    snippetFor({ matchedOn: 'text', row: {}, parsed: words, canViewPii: false, names: [['Contact', 'Priya Chauhan'], ['Institute', null]] }).snippet,
    'Contact Priya Chauhan',
  );
  assert.equal(snippetFor({ matchedOn: 'name', row: {}, parsed: words, canViewPii: false }).snippet, null);
});

test('hits never carry keywords, and contact points are masked without the right', () => {
  const units = new Map([['co', { id: 'co', name: 'SatnPaper', code: 'satnpaper' }]]);
  const contact = presentHit(
    { id: 'c1', title: 'Priya Sharma', subtitle: 'Parent · Pune', keywords: '+919812345678', primary_phone: '+919812345678', primary_email: 'p@x.example' },
    { type: 'contact', matchedOn: 'name', snippet: null, snippetMasked: false, canViewPii: false, unitsById: units },
  );
  assert.equal(contact.contactPoint, '+91 •••••••678');
  assert.equal(contact.piiMasked, true);
  assert.ok(!JSON.stringify(contact).includes('9812345678'));
  assert.equal(contact.companyId, null);

  const visible = presentHit(
    { id: 'c1', title: 'Priya Sharma', subtitle: null, primary_phone: '+919812345678', primary_email: null },
    { type: 'contact', matchedOn: 'name', snippet: null, snippetMasked: false, canViewPii: true, unitsById: units },
  );
  assert.equal(visible.contactPoint, '+91 9812345678');
  assert.equal(visible.piiMasked, false);

  const deal = presentHit(
    { id: 'd1', title: 'Priya Sharma – SAT', subtitle: 'SP-1', company_id: 'co', status: 'open', value_minor: '5000000', currency: 'INR', owner_user_id: 'u1', owner_name: 'Ritika' },
    { type: 'deal', matchedOn: 'ref', snippet: 'Ref SP-1', snippetMasked: false, canViewPii: true, unitsById: units },
  );
  assert.deepEqual(deal.company, { id: 'co', name: 'SatnPaper', code: 'satnpaper' });
  assert.deepEqual(deal.value, { valueMinor: 5000000, currency: 'INR' });
  assert.deepEqual(deal.owner, { id: 'u1', name: 'Ritika' });
  assert.equal(deal.contactPoint, null);
  assert.equal(deal.piiMasked, false);
});

test('the query schema', () => {
  const ok = searchQuerySchema.parse({ unitId: UNIT, q: '  priya ', types: 'deal, contact' });
  assert.equal(ok.q, 'priya');
  assert.deepEqual(ok.types, ['deal', 'contact']);
  assert.equal(ok.limit, 6);
  assert.equal(searchQuerySchema.safeParse({ unitId: UNIT, q: ' a ' }).success, false, 'at least 2 characters');
  assert.equal(searchQuerySchema.safeParse({ unitId: UNIT, q: 'x'.repeat(101) }).success, false);
  assert.equal(searchQuerySchema.safeParse({ unitId: UNIT, q: 'ab', types: 'task' }).success, false);
  assert.equal(searchQuerySchema.safeParse({ unitId: UNIT, q: 'ab', limit: '21' }).success, false);
  assert.equal(searchQuerySchema.safeParse({ unitId: UNIT, q: 'ab', extra: '1' }).success, false, 'strict');
});
