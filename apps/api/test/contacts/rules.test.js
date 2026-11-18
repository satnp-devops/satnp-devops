import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../../src/lib/db.js';
import { consentTitle } from '../../src/modules/contacts/consents.js';
import { householdPhrase } from '../../src/modules/contacts/households.js';
import { mergeLinkValues, mergedContactFill } from '../../src/modules/contacts/merge.js';
import { presentContactSummary, presentHousehold } from '../../src/modules/contacts/present.js';
import { consentBody, contactCreateBody, contactListQuery, contactPatchBody } from '../../src/modules/contacts/schemas.js';

// Pure rules of the contacts module: merging links and blanks, request schemas, presenters, titles.

// The modules import the shared knex instance; it never connects here, but close it so the run ends.
after(() => db.destroy());

const UNIT = '7f0c0a8e-6a7b-4c1d-9f3e-2b1a0c9d8e7f';

test('merging links: the target wins, blanks fill from the source, tags union, earliest first seen', () => {
  const kept = {
    owner_user_id: null,
    status: 'lead',
    source: null,
    tags: ['webinar'],
    first_seen_at: '2026-10-05T00:00:00Z',
    custom: { how_heard: 'google' },
    archived_at: null,
  };
  const other = {
    owner_user_id: 'u2',
    status: 'customer',
    source: { channel: 'whatsapp' },
    tags: ['webinar', 'vip'],
    first_seen_at: '2026-09-01T00:00:00Z',
    custom: { how_heard: 'instagram', referred_by: 'Ravi' },
    archived_at: '2026-10-10T00:00:00Z',
  };
  const merged = mergeLinkValues(kept, other);
  assert.equal(merged.owner_user_id, 'u2');
  assert.equal(merged.status, 'customer', 'a customer stays a customer');
  assert.deepEqual(merged.source, { channel: 'whatsapp' });
  assert.deepEqual(merged.tags, ['webinar', 'vip']);
  assert.equal(merged.first_seen_at.toISOString(), '2026-09-01T00:00:00.000Z');
  assert.deepEqual(merged.custom, { how_heard: 'google', referred_by: 'Ravi' });
  assert.equal(merged.archived_at, null, 'visible when either link was');
});

test('merging people: only blanks are filled, and the name is rebuilt when it was missing', () => {
  const target = { first_name: null, last_name: null, kind: 'other', city: 'Pune', country_code: null, time_zone: null, language: null, student_profile: { grade: '11' }, date_of_birth: null, address: {} };
  const source = { first_name: 'Neha', last_name: 'Rao', kind: 'parent', city: 'Mysuru', country_code: 'IN', time_zone: 'Asia/Kolkata', language: 'kn', student_profile: { grade: '12', board: 'CBSE' }, date_of_birth: '1980-01-01', address: { city: 'Mysuru' } };
  const fill = mergedContactFill(target, source);
  assert.equal(fill.first_name, 'Neha');
  assert.equal(fill.display_name, 'Neha Rao');
  assert.equal(fill.name_normalized, 'neha rao');
  assert.equal(fill.kind, 'parent');
  assert.equal(fill.city, undefined, 'the target keeps its city');
  assert.deepEqual(fill.student_profile, { grade: '11', board: 'CBSE' });
  assert.equal(fill.date_of_birth, '1980-01-01');
  assert.deepEqual(fill.address, { city: 'Mysuru' });
  assert.deepEqual(mergedContactFill({ ...source }, target), {}, 'nothing to fill on a complete record');
});

test('create needs a name, a phone or an email; unknown keys are rejected', () => {
  assert.equal(contactCreateBody.safeParse({ unitId: UNIT }).success, false);
  assert.equal(contactCreateBody.safeParse({ unitId: UNIT, emails: ['a@b.example'] }).success, true);
  assert.equal(contactCreateBody.safeParse({ unitId: UNIT, firstName: 'A', nickname: 'x' }).success, false);
  const parsed = contactCreateBody.parse({ unitId: UNIT, firstName: '  Asha ' });
  assert.equal(parsed.firstName, 'Asha');
  assert.equal(parsed.mode, 'link');
});

