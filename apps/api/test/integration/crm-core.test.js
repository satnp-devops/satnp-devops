import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../../src/lib/db.js';
import { redis } from '../../src/lib/redis.js';
import { loadAccess } from '../../src/core/access.js';
import { buildRegistry } from '../../src/registry.js';
import { canContact } from '../../src/core/crm/consent.js';
import { findOrCreateContact } from '../../src/core/crm/contacts.js';
import {
  applyListScope,
  companiesInScope,
  listScope,
  loadVisible,
  loadVisibleContact,
  usersWithPermissionAt,
} from '../../src/core/crm/scope.js';
import { refreshSearchDocument } from '../../src/core/crm/search.js';
import { addTimelineEvent } from '../../src/core/crm/timeline.js';

// The shared CRM helpers against the seeded database (02_crm.js): scoping as different seeded
// users, de-duplication, the timeline and search. Writes happen in transactions that are rolled back.
//   npm run db:migrate && npm run db:seed && INTEGRATION=1 npm test

const enabled = process.env.INTEGRATION === '1';
const RUN = Date.now().toString(36);
// A number in the fake range that no seeded person has: +91 90009 xxxxx.
const fakePhone = () => `090009${String(Math.floor(Math.random() * 100_000)).padStart(5, '0')}`;

class Rollback extends Error {}

