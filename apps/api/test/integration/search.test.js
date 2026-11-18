import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { env } from '../../src/config/env.js';
import { db } from '../../src/lib/db.js';
import { redis } from '../../src/lib/redis.js';
import { closeQueues } from '../../src/core/queue.js';
import { createApp } from '../../src/app.js';
import { buildRegistry } from '../../src/registry.js';
import { modules } from '../../src/modules/index.js';
import { findOrCreateContact } from '../../src/core/crm/contacts.js';
import { refreshSearchDocument, reindexSearch } from '../../src/core/crm/search.js';
import { handleSearchEvent } from '../../src/modules/search/handlers.js';

// GET /search against the seeded database (02_crm.js), as different seeded people, plus the
// consistency handlers and the reindex CLI. Fixtures are unique per run and removed afterwards.
//   npm run db:migrate && npm run db:seed && INTEGRATION=1 npm test

const enabled = process.env.INTEGRATION === '1';
const RUN = Date.now().toString(36);
// A run-unique word, so name searches find only this run's fixtures.
const MARK = `zq${RUN.replace(/\d/g, (digit) => 'abcdefghij'[Number(digit)])}`;
// Numbers in the fake range no seeded person has: +91 90009 xxxxx.
const fakeNational = () => `90009${String(Math.floor(Math.random() * 100_000)).padStart(5, '0')}`;
const API_DIR = fileURLToPath(new URL('../../', import.meta.url));

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
    return { status: res.status, body: text ? JSON.parse(text) : null, text };
  };
}

const group = (body, type) => body.data.groups.find((g) => g.type === type);
const ids = (body, type) => (group(body, type)?.hits ?? []).map((hit) => hit.id);

