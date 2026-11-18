import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_DEDUP_OPTIONS,
  DEFAULT_MERGE_RELATIONS,
  candidateKeys,
  choosePrimary,
  findDuplicates,
  mergePlan,
  phonesNear,
  scoreCandidate,
  toDedupRecord,
} from '../../src/core/intake/dedup.js';
import { toEnquiry } from '../../src/core/intake/enquiry.js';

const NOW = Date.UTC(2026, 10, 5);

/** A normalised enquiry, built the way every channel builds one. */
function enquiry({ name, phone, email, city, student, parent, relation } = {}) {
  const result = toEnquiry(
    {
      source: { channel: { type: 'website_form', identity: 'satnpaper.com' } },
      contact: { name, phone, email, city, relation },
      ...(student ? { student: { name: student } } : {}),
      ...(parent ? { parent: { name: parent } } : {}),
    },
    { now: NOW },
  );
  assert.ok(result.ok, JSON.stringify(result));
  return result.enquiry;
}

const score = (incoming, contact, options) => scoreCandidate(toDedupRecord(incoming), toDedupRecord(contact), options);

test('defaults: merge at 0.9, suggest at 0.6', () => {
  assert.deepEqual(DEFAULT_DEDUP_OPTIONS.thresholds, { merge: 0.9, suggest: 0.6 });
});

// --- phone ---------------------------------------------------------------------------------------

test('same phone and agreeing names merge', () => {
  const result = score(enquiry({ name: 'Rahul Sharma', phone: '098765 43210' }), { id: 'c1', name: 'Rahul Sarma', phone: '+91 98765 43210' });
  assert.equal(result.decision, 'merge');
  assert.equal(result.score, 1);
  assert.equal(result.rules[0].rule, 'phone_exact');
  assert.match(result.explanation, /Same phone \+919876543210; names agree \(spelling or transliteration variant\)/);
  assert.equal(result.matchedAs, 'person');
});

test('same phone with a name missing on one side still merges, a little lower', () => {
  const result = score(enquiry({ phone: '9876543210' }), { id: 'c1', name: 'Rahul Sharma', phones: ['+919876543210'] });
  assert.equal(result.score, 0.95);
  assert.equal(result.decision, 'merge');
  assert.match(result.explanation, /a name is missing/);
});

test('same phone but different names is only a suggestion (a family phone)', () => {
  const result = score(enquiry({ name: 'Sunita Sharma', phone: '9876543210' }), { id: 'c1', name: 'Rahul Sharma', phone: '9876543210' });
  assert.equal(result.score, 0.7);
  assert.equal(result.decision, 'suggest');
  assert.match(result.explanation, /names differ .* family member/);
});

test('a learner enquiring from a parent’s phone matches the family as the student', () => {
  const result = score(enquiry({ name: 'Aarav Sharma', phone: '9876543210', relation: 'self' }), {
    id: 'c1',
    name: 'Rahul Sharma',
    phone: '9876543210',
    students: [{ name: 'Aarav Sharma' }],
  });
  assert.equal(result.decision, 'merge');
  assert.equal(result.score, 0.95);
  assert.equal(result.matchedAs, 'student');
  assert.match(result.explanation, /matches the student on this record \(Aarav Sharma\)/);
});

test('a parent enquiring from a learner’s phone matches the record as the parent', () => {
  const result = score(enquiry({ name: 'Rahul Sharma', phone: '9876543210' }), {
    id: 's1',
    name: 'Aarav Sharma',
    phone: '9876543210',
    parents: ['Rahul Sharma'],
  });
  assert.equal(result.matchedAs, 'parent');
  assert.equal(result.decision, 'merge');
});

test('the alternate phone counts as a phone', () => {
  const incoming = toEnquiry({ source: { channel: { type: 'phone_call' } }, contact: { name: 'Rahul Sharma', phone: '9000000001', altPhone: '9876543210' } }).enquiry;
  assert.equal(score(incoming, { id: 'c1', name: 'Rahul Sharma', phones: [{ value: '+919876543210', label: 'work' }] }).decision, 'merge');
});

