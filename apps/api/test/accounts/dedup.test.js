import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accountDedupKeys,
  accountDomain,
  accountLockKeys,
  accountNameKey,
  chooseAccountMatch,
  cityKey,
  fillAccountBlanks,
  matchReasons,
} from '../../src/modules/accounts/dedup.js';
import { accountCreateBody, accountListQuery } from '../../src/modules/accounts/schemas.js';

// Institute de-duplication keys (docs/crm/PHASE2_CONTRACT.md §9.2, POST /accounts).

test('the domain comes from the website, else from a work email', () => {
  assert.equal(accountDomain({ website: 'https://www.Sunrise-Academy.example/about?x=1' }), 'sunrise-academy.example');
  assert.equal(accountDomain({ website: 'http://www2.school.example:8080' }), 'school.example');
  assert.equal(accountDomain({ email: 'principal@dps-pune.example' }), 'dps-pune.example');
  assert.equal(accountDomain({ website: 'https://site.example', email: 'a@other.example' }), 'site.example', 'the website wins');
});

test('free mailbox domains say nothing about the institute', () => {
  assert.equal(accountDomain({ email: 'mentor.rao@gmail.com' }), null);
  assert.equal(accountDomain({ email: 'office@Rediffmail.com' }), null);
  assert.equal(accountDomain({}), null);
});

test('keys: phone in E.164, email lower-case, name normalised, city lower-case', () => {
  const { keys, invalid } = accountDedupKeys({
    name: '  Dr. Sharma’s  Coaching Centre ',
    city: ' Pune ',
    phone: '098765 43210',
    email: ' Office@Sharma-Coaching.Example ',
  });
  assert.deepEqual(invalid, []);
  assert.equal(keys.phone, '+919876543210');
  assert.equal(keys.email, 'office@sharma-coaching.example');
  assert.equal(keys.domain, 'sharma-coaching.example');
  assert.equal(keys.city, 'pune');
  assert.equal(keys.name, accountNameKey("Sharma's Coaching Centre"), 'honorifics and punctuation do not matter');
});

test('invalid phone and email are reported on their fields', () => {
  const { keys, invalid } = accountDedupKeys({ name: 'X', phone: '12', email: 'not-an-email' }, { path: 'body' });
  assert.equal(keys.phone, null);
  assert.equal(keys.email, null);
  assert.deepEqual(
    invalid.map((item) => item.path),
    ['body.phone', 'body.email'],
  );
});

test('a name made only of punctuation still gets a key', () => {
  assert.equal(accountNameKey('Coaching Hub'), 'coaching hub');
  assert.ok(accountNameKey('???').length > 0);
});

test('city keys ignore case and surrounding spaces', () => {
  assert.equal(cityKey(' New Delhi '), 'new delhi');
  assert.equal(cityKey(null), '');
});

test('lock keys are sorted and name the group', () => {
  const keys = { domain: 'a.example', email: 'x@a.example', phone: '+919000000001', name: 'alpha', city: 'pune' };
  const locks = accountLockKeys('g1', keys);
  assert.deepEqual([...locks].sort(), locks);
  assert.equal(locks.length, 4);
  assert.ok(locks.every((lock) => lock.startsWith('crm.account:g1:')));
  assert.deepEqual(accountLockKeys('g1', { domain: null, email: null, phone: null, name: 'alpha', city: '' }), ['crm.account:g1:name:alpha|']);
});

const row = (overrides) => ({
  id: 'id',
  domain: null,
  primary_email: null,
  primary_phone: null,
  name_normalized: 'sunrise academy',
  city: 'Pune',
  updated_at: '2026-10-01T00:00:00Z',
  ...overrides,
});
const input = { domain: 'sunrise.example', email: 'office@sunrise.example', phone: '+919000011111', name: 'sunrise academy', city: 'pune' };

test('the same name only matches in the same city', () => {
  assert.deepEqual(matchReasons(row({}), input), ['name']);
  assert.deepEqual(matchReasons(row({ city: 'Mumbai' }), input), []);
  assert.deepEqual(matchReasons(row({ city: null }), { ...input, city: '' }), ['name']);
});

test('domain beats email, email beats phone, phone beats name', () => {
  const byName = row({ id: 'name', updated_at: '2026-11-01T00:00:00Z' });
  const byPhone = row({ id: 'phone', name_normalized: 'other', primary_phone: '+919000011111' });
  const byEmail = row({ id: 'email', name_normalized: 'other', primary_email: 'office@sunrise.example' });
  const byDomain = row({ id: 'domain', name_normalized: 'other', domain: 'Sunrise.example' });
  assert.deepEqual(chooseAccountMatch([byName, byPhone, byEmail, byDomain], input), { candidate: byDomain, matchedBy: 'domain' });
  assert.equal(chooseAccountMatch([byName, byPhone, byEmail], input).matchedBy, 'email');
  assert.equal(chooseAccountMatch([byName, byPhone], input).matchedBy, 'phone');
  assert.equal(chooseAccountMatch([byName], input).matchedBy, 'name');
  assert.equal(chooseAccountMatch([row({ name_normalized: 'other' })], input), null);
});

