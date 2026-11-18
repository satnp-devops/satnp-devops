import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignPrimaries, chooseContactMatch, fillBlanks, normalizeMethods, primaryEmailOf, primaryPhoneOf } from '../../src/core/crm/contacts.js';
import { db } from '../../src/lib/db.js';

const candidate = (overrides) => ({
  id: 'c1',
  kind: 'parent',
  first_name: 'Priya',
  last_name: 'Sharma',
  updated_at: '2026-10-01T00:00:00Z',
  matchedEmails: [],
  matchedPhones: [],
  ...overrides,
});

test('normalizeMethods normalises, de-duplicates and reports bad values with paths', () => {
  const { methods, invalid } = normalizeMethods(
    {
      phones: ['098123 45678', { value: '+91 98123 45678', kind: 'whatsapp' }, '+91-98123-45678', 'call me'],
      emails: [' Priya.Sharma@Example.com ', 'not-an-email'],
    },
    { path: 'body.contact' },
  );
  assert.deepEqual(
    methods.map((m) => [m.kind, m.normalized]),
    [
      ['phone', '+919812345678'],
      ['whatsapp', '+919812345678'],
      ['email', 'priya.sharma@example.com'],
    ],
  );
  assert.equal(methods[2].value, 'Priya.Sharma@Example.com', 'the value is kept as entered (trimmed)');
  assert.deepEqual(
    invalid.map((i) => i.path),
    ['body.contact.phones.3', 'body.contact.emails.1'],
  );
});

test('normalizeMethods uses the default country for national numbers', () => {
  const { methods } = normalizeMethods({ phones: ['050 123 4567'] }, { defaultCountry: 'AE' });
  assert.equal(methods[0].normalized, '+971501234567');
});

test('assignPrimaries keeps one primary per kind and respects stored primaries', () => {
  const methods = [
    { kind: 'phone', normalized: '+911', isPrimary: false },
    { kind: 'phone', normalized: '+912', isPrimary: true },
    { kind: 'email', normalized: 'a@x.example', isPrimary: false },
  ];
  assert.deepEqual(
    assignPrimaries(methods).map((m) => m.isPrimary),
    [false, true, true],
  );
  assert.deepEqual(
    assignPrimaries(methods, { hasPrimary: { phone: true } }).map((m) => m.isPrimary),
    [false, false, true],
  );
  const primaries = assignPrimaries(methods);
  assert.equal(primaryPhoneOf(primaries), '+912');
  assert.equal(primaryEmailOf(primaries), 'a@x.example');
  assert.equal(primaryPhoneOf([{ kind: 'whatsapp', normalized: '+913', isPrimary: true }]), '+913');
});

test('chooseContactMatch: an email match beats a phone match', () => {
  const byPhone = candidate({ id: 'phone', matchedPhones: ['+919812345678'], updated_at: '2026-10-05T00:00:00Z' });
  const byEmail = candidate({ id: 'email', matchedEmails: ['priya@example.com'] });
  const match = chooseContactMatch([byPhone, byEmail], { kind: 'parent', name: 'Priya Sharma' });
  assert.equal(match.candidate.id, 'email');
  assert.equal(match.matchedBy, 'email');
});

test('chooseContactMatch: a parent and child sharing a number stay separate people', () => {
  const parent = candidate({ matchedPhones: ['+919812345678'] });
  assert.equal(chooseContactMatch([parent], { kind: 'student', name: 'Aarav Sharma' }), null);
  assert.equal(chooseContactMatch([parent], { kind: 'parent', name: 'Rajesh Kumar' }), null, 'a clearly different name is a different person');
  assert.equal(chooseContactMatch([parent], { kind: 'parent', name: 'priya  sharma' }).candidate.id, 'c1');
  assert.equal(chooseContactMatch([parent], { name: '' }).candidate.id, 'c1', 'no name given: the number decides');
});

test('chooseContactMatch: the most recently updated wins a tie', () => {
  const older = candidate({ id: 'old', matchedPhones: ['+91'], updated_at: '2026-01-01T00:00:00Z' });
  const newer = candidate({ id: 'new', matchedPhones: ['+91'], updated_at: '2026-09-01T00:00:00Z' });
  assert.equal(chooseContactMatch([older, newer], { name: 'Priya Sharma' }).candidate.id, 'new');
});

test('fillBlanks only fills what is missing', () => {
  const stored = { first_name: null, last_name: null, kind: 'other', city: 'Pune', country_code: null, time_zone: null, language: null, student_profile: { grade: '11' } };
  const changes = fillBlanks(stored, {
    firstName: 'Aarav',
    lastName: 'Shah',
    kind: 'student',
    city: 'Mumbai',
    countryCode: 'IN',
    studentProfile: { grade: '12', targetExam: 'SAT' },
  });
  assert.deepEqual(changes, {
    first_name: 'Aarav',
    last_name: 'Shah',
    kind: 'student',
    country_code: 'IN',
    student_profile: { grade: '11', targetExam: 'SAT' },
  });
  assert.deepEqual(fillBlanks({ ...stored, first_name: 'Aarav', kind: 'student', country_code: 'IN', student_profile: { grade: '11', targetExam: 'SAT' } }, { firstName: 'Other', countryCode: 'IN' }), {});
});

test.after(() => db.destroy());