// --- email ---------------------------------------------------------------------------------------

test('same email and agreeing names merge', () => {
  const result = score(enquiry({ name: 'Priya Iyer', email: 'Priya.Iyer@Example.in' }), { id: 'c2', name: 'Priya Aiyar', emails: [{ address: 'priya.iyer@example.in' }] });
  assert.equal(result.decision, 'merge');
  assert.equal(result.rules[0].rule, 'email_exact');
});

test('same email but different names is a suggestion', () => {
  const result = score(enquiry({ name: 'Kavya Iyer', email: 'iyerfamily@example.in' }), { id: 'c2', name: 'Priya Iyer', email: 'iyerfamily@example.in' });
  assert.equal(result.decision, 'suggest');
  assert.equal(result.score, 0.7);
});

test('same phone and same email merge even when the names differ', () => {
  const result = score(enquiry({ name: 'Bunty', phone: '9876543210', email: 'rahul@example.in' }), { id: 'c1', name: 'Rahul Sharma', phone: '9876543210', email: 'rahul@example.in' });
  assert.equal(result.decision, 'merge');
  assert.equal(result.rules[0].rule, 'phone_and_email');
  assert.equal(result.score, 1);
});

test('the same Gmail mailbox written differently merges when names agree', () => {
  const incoming = enquiry({ name: 'Rahul Sharma', email: 'rahul.sharma+sat@gmail.com' });
  const result = score(incoming, { id: 'c1', name: 'Rahul Sharma', email: 'rahulsharma@googlemail.com' });
  assert.equal(result.rules[0].rule, 'email_alias');
  assert.equal(result.score, 0.95);
  assert.equal(result.decision, 'merge');
  const otherName = score(incoming, { id: 'c2', name: 'Sunita Sharma', email: 'rahulsharma@gmail.com' });
  assert.equal(otherName.decision, 'suggest');
  assert.equal(otherName.score, 0.65);
  const outlook = score(enquiry({ name: 'Rahul Sharma', email: 'rahul.sharma@outlook.com' }), { id: 'c3', name: 'Rahul Sharma', email: 'rahulsharma@outlook.com' });
  assert.ok(!outlook.rules.some((r) => r.rule === 'email_alias'), 'outside Gmail dots are significant');
});

// --- parent + student ----------------------------------------------------------------------------

test('full parent and student names matching merge without any shared contact point', () => {
  const result = score(enquiry({ name: 'Rahul Sharma', phone: '9000000001', student: 'Aarav Sharma' }), {
    id: 'c3',
    name: 'Rahul Sarma',
    phone: '9111111111',
    children: ['Aarav Sharma', 'Anaya Sharma'],
  });
  assert.equal(result.rules[0].rule, 'parent_student');
  assert.equal(result.score, 0.874); // 0.92 × 0.95 (parent is a spelling variant)
  assert.equal(result.decision, 'suggest', 'a spelling variant keeps it below the merge line');
  const exact = score(enquiry({ name: 'Rahul Sharma', phone: '9000000001', student: 'Aarav Sharma' }), { id: 'c3', name: 'Rahul Sharma', children: ['Aarav Sharma'] });
  assert.equal(exact.score, 0.92);
  assert.equal(exact.decision, 'merge');
});

test('parent + student with first names only can only be suggested', () => {
  const result = score(enquiry({ name: 'Rahul', phone: '9000000001', student: 'Aarav' }), { id: 'c3', name: 'Rahul', students: ['Aarav'] });
  assert.equal(result.score, 0.75);
  assert.equal(result.decision, 'suggest');
  assert.match(result.explanation, /not all are full names/);
});

