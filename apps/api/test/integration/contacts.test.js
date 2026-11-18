import { test } from 'node:test';
import assert from 'node:assert/strict';
import { env } from '../../src/config/env.js';
import { db } from '../../src/lib/db.js';
import { redis } from '../../src/lib/redis.js';
import { closeQueues } from '../../src/core/queue.js';
import { createApp } from '../../src/app.js';
import { buildRegistry } from '../../src/registry.js';
import { modules } from '../../src/modules/index.js';

// Contacts, households, consents, duplicates, merge, export and erase end to end, as different
// seeded people (docs/crm/PHASE2_CONTRACT.md §9.1, §16). Needs a migrated and seeded database:
//   npm run db:migrate && npm run db:seed && INTEGRATION=1 npm test
// Records get unique names per run, so it can run repeatedly.

const enabled = process.env.INTEGRATION === '1';
const RUN = Date.now().toString(36);
let phoneSeq = Math.floor(Math.random() * 50_000);
/** A number in the fake range no seeded person has: +91 90008 xxxxx. */
const fakePhone = () => `+91 90008 ${String((phoneSeq += 7) % 100_000).padStart(5, '0')}`;
const email = (name) => `${name}.${RUN}@contacts-test.example`;
/** People and households this run created, removed again afterwards so demo lists stay clean. */
const created = { contacts: new Set(), households: new Set() };

function client(base) {
  let cookie = '';
  return async function call(method, path, body) {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', 'x-phoenix-client': 'integration-test', ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const header of res.headers.getSetCookie()) {
      const [pair] = header.split(';');
      if (pair.startsWith(`${env.SESSION_COOKIE_NAME}=`)) cookie = pair.endsWith('=') ? '' : pair;
    }
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    // 201 only: a 200 is an existing person (maybe seeded), never removed.
    if (method === 'POST' && res.status === 201 && path === '/contacts') created.contacts.add(json.data.contact.id);
    if (method === 'POST' && res.status === 201 && path === '/households') created.households.add(json.data.id);
    return { status: res.status, body: json, headers: res.headers };
  };
}

/** Deletes what this run created (history rows first; contacts last, tombstones unlinked first). */
async function removeCreated() {
  const ids = [...created.contacts];
  if (ids.length > 0) {
    await db('timeline_events').whereIn('contact_id', ids).delete();
    await db('consents').whereIn('contact_id', ids).delete();
    await db('tasks').whereIn('contact_id', ids).delete();
    await db('search_documents').where({ entity_type: 'contact' }).whereIn('entity_id', ids).delete();
    await db('contacts').whereIn('id', ids).update({ merged_into_id: null });
    await db('contacts').whereIn('id', ids).delete();
  }
  if (created.households.size > 0) await db('households').whereIn('id', [...created.households]).delete();
}