/** Run fn in a transaction and always roll it back. */
async function inRollback(fn) {
  try {
    await db.transaction(async (trx) => {
      await fn(trx);
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
}

test('CRM core helpers', { skip: !enabled && 'set INTEGRATION=1 to run' }, async (t) => {
  const registry = buildRegistry();
  t.after(async () => {
    await db.destroy();
    await redis.quit();
  });

  const group = await db('org_units').whereNull('parent_id').where({ code: 'phoenix' }).first();
  const units = await db('org_units').where({ root_id: group.id });
  const byCode = (code) => units.find((u) => u.code === code);
  const satnpaper = byCode('satnpaper');
  const pivector = byCode('pi-vector');
  const online = byCode('online');
  const satAdmissions = byCode('sat-admissions');
  assert.ok(satnpaper && pivector && online && satAdmissions, 'seeded units are there');
  assert.ok(await db('pipelines').where({ company_id: satnpaper.id }).first(), 'run the CRM seed first');

  const users = new Map((await db('users').select('id', 'email')).map((u) => [u.email, u.id]));
  const as = async (email) => {
    const id = users.get(email);
    assert.ok(id, `${email} is seeded`);
    return { auth: { user: { id } }, access: await loadAccess(id, registry), app: { locals: { registry } } };
  };
  const owner = await as('owner@phoenix.test');
  const ritika = await as('ritika@phoenix.test');
  const kabir = await as('kabir@phoenix.test');
  const pvAdmin = await as('admin.pivector@phoenix.test');

  const dealsFor = async (req, unitId) => {
    const scope = await listScope(req, 'deals.view', { unitId });
    return applyListScope(db('deals'), scope).whereNull('archived_at').select('id', 'owner_user_id', 'unit_id', 'company_id');
  };

  await t.test('a counsellor sees only her own deals; her manager sees the whole branch', async () => {
    const mine = await dealsFor(ritika, satnpaper.id);
    assert.ok(mine.length > 0);
    assert.ok(mine.every((d) => d.owner_user_id === users.get('ritika@phoenix.test')));

    const branch = await dealsFor(kabir, online.id);
    const onlineUnits = new Set(units.filter((u) => u.path.startsWith(online.path)).map((u) => u.id));
    assert.ok(branch.length > mine.length);
    assert.ok(branch.every((d) => onlineUnits.has(d.unit_id)));
    assert.ok(branch.some((d) => d.owner_user_id !== users.get('kabir@phoenix.test')), 'kabir sees colleagues’ deals');

    const everything = await dealsFor(owner, group.id);
    assert.equal(new Set(everything.map((d) => d.company_id)).size, 3, 'the owner sees all three companies');
  });

  await t.test("other companies' records are 404", async () => {
    const spDeal = await db('deals').where({ company_id: satnpaper.id }).first();
    await assert.rejects(loadVisible(pvAdmin, { table: 'deals', id: spDeal.id, permission: 'deals.view', notFound: 'Deal' }), { status: 404 });
    await assert.rejects(listScope(pvAdmin, 'deals.view', { unitId: satnpaper.id }), { status: 404 });
    const { level } = await loadVisible(owner, { table: 'deals', id: spDeal.id, permission: 'deals.view' });
    assert.equal(level, 'all');

    const spOnly = await db('contacts as c')
      .whereExists(db('contact_companies as l').whereRaw('l.contact_id = c.id').where('l.company_id', satnpaper.id))
      .whereNotExists(db('contact_companies as l').whereRaw('l.contact_id = c.id').whereNot('l.company_id', satnpaper.id))
      .whereNotExists(db('deal_contacts as dc').join('deals as d', 'd.id', 'dc.deal_id').whereRaw('dc.contact_id = c.id').whereNot('d.company_id', satnpaper.id))
      .first('c.id');
    await assert.rejects(loadVisibleContact(pvAdmin, spOnly.id), { status: 404 });
  });

  await t.test('counsellors see the contacts of their team, with personal details', async () => {
    const link = await db('contact_companies').where({ unit_id: satAdmissions.id }).whereNot('owner_user_id', users.get('ritika@phoenix.test')).first();
    const seen = await loadVisibleContact(ritika, link.contact_id);
    assert.equal(seen.canView, true);
    assert.equal(seen.canViewPii, true);
    assert.equal(seen.canMerge, false);
  });

  await t.test('configuration lists cover the right companies', async () => {
    const all = await companiesInScope(owner, group.id, 'pipelines.view');
    assert.deepEqual(all.map((c) => c.code).sort(), ['excel', 'pi-vector', 'satnpaper']);
    const fromTeam = await companiesInScope(ritika, satAdmissions.id, 'pipelines.view');
    assert.deepEqual(fromTeam.map((c) => c.code), ['satnpaper']);
    const fromGroup = await companiesInScope(ritika, group.id, 'pipelines.view');
    assert.deepEqual(fromGroup.map((c) => c.code), ['satnpaper']);
  });

  await t.test('owner pickers list people who can work there', async () => {
    const people = await usersWithPermissionAt(satAdmissions, 'deals.manage');
    const emails = new Set(people.map((p) => [...users.entries()].find(([, id]) => id === p.id)?.[0]));
    assert.ok(emails.has('ritika@phoenix.test') && emails.has('kabir@phoenix.test'));
    assert.ok(!emails.has('admin.pivector@phoenix.test'));
    assert.equal(people.find((p) => p.id === users.get('kabir@phoenix.test')).level, 'all');
  });

  await t.test('findOrCreateContact de-duplicates across the group and links companies', async () => {
    await inRollback(async (trx) => {
      const phone = fakePhone();
      const base = { groupId: group.id, companyId: satnpaper.id, unitId: satAdmissions.id };
      const first = await findOrCreateContact(trx, { ...base, kind: 'parent', fullName: `Meera Test ${RUN}`, phones: [phone], emails: [`meera.${RUN}@example.com`] });
      assert.equal(first.created, true);
      assert.equal(first.contact.primary_phone, `+91${phone.slice(1)}`);

      const again = await findOrCreateContact(trx, { ...base, kind: 'parent', fullName: `Meera Test ${RUN}`, phones: [`+91 ${phone.slice(1, 6)} ${phone.slice(6)}`] });
      assert.equal(again.created, false);
      assert.equal(again.matchedBy, 'phone');
      assert.equal(again.contact.id, first.contact.id);
      assert.equal(again.linkCreated, false);

      const child = await findOrCreateContact(trx, { ...base, kind: 'student', fullName: `Arjun Test ${RUN}`, phones: [phone] });
      assert.equal(child.created, true, 'a student sharing the parent’s number is a different person');

      const elsewhere = await findOrCreateContact(trx, { groupId: group.id, companyId: pivector.id, unitId: pivector.id, emails: [`MEERA.${RUN}@example.com`] });
      assert.equal(elsewhere.contact.id, first.contact.id);
      assert.equal(elsewhere.matchedBy, 'email');
      assert.equal(elsewhere.linkCreated, true);

      const links = await trx('contact_companies').where({ contact_id: first.contact.id }).pluck('company_id');
      assert.deepEqual(links.sort(), [pivector.id, satnpaper.id].sort());
      const entries = await trx('timeline_events').where({ contact_id: first.contact.id }).pluck('title');
      assert.deepEqual(entries.sort(), ['Contact added', 'Contact added to this company']);
      const doc = await trx('search_documents').where({ entity_type: 'contact', entity_id: first.contact.id }).first();
      assert.ok(doc.keywords.includes(phone.slice(1)));
      const events = await trx('outbox_events').where({ aggregate_id: first.contact.id }).pluck('type');
      assert.deepEqual(events.sort(), ['contact.company_linked', 'contact.created']);

      await assert.rejects(findOrCreateContact(trx, { ...base, phones: ['not a phone'] }), { status: 422 });
    });
  });

  await t.test('addTimelineEvent is idempotent and records the first reply', async () => {
    await inRollback(async (trx) => {
      const deal = await trx('deals').where({ company_id: satnpaper.id, status: 'open' }).whereNull('first_replied_at').whereNotNull('first_reply_due_at').first();
      assert.ok(deal, 'the seed has an open deal waiting for a first reply');
      const entry = {
        groupId: deal.group_id,
        companyId: deal.company_id,
        unitId: deal.unit_id,
        dealId: deal.id,
        kind: 'message',
        channel: 'whatsapp',
        direction: 'outbound',
        body: 'Hello! Sharing the batch details.',
        actorType: 'user',
        actorUserId: users.get('ritika@phoenix.test'),
        sourceEventId: `test:${RUN}`,
      };
      const first = await addTimelineEvent(trx, entry);
      const second = await addTimelineEvent(trx, entry);
      assert.equal(first.created, true);
      assert.equal(second.created, false);
      assert.equal(String(second.entry.id), String(first.entry.id));
      const after = await trx('deals').where({ id: deal.id }).first();
      assert.ok(after.first_replied_at);
      assert.ok(new Date(after.last_activity_at) >= new Date(first.entry.occurred_at));
      const events = await trx('outbox_events').where({ aggregate_id: deal.id, type: 'deal.first_replied' }).count('* as n');
      assert.equal(Number(events[0].n), 1);
    });
  });

  await t.test('search documents follow archiving', async () => {
    await inRollback(async (trx) => {
      const deal = await trx('deals').whereNull('archived_at').first();
      await trx('deals').where({ id: deal.id }).update({ archived_at: trx.fn.now() });
      assert.deepEqual(await refreshSearchDocument(trx, 'deal', deal.id), { upserted: 0, removed: 1 });
      assert.equal(await trx('search_documents').where({ entity_type: 'deal', entity_id: deal.id }).first(), undefined);
    });
  });

  await t.test('consent records decide whether a company may message someone', async () => {
    const withdrawn = await db('consents').where({ status: 'withdrawn', channel: 'whatsapp', purpose: 'marketing' }).first();
    if (!withdrawn) return;
    const result = await canContact({ contactId: withdrawn.contact_id, companyId: withdrawn.company_id, channel: 'whatsapp', purpose: 'marketing' });
    assert.equal(result.allowed, false);
  });
});