test('the same parent with a different child is not a parent + student match', () => {
  const result = score(enquiry({ name: 'Rahul Sharma', phone: '9000000001', student: 'Ishaan Sharma' }), { id: 'c3', name: 'Rahul Sharma', students: ['Aarav Sharma'] });
  const pair = result.rules.find((r) => r.rule === 'parent_student');
  assert.ok(!pair || pair.score < 0.6, JSON.stringify(result.rules));
});

test('household members with a child relation count as students', () => {
  const contact = { id: 'c3', name: 'Rahul Sharma', household: { members: [{ name: 'Aarav Sharma', relation: 'son' }, { name: 'Meera Sharma', relation: 'spouse' }] } };
  assert.deepEqual(toDedupRecord(contact).students, ['Aarav Sharma']);
  assert.equal(score(enquiry({ name: 'Rahul Sharma', phone: '9000000001', student: 'Aarav Sharma' }), contact).decision, 'merge');
});

test('a learner who names a parent matches the parent’s record', () => {
  const result = score(enquiry({ name: 'Aarav Sharma', phone: '9000000001', relation: 'self', parent: 'Rahul Sharma' }), {
    id: 'c3',
    name: 'Rahul Sharma',
    students: ['Aarav Sharma'],
  });
  assert.equal(result.rules[0].rule, 'parent_student');
  assert.equal(result.matchedAs, 'parent');
  assert.equal(result.decision, 'merge');
});

test('a parent enquiry matches a learner’s own record through its parents', () => {
  const result = score(enquiry({ name: 'Rahul Sharma', phone: '9000000001', student: 'Aarav Sharma' }), {
    id: 's1',
    name: 'Aarav Sharma',
    guardians: [{ firstName: 'Rahul', lastName: 'Sharma' }],
  });
  assert.equal(result.matchedAs, 'student');
  assert.equal(result.decision, 'merge');
});

// --- near phones and names -----------------------------------------------------------------------

test('phonesNear spots one wrong digit or two swapped digits', () => {
  assert.ok(phonesNear('+919876543210', '+919876543211'));
  assert.ok(phonesNear('+919876543210', '+919876542310'));
  assert.ok(!phonesNear('+919876543210', '+919876543210'), 'equal is not near');
  assert.ok(!phonesNear('+919876543210', '+919876540000'), 'several digits');
  assert.ok(!phonesNear('+919876543210', '+929876543210'), 'country code differs');
  assert.ok(!phonesNear('+919876543210', '+91987654321'), 'lengths differ');
  assert.ok(!phonesNear('+9198765', '+9198766'), 'too short to judge');
});

test('a phone typo with an agreeing name is suggested', () => {
  const result = score(enquiry({ name: 'Rahul Sharma', phone: '9876543211' }), { id: 'c1', name: 'Rahul Sharma', phone: '9876543210' });
  assert.equal(result.rules[0].rule, 'phone_near');
  assert.equal(result.score, 0.8);
  assert.equal(result.decision, 'suggest');
  const otherName = score(enquiry({ name: 'Kavya Nair', phone: '9876543211' }), { id: 'c1', name: 'Rahul Sharma', phone: '9876543210' });
  assert.equal(otherName.decision, 'new');
});

test('a name alone is suggested only in the same city, and never merges', () => {
  const sameCity = score(enquiry({ name: 'Rahul Sharma', phone: '9000000001', city: 'Delhi' }), { id: 'c4', name: 'Rahul Sharma', city: 'delhi ' });
  assert.equal(sameCity.rules[0].rule, 'name_similar');
  assert.equal(sameCity.score, 0.65);
  assert.equal(sameCity.decision, 'suggest');
  const noCity = score(enquiry({ name: 'Rahul Sharma', phone: '9000000001' }), { id: 'c4', name: 'Rahul Sharma' });
  assert.equal(noCity.score, 0.55);
  assert.equal(noCity.decision, 'new');
  const weak = score(enquiry({ name: 'Rahul Sharma', phone: '9000000001', city: 'Delhi' }), { id: 'c4', name: 'Rohit Sharma', city: 'Delhi' });
  assert.deepEqual(weak.rules, [], 'below nameOnlyMin the rule does not fire');
  const generous = score(enquiry({ name: 'Rahul Sharma', phone: '9000000001', city: 'Delhi' }), { id: 'c4', name: 'Rahul Sharma', city: 'Delhi' }, { thresholds: { merge: 0.5, suggest: 0.3 } });
  assert.ok(generous.score < 0.5, 'name_similar stays below the merge line whatever the thresholds');
});

