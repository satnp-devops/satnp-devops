import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { env } from '../../src/config/env.js';
import { db } from '../../src/lib/db.js';
import { redis } from '../../src/lib/redis.js';
import { bumpAccessVersion } from '../../src/core/access.js';
import { dispatchEvent } from '../../src/core/events.js';
import { closeQueues } from '../../src/core/queue.js';
import { addTimelineEvent } from '../../src/core/crm/timeline.js';
import { createApp } from '../../src/app.js';
import { buildRegistry } from '../../src/registry.js';
import { modules } from '../../src/modules/index.js';
import { archiveTimeline } from '../../src/modules/timeline/archive.js';

// Timeline API against the seeded database (02_crm.js), as different seeded people:
// cross-company visibility on person and institute timelines, note permissions, pins, PII
// masking, idempotent sweep handlers and archive reads.
//   npm run db:migrate && npm run db:seed && INTEGRATION=1 npm test

const enabled = process.env.INTEGRATION === '1';
const RUN = Date.now().toString(36);

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

test('Timeline API', { skip: !enabled && 'set INTEGRATION=1 to run' }, async (t) => {
  const registry = buildRegistry();
  const app = createApp({ registry, modules });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const created = []; // timeline entry ids written by this run, removed at the end
  let analystAssignmentId = null;

  t.after(async () => {
    if (created.length) {
      await db('timeline_events').whereIn('id', created).del();
      await db('timeline_events_archive').whereIn('id', created).del();
    }
    if (analystAssignmentId) {
      await db('role_assignments').where({ id: analystAssignmentId }).del();
      await bumpAccessVersion();
    }
    server.close();
    await closeQueues();
    await db.destroy();
    await redis.quit();
  });

  const limits = await redis.keys('rl:*');
  if (limits.length) await redis.del(...limits);

  const group = await db('org_units').whereNull('parent_id').where({ code: 'phoenix' }).first();
  const units = await db('org_units').where({ root_id: group.id });
  const byCode = (code) => units.find((u) => u.code === code);
  const satnpaper = byCode('satnpaper');
  const pivector = byCode('pi-vector');
  assert.ok(satnpaper && pivector, 'seeded companies are there');
  assert.ok(await db('pipelines').where({ company_id: satnpaper.id }).first(), 'run the CRM seed first');
  const users = new Map((await db('users').select('id', 'email')).map((u) => [u.email, u.id]));
  const ritikaId = users.get('ritika@phoenix.test');

  const people = {};
  for (const [name, email] of [
    ['owner', 'owner@phoenix.test'],
    ['ritika', 'ritika@phoenix.test'],
    ['kabir', 'kabir@phoenix.test'],
    ['pvAdmin', 'admin.pivector@phoenix.test'],
    ['spAdmin', 'admin.satnpaper@phoenix.test'],
    ['sales', 'sales.satnpaper@phoenix.test'],
  ]) {
    people[name] = client(base);
    const login = await people[name]('POST', '/auth/login', { email, password: env.SEED_PASSWORD });
    assert.equal(login.status, 200, `${email} signs in`);
  }
  const { owner, ritika, kabir, pvAdmin, spAdmin, sales } = people;

  const ritikaDeal = await db('deals').where({ owner_user_id: ritikaId, company_id: satnpaper.id }).whereNull('archived_at').orderBy('created_at').first();
  const kabirDeal = await db('deals').where({ owner_user_id: users.get('kabir@phoenix.test'), company_id: satnpaper.id }).whereNull('archived_at').first();
  assert.ok(ritikaDeal && kabirDeal, 'seeded deals for ritika and kabir');

  const note = async (who, subject, body = `Note ${RUN}`, extra = {}) => {
    const res = await who('POST', '/timeline', { ...subject, kind: 'note', body, ...extra });
    if (res.status === 201) created.push(res.body.data.id);
    return res;
  };

  await t.test('kinds and subject validation', async () => {
    const kinds = await ritika('GET', '/timeline/kinds');
    assert.equal(kinds.status, 200);
    assert.ok(kinds.body.data.some((kind) => kind.key === 'note'));
    assert.equal((await owner('GET', '/timeline')).status, 422);
    assert.equal((await owner('GET', `/timeline?dealId=${ritikaDeal.id}&contactId=${ritikaDeal.primary_contact_id}`)).status, 422);
    assert.equal((await owner('GET', `/timeline?dealId=${ritikaDeal.id}&cursor=not-a-cursor`)).status, 400);
  });

  await t.test('a deal timeline is newest first with a keyset cursor', async () => {
    const first = await owner('GET', `/timeline?dealId=${ritikaDeal.id}&limit=2`);
    assert.equal(first.status, 200);
    assert.equal(first.body.data.length, 2);
    assert.ok(first.body.nextCursor, 'seeded deals have more than two entries');
    const second = await owner('GET', `/timeline?dealId=${ritikaDeal.id}&limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    assert.equal(second.status, 200);
    const all = [...first.body.data, ...second.body.data];
    assert.equal(new Set(all.map((e) => e.id)).size, all.length, 'pages do not overlap');
    for (let i = 1; i < all.length; i += 1) {
      const [a, b] = [all[i - 1], all[i]];
      assert.ok(a.occurredAt > b.occurredAt || (a.occurredAt === b.occurredAt && BigInt(a.id) > BigInt(b.id)), 'ordered by occurred_at desc, id desc');
    }
    assert.ok(all.every((e) => e.dealId === ritikaDeal.id));
    const onlyNotes = await owner('GET', `/timeline?dealId=${ritikaDeal.id}&kind=stage_change,system`);
    assert.ok(onlyNotes.body.data.every((e) => ['stage_change', 'system'].includes(e.kind)));
  });

  await t.test('deal timelines follow deal visibility (own deals for counsellors, 404 across companies)', async () => {
    assert.equal((await ritika('GET', `/timeline?dealId=${ritikaDeal.id}`)).status, 200);
    assert.equal((await ritika('GET', `/timeline?dealId=${kabirDeal.id}`)).status, 404);
    assert.equal((await kabir('GET', `/timeline?dealId=${ritikaDeal.id}`)).status, 200);
    assert.equal((await pvAdmin('GET', `/timeline?dealId=${ritikaDeal.id}`)).status, 404);
    assert.equal((await pvAdmin('POST', '/timeline', { dealId: ritikaDeal.id, kind: 'note', body: 'x' })).status, 404);
  });

  await t.test('person timelines only show entries of companies the viewer can see', async () => {
    const shared = await db('contacts as c')
      .whereExists(db('contact_companies as a').whereRaw('a.contact_id = c.id').where('a.company_id', satnpaper.id).select(db.raw('1')))
      .whereExists(db('contact_companies as b').whereRaw('b.contact_id = c.id').where('b.company_id', pivector.id).select(db.raw('1')))
      .whereNull('c.merged_into_id')
      .first('c.id');
    assert.ok(shared, 'a seeded person is known to SatnPaper and Pi Vector');
    const subject = { contactId: shared.id };

    // The owner works across companies, so a note needs its company.
    assert.equal((await note(owner, subject)).status, 422);
    const spNote = await note(owner, subject, `SatnPaper note ${RUN}`, { companyId: satnpaper.id });
    const pvNote = await note(owner, subject, `Pi Vector note ${RUN}`, { companyId: pivector.id });
    assert.equal(spNote.status, 201, JSON.stringify(spNote.body));
    assert.equal(pvNote.status, 201);
    assert.equal(spNote.body.data.companyId, satnpaper.id);

    const ids = async (who) => {
      const res = await who('GET', `/timeline?contactId=${shared.id}&limit=100`);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      return res.body.data;
    };
    const ownerView = await ids(owner);
    assert.ok(ownerView.some((e) => e.id === spNote.body.data.id) && ownerView.some((e) => e.id === pvNote.body.data.id), 'group roles see all');
    const companies = new Set(ownerView.map((e) => e.companyId).filter(Boolean));
    assert.ok(companies.has(satnpaper.id) && companies.has(pivector.id));

    const pvView = await ids(pvAdmin);
    assert.ok(pvView.some((e) => e.id === pvNote.body.data.id));
    assert.ok(pvView.every((e) => e.companyId === null || e.companyId === pivector.id), 'Pi Vector sees nothing of SatnPaper');
    const spView = await ids(spAdmin);
    assert.ok(spView.some((e) => e.id === spNote.body.data.id));
    assert.ok(spView.every((e) => e.companyId === null || e.companyId === satnpaper.id), 'SatnPaper sees nothing of Pi Vector');
    // Deal entries on the person's timeline carry the deal ref.
    const onDeal = spView.find((e) => e.dealId);
    if (onDeal) assert.ok(onDeal.deal?.ref);

    // A Pi Vector admin can't touch the SatnPaper note (not visible: 404).
    assert.equal((await pvAdmin('DELETE', `/timeline/${spNote.body.data.id}`)).status, 404);
    assert.equal((await pvAdmin('POST', '/timeline', { ...subject, kind: 'note', body: 'x', companyId: satnpaper.id })).status, 422);
  });

  await t.test('institute timelines follow the same rule', async () => {
    const account = await db('account_companies').where({ company_id: satnpaper.id }).first('account_id');
    assert.ok(account);
    assert.equal((await owner('GET', `/timeline?accountId=${account.account_id}`)).status, 200);
    const linkedToPv = await db('account_companies').where({ account_id: account.account_id, company_id: pivector.id }).first();
    const dealWithPv = await db('deals').where({ account_id: account.account_id, company_id: pivector.id }).first();
    const pv = await pvAdmin('GET', `/timeline?accountId=${account.account_id}`);
    assert.equal(pv.status, linkedToPv || dealWithPv ? 200 : 404);
  });

  await t.test('notes: authors edit and delete their own, moderators delete others, system entries stay', async () => {
    const subject = { dealId: ritikaDeal.id };
    assert.equal((await ritika('POST', '/timeline', { ...subject, kind: 'note' })).status, 422, 'a note needs a body');
    const future = new Date(Date.now() + 3_600_000).toISOString();
    assert.equal((await ritika('POST', '/timeline', { ...subject, kind: 'note', body: 'x', occurredAt: future })).status, 422);

    const mine = await note(ritika, subject, `Ritika's note ${RUN}`);
    assert.equal(mine.status, 201);
    const entry = mine.body.data;
    assert.equal(entry.kind, 'note');
    assert.equal(entry.direction, 'internal');
    assert.equal(entry.actor.id, ritikaId);
    assert.equal(entry.contactId, ritikaDeal.primary_contact_id, 'deal entries carry the primary contact');
    assert.ok(entry.canEdit && entry.canDelete && entry.canPin);

    const edited = await ritika('PATCH', `/timeline/${entry.id}`, { body: `Edited ${RUN}` });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.data.body, `Edited ${RUN}`);
    assert.ok(edited.body.data.editedAt);
    assert.equal((await kabir('PATCH', `/timeline/${entry.id}`, { body: 'not mine' })).status, 403, 'only the author edits');
    assert.equal((await sales('PATCH', `/timeline/${entry.id}`, { body: 'x' })).status, 404, 'not visible to another team');

    const kabirView = await kabir('GET', `/timeline?dealId=${ritikaDeal.id}`);
    const seen = kabirView.body.data.find((e) => e.id === entry.id);
    assert.equal(seen.canEdit, false);
    assert.equal(seen.canDelete, true, 'a manager moderates');

    const system = kabirView.body.data.find((e) => e.kind === 'system' || e.kind === 'stage_change');
    assert.ok(system);
    assert.equal(system.canDelete, false);
    assert.equal((await owner('DELETE', `/timeline/${system.id}`)).status, 403, 'system entries cannot be deleted');
    assert.equal((await owner('PATCH', `/timeline/${system.id}`, { title: 'x' })).status, 403);

    assert.equal((await ritika('DELETE', `/timeline/${entry.id}`)).status, 204);
    const after = await ritika('GET', `/timeline?dealId=${ritikaDeal.id}&limit=100`);
    assert.ok(!after.body.data.some((e) => e.id === entry.id), 'deleted notes leave the list');
    assert.ok(await db('timeline_events').where({ id: entry.id }).whereNotNull('deleted_at').first(), 'soft delete');
    const audit = await db('audit_logs').where({ action: 'timeline.entry_deleted', entity_id: entry.id }).first();
    assert.ok(audit, 'deletes are audited');
    assert.ok(await db('outbox_events').where({ type: 'timeline.entry_added', aggregate_id: entry.id }).first(), 'event emitted');

    const other = await note(ritika, subject, `Another ${RUN}`);
    assert.equal((await kabir('DELETE', `/timeline/${other.body.data.id}`)).status, 204, 'moderators delete other notes');
  });

  await t.test('pins: at most five per record', async () => {
    const subject = { dealId: kabirDeal.id };
    const pinnedBefore = await db('timeline_events').where({ deal_id: kabirDeal.id }).whereNotNull('pinned_at').whereNull('deleted_at').count({ n: '*' });
    const room = 5 - Number(pinnedBefore[0].n);
    const entries = [];
    for (let i = 0; i <= room; i += 1) entries.push((await note(kabir, subject, `Pin ${i} ${RUN}`)).body.data);
    for (let i = 0; i < room; i += 1) assert.equal((await kabir('POST', `/timeline/${entries[i].id}/pin`)).status, 200);
    assert.equal((await kabir('POST', `/timeline/${entries[room].id}/pin`)).status, 409);
    const pinned = await kabir('GET', `/timeline?dealId=${kabirDeal.id}&pinned=true`);
    assert.equal(pinned.status, 200);
    assert.ok(pinned.body.data.every((e) => e.pinnedAt));
    assert.equal(pinned.body.nextCursor, null);
    if (room > 0) {
      const unpinned = await kabir('POST', `/timeline/${entries[0].id}/unpin`);
      assert.equal(unpinned.status, 200);
      assert.equal(unpinned.body.data.pinnedAt, null);
    }
    assert.equal((await ritika('POST', `/timeline/${entries[0].id}/pin`)).status, 404, "ritika can't see kabir's deal");
  });

  await t.test('logged calls count as the first reply and default to the phone channel', async () => {
    const res = await ritika('POST', '/timeline', { dealId: ritikaDeal.id, kind: 'call', title: 'Called back', meta: { durationSeconds: 120, outcome: 'connected' } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    created.push(res.body.data.id);
    assert.equal(res.body.data.channel, 'voice_call');
    assert.equal(res.body.data.direction, 'outbound');
    assert.equal((await ritika('POST', '/timeline', { dealId: ritikaDeal.id, kind: 'call', channel: 'carrier_pigeon' })).status, 422);
  });

  await t.test('phone numbers and emails in meta are masked without contacts.view_pii', async () => {
    const entry = await db.transaction(async (trx) => {
      const { entry: row } = await addTimelineEvent(trx, {
        groupId: kabirDeal.group_id,
        companyId: kabirDeal.company_id,
        unitId: kabirDeal.unit_id,
        dealId: kabirDeal.id,
        kind: 'message',
        channel: 'whatsapp',
        direction: 'inbound',
        body: 'Hello',
        meta: { from: '+919000012345', email: 'parent@example.com' },
        actorType: 'contact',
        touchDeal: false,
      });
      return row;
    });
    created.push(String(entry.id));
    const visible = await owner('GET', `/timeline?dealId=${kabirDeal.id}&limit=100`);
    assert.equal(visible.body.data.find((e) => e.id === String(entry.id)).meta.from, '+919000012345');

    // A temporary analyst role at SatnPaper for the account executive: deals.view everywhere, no PII.
    const analyst = await db('roles').where({ key: 'analyst' }).first();
    const [assignment] = await db('role_assignments')
      .insert({ user_id: users.get('sales.satnpaper@phoenix.test'), role_id: analyst.id, org_unit_id: satnpaper.id })
      .returning('id');
    analystAssignmentId = assignment.id;
    await bumpAccessVersion();
    const masked = await sales('GET', `/timeline?dealId=${kabirDeal.id}&limit=100`);
    assert.equal(masked.status, 200);
    const seen = masked.body.data.find((e) => e.id === String(entry.id));
    assert.notEqual(seen.meta.from, '+919000012345');
    assert.match(seen.meta.from, /•/);
    assert.match(seen.meta.email, /^p•••@example\.com$/);
    assert.equal(seen.canDelete, false, 'inbound messages cannot be deleted');
    await db('role_assignments').where({ id: analystAssignmentId }).del();
    analystAssignmentId = null;
    await bumpAccessVersion();
  });

  await t.test('sweep handlers write one entry per event, however often the job runs', async () => {
    const event = {
      id: randomUUID(),
      type: 'deal.sla_breached',
      groupId: ritikaDeal.group_id,
      unitId: ritikaDeal.unit_id,
      aggregateType: 'deal',
      aggregateId: ritikaDeal.id,
      payload: { dealId: ritikaDeal.id, companyId: ritikaDeal.company_id, unitId: ritikaDeal.unit_id, stageId: ritikaDeal.stage_id, dueAt: new Date(Date.now() - 60_000).toISOString(), ownerUserId: ritikaId },
      occurredAt: new Date().toISOString(),
    };
    const before = await db('deals').where({ id: ritikaDeal.id }).first('last_activity_at');
    assert.ok(
      registry.eventHandlers.get(event.type)?.some((handler) => handler.module === 'timeline'),
      'the timeline module handles it',
    );
    await dispatchEvent(registry, event, { db, registry });
    await dispatchEvent(registry, event, { db, registry });
    const rows = await db('timeline_events').where({ source_event_id: `event:${event.id}` });
    assert.equal(rows.length, 1);
    created.push(String(rows[0].id));
    assert.equal(rows[0].title, 'Stage SLA missed');
    assert.equal(rows[0].meta.action, 'deal.sla_breached');
    assert.equal(rows[0].contact_id, ritikaDeal.primary_contact_id);
    const after = await db('deals').where({ id: ritikaDeal.id }).first('last_activity_at');
    assert.equal(String(after.last_activity_at), String(before.last_activity_at), 'a missed SLA is not activity');

    const overdue = { ...event, id: randomUUID(), type: 'deal.first_reply_overdue', payload: { ...event.payload, channel: 'whatsapp' } };
    await dispatchEvent(registry, overdue, { db, registry });
    await dispatchEvent(registry, overdue, { db, registry });
    const overdueRows = await db('timeline_events').where({ source_event_id: `event:${overdue.id}` });
    assert.equal(overdueRows.length, 1);
    created.push(String(overdueRows[0].id));
    assert.equal(overdueRows[0].title, 'First reply overdue');
  });

  await t.test('archived entries leave the hot table and come back with includeArchive', async () => {
    const old = await db.transaction(async (trx) =>
      (
        await addTimelineEvent(trx, {
          groupId: ritikaDeal.group_id,
          companyId: ritikaDeal.company_id,
          unitId: ritikaDeal.unit_id,
          dealId: ritikaDeal.id,
          kind: 'note',
          direction: 'internal',
          body: `Old note ${RUN}`,
          actorType: 'user',
          actorUserId: ritikaId,
          occurredAt: new Date('2001-01-01T10:00:00Z'),
          touchDeal: false,
        })
      ).entry,
    );
    const id = String(old.id);
    created.push(id);
    const moved = await archiveTimeline(db, { before: new Date('2001-01-02T00:00:00Z'), groupId: ritikaDeal.group_id, batchSize: 100 });
    assert.ok(moved >= 1);
    assert.equal(await db('timeline_events').where({ id }).first(), undefined);
    assert.ok(await db('timeline_events_archive').where({ id }).first());

    const hot = await ritika('GET', `/timeline?dealId=${ritikaDeal.id}&limit=100`);
    assert.ok(!hot.body.data.some((e) => e.id === id));
    let cursor = null;
    let found = null;
    for (let page = 0; page < 20 && !found; page += 1) {
      const res = await ritika('GET', `/timeline?dealId=${ritikaDeal.id}&includeArchive=true&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      found = res.body.data.find((e) => e.id === id);
      cursor = res.body.nextCursor;
      if (!cursor) break;
    }
    assert.ok(found, 'the archived note is read back');
    assert.equal(found.archived, true);
    assert.equal(found.canEdit, false);
    assert.equal((await ritika('PATCH', `/timeline/${id}`, { body: 'x' })).status, 404, 'archived entries are read-only');
  });
});