test('among equal matches, more shared keys then the newest wins', () => {
  const older = row({ id: 'older', domain: 'sunrise.example', updated_at: '2026-01-01T00:00:00Z' });
  const newer = row({ id: 'newer', name_normalized: 'x', domain: 'sunrise.example', updated_at: '2026-06-01T00:00:00Z' });
  assert.equal(chooseAccountMatch([newer, older], input).candidate.id, 'older', 'domain + name beats domain alone');
  const a = row({ id: 'a', name_normalized: 'x', domain: 'sunrise.example', updated_at: '2026-01-01T00:00:00Z' });
  const b = row({ id: 'b', name_normalized: 'x', domain: 'sunrise.example', updated_at: '2026-06-01T00:00:00Z' });
  assert.equal(chooseAccountMatch([a, b], input).candidate.id, 'b');
});

test('filling blanks never overwrites what someone entered', () => {
  const stored = {
    kind: 'other',
    legal_name: 'Sunrise Academy Pvt Ltd',
    website: null,
    domain: null,
    primary_phone: '+919000000001',
    primary_email: null,
    city: 'Pune',
    state: null,
    country_code: null,
    branch_count: 0,
    student_count: null,
    current_software: '',
    address: {},
    profile: { boards: ['CBSE'] },
  };
  const changes = fillAccountBlanks(stored, {
    kind: 'coaching_institute',
    legalName: 'Other name',
    website: 'https://sunrise.example',
    domain: 'sunrise.example',
    phone: '+919000000002',
    email: 'office@sunrise.example',
    city: 'Mumbai',
    state: 'Maharashtra',
    countryCode: 'IN',
    branchCount: 3,
    studentCount: 1200,
    currentSoftware: 'Excel sheets',
    address: { line1: 'FC Road' },
    profile: { boards: ['ICSE'], exams: ['JEE'] },
  });
  assert.deepEqual(changes, {
    kind: 'coaching_institute',
    website: 'https://sunrise.example',
    domain: 'sunrise.example',
    primary_email: 'office@sunrise.example',
    state: 'Maharashtra',
    country_code: 'IN',
    student_count: 1200,
    current_software: 'Excel sheets',
    address: { line1: 'FC Road' },
    profile: { boards: ['CBSE'], exams: ['JEE'] },
  });
  assert.deepEqual(fillAccountBlanks({ ...stored, kind: 'school' }, { kind: 'college' }), {}, 'a known kind stays');
});

test('the create body needs exactly one of contactId and contact per person', () => {
  const base = { unitId: '6f1c2b8e-3a4d-4c5e-9f60-7a8b9c0d1e2f', kind: 'school', name: 'Green Valley School' };
  assert.equal(accountCreateBody.safeParse(base).success, true);
  assert.equal(accountCreateBody.safeParse({ ...base, contacts: [{ role: 'decision_maker' }] }).success, false);
  assert.equal(
    accountCreateBody.safeParse({ ...base, contacts: [{ contactId: base.unitId, contact: { firstName: 'Ravi' } }] }).success,
    false,
  );
  const ok = accountCreateBody.safeParse({ ...base, contacts: [{ contact: { firstName: 'Ravi' }, title: 'Principal' }] });
  assert.equal(ok.success, true);
  assert.equal(ok.data.contacts[0].role, 'other');
  assert.equal(accountCreateBody.safeParse({ ...base, kind: 'hospital' }).success, false, 'kinds come from ACCOUNT_KINDS');
  assert.equal(accountCreateBody.safeParse({ ...base, website: 'javascript:alert(1)' }).success, false);
  assert.equal(accountCreateBody.safeParse({ ...base, extra: 1 }).success, false, 'strict');
});

test('the list query reads csv filters and checks the student range', () => {
  const unitId = '6f1c2b8e-3a4d-4c5e-9f60-7a8b9c0d1e2f';
  const parsed = accountListQuery.parse({ unitId, kind: 'school,college', city: 'Pune, Mumbai', studentCountMin: '100' });
  assert.deepEqual(parsed.kind, ['school', 'college']);
  assert.deepEqual(parsed.city, ['Pune', 'Mumbai']);
  assert.equal(parsed.studentCountMin, 100);
  assert.equal(parsed.sort, '-updatedAt');
  assert.equal(parsed.includeArchived, false);
  assert.equal(accountListQuery.safeParse({ unitId, studentCountMin: '500', studentCountMax: '100' }).success, false);
  assert.equal(accountListQuery.safeParse({ unitId, sort: 'phone' }).success, false);
});