test('nothing in common is new', () => {
  const result = score(enquiry({ name: 'Kavya Nair', phone: '9000000001' }), { id: 'c9', name: 'Rahul Sharma', phone: '9111111111' });
  assert.deepEqual(result, { contactId: 'c9', score: 0, decision: 'new', rules: [], explanation: 'Nothing in common' });
});

// --- thresholds and safety rules -----------------------------------------------------------------

test('thresholds are configurable', () => {
  const incoming = enquiry({ phone: '9876543210' });
  const contact = { id: 'c1', name: 'Rahul Sharma', phone: '9876543210' };
  assert.equal(score(incoming, contact).decision, 'merge');
  assert.equal(score(incoming, contact, { thresholds: { merge: 0.96 } }).decision, 'suggest');
  assert.equal(score(incoming, contact, { thresholds: { merge: 0.99, suggest: 0.96 } }).decision, 'new');
  const looseNames = score(enquiry({ name: 'Priya', phone: '9876543210' }), { id: 'c1', name: 'Priyanka', phone: '9876543210' }, { nameAgree: 0.5 });
  assert.equal(looseNames.decision, 'merge', 'nameAgree decides when names count as the same');
});

test('findDuplicates merges into the single strong match and lists the rest', () => {
  const incoming = enquiry({ name: 'Rahul Sharma', phone: '9876543210', email: 'rahul.sharma@gmail.com', student: 'Aarav Sharma', city: 'Delhi' });
  const result = findDuplicates(incoming, [
    { id: 'c1', name: 'Rahul Sarma', phones: ['+919876543210'] },
    { id: 'c2', name: 'Sunita Sharma', email: 'rahulsharma@gmail.com' },
    { id: 'c3', name: 'Rahul Kumar Sharma', students: [{ name: 'Aarav Sharma' }] },
    { id: 'c4', name: 'Rahul Sharma', city: 'Delhi' },
    { id: 'c5', name: 'Kavya Nair', phone: '9111111111' },
  ]);
  assert.equal(result.decision, 'merge');
  assert.equal(result.contactId, 'c1');
  assert.equal(result.matchedAs, 'person');
  assert.deepEqual(result.candidates.map((c) => [c.contactId, c.decision]), [
    ['c1', 'merge'],
    ['c3', 'suggest'],
    ['c2', 'suggest'],
    ['c4', 'suggest'],
  ]);
});

test('two different contacts at merge level are ambiguous: suggest, never auto-merge', () => {
  const incoming = enquiry({ name: 'Rahul Sharma', phone: '9876543210', email: 'rahul@example.in' });
  const result = findDuplicates(incoming, [
    { id: 'c1', name: 'Rahul Sharma', phone: '9876543210' },
    { id: 'c2', name: 'Rahul Sharma', email: 'rahul@example.in' },
  ]);
  assert.equal(result.decision, 'suggest');
  assert.equal(result.contactId, null);
  assert.match(result.explanation, /Matches 2 existing contacts strongly/);
  assert.equal(result.candidates.length, 2);
});

