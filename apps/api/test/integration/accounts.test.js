import { test } from 'node:test';
import assert from 'node:assert/strict';
import { env } from '../../src/config/env.js';
import { db } from '../../src/lib/db.js';
import { redis } from '../../src/lib/redis.js';
import { closeQueues } from '../../src/core/queue.js';
import { createApp } from '../../src/app.js';
import { buildRegistry } from '../../src/registry.js';
import { modules } from '../../src/modules/index.js';

// The institutes API end to end against the seeded database (01_foundation + 02_crm), as different
// seeded people: create and de-duplication, scoping across companies, people at institutes,
// company links, PII masking. Records get unique names per run, so it can run repeatedly.
//   npm run db:migrate && npm run db:seed && INTEGRATION=1 npm test

const enabled = process.env.INTEGRATION === '1';
const RUN = Date.now().toString(36);
// Numbers in the fake range that no seeded institute or person has: +91 90008 xxxxx.
const fakePhone = () => `+9190008${String(Math.floor(Math.random() * 100_000)).padStart(5, '0')}`;

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
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
}

const qs = (query) => `?${new URLSearchParams(query)}`;
const show = (res) => JSON.stringify(res.body);

test('Institutes API', { skip: !enabled && 'set INTEGRATION=1 to run' }, async (t) => {
  const app = createApp({ registry: buildRegistry(), modules });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const cleanups = [];

  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup().catch(() => undefined);
    server.close();
    await closeQueues();
    await db.destroy();
    await redis.quit();
  });

  // Repeated local runs would otherwise trip the sign-in rate limit.
  const limits = await redis.keys('rl:*');
  if (limits.length) await redis.del(...limits);

  const group = await db('org_units').whereNull('parent_id').where({ code: 'phoenix' }).first();
  const units = await db('org_units').where({ root_id: group.id });
  const byCode = (code) => units.find((u) => u.code === code);
  const satnpaper = byCode('satnpaper');
  const pivector = byCode('pi-vector');
  const online = byCode('online');
  const software = byCode('software-sales');
  const satAdmissions = byCode('sat-admissions');
  assert.ok(await db('accounts').where({ group_id: group.id }).first(), 'run the CRM seed first');
  const userIds = new Map((await db('users').select('id', 'email')).map((u) => [u.email, u.id]));

  const people = {};
  for (const [name, email] of [
    ['owner', 'owner@phoenix.test'],
    ['sales', 'sales.satnpaper@phoenix.test'],
    ['spAdmin', 'admin.satnpaper@phoenix.test'],
    ['pvAdmin', 'admin.pivector@phoenix.test'],
    ['ritika', 'ritika@phoenix.test'],
    ['kabir', 'kabir@phoenix.test'],
  ]) {
    people[name] = client(base);
    const login = await people[name]('POST', '/auth/login', { email, password: env.SEED_PASSWORD });
    assert.equal(login.status, 200, `${email}: ${show(login)}`);
  }
  const { owner, sales, spAdmin, pvAdmin, ritika, kabir } = people;

  const list = (who, query) => who('GET', `/accounts${qs({ limit: '100', ...query })}`);
  const seededSatnpaperOnly = await db('accounts as a')
    .whereExists(db('account_companies').whereRaw('account_id = a.id').where({ company_id: satnpaper.id }))
    .whereNotExists(db('account_companies').whereRaw('account_id = a.id').where({ company_id: pivector.id }))
    .first('a.*');
  const seededShared = await db('accounts as a')
    .whereExists(db('account_companies').whereRaw('account_id = a.id').where({ company_id: satnpaper.id }))
    .whereExists(db('account_companies').whereRaw('account_id = a.id').where({ company_id: pivector.id }))
    .first('a.*');
  assert.ok(seededSatnpaperOnly && seededShared, 'the seed has SatnPaper-only and shared institutes');

  await t.test('the owner lists SatnPaper institutes with keyset pages and unmasked details', async () => {
    const all = await list(owner, { unitId: satnpaper.id });
    assert.equal(all.status, 200, show(all));
    assert.ok(all.body.data.length >= 10);
    const item = all.body.data.find((row) => row.id === seededSatnpaperOnly.id);
    assert.ok(item);
    assert.equal(item.piiMasked, false);
    assert.equal(item.primaryPhone, seededSatnpaperOnly.primary_phone);
    assert.equal(item.link.companyId, satnpaper.id);
    assert.deepEqual(item.companies.map((c) => c.id), [satnpaper.id]);
    assert.equal(typeof item.openDealCount, 'number');

    const first = await list(owner, { unitId: satnpaper.id, limit: '3', sort: 'name' });
    assert.equal(first.body.data.length, 3);
    assert.ok(first.body.nextCursor);
    const second = await list(owner, { unitId: satnpaper.id, limit: '3', sort: 'name', cursor: first.body.nextCursor });
    assert.equal(second.status, 200, show(second));
    const ids = new Set(first.body.data.map((row) => row.id));
    assert.ok(second.body.data.every((row) => !ids.has(row.id)), 'pages do not overlap');
    const names = [...first.body.data, ...second.body.data].map((row) => row.name.toLowerCase().replace(/[^a-z ]/g, ''));
    assert.deepEqual(names, [...names].sort(), 'sorted by name');

    const byUpdated = await list(owner, { unitId: satnpaper.id, limit: '2' });
    const next = await list(owner, { unitId: satnpaper.id, limit: '2', cursor: byUpdated.body.nextCursor });
    assert.equal(next.status, 200);
    assert.ok(new Date(next.body.data[0].updatedAt) <= new Date(byUpdated.body.data[1].updatedAt));
    const wrongSort = await list(owner, { unitId: satnpaper.id, sort: 'name', cursor: byUpdated.body.nextCursor });
    assert.equal(wrongSort.status, 400, 'a cursor only continues its own sort');

    const group = await list(owner, { unitId: satnpaper.root_id });
    const shared = group.body.data.find((row) => row.id === seededShared.id);
    assert.equal(shared.link, null, 'no working company at group level');
    assert.equal(shared.companies.length, 2);
  });

  await t.test('filters: kind, city, student count, software, owner and search', async () => {
    const schools = await list(owner, { unitId: satnpaper.id, kind: 'school' });
    assert.ok(schools.body.data.length > 0 && schools.body.data.every((row) => row.kind === 'school'));
    const city = await list(owner, { unitId: satnpaper.id, city: seededSatnpaperOnly.city.toUpperCase() });
    assert.ok(city.body.data.some((row) => row.id === seededSatnpaperOnly.id));
    assert.ok(city.body.data.every((row) => row.city === seededSatnpaperOnly.city));
    const big = await list(owner, { unitId: satnpaper.id, studentCountMin: '2000', studentCountMax: '3000' });
    assert.ok(big.body.data.length > 0 && big.body.data.every((row) => row.studentCount >= 2000 && row.studentCount <= 3000));
    const software = await list(owner, { unitId: satnpaper.id, currentSoftware: 'erp' });
    assert.ok(software.body.data.length > 0 && software.body.data.every((row) => /erp/i.test(row.currentSoftware)));
    const mine = await list(sales, { unitId: satnpaper.id, owner: 'me' });
    assert.ok(mine.body.data.length > 0 && mine.body.data.every((row) => row.link.owner.id === userIds.get('sales.satnpaper@phoenix.test')));
    const none = await list(sales, { unitId: satnpaper.id, owner: 'none' });
    assert.ok(none.body.data.every((row) => row.link.owner === null));

    const byName = await list(owner, { unitId: satnpaper.id, q: seededSatnpaperOnly.name.split(' ')[0].toLowerCase() });
    assert.ok(byName.body.data.some((row) => row.id === seededSatnpaperOnly.id), show(byName));
    if (seededSatnpaperOnly.domain) {
      const byDomain = await list(owner, { unitId: satnpaper.id, q: `someone@${seededSatnpaperOnly.domain}` });
      assert.deepEqual(byDomain.body.data.map((row) => row.id), [seededSatnpaperOnly.id]);
    }
    const byPhone = await list(owner, { unitId: satnpaper.id, q: seededSatnpaperOnly.primary_phone.replace('+91', '0') });
    assert.deepEqual(byPhone.body.data.map((row) => row.id), [seededSatnpaperOnly.id]);
  });

  await t.test('other companies and roles without institutes get 403 or 404', async () => {
    assert.equal((await list(pvAdmin, { unitId: satnpaper.id })).status, 404, 'SatnPaper is not visible to Pi Vector');
    assert.equal((await pvAdmin('GET', `/accounts/${seededSatnpaperOnly.id}`)).status, 404);
    assert.equal((await pvAdmin('PATCH', `/accounts/${seededSatnpaperOnly.id}`, { currentSoftware: 'x' })).status, 404);
    const pvList = await list(pvAdmin, { unitId: pivector.id });
    assert.equal(pvList.status, 200);
    assert.ok(pvList.body.data.every((row) => row.id !== seededSatnpaperOnly.id));

    // A shared institute shows Pi Vector its own link and deals only.
    const shared = await pvAdmin('GET', `/accounts/${seededShared.id}`);
    assert.equal(shared.status, 200, show(shared));
    assert.deepEqual(shared.body.data.links.map((link) => link.company.id), [pivector.id]);
    assert.ok([...shared.body.data.openDeals, ...shared.body.data.closedDeals].every((deal) => deal.companyId === pivector.id));
    const ownerView = await owner('GET', `/accounts/${seededShared.id}`);
    assert.equal(ownerView.body.data.links.length, 2);

    // Counsellors don't work with institutes.
    assert.equal((await list(ritika, { unitId: satAdmissions.id })).status, 403);
    assert.equal((await ritika('GET', `/accounts/${seededSatnpaperOnly.id}`)).status, 404);
    // Kabir manages Online, where no seeded institute lives.
    const kabirList = await list(kabir, { unitId: satnpaper.id });
    assert.equal(kabirList.status, 200);
    assert.ok(kabirList.body.data.every((row) => row.link.unitId !== software.id));
    assert.equal((await kabir('GET', `/accounts/${seededSatnpaperOnly.id}`)).status, 404);
  });

  let created;
  const website = `https://www.nova-${RUN}.example/contact`;
  const phone = fakePhone();
  await t.test('an account executive adds an institute with two people', async () => {
    const res = await sales('POST', '/accounts', {
      unitId: software.id,
      kind: 'coaching_institute',
      name: `Nova Coaching ${RUN}`,
      website,
      phone,
      email: `office@nova-${RUN}.example`,
      city: 'Pune',
      state: 'Maharashtra',
      branchCount: 2,
      studentCount: 640,
      currentSoftware: 'Spreadsheets',
      profile: { exams: ['JEE'], budgetBand: 'l1_5' },
      tags: ['Hot lead'],
      source: { channel: 'website_form', campaign: 'b2b-demo' },
      custom: { software_renewal_on: '2027-03-31' },
      contacts: [
        { contact: { firstName: 'Ravi', lastName: `Kulkarni ${RUN}`, phones: [fakePhone()] }, title: 'Director', role: 'decision_maker', isPrimary: true },
        { contact: { firstName: 'Neha', lastName: `Joshi ${RUN}`, emails: [`neha.${RUN}@nova-${RUN}.example`] }, title: 'Academic head', role: 'influencer' },
      ],
    });
    assert.equal(res.status, 201, show(res));
    assert.equal(res.body.data.created, true);
    assert.equal(res.body.data.linkCreated, true);
    created = res.body.data.account;
    assert.equal(created.domain, `nova-${RUN}.example`);
    assert.equal(created.primaryPhone, phone);
    assert.equal(created.can.manage, true);
    assert.equal(created.links.length, 1);
    assert.equal(created.links[0].owner.id, userIds.get('sales.satnpaper@phoenix.test'));
    assert.deepEqual(created.links[0].tags, ['hot lead']);
    assert.equal(created.links[0].custom.software_renewal_on, '2027-03-31');
    assert.equal(created.contacts.length, 2);
    assert.equal(created.contacts[0].role, 'decision_maker');
    assert.equal(created.contacts[0].isPrimary, true);
    assert.equal(created.contacts[0].contact.kind, 'staff');

    const [timeline, search, audit, events] = await Promise.all([
      db('timeline_events').where({ account_id: created.id }).orderBy('id'),
      db('search_documents').where({ entity_type: 'account', entity_id: created.id }).first(),
      db('audit_logs').where({ entity_type: 'account', entity_id: created.id }).pluck('action'),
      db('outbox_events').where({ aggregate_type: 'account', aggregate_id: created.id }).pluck('type'),
    ]);
    assert.equal(timeline[0].title, 'Institute added');
    assert.equal(timeline[0].company_id, satnpaper.id);
    assert.ok(timeline.some((entry) => entry.title === `Ravi Kulkarni ${RUN} added as decision maker`));
    assert.equal(search.title, `Nova Coaching ${RUN}`);
    assert.ok(search.keywords.includes(`nova-${RUN}.example`));
    assert.ok(audit.includes('account.created') && audit.includes('account.contact_added'));
    assert.ok(events.includes('account.created'));
    const auditRow = await db('audit_logs').where({ entity_type: 'account', entity_id: created.id, action: 'account.created' }).first();
    assert.ok(!JSON.stringify(auditRow.after).includes(phone), 'no phone numbers in the audit log');
  });

  await t.test('adding the same institute again finds it (domain, phone, name + city)', async () => {
    const byDomain = await sales('POST', '/accounts', { unitId: software.id, kind: 'other', name: 'Nova (duplicate)', website: `http://nova-${RUN}.example` });
    assert.equal(byDomain.status, 200, show(byDomain));
    assert.equal(byDomain.body.data.created, false);
    assert.equal(byDomain.body.data.matchedBy, 'domain');
    assert.equal(byDomain.body.data.account.id, created.id);
    assert.equal(byDomain.body.data.linkCreated, false);

    const byPhone = await sales('POST', '/accounts', { unitId: software.id, kind: 'school', name: 'Somebody else', phone: phone.replace('+91', '') });
    assert.equal(byPhone.body.data.matchedBy, 'phone');
    assert.equal(byPhone.body.data.account.id, created.id);

    const byName = await sales('POST', '/accounts', { unitId: software.id, kind: 'coaching_institute', name: `NOVA coaching ${RUN}.`, city: ' pune ' });
    assert.equal(byName.body.data.matchedBy, 'name');
    assert.equal(byName.body.data.account.id, created.id);

    const otherCity = await sales('POST', '/accounts', { unitId: software.id, kind: 'coaching_institute', name: `Nova Coaching ${RUN}`, city: 'Nashik' });
    assert.equal(otherCity.status, 201, 'the same name in another city is another institute');
    const forced = await sales('POST', '/accounts', { unitId: software.id, kind: 'coaching_institute', name: `Nova Coaching ${RUN}`, city: 'Pune', mode: 'create' });
    assert.equal(forced.status, 201, 'mode create skips matching');

    // Pi Vector adds it too: one institute, two company links; Pi Vector sees only its own.
    const pv = await pvAdmin('POST', '/accounts', { unitId: pivector.id, kind: 'coaching_institute', name: 'Nova', email: `admissions@nova-${RUN}.example` });
    assert.equal(pv.status, 200, show(pv));
    assert.equal(pv.body.data.linkCreated, true);
    assert.equal(pv.body.data.account.id, created.id);
    assert.deepEqual(pv.body.data.account.links.map((link) => link.company.id), [pivector.id]);
    assert.equal(pv.body.data.account.links[0].custom.software_renewal_on, undefined, "SatnPaper's custom values stay hidden");
    const linked = await db('timeline_events').where({ account_id: created.id, company_id: pivector.id }).first();
    assert.equal(linked.title, 'Institute added to this company');
  });

  await t.test('create validates owners, units and inputs', async () => {
    const invisibleUnit = await sales('POST', '/accounts', { unitId: online.id, kind: 'school', name: `X ${RUN}` });
    assert.equal(invisibleUnit.status, 404, 'Online is outside the account executive’s team');
    const counsellor = await ritika('POST', '/accounts', { unitId: satAdmissions.id, kind: 'school', name: `X ${RUN}` });
    assert.equal(counsellor.status, 403, 'counsellors have no accounts.manage');
    const groupLevel = await owner('POST', '/accounts', { unitId: group.id, kind: 'school', name: `X ${RUN}` });
    assert.equal(groupLevel.status, 422);
    const badOwner = await sales('POST', '/accounts', { unitId: software.id, kind: 'school', name: `Y ${RUN}`, ownerUserId: userIds.get('ritika@phoenix.test') });
    assert.equal(badOwner.status, 422);
    assert.equal(badOwner.body.error.details[0].path, 'body.ownerUserId');
    const badPhone = await sales('POST', '/accounts', { unitId: software.id, kind: 'school', name: `Z ${RUN}`, phone: '12' });
    assert.equal(badPhone.status, 422);
    assert.equal(badPhone.body.error.details[0].path, 'body.phone');
    const badCustom = await sales('POST', '/accounts', { unitId: software.id, kind: 'school', name: `W ${RUN}`, custom: { software_renewal_on: 'soon' } });
    assert.equal(badCustom.status, 422);
    assert.equal(badCustom.body.error.details[0].path, 'body.custom.software_renewal_on');
    const twoPrimaries = await sales('POST', '/accounts', {
      unitId: software.id,
      kind: 'school',
      name: `V ${RUN}`,
      contacts: [
        { contact: { firstName: 'A' }, isPrimary: true },
        { contact: { firstName: 'B' }, isPrimary: true },
      ],
    });
    assert.equal(twoPrimaries.status, 422);

    // Kabir (SatnPaper › Online) adds Nova, which SatnPaper's Software sales team already works.
    const before = await db('accounts').where({ id: created.id }).first();
    const hiddenTeam = await kabir('POST', '/accounts', { unitId: online.id, kind: 'school', name: 'Nova', website, legalName: `Nova Pvt Ltd ${RUN}` });
    assert.equal(hiddenTeam.status, 409, show(hiddenTeam));
    assert.match(hiddenTeam.body.error.message, /another team in SatnPaper/);
    const after = await db('accounts').where({ id: created.id }).first();
    assert.equal(after.legal_name, before.legal_name, 'nothing is written to an institute the user cannot see');
  });

  await t.test('people at the institute: link existing, add new, change, remove', async () => {
    const detail = (await sales('GET', `/accounts/${created.id}`)).body.data;
    const neha = detail.contacts.find((c) => c.contact.firstName === 'Neha');
    assert.equal((await sales('POST', `/accounts/${created.id}/contacts`, { contactId: neha.contact.id, role: 'user' })).status, 409);

    // A seeded SatnPaper institute's staff member, visible to the account executive.
    const staff = await db('account_contacts').where({ account_id: seededSatnpaperOnly.id }).first();
    const added = await sales('POST', `/accounts/${created.id}/contacts`, { contactId: staff.contact_id, title: 'Consultant', role: 'champion', isPrimary: true });
    assert.equal(added.status, 201, show(added));
    assert.equal(added.body.data.isPrimary, true);
    const after = (await sales('GET', `/accounts/${created.id}`)).body.data;
    assert.equal(after.contacts.filter((c) => c.isPrimary).length, 1, 'one main contact');
    assert.equal(after.contacts[0].contact.id, staff.contact_id);

    // A Pi Vector-only person is not visible to SatnPaper's account executive.
    const pvOnly = await db('contact_companies as l')
      .where('l.company_id', pivector.id)
      .whereNotExists(db('contact_companies').whereRaw('contact_id = l.contact_id').whereNot({ company_id: pivector.id }))
      .whereNotExists(db('deal_contacts as dc').join('deals as d', 'd.id', 'dc.deal_id').whereRaw('dc.contact_id = l.contact_id').where('d.company_id', satnpaper.id))
      .first('l.contact_id');
    const hidden = await sales('POST', `/accounts/${created.id}/contacts`, { contactId: pvOnly.contact_id, role: 'other' });
    assert.equal(hidden.status, 422);
    assert.equal(hidden.body.error.details[0].path, 'body.contactId');

    const fresh = await sales('POST', `/accounts/${created.id}/contacts`, { contact: { firstName: 'Imran', lastName: `Shaikh ${RUN}`, phones: [fakePhone()] }, role: 'billing' });
    assert.equal(fresh.status, 201, show(fresh));
    assert.equal(fresh.body.data.contact.kind, 'staff');
    const link = await db('contact_companies').where({ contact_id: fresh.body.data.contact.id, company_id: satnpaper.id }).first();
    assert.equal(link.unit_id, software.id, 'new people join the company that works the institute');

    const changed = await sales('PATCH', `/accounts/${created.id}/contacts/${fresh.body.data.contact.id}`, { title: 'Accounts', role: 'decision_maker', isPrimary: true });
    assert.equal(changed.status, 200, show(changed));
    assert.equal(changed.body.data.role, 'decision_maker');
    assert.equal(changed.body.data.title, 'Accounts');
    const primaries = await db('account_contacts').where({ account_id: created.id, is_primary: true }).pluck('contact_id');
    assert.deepEqual(primaries, [fresh.body.data.contact.id]);

    assert.equal((await sales('DELETE', `/accounts/${created.id}/contacts/${staff.contact_id}`)).status, 204);
    assert.equal((await sales('DELETE', `/accounts/${created.id}/contacts/${staff.contact_id}`)).status, 404);
    assert.ok(await db('contacts').where({ id: staff.contact_id }).first(), 'the person stays a contact');
    const removed = await db('timeline_events').where({ account_id: created.id }).whereRaw("meta->>'action' = 'account.contact_removed'").first();
    assert.ok(removed);
    assert.equal((await pvAdmin('DELETE', `/accounts/${seededSatnpaperOnly.id}/contacts/${staff.contact_id}`)).status, 404);
  });

  await t.test('edit details and the company relationship', async () => {
    const renamed = await sales('PATCH', `/accounts/${created.id}`, { name: `Nova Coaching Classes ${RUN}`, studentCount: 700, website: null });
    assert.equal(renamed.status, 200, show(renamed));
    assert.equal(renamed.body.data.studentCount, 700);
    assert.equal(renamed.body.data.domain, `nova-${RUN}.example`, 'the domain falls back to the work email');
    const doc = await db('search_documents').where({ entity_type: 'account', entity_id: created.id }).first();
    assert.equal(doc.title, `Nova Coaching Classes ${RUN}`);
    assert.equal((await sales('PATCH', `/accounts/${created.id}`, { phone: 'abc' })).status, 422);
    assert.equal((await sales('PATCH', `/accounts/${created.id}`, { name: '' })).status, 422);

    const link = await sales('PATCH', `/accounts/${created.id}/links/${satnpaper.id}`, {
      status: 'customer',
      ownerUserId: userIds.get('admin.satnpaper@phoenix.test'),
      custom: { software_renewal_on: null },
    });
    assert.equal(link.status, 200, show(link));
    const spLink = link.body.data.links.find((l) => l.company.id === satnpaper.id);
    assert.equal(spLink.status, 'customer');
    assert.equal(spLink.owner.name, 'Rohit Bansal');
    assert.deepEqual(spLink.custom, {});
    const wrongOwner = await sales('PATCH', `/accounts/${created.id}/links/${satnpaper.id}`, { ownerUserId: userIds.get('kabir@phoenix.test') });
    assert.equal(wrongOwner.status, 422, 'kabir has no access to institutes in Software sales');
    assert.equal((await sales('PATCH', `/accounts/${created.id}/links/${satnpaper.id}`, { unitId: online.id })).status, 422, 'a unit they can’t see');
    assert.equal((await sales('PATCH', `/accounts/${created.id}/links/${satnpaper.id}`, { unitId: byCode('north').id })).status, 422);
    assert.equal((await sales('PATCH', `/accounts/${created.id}/links/${pivector.id}`, { status: 'former' })).status, 404, "Pi Vector's link is hidden");

    // The company admin moves it to Online, where Kabir (manager) now sees it.
    const moved = await spAdmin('PATCH', `/accounts/${created.id}/links/${satnpaper.id}`, { unitId: online.id });
    assert.equal(moved.status, 200, show(moved));
    const kabirSees = await kabir('GET', `/accounts/${created.id}`);
    assert.equal(kabirSees.status, 200);
    assert.equal(kabirSees.body.data.can.manage, true);
    assert.equal((await sales('GET', `/accounts/${created.id}`)).status, 404, 'out of the account executive’s team now');

    const archived = await spAdmin('PATCH', `/accounts/${created.id}/links/${satnpaper.id}`, { archived: true });
    assert.equal(archived.status, 200);
    const hiddenList = await list(kabir, { unitId: satnpaper.id });
    assert.ok(hiddenList.body.data.every((row) => row.id !== created.id), 'archived links leave the list');
    const archivedList = await list(kabir, { unitId: satnpaper.id, includeArchived: 'true' });
    assert.ok(archivedList.body.data.some((row) => row.id === created.id));
    const actions = await db('audit_logs').where({ entity_type: 'account', entity_id: created.id, action: 'account.link_updated' }).count({ n: '*' }).first();
    assert.ok(Number(actions.n) >= 3);
  });

  await t.test('people without contacts.view_pii see masked phones and emails', async () => {
    // A temporary analyst role for Kabir in Software sales: institutes visible, personal data masked there.
    const analyst = await db('roles').whereNull('group_id').where({ key: 'analyst' }).first();
    const assigned = await owner('POST', `/users/${userIds.get('kabir@phoenix.test')}/assignments`, { roleId: analyst.id, unitId: software.id });
    assert.equal(assigned.status, 201, show(assigned));
    const assignmentId = assigned.body.data.assignments.find((a) => a.role.key === 'analyst' && a.unit.id === software.id)?.id;
    cleanups.push(() => owner('DELETE', `/users/${userIds.get('kabir@phoenix.test')}/assignments/${assignmentId}`));

    const rows = await list(kabir, { unitId: software.id });
    assert.equal(rows.status, 200, show(rows));
    const row = rows.body.data.find((item) => item.id === seededSatnpaperOnly.id);
    assert.ok(row);
    assert.equal(row.piiMasked, true);
    assert.notEqual(row.primaryPhone, seededSatnpaperOnly.primary_phone);
    assert.match(row.primaryPhone, /•/);
    const detail = await kabir('GET', `/accounts/${seededSatnpaperOnly.id}`);
    assert.equal(detail.body.data.can.viewPii, false);
    assert.equal(detail.body.data.can.manage, false);
    assert.equal(detail.body.data.address, null);
    assert.ok(detail.body.data.contacts.every((c) => c.contact.piiMasked && (!c.contact.primaryPhone || c.contact.primaryPhone.includes('•'))));
    assert.equal((await kabir('PATCH', `/accounts/${seededSatnpaperOnly.id}`, { currentSoftware: 'x' })).status, 403);

    const res = await owner('DELETE', `/users/${userIds.get('kabir@phoenix.test')}/assignments/${assignmentId}`);
    assert.equal(res.status, 204);
    cleanups.pop();
    assert.equal((await kabir('GET', `/accounts/${seededSatnpaperOnly.id}`)).status, 404, 'access ends with the assignment');
  });

  await t.test('the institute page lists the deals the viewer may see', async () => {
    const withDeals = await db('deals').where({ company_id: satnpaper.id }).whereNotNull('account_id').where({ status: 'open' }).first('account_id');
    const res = await owner('GET', `/accounts/${withDeals.account_id}`);
    assert.equal(res.status, 200);
    const deal = res.body.data.openDeals[0];
    assert.ok(deal.ref && deal.stage.name && typeof deal.value.valueMinor === 'number');
    assert.ok(res.body.data.openDealCount >= res.body.data.openDeals.length);
    const asSales = await sales('GET', `/accounts/${withDeals.account_id}`);
    assert.ok(asSales.body.data.openDeals.every((d) => d.owner?.id === userIds.get('sales.satnpaper@phoenix.test')), 'own deals only');
  });
});