test('contacts API', { skip: !enabled && 'set INTEGRATION=1 to run' }, async (t) => {
  const app = createApp({ registry: buildRegistry(), modules });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const analystEmail = `analyst.${RUN}@phoenix.test`;

  t.after(async () => {
    server.close();
    await removeCreated();
    await db('users').where({ email: analystEmail }).delete();
    await closeQueues();
    await db.destroy();
    await redis.quit();
  });

  // Repeated local runs would otherwise trip the sign-in rate limits.
  const limits = await redis.keys('rl:*');
  if (limits.length) await redis.del(...limits);

  const group = await db('org_units').whereNull('parent_id').where({ code: 'phoenix' }).first();
  const units = await db('org_units').where({ root_id: group.id });
  const byCode = (code) => units.find((u) => u.code === code);
  const satnpaper = byCode('satnpaper');
  const pivector = byCode('pi-vector');
  const satAdmissions = byCode('sat-admissions');
  const softwareSales = units.find((u) => u.name === 'Software sales' && u.path.startsWith(satnpaper.path));
  assert.ok(satnpaper && pivector && satAdmissions && softwareSales, 'seeded units are there');

  // A temporary analyst at SatnPaper: sees contacts, never their personal data.
  const owner = await db('users').where({ email: 'owner@phoenix.test' }).first();
  const analystRole = await db('roles').whereNull('group_id').where({ key: 'analyst' }).first();
  const [analystUser] = await db('users')
    .insert({ email: analystEmail, name: `Analyst ${RUN}`, password_hash: owner.password_hash, status: 'active' })
    .returning('id');
  await db('role_assignments').insert({ user_id: analystUser.id, role_id: analystRole.id, org_unit_id: satnpaper.id });

  const people = {};
  for (const [key, mail] of [
    ['owner', 'owner@phoenix.test'],
    ['spAdmin', 'admin.satnpaper@phoenix.test'],
    ['pvAdmin', 'admin.pivector@phoenix.test'],
    ['kabir', 'kabir@phoenix.test'],
    ['ritika', 'ritika@phoenix.test'],
    ['analyst', analystEmail],
  ]) {
    people[key] = client(base);
    const login = await people[key]('POST', '/auth/login', { email: mail, password: env.SEED_PASSWORD });
    assert.equal(login.status, 200, `${mail}: ${JSON.stringify(login.body)}`);
  }
  const { owner: asOwner, spAdmin, pvAdmin, kabir, ritika, analyst } = people;

  const ashaPhone = fakePhone();
  const ashaEmail = email('asha');
  let asha;

  await t.test('a counsellor adds a contact in their team', async () => {
    const res = await ritika('POST', '/contacts', {
      unitId: satAdmissions.id,
      kind: 'parent',
      firstName: `Asha${RUN}`,
      lastName: 'Verma',
      phones: [ashaPhone],
      emails: [ashaEmail],
      city: 'Pune',
      dateOfBirth: '1984-05-02',
      tags: ['webinar'],
      custom: { how_heard: 'instagram' },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.created, true);
    asha = res.body.data.contact;
    assert.equal(asha.displayName, `Asha${RUN} Verma`);
    assert.equal(asha.primaryEmail, ashaEmail);
    assert.equal(asha.dateOfBirth, '1984-05-02');
    assert.equal(asha.links.length, 1);
    assert.equal(asha.links[0].unit.id, satAdmissions.id);
    assert.deepEqual(asha.links[0].tags, ['webinar']);
    assert.equal(asha.links[0].custom.how_heard, 'instagram');
    assert.equal(asha.can.manage, true);
    assert.equal(asha.can.merge, false, 'counsellors do not merge');

    const audit = await db('audit_logs').where({ entity_type: 'contact', entity_id: asha.id, action: 'contact.created' }).first();
    assert.ok(audit, 'audited');
    assert.ok(!JSON.stringify(audit.after ?? {}).includes(ashaEmail), 'no email in the audit log');
    assert.ok(await db('outbox_events').where({ type: 'contact.created', aggregate_id: asha.id }).first(), 'event emitted');
    const doc = await db('search_documents').where({ entity_type: 'contact', entity_id: asha.id }).first();
    assert.ok(doc.keywords.includes(ashaEmail), 'search document written');
  });

  await t.test('adding the same person again returns the existing contact (dedup)', async () => {
    const digits = ashaPhone.replace(/\D/g, '').slice(2);
    const again = await kabir('POST', '/contacts', { unitId: satAdmissions.id, firstName: `Asha${RUN}`, lastName: 'Verma', phones: [`0${digits}`] });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.data.created, false);
    assert.equal(again.body.data.matchedBy, 'phone');
    assert.equal(again.body.data.contact.id, asha.id);

    // Another company: the person is linked to it, not duplicated.
    const pv = await pvAdmin('POST', '/contacts', { unitId: pivector.id, firstName: `Asha${RUN}`, emails: [ashaEmail.toUpperCase()] });
    assert.equal(pv.status, 200, JSON.stringify(pv.body));
    assert.equal(pv.body.data.contact.id, asha.id);
    assert.equal(pv.body.data.matchedBy, 'email');
    assert.equal(pv.body.data.linkCreated, true);
    assert.deepEqual(
      pv.body.data.contact.links.map((link) => link.company.id),
      [pivector.id],
      'Pi Vector sees only its own link',
    );
    const count = await db('contact_methods').where({ group_id: group.id, normalized: ashaEmail }).count({ n: '*' }).first();
    assert.equal(Number(count.n), 1, 'one person, one email');
  });

  await t.test('the live check finds the person, or says it is known elsewhere', async () => {
    const visible = await ritika('POST', '/contacts/check', { unitId: satAdmissions.id, firstName: `Asha${RUN}`, phones: [ashaPhone] });
    assert.equal(visible.status, 200, JSON.stringify(visible.body));
    assert.equal(visible.body.data.match.id, asha.id);
    assert.equal(visible.body.data.hiddenMatch, false);

    const only = await spAdmin('POST', '/contacts', { unitId: satnpaper.id, firstName: `Hidden${RUN}`, phones: [fakePhone()] });
    assert.equal(only.status, 201);
    const hidden = await pvAdmin('POST', '/contacts/check', {
      unitId: pivector.id,
      firstName: `Hidden${RUN}`,
      phones: [only.body.data.contact.primaryPhone],
    });
    assert.equal(hidden.status, 200);
    assert.equal(hidden.body.data.match, null);
    assert.equal(hidden.body.data.hiddenMatch, true);
  });

  let spOnly;
  await t.test("another company's admin gets 404", async () => {
    const res = await spAdmin('POST', '/contacts', { unitId: softwareSales.id, kind: 'staff', firstName: `Ravi${RUN}`, lastName: 'Kumar', phones: [fakePhone()] });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    spOnly = res.body.data.contact;
    for (const path of [`/contacts/${spOnly.id}`, `/contacts/${spOnly.id}/duplicates`, `/contacts/${spOnly.id}/consents`]) {
      assert.equal((await pvAdmin('GET', path)).status, 404, path);
    }
    assert.equal((await pvAdmin('PATCH', `/contacts/${spOnly.id}`, { city: 'Goa' })).status, 404);
    assert.equal((await pvAdmin('GET', `/contacts?unitId=${satnpaper.id}`)).status, 404, 'unit not visible');
    const list = await pvAdmin('GET', `/contacts?unitId=${pivector.id}&q=${encodeURIComponent(`Ravi${RUN}`)}`);
    assert.equal(list.status, 200);
    assert.equal(list.body.data.length, 0);
    // A counsellor in SAT admissions doesn't see Software sales contacts either.
    assert.equal((await ritika('GET', `/contacts/${spOnly.id}`)).status, 404);
    assert.equal((await kabir('GET', `/contacts/${spOnly.id}`)).status, 404, 'kabir works in Online, not Software sales');
    assert.equal((await asOwner('GET', `/contacts/${spOnly.id}`)).status, 200);
  });

  await t.test('lists: scope, search by phone, email and name, filters, keyset pages', async () => {
    const byPhone = await ritika('GET', `/contacts?unitId=${satAdmissions.id}&q=${encodeURIComponent(ashaPhone.replace(/\s/g, ''))}`);
    assert.equal(byPhone.status, 200, JSON.stringify(byPhone.body));
    assert.deepEqual(byPhone.body.data.map((c) => c.id), [asha.id]);
    const byEmail = await ritika('GET', `/contacts?unitId=${satAdmissions.id}&q=${encodeURIComponent(ashaEmail)}`);
    assert.deepEqual(byEmail.body.data.map((c) => c.id), [asha.id]);
    const byName = await ritika('GET', `/contacts?unitId=${satAdmissions.id}&q=asha${RUN}`);
    const item = byName.body.data.find((c) => c.id === asha.id);
    assert.ok(item, 'found by name (similar names from earlier runs may come too)');
    assert.equal(item.link.companyId, satnpaper.id);
    assert.ok(item.companies.some((c) => c.id === satnpaper.id));
    assert.ok(!item.companies.some((c) => c.id === pivector.id), 'companies the viewer cannot see stay hidden');

    const parents = await kabir('GET', `/contacts?unitId=${satAdmissions.id}&kind=parent&limit=5`);
    assert.equal(parents.status, 200);
    assert.ok(parents.body.data.every((c) => c.kind === 'parent'));
    assert.ok(parents.body.nextCursor, 'more than one page of seeded parents');
    const next = await kabir('GET', `/contacts?unitId=${satAdmissions.id}&kind=parent&limit=5&cursor=${parents.body.nextCursor}`);
    assert.equal(next.status, 200);
    const firstIds = new Set(parents.body.data.map((c) => c.id));
    assert.ok(next.body.data.every((c) => !firstIds.has(c.id)), 'no repeats across pages');

    const byNameSort = await asOwner('GET', `/contacts?unitId=${group.id}&sort=name&limit=10`);
    assert.equal(byNameSort.status, 200);
    assert.equal(byNameSort.body.data[0].link, null, 'no working link at group scope');
    assert.equal((await asOwner('GET', `/contacts?unitId=${group.id}&cursor=not-a-cursor`)).status, 400);
  });

  await t.test('personal data is masked without contacts.view_pii', async () => {
    const res = await analyst('GET', `/contacts/${asha.id}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const masked = res.body.data;
    assert.equal(masked.piiMasked, true);
    assert.notEqual(masked.primaryEmail, ashaEmail);
    assert.match(masked.primaryEmail, /•/);
    assert.match(masked.primaryPhone, /•/);
    assert.equal(masked.dateOfBirth, null);
    assert.equal(masked.address, null);
    assert.ok(masked.methods.every((m) => m.masked && m.normalized === null));
    assert.equal(masked.can.manage, false);
    const list = await analyst('GET', `/contacts?unitId=${satnpaper.id}&q=asha${RUN}`);
    assert.equal(list.body.data[0].piiMasked, true);
    assert.match(list.body.data[0].primaryPhone, /•/);
    assert.equal((await analyst('PATCH', `/contacts/${asha.id}`, { city: 'Goa' })).status, 403);
    assert.equal((await analyst('GET', `/contacts/${asha.id}/export`)).status, 403);
  });

  await t.test('details, link and methods change with audit and events', async () => {
    const patched = await ritika('PATCH', `/contacts/${asha.id}`, { lastName: 'Varma', studentProfile: { grade: null } });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.data.displayName, `Asha${RUN} Varma`);
    const doc = await db('search_documents').where({ entity_type: 'contact', entity_id: asha.id }).first();
    assert.equal(doc.title, `Asha${RUN} Varma`);

    const link = await ritika('PATCH', `/contacts/${asha.id}/links/${satnpaper.id}`, { status: 'customer', tags: ['webinar', 'vip'] });
    assert.equal(link.status, 200, JSON.stringify(link.body));
    const spLink = link.body.data.links.find((l) => l.company.id === satnpaper.id);
    assert.equal(spLink.status, 'customer');
    assert.deepEqual(spLink.tags, ['webinar', 'vip']);
    const badUnit = await ritika('PATCH', `/contacts/${asha.id}/links/${satnpaper.id}`, { unitId: pivector.id });
    assert.equal(badUnit.status, 422);
    assert.equal((await ritika('PATCH', `/contacts/${asha.id}/links/${pivector.id}`, { status: 'customer' })).status, 404);
    const badCustom = await ritika('PATCH', `/contacts/${asha.id}/links/${satnpaper.id}`, { custom: { how_heard: 'carrier_pigeon' } });
    assert.equal(badCustom.status, 422);

    const whatsapp = fakePhone();
    const added = await ritika('POST', `/contacts/${asha.id}/methods`, { kind: 'whatsapp', value: whatsapp, label: 'WhatsApp' });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    assert.equal(added.body.data.isPrimary, true, 'first of its kind becomes primary');
    assert.equal((await ritika('POST', `/contacts/${asha.id}/methods`, { kind: 'whatsapp', value: whatsapp })).status, 409);
    assert.equal((await ritika('POST', `/contacts/${asha.id}/methods`, { kind: 'email', value: 'not-an-email' })).status, 422);

    const optOut = await ritika('PATCH', `/contacts/${asha.id}/methods/${added.body.data.id}`, { optedOut: true });
    assert.equal(optOut.status, 200);
    assert.ok(optOut.body.data.optedOutAt);

    const second = await ritika('POST', `/contacts/${asha.id}/methods`, { kind: 'phone', value: fakePhone(), isPrimary: true });
    assert.equal(second.status, 201);
    const detail = await ritika('GET', `/contacts/${asha.id}`);
    assert.equal(detail.body.data.primaryPhone, second.body.data.normalized, 'primary phone follows the primary method');
    assert.equal((await ritika('DELETE', `/contacts/${asha.id}/methods/${second.body.data.id}`)).status, 204);
    const after = await ritika('GET', `/contacts/${asha.id}`);
    assert.equal(after.body.data.methods.filter((m) => m.kind === 'phone' && m.isPrimary).length, 1, 'the other phone was promoted');
    assert.equal(after.body.data.primaryPhone.replace(/\D/g, ''), ashaPhone.replace(/\D/g, ''));

    const actions = await db('audit_logs').where({ entity_type: 'contact', entity_id: asha.id }).pluck('action');
    for (const action of ['contact.updated', 'contact.link_updated', 'contact.method_added', 'contact.method_updated', 'contact.method_removed']) {
      assert.ok(actions.includes(action), action);
    }
  });

  await t.test('consents: per company and channel, group-wide grants need a group role', async () => {
    const withdrawn = await ritika('POST', `/contacts/${asha.id}/consents`, {
      companyId: satnpaper.id,
      channel: 'whatsapp',
      purpose: 'marketing',
      status: 'withdrawn',
      source: 'whatsapp',
      evidence: { messageId: 'wamid.123' },
    });
    assert.equal(withdrawn.status, 201, JSON.stringify(withdrawn.body));
    assert.equal((await ritika('POST', `/contacts/${asha.id}/consents`, { companyId: null, channel: 'email', purpose: 'marketing', status: 'granted' })).status, 403);
    assert.equal((await ritika('POST', `/contacts/${asha.id}/consents`, { companyId: pivector.id, channel: 'email', purpose: 'marketing', status: 'granted' })).status, 422);
    const groupWide = await asOwner('POST', `/contacts/${asha.id}/consents`, { companyId: null, channel: 'all', purpose: 'service', status: 'granted' });
    assert.equal(groupWide.status, 201);

    const consents = await ritika('GET', `/contacts/${asha.id}/consents`);
    assert.equal(consents.status, 200);
    const state = consents.body.data.effective.find((s) => s.companyId === satnpaper.id && s.channel === 'whatsapp' && s.purpose === 'marketing');
    assert.equal(state.status, 'withdrawn');
    const service = consents.body.data.effective.find((s) => s.companyId === satnpaper.id && s.channel === 'sms' && s.purpose === 'service');
    assert.equal(service.status, 'granted', 'group-wide records apply to every company');
    const entry = await db('timeline_events').where({ contact_id: asha.id, kind: 'system', title: 'WhatsApp marketing consent withdrawn' }).first();
    assert.ok(entry, 'timeline entry written');
    assert.equal(entry.company_id, satnpaper.id);
  });

  let household;
  let student;
  await t.test('households: create, add members, siblings, remove', async () => {
    const kid = await ritika('POST', '/contacts', {
      unitId: satAdmissions.id,
      kind: 'student',
      firstName: `Aarav${RUN}`,
      lastName: 'Verma',
      phones: [ashaPhone],
      studentProfile: { grade: '11', targetExam: 'SAT' },
    });
    assert.equal(kid.status, 201, 'a student sharing the parent number is a different person');
    student = kid.body.data.contact;
    assert.notEqual(student.id, asha.id);

    const created = await ritika('POST', '/households', {
      unitId: satAdmissions.id,
      name: `Verma${RUN} family`,
      city: 'Pune',
      members: [
        { contactId: asha.id, role: 'parent', relation: 'Mother', isPrimary: true },
        { contactId: student.id, role: 'student', relation: 'Son' },
      ],
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    household = created.body.data;
    assert.equal(household.members.length, 2);
    assert.equal(household.members[0].contact.id, asha.id, 'the main contact comes first');
    assert.equal(household.can.manage, true);
    assert.equal((await ritika('POST', '/households', { unitId: satAdmissions.id, name: 'X', members: [{ contactId: spOnly.id, role: 'parent' }] })).status, 422);

    const sibling = await ritika('POST', '/contacts', {
      unitId: satAdmissions.id,
      kind: 'student',
      firstName: `Diya${RUN}`,
      lastName: 'Verma',
      household: { householdId: household.id, role: 'student', relation: 'Daughter' },
    });
    assert.equal(sibling.status, 201, JSON.stringify(sibling.body));
    const full = await ritika('GET', `/households/${household.id}`);
    assert.equal(full.body.data.members.filter((m) => m.role === 'student').length, 2, 'siblings are the students of a household');
    assert.ok(await db('timeline_events').where({ contact_id: sibling.body.data.contact.id, title: `Added to the Verma${RUN} family` }).first());

    assert.equal((await ritika('POST', `/households/${household.id}/members`, { contactId: student.id, role: 'student' })).status, 409);
    const pvView = await pvAdmin('GET', `/households/${household.id}`);
    assert.equal(pvView.status, 200, 'Pi Vector knows Asha, so it sees her household');
    assert.deepEqual(pvView.body.data.members.map((m) => m.contact.id), [asha.id], 'but only the members it knows');
    assert.equal(pvView.body.data.hiddenMemberCount, 2);
    assert.equal(pvView.body.data.can.manage, true, 'its admin manages Asha, so the household too');
    assert.equal((await asOwner('GET', `/households/${household.id}`)).body.data.members.length, 3);
    assert.equal((await spAdmin('GET', `/households/${household.id}`)).status, 200);
    const listed = await kabir('GET', `/households?unitId=${satAdmissions.id}&q=${encodeURIComponent(`verma${RUN}`)}`);
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.data.map((h) => h.id), [household.id]);
    assert.equal(listed.body.data[0].members.length, 3);

    const removed = await ritika('DELETE', `/households/${household.id}/members/${sibling.body.data.contact.id}`);
    assert.equal(removed.status, 200);
    assert.equal(removed.body.data.members.length, 2);
    const detail = await ritika('GET', `/contacts/${student.id}`);
    assert.equal(detail.body.data.households[0].id, household.id);
  });

  await t.test('duplicates: shared numbers, similar names and families entered twice', async () => {
    const dups = await ritika('GET', `/contacts/${asha.id}/duplicates`);
    assert.equal(dups.status, 200, JSON.stringify(dups.body));
    const kid = dups.body.data.candidates.find((c) => c.contact.id === student.id);
    assert.ok(kid, 'the student sharing the number is listed');
    assert.ok(kid.reasons.includes('phone'));

    // The same family typed in again by someone else: a second parent record and child record.
    const parent2 = await spAdmin('POST', '/contacts', { unitId: satAdmissions.id, kind: 'parent', firstName: `Asha${RUN}`, lastName: 'Varma', phones: [fakePhone()], mode: 'create' });
    const kid2 = await spAdmin('POST', '/contacts', { unitId: satAdmissions.id, kind: 'student', firstName: `Aarav${RUN}`, lastName: 'Varma', mode: 'create' });
    assert.equal(parent2.status, 201);
    const varmas = await spAdmin('POST', '/households', {
      unitId: satAdmissions.id,
      name: `Varma${RUN} family`,
      members: [
        { contactId: parent2.body.data.contact.id, role: 'parent' },
        { contactId: kid2.body.data.contact.id, role: 'student' },
      ],
    });
    assert.equal(varmas.status, 201, JSON.stringify(varmas.body));
    assert.equal((await pvAdmin('GET', `/households/${varmas.body.data.id}`)).status, 404, 'a household of people only SatnPaper knows');
    const again = await ritika('GET', `/contacts/${asha.id}/duplicates`);
    const twin = again.body.data.candidates.find((c) => c.contact.id === parent2.body.data.contact.id);
    assert.ok(twin, JSON.stringify(again.body.data));
    assert.ok(twin.reasons.includes('household'), 'parent and student names match another household');
    assert.ok(twin.score > 0.5);
  });

  await t.test('merge keeps all history and leaves a tombstone', async () => {
    const a = await spAdmin('POST', '/contacts', { unitId: satAdmissions.id, kind: 'parent', firstName: `Neha${RUN}`, lastName: 'Rao', phones: [fakePhone()] });
    const b = await pvAdmin('POST', '/contacts', {
      unitId: pivector.id,
      kind: 'parent',
      firstName: `Neha${RUN}`,
      lastName: 'Rao',
      emails: [email('neha')],
      city: 'Mysuru',
      mode: 'create',
    });
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    const target = a.body.data.contact;
    const source = b.body.data.contact;
    const task = await db('tasks')
      .insert({ group_id: group.id, company_id: pivector.id, unit_id: pivector.id, title: `Call Neha ${RUN}`, contact_id: source.id })
      .returning('id');
    await asOwner('POST', `/contacts/${source.id}/consents`, { companyId: pivector.id, channel: 'email', purpose: 'marketing', status: 'granted' });

    assert.equal((await ritika('POST', `/contacts/${target.id}/merge`, { sourceId: source.id })).status, 422, 'ritika cannot see the Pi Vector record');
    assert.equal((await spAdmin('POST', `/contacts/${target.id}/merge`, { sourceId: source.id })).status, 422, 'the SatnPaper admin cannot see it either');
    assert.equal((await asOwner('POST', `/contacts/${target.id}/merge`, { sourceId: target.id })).status, 422);

    const merged = await asOwner('POST', `/contacts/${target.id}/merge`, { sourceId: source.id });
    assert.equal(merged.status, 200, JSON.stringify(merged.body));
    const kept = merged.body.data;
    assert.equal(kept.city, 'Mysuru', 'blanks filled from the source');
    assert.equal(kept.primaryEmail, email('neha'));
    assert.deepEqual(kept.links.map((l) => l.company.id).sort(), [pivector.id, satnpaper.id].sort());

    const gone = await asOwner('GET', `/contacts/${source.id}`);
    assert.equal(gone.status, 404);
    assert.equal(gone.body.error.code, 'merged');
    assert.equal(gone.body.error.details.mergedIntoId, target.id);
    assert.equal((await db('tasks').where({ id: task[0].id }).first()).contact_id, target.id, 'tasks move');
    assert.equal(await db('consents').where({ contact_id: source.id }).first(), undefined, 'consents move');
    assert.equal(await db('search_documents').where({ entity_type: 'contact', entity_id: source.id }).first(), undefined);
    assert.ok(await db('timeline_events').where({ contact_id: target.id, title: `Merged with Neha${RUN} Rao` }).first());
    assert.ok(await db('outbox_events').where({ type: 'contact.merged', aggregate_id: target.id }).first());
    const pvView = await pvAdmin('GET', `/contacts/${target.id}`);
    assert.equal(pvView.status, 200, 'Pi Vector still sees the person through its moved link');
    await db('tasks').where({ id: task[0].id }).delete();
  });

  await t.test('export and erase follow the DPDP Act', async () => {
    assert.equal((await ritika('GET', `/contacts/${asha.id}/export`)).status, 403, 'counsellors do not handle data requests');
    assert.equal((await spAdmin('GET', `/contacts/${asha.id}/export`)).status, 403, 'Pi Vector knows her too: needs privacy there as well');
    const exported = await asOwner('GET', `/contacts/${asha.id}/export`);
    assert.equal(exported.status, 200, JSON.stringify(exported.body));
    assert.match(exported.headers.get('content-disposition'), /attachment; filename="contact-/);
    const data = exported.body.data;
    assert.equal(data.contact.primaryEmail, ashaEmail);
    assert.equal(data.contact.piiMasked, false);
    assert.equal(data.contact.links.length, 2, 'every company link');
    assert.ok(data.consents.length >= 2);
    assert.ok(data.households.some((h) => h.id === household.id));
    assert.ok(data.timeline.length > 0);
    assert.ok(await db('audit_logs').where({ entity_id: asha.id, action: 'contact.exported' }).first());

    assert.equal((await asOwner('POST', `/contacts/${asha.id}/erase`, { reason: 'Asked by email', confirm: false })).status, 422);
    const erased = await asOwner('POST', `/contacts/${asha.id}/erase`, { reason: 'Asked by email on 6 Nov', confirm: true });
    assert.equal(erased.status, 200, JSON.stringify(erased.body));
    assert.equal(erased.body.data.displayName, 'Erased contact');
    assert.equal(erased.body.data.erased, true);
    assert.equal(erased.body.data.methods.length, 0);
    assert.equal(erased.body.data.primaryEmail, null);
    assert.equal(erased.body.data.households.length, 0);
    assert.equal((await asOwner('POST', `/contacts/${asha.id}/erase`, { reason: 'again', confirm: true })).status, 409);
    assert.equal((await ritika('PATCH', `/contacts/${asha.id}`, { city: 'Pune' })).status, 409);
    assert.equal(await db('search_documents').where({ entity_type: 'contact', entity_id: asha.id }).first(), undefined);
    const consents = await db('consents').where({ contact_id: asha.id });
    assert.ok(consents.length >= 2 && consents.every((c) => Object.keys(c.evidence).length === 0), 'consents kept, evidence cleared');
    const audit = await db('audit_logs').where({ entity_id: asha.id, action: 'contact.erased' }).first();
    assert.equal(audit.meta.reason, 'Asked by email on 6 Nov');
    // A new enquiry with the old number creates a new person rather than reviving the erased one.
    const fresh = await ritika('POST', '/contacts', { unitId: satAdmissions.id, kind: 'parent', firstName: 'Asha', phones: [ashaPhone] });
    assert.equal(fresh.status, 201, 'the student sharing the number is another person, so a new parent is created');
    assert.notEqual(fresh.body.data.contact.id, asha.id);
  });
});