test('a pair marked as not duplicates is never merged or suggested', () => {
  const incoming = enquiry({ name: 'Rahul Sharma', phone: '9876543210' });
  const result = findDuplicates(incoming, [{ id: 'c1', name: 'Rahul Sharma', phone: '9876543210' }], { notDuplicates: ['c1'] });
  assert.equal(result.decision, 'new');
  const scored = score(incoming, { id: 'c1', name: 'Rahul Sharma', phone: '9876543210' }, { notDuplicates: new Set(['c1']) });
  assert.match(scored.explanation, /^Marked as not a duplicate/);
  assert.ok(scored.score < 0.6);
});

test('findDuplicates with no matches is new', () => {
  assert.deepEqual(findDuplicates(enquiry({ name: 'Kavya', phone: '9000000001' }), []), {
    decision: 'new',
    contactId: null,
    score: 0,
    explanation: 'No existing contact matches',
    candidates: [],
  });
  assert.equal(findDuplicates(enquiry({ phone: '9000000001' }), undefined).decision, 'new');
});

test('repeated candidates and the subject itself are skipped; limit caps the list', () => {
  const contact = { id: 'c1', name: 'Rahul Sharma', phone: '9876543210' };
  const self = { id: 'me', name: 'Rahul Sharma', phone: '9876543210' };
  const result = findDuplicates(self, [contact, contact, { ...self }]);
  assert.deepEqual(result.candidates.map((c) => c.contactId), ['c1']);
  const many = Array.from({ length: 8 }, (_, i) => ({ id: `n${i}`, name: 'Rahul Sharma', phone: '9876543210', email: `x${i}@y.in` }));
  const limited = findDuplicates(enquiry({ name: 'Sunita Sharma', phone: '9876543210' }), many, { limit: 3 });
  assert.equal(limited.candidates.length, 3);
});

test('records can be passed already adapted', () => {
  const record = toDedupRecord({ id: 'c1', name: 'Rahul Sharma', phone: '9876543210' });
  assert.equal(findDuplicates(toDedupRecord(enquiry({ name: 'Rahul Sharma', phone: '9876543210' })), [record]).contactId, 'c1');
});

test('toDedupRecord reads the contact shapes phase 2 may use', () => {
  const record = toDedupRecord({
    id: 'c1',
    firstName: 'priya',
    lastName: 'iyer',
    phones: [{ number: '98765 43210' }, { e164: '+919000000001' }, 'not a phone'],
    emails: [{ value: 'P@X.in' }, { email: 'p@x.in' }],
    address: { city: 'Chennai' },
  });
  assert.deepEqual(record, {
    id: 'c1',
    name: 'Priya Iyer',
    phones: ['+919876543210', '+919000000001'],
    emails: ['p@x.in'],
    city: 'Chennai',
    students: [],
    parents: [],
  });
  assert.deepEqual(toDedupRecord(null), { id: undefined, name: '', phones: [], emails: [], city: undefined, students: [], parents: [] });
});

test('the contact’s country is used to read its phones', () => {
  const record = toDedupRecord({ id: 'c1', name: 'A', phone: '050 123 4567', country: 'AE' });
  assert.deepEqual(record.phones, ['+971501234567']);
});

test('injected normalisers are used for both sides', () => {
  const lastTen = (raw) => {
    const digits = String(raw ?? '').replace(/\D/g, '');
    return digits.length >= 10 ? digits.slice(-10) : null;
  };
  const result = findDuplicates(
    { id: 'x', name: 'Rahul Sharma', phone: '(987) 654-3210' },
    [{ id: 'c1', name: 'Rahul Sharma', phone: '+1 987 654 3210' }],
    { normalizers: { phone: lastTen } },
  );
  assert.equal(result.decision, 'merge');
});

test('candidateKeys gives the lookups to run before scoring', () => {
  const keys = candidateKeys(enquiry({ name: 'Rahul Sharma', phone: '9876543210', email: 'Rahul.Sharma+x@gmail.com', student: 'Aarav Sharma' }));
  assert.deepEqual(keys, {
    phones: ['+919876543210'],
    emails: ['rahul.sharma+x@gmail.com'],
    mailboxes: ['rahulsharma@gmail.com'],
    names: ['Rahul Sharma', 'Aarav Sharma'],
  });
});