test('global search', { skip: !enabled && 'set INTEGRATION=1 to run' }, async (t) => {
  const app = createApp({ registry: buildRegistry(), modules });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;

  const limits = await redis.keys('rl:*');
  if (limits.length) await redis.del(...limits);

  const phoenix = await db('org_units').whereNull('parent_id').where({ code: 'phoenix' }).first();
  const units = await db('org_units').where({ root_id: phoenix.id });
  const byCode = (code) => units.find((u) => u.code === code);
  const satnpaper = byCode('satnpaper');
  const pivector = byCode('pi-vector');
  const satAdmissions = byCode('sat-admissions');
  assert.ok(satnpaper && pivector && satAdmissions, 'seeded units are there');
  const users = new Map((await db('users').select('id', 'email')).map((u) => [u.email, u.id]));
  const kabirId = users.get('kabir@phoenix.test');
  const pvAdminId = users.get('admin.pivector@phoenix.test');

  // ---------- Fixtures ----------
  const phone = fakeNational();
  const email = `zubin.${RUN}@example.com`;
  const fixture = { contacts: [], deals: [], users: [] };
  const firstStage = async (companyId) => {
    const pipeline = await db('pipelines').where({ company_id: companyId, kind: 'b2c', is_default: true }).whereNull('archived_at').first();
    const stage = await db('pipeline_stages').where({ pipeline_id: pipeline.id, category: 'open' }).orderBy('position').first();
    return { pipeline, stage };
  };
  const insertDeal = async (trx, { company, unit, ownerUserId, contactId, prefix }) => {
    const { pipeline, stage } = await firstStage(company.id);
    const number = 900_000 + Math.floor(Math.random() * 99_999);
    const [deal] = await trx('deals')
      .insert({
        group_id: phoenix.id,
        company_id: company.id,
        unit_id: unit.id,
        number,
        ref: `${prefix}-${number}`,
        title: `Zubin ${MARK} – SAT batches`,
        kind: 'b2c',
        pipeline_id: pipeline.id,
        stage_id: stage.id,
        currency: 'INR',
        value_minor: 5_000_000,
        owner_user_id: ownerUserId,
        primary_contact_id: contactId,
        channel: 'website_form',
      })
      .returning('*');
    await trx('deal_contacts').insert({ deal_id: deal.id, contact_id: contactId, role: 'parent' });
    await refreshSearchDocument(trx, 'deal', deal.id);
    fixture.deals.push(deal.id);
    return deal;
  };

  let shared;
  let pvOnly;
  let spDeal;
  let pvDeal;
  await db.transaction(async (trx) => {
    const base = { groupId: phoenix.id, kind: 'parent', writeTimeline: false };
    shared = (
      await findOrCreateContact(trx, {
        ...base,
        companyId: satnpaper.id,
        unitId: satAdmissions.id,
        fullName: `Zubin ${MARK}`,
        phones: [phone],
        emails: [email],
      })
    ).contact;
    // The same person is known to Pi Vector too.
    await findOrCreateContact(trx, { ...base, companyId: pivector.id, unitId: pivector.id, fullName: `Zubin ${MARK}`, phones: [phone] });
    pvOnly = (
      await findOrCreateContact(trx, {
        ...base,
        companyId: pivector.id,
        unitId: pivector.id,
        fullName: `Zara ${MARK}`,
        phones: [fakeNational()],
      })
    ).contact;
    fixture.contacts.push(shared.id, pvOnly.id);
    spDeal = await insertDeal(trx, { company: satnpaper, unit: satAdmissions, ownerUserId: kabirId, contactId: shared.id, prefix: 'SP' });
    pvDeal = await insertDeal(trx, { company: pivector, unit: pivector, ownerUserId: pvAdminId, contactId: shared.id, prefix: 'PV' });
  });

  // A temporary analyst at SatnPaper: sees everything there, with personal data masked.
  const owner = await db('users').where({ email: 'owner@phoenix.test' }).first();
  const analystRole = await db('roles').whereNull('group_id').where({ key: 'analyst' }).first();
  assert.ok(analystRole, 'the analyst role is synced (npm run roles:sync)');
  const [analyst] = await db('users')
    .insert({ email: `search.analyst.${RUN}@phoenix.test`, name: `Search Analyst ${RUN}`, password_hash: owner.password_hash, status: 'active' })
    .returning('*');
  fixture.users.push(analyst.id);
  await db('role_assignments').insert({ user_id: analyst.id, role_id: analystRole.id, org_unit_id: satnpaper.id });

  t.after(async () => {
    server.close();
    await db('search_documents').whereIn('entity_id', [...fixture.deals, ...fixture.contacts]).delete();
    await db('timeline_events').whereIn('deal_id', fixture.deals).orWhereIn('contact_id', fixture.contacts).delete();
    await db('deals').whereIn('id', fixture.deals).delete();
    await db('contacts').whereIn('id', fixture.contacts).delete();
    await db('users').whereIn('id', fixture.users).delete();
    await closeQueues();
    await db.destroy();
    await redis.quit();
  });

  const signIn = async (address) => {
    const call = client(base);
    const login = await call('POST', '/auth/login', { email: address, password: env.SEED_PASSWORD });
    assert.equal(login.status, 200, `${address}: ${JSON.stringify(login.body)}`);
    return call;
  };
  const asOwner = await signIn('owner@phoenix.test');
  const asRitika = await signIn('ritika@phoenix.test');
  const asKabir = await signIn('kabir@phoenix.test');
  const asPvAdmin = await signIn('admin.pivector@phoenix.test');
  const asAnalyst = await signIn(analyst.email);

  const find = (call, unit, q, extra = '') => call('GET', `/search?unitId=${unit.id}&q=${encodeURIComponent(q)}${extra}`);

  await t.test('inputs are validated and the working unit must be visible', async () => {
    assert.equal((await find(asOwner, phoenix, 'a')).status, 422);
    assert.equal((await find(asOwner, phoenix, 'ab', '&types=task')).status, 422);
    assert.equal((await find(asOwner, phoenix, 'ab', '&limit=50')).status, 422);
    assert.equal((await find(asPvAdmin, satnpaper, MARK)).status, 404, 'another company is not found');
    const anonymous = await client(base)('GET', `/search?unitId=${phoenix.id}&q=ab`);
    assert.equal(anonymous.status, 401);
  });

  await t.test('the group owner finds a phone number in any form, across companies, unmasked', async () => {
    for (const typed of [phone, `+91 ${phone.slice(0, 5)} ${phone.slice(5)}`, `0${phone}`]) {
      const res = await find(asOwner, phoenix, typed);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const deals = group(res.body, 'deal').hits;
      assert.deepEqual(new Set(deals.map((h) => h.id)), new Set([spDeal.id, pvDeal.id]), typed);
      assert.ok(deals.every((h) => h.matchedOn === 'phone' && h.snippet === `Phone +91 ${phone}` && !h.piiMasked));
      const contact = group(res.body, 'contact').hits.find((h) => h.id === shared.id);
      assert.equal(contact?.matchedOn, 'phone');
      assert.equal(contact.contactPoint, `+91 ${phone}`);
      assert.ok(!res.text.includes('keywords'), 'keywords never leave the server');
    }
    const sp = group((await find(asOwner, phoenix, phone)).body, 'deal').hits.find((h) => h.id === spDeal.id);
    assert.deepEqual(sp.company, { id: satnpaper.id, name: satnpaper.name, code: satnpaper.code });
    assert.equal(sp.status, 'open');
    assert.deepEqual(sp.value, { valueMinor: 5_000_000, currency: 'INR' });
    assert.equal(sp.owner.id, kabirId);
    assert.equal(sp.companyId, satnpaper.id);
  });

  await t.test('exact email and reference matches rank first', async () => {
    const byEmail = await find(asOwner, phoenix, email.toUpperCase());
    assert.equal(group(byEmail.body, 'contact').hits[0].id, shared.id);
    assert.equal(group(byEmail.body, 'contact').hits[0].matchedOn, 'email');
    const byRef = await find(asOwner, satnpaper, spDeal.ref);
    assert.deepEqual(ids(byRef.body, 'deal'), [spDeal.id]);
    assert.equal(group(byRef.body, 'deal').hits[0].snippet, `Ref ${spDeal.ref}`);
    const byNumber = await find(asOwner, phoenix, String(spDeal.number));
    assert.equal(group(byNumber.body, 'deal').hits[0].matchedOn, 'ref');
  });

  await t.test('names match by words and by trigram similarity', async () => {
    const res = await find(asOwner, phoenix, `zubin ${MARK}`);
    assert.equal(group(res.body, 'contact').hits[0].id, shared.id);
    assert.equal(group(res.body, 'contact').hits[0].matchedOn, 'name');
    const prefix = await find(asOwner, phoenix, `zub ${MARK.slice(0, -2)}`);
    assert.ok(ids(prefix.body, 'contact').includes(shared.id), 'word prefixes match');
    const typo = await find(asOwner, phoenix, `${MARK}x`);
    assert.ok(ids(typo.body, 'contact').includes(shared.id), 'a near miss still matches by trigrams');
  });

  await t.test('a counsellor sees her unit’s people but only her own deals', async () => {
    const res = await find(asRitika, satnpaper, phone);
    assert.equal(res.status, 200);
    assert.deepEqual(ids(res.body, 'contact'), [shared.id]);
    assert.deepEqual(ids(res.body, 'deal'), [], 'Kabir’s deal is not hers; Pi Vector’s is another company');
    assert.equal(group(res.body, 'account'), undefined, 'no accounts.view: the type is skipped, not 403');
    const byName = await find(asRitika, satnpaper, MARK);
    assert.ok(!ids(byName.body, 'contact').includes(pvOnly.id), 'a Pi Vector person stays hidden');
    // Her own seeded deals are found.
    const mine = await db('deals').where({ owner_user_id: users.get('ritika@phoenix.test') }).whereNull('archived_at').first();
    const own = await find(asRitika, satnpaper, mine.ref);
    assert.deepEqual(ids(own.body, 'deal'), [mine.id]);
  });

  await t.test('a manager sees his branch’s deals, never another company’s', async () => {
    const res = await find(asKabir, satnpaper, phone);
    assert.deepEqual(ids(res.body, 'deal'), [spDeal.id]);
    const name = await find(asKabir, satnpaper, MARK);
    assert.ok(!ids(name.body, 'contact').includes(pvOnly.id));
    assert.ok(!ids(name.body, 'deal').includes(pvDeal.id));
  });

  await t.test('a Pi Vector admin never sees SatnPaper’s deal', async () => {
    const res = await find(asPvAdmin, pivector, phone);
    assert.equal(res.status, 200);
    assert.deepEqual(ids(res.body, 'deal'), [pvDeal.id]);
    assert.deepEqual(new Set(ids(res.body, 'contact')), new Set([shared.id]));
    const byRef = await find(asPvAdmin, pivector, spDeal.ref);
    assert.deepEqual(ids(byRef.body, 'deal'), []);
    const name = await find(asPvAdmin, pivector, MARK);
    assert.ok(ids(name.body, 'contact').includes(pvOnly.id));
    assert.ok(!ids(name.body, 'deal').includes(spDeal.id));
  });

  await t.test('personal data is masked for people without contacts.view_pii', async () => {
    const res = await find(asAnalyst, satnpaper, phone);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const contact = group(res.body, 'contact').hits.find((h) => h.id === shared.id);
    assert.ok(contact, 'the analyst finds the person by exact number');
    assert.equal(contact.piiMasked, true);
    assert.match(contact.contactPoint, /^\+91 •+\d{3}$/);
    assert.match(contact.snippet, /^Phone \+91 •+\d{3}$/);
    const deal = group(res.body, 'deal').hits.find((h) => h.id === spDeal.id);
    assert.equal(deal.piiMasked, true);
    assert.ok(!JSON.stringify(res.body.data.groups).includes(phone), 'the number never appears in the hits (only in the echoed query)');
    const byEmail = await find(asAnalyst, satnpaper, email);
    assert.ok(!JSON.stringify(byEmail.body.data.groups).includes(email));
    assert.match(group(byEmail.body, 'contact').hits[0].snippet, /^Email z•••@example\.com$/);
    // Fragments of numbers only work for people who may see them.
    const fragment = phone.slice(-6);
    assert.deepEqual(ids((await find(asAnalyst, satnpaper, fragment)).body, 'contact'), []);
    assert.ok(ids((await find(asOwner, satnpaper, fragment)).body, 'contact').includes(shared.id));
  });

  await t.test('types and limit narrow the result', async () => {
    const res = await find(asOwner, phoenix, phone, '&types=contact&limit=1');
    assert.deepEqual(res.body.data.groups.map((g) => g.type), ['contact']);
    assert.equal(res.body.data.groups[0].hits.length, 1);
  });

  await t.test('event handlers repair drift and drop archived records', async () => {
    // A producer that forgot to refresh the document: the handler fixes it from the deal row.
    await db('deals').where({ id: spDeal.id }).update({ title: `Renamed ${MARK} – SAT batches` });
    await handleSearchEvent({ type: 'deal.updated', aggregateId: spDeal.id, payload: { dealId: spDeal.id } }, { db });
    await handleSearchEvent({ type: 'deal.updated', aggregateId: spDeal.id, payload: { dealId: spDeal.id } }, { db });
    const doc = await db('search_documents').where({ entity_type: 'deal', entity_id: spDeal.id }).first();
    assert.equal(doc.title, `Renamed ${MARK} – SAT batches`, 'idempotent: twice is the same as once');

    await db('deals').where({ id: pvDeal.id }).update({ archived_at: db.fn.now() });
    await handleSearchEvent({ type: 'deal.archived', aggregateId: pvDeal.id, payload: { dealId: pvDeal.id } }, { db });
    assert.deepEqual(ids((await find(asOwner, phoenix, phone)).body, 'deal'), [spDeal.id]);

    // A contact edit refreshes the deals that carry the contact's name and numbers.
    await db('search_documents').where({ entity_type: 'deal', entity_id: spDeal.id }).update({ keywords: '' });
    await handleSearchEvent({ type: 'contact.updated', aggregateId: shared.id, payload: { contactId: shared.id, changes: ['phones'] } }, { db });
    assert.deepEqual(ids((await find(asOwner, phoenix, phone)).body, 'deal'), [spDeal.id]);
  });

  await t.test('reindex rebuilds missing documents', async () => {
    await db('search_documents').whereIn('entity_id', [shared.id, pvOnly.id]).delete();
    assert.deepEqual(ids((await find(asOwner, phoenix, MARK)).body, 'contact'), []);
    const totals = await reindexSearch(db, { entityTypes: ['contact'], groupId: phoenix.id, batchSize: 1000, prune: true });
    assert.ok(totals.contact >= 2);
    assert.deepEqual(new Set(ids((await find(asOwner, phoenix, MARK)).body, 'contact')), new Set([shared.id, pvOnly.id]));
  });

  await t.test('the reindex CLI rebuilds one type', async () => {
    await db('search_documents').where({ entity_type: 'deal', entity_id: spDeal.id }).delete();
    const run = spawnSync(process.execPath, ['src/cli/search-reindex.js', '--type', 'deals', '--group', phoenix.id, '--quiet'], {
      cwd: API_DIR,
      encoding: 'utf8',
      timeout: 120_000,
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Search index rebuilt in [\d.]+ s: \d+ deals/);
    assert.ok(await db('search_documents').where({ entity_type: 'deal', entity_id: spDeal.id }).first());
    assert.equal(spawnSync(process.execPath, ['src/cli/search-reindex.js', '--type', 'tasks'], { cwd: API_DIR }).status, 1);
  });
});