test('patching a student profile: null removes a key', () => {
  const parsed = contactPatchBody.parse({ studentProfile: { grade: null, targetExam: 'SAT' } });
  assert.deepEqual(parsed.studentProfile, { grade: null, targetExam: 'SAT' });
  assert.equal(contactPatchBody.safeParse({ studentProfile: { shoeSize: 9 } }).success, false);
});

test('list queries: csv filters, defaults and sorts', () => {
  const parsed = contactListQuery.parse({ unitId: UNIT, kind: 'parent,student', owner: 'me,none', includeArchived: 'true' });
  assert.deepEqual(parsed.kind, ['parent', 'student']);
  assert.deepEqual(parsed.owner, ['me', 'none']);
  assert.equal(parsed.includeArchived, true);
  assert.equal(parsed.sort, '-updatedAt');
  assert.equal(parsed.limit, 50);
  assert.equal(contactListQuery.safeParse({ unitId: UNIT, sort: 'phone' }).success, false);
  assert.equal(contactListQuery.safeParse({ unitId: UNIT, limit: '500' }).success, false);
});

test('consent records: not in the future, at most 20 evidence entries', () => {
  const base = { companyId: null, channel: 'whatsapp', purpose: 'marketing', status: 'withdrawn' };
  assert.equal(consentBody.parse(base).source, 'manual');
  assert.equal(consentBody.safeParse({ ...base, capturedAt: '2999-01-01T00:00:00Z' }).success, false);
  assert.equal(consentBody.safeParse({ ...base, capturedAt: '2026-01-01T00:00:00+05:30' }).success, true);
  const evidence = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, i]));
  assert.equal(consentBody.safeParse({ ...base, evidence }).success, false);
});

test('summaries mask personal data and flag erased people', () => {
  const row = { id: 'c1', kind: 'parent', display_name: 'Priya Sharma', first_name: 'Priya', last_name: 'Sharma', city: 'Pune', primary_phone: '+919810012345', primary_email: 'priya@example.com', erased_at: null };
  const open = presentContactSummary(row, true);
  assert.equal(open.primaryPhone, '+919810012345');
  assert.equal(open.piiMasked, false);
  const masked = presentContactSummary(row, false);
  assert.equal(masked.primaryPhone, '+91 •••••••345');
  assert.equal(masked.primaryEmail, 'p•••@example.com');
  assert.equal(masked.piiMasked, true);
  assert.equal(presentContactSummary({ ...row, erased_at: '2026-11-01T00:00:00Z' }, true).erased, true);
});

test('households list only the members the viewer can see, the main contact first', () => {
  const contact = (id, kind) => ({ id, kind, display_name: id, primary_phone: '+919810012345', primary_email: null, erased_at: null });
  const members = [
    { contact: contact('kid', 'student'), role: 'student', relation: 'Son', is_primary: false },
    { contact: contact('mum', 'parent'), role: 'parent', relation: 'Mother', is_primary: true },
    { contact: contact('dad', 'parent'), role: 'parent', relation: 'Father', is_primary: false },
  ];
  const decisions = new Map([
    ['kid', { canView: true, canViewPii: false }],
    ['mum', { canView: true, canViewPii: true }],
    ['dad', { canView: false }],
  ]);
  const household = presentHousehold({ id: 'h1', name: 'Sharma family', created_at: new Date(), updated_at: new Date() }, members, { decisions, canManage: true });
  assert.deepEqual(household.members.map((m) => m.contact.id), ['mum', 'kid']);
  assert.equal(household.hiddenMemberCount, 1);
  assert.equal(household.members[1].contact.piiMasked, true, 'masked per member');
});

test('timeline titles for households and consent say nothing personal', () => {
  assert.equal(householdPhrase('Sharma family'), 'the Sharma family');
  assert.equal(householdPhrase('Rao'), 'household Rao');
  assert.equal(consentTitle({ channel: 'whatsapp', purpose: 'marketing', status: 'withdrawn' }), 'WhatsApp marketing consent withdrawn');
  assert.equal(consentTitle({ channel: 'all', purpose: 'service', status: 'granted' }), 'Service consent granted on every channel');
});