// --- merge plans ---------------------------------------------------------------------------------

const primary = {
  id: 'p',
  name: 'R. Sharma',
  phones: [{ value: '+919876543210', label: 'mobile' }],
  emails: ['rahul@example.in'],
  city: 'Delhi',
  grade: '10',
  ownerId: 'u1',
  tags: ['sat'],
  consent: { marketing: true, whatsapp: true },
  doNotCall: false,
  customFields: { board: 'CBSE', budget: 200000 },
  createdAt: '2025-01-10T00:00:00.000Z',
  updatedAt: '2025-06-01T00:00:00.000Z',
  status: 'active',
};
const duplicate = {
  id: 'd',
  name: 'Rahul Sharma',
  phones: [{ value: '+919876543210', label: 'whatsapp' }, { value: '+919000000001' }],
  emails: ['rahul.sharma@gmail.com'],
  city: 'Gurugram',
  grade: '11',
  language: 'hi',
  tags: ['sat', 'ug'],
  consent: { marketing: false },
  doNotCall: true,
  customFields: { board: 'ICSE', school: 'DPS' },
  createdAt: '2026-02-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  status: 'active',
};

test('mergePlan: the primary wins conflicts and the duplicate fills gaps', () => {
  const plan = mergePlan(primary, duplicate);
  assert.equal(plan.primaryId, 'p');
  assert.equal(plan.duplicateId, 'd');
  assert.equal(plan.result.city, 'Delhi');
  assert.equal(plan.result.language, 'hi');
  assert.equal(plan.result.ownerId, 'u1');
  const city = plan.fields.find((f) => f.field === 'city');
  assert.deepEqual(city, { field: 'city', winner: 'primary', value: 'Delhi', reason: 'both had a value; primary wins', discarded: 'Gurugram' });
  assert.deepEqual(plan.fields.find((f) => f.field === 'language'), { field: 'language', winner: 'duplicate', value: 'hi', reason: 'primary had no value' });
  assert.ok(plan.conflicts.some((c) => c.field === 'city' && c.discarded === 'Gurugram'), 'losing values are kept in the history');
});

test('mergePlan: phones, emails and tags keep every value once', () => {
  const plan = mergePlan(primary, duplicate);
  assert.deepEqual(plan.result.phones, [{ value: '+919876543210', label: 'mobile' }, { value: '+919000000001' }]);
  assert.deepEqual(plan.result.emails, ['rahul@example.in', 'rahul.sharma@gmail.com']);
  assert.deepEqual(plan.result.tags, ['sat', 'ug']);
});

test('mergePlan: an opt-out on either side wins', () => {
  const plan = mergePlan(primary, duplicate);
  assert.deepEqual(plan.result.consent, { marketing: false, whatsapp: true });
  assert.equal(plan.result.doNotCall, true);
  assert.equal(plan.fields.find((f) => f.field === 'consent').winner, 'restrictive');
});

test('mergePlan: nested objects merge key by key', () => {
  const plan = mergePlan(primary, duplicate);
  assert.deepEqual(plan.result.customFields, { board: 'CBSE', budget: 200000, school: 'DPS' });
  assert.ok(plan.conflicts.some((c) => c.field === 'customFields.board' && c.discarded === 'ICSE'));
  assert.ok(plan.fields.some((f) => f.field === 'customFields.school' && f.winner === 'duplicate'));
});

test('mergePlan: a fuller form of the same name replaces initials', () => {
  const plan = mergePlan(primary, duplicate);
  assert.equal(plan.result.name, 'Rahul Sharma');
  assert.equal(plan.fields.find((f) => f.field === 'name').reason, 'a fuller form of the same name');
  const different = mergePlan({ ...primary, name: 'Rahul Sharma' }, { ...duplicate, name: 'Rohit Sharma' });
  assert.equal(different.result.name, 'Rahul Sharma');
});

test('mergePlan: preferNewest fields take the most recently updated value', () => {
  const plan = mergePlan(primary, duplicate, { preferNewest: ['grade', 'customFields.board'] });
  assert.equal(plan.result.grade, '11');
  assert.equal(plan.result.customFields.board, 'ICSE');
  assert.equal(plan.fields.find((f) => f.field === 'grade').winner, 'newest');
  const older = mergePlan(primary, { ...duplicate, updatedAt: '2024-01-01T00:00:00Z' }, { preferNewest: ['grade'] });
  assert.equal(older.result.grade, '10');
});

test('mergePlan: system fields are not merged; the earliest creation date is kept', () => {
  const plan = mergePlan(primary, duplicate);
  assert.equal(plan.result.id, 'p');
  assert.equal(plan.result.createdAt, '2025-01-10T00:00:00.000Z');
  assert.equal(plan.result.status, undefined);
  assert.equal(plan.result.updatedAt, undefined);
  const reversed = mergePlan(duplicate, primary);
  assert.equal(reversed.result.createdAt, '2025-01-10T00:00:00.000Z', 'history starts at the older record');
});

test('mergePlan: every related record moves and the duplicate points at the primary', () => {
  const plan = mergePlan(primary, duplicate, { at: '2026-11-05T00:00:00.000Z' });
  assert.equal(plan.moves.length, DEFAULT_MERGE_RELATIONS.length);
  assert.deepEqual(plan.moves[0], { relation: 'enquiries', fromId: 'd', toId: 'p' });
  assert.deepEqual(plan.duplicate, { id: 'd', status: 'merged', mergedIntoId: 'p' });
  assert.equal(plan.event.type, 'contact.merged');
  assert.equal(plan.event.aggregateId, 'p');
  assert.equal(plan.event.payload.at, '2026-11-05T00:00:00.000Z');
  assert.deepEqual(plan.event.payload.conflicts, plan.conflicts);
  const custom = mergePlan(primary, duplicate, { relations: ['deals'] });
  assert.deepEqual(custom.moves, [{ relation: 'deals', fromId: 'd', toId: 'p' }]);
});

test('mergePlan: unchanged fields are not listed', () => {
  const plan = mergePlan({ id: 'a', name: 'Rahul Sharma', city: 'Delhi' }, { id: 'b', name: 'Rahul Sharma', city: 'Delhi' });
  assert.deepEqual(plan.fields, []);
  assert.deepEqual(plan.conflicts, []);
});

test('mergePlan: inputs are not mutated, and bad pairs are refused', () => {
  const a = structuredClone(primary);
  const b = structuredClone(duplicate);
  mergePlan(a, b);
  assert.deepEqual(a, primary);
  assert.deepEqual(b, duplicate);
  assert.throws(() => mergePlan(primary, { ...duplicate, id: 'p' }), /itself/);
  assert.throws(() => mergePlan({ name: 'x' }, duplicate), /id/);
});

test('choosePrimary keeps the older record, then the owned one, then the fuller one', () => {
  assert.deepEqual(choosePrimary(duplicate, primary).map((c) => c.id), ['p', 'd']);
  const a = { id: 'a', name: 'X' };
  const b = { id: 'b', name: 'X', ownerId: 'u1' };
  assert.deepEqual(choosePrimary(a, b).map((c) => c.id), ['b', 'a']);
  const c = { id: 'c', name: 'X', city: 'Pune', email: 'x@y.in' };
  assert.deepEqual(choosePrimary(a, c).map((x) => x.id), ['c', 'a']);
  assert.deepEqual(choosePrimary({ id: 'z' }, { id: 'y' }).map((x) => x.id), ['y', 'z']);
});
