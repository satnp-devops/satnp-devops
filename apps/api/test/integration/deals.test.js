import { test } from 'node:test';
import assert from 'node:assert/strict';
import { env } from '../../src/config/env.js';
import { db } from '../../src/lib/db.js';
import { redis } from '../../src/lib/redis.js';
import { bumpAccessVersion } from '../../src/core/access.js';
import { closeQueues } from '../../src/core/queue.js';
import { createApp } from '../../src/app.js';
import { buildRegistry } from '../../src/registry.js';
import { modules } from '../../src/modules/index.js';
import { sweepSlaBreaches } from '../../src/modules/deals/sla.js';

// The deals module end to end against the seeded database (02_crm.js): list filters, sorts and
// cursors, scoping as different seeded people, stage rules, lost and reopen, assignment, bulk
// results, saved views and PII masking. Leads made here get unique phone numbers and a run tag,
// and are archived at the end.
//   npm run db:migrate && npm run db:seed && INTEGRATION=1 npm test

const enabled = process.env.INTEGRATION === '1';
const RUN = Date.now().toString(36);
const TAG = `it-${RUN}`;
// Numbers in the fake range that no seeded person has: +91 90008 xxxxx.
let phoneSeq = Math.floor(Math.random() * 50_000);
const fakePhone = () => `+9190008${String((phoneSeq += 7) % 100_000).padStart(5, '0')}`;

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

const qs = (params) => new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined)).toString();

test('Deals and the Leads list', { skip: !enabled && 'set INTEGRATION=1 to run' }, async (t) => {
  const app = createApp({ registry: buildRegistry(), modules });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const created = [];
  let analystAssignmentId = null;

  t.after(async () => {
    if (analystAssignmentId) {
      await db('role_assignments').where({ id: analystAssignmentId }).delete();
      await bumpAccessVersion();
    }
    if (created.length) {
      // Keep the shared lists clean for the next run: archive what this run made.
      await db('deals').whereIn('id', created).whereNull('archived_at').update({ archived_at: new Date() });
      await db('search_documents').where({ entity_type: 'deal' }).whereIn('entity_id', created).delete();
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
  const unit = (code) => units.find((u) => u.code === code);
  const satnpaper = unit('satnpaper');
  const pivector = unit('pi-vector');
  const online = unit('online');
  const satAdmissions = unit('sat-admissions');
  assert.ok(satnpaper && pivector && online && satAdmissions, 'seeded units are there');
  const pipeline = await db('pipelines').where({ company_id: satnpaper.id, kind: 'b2c', is_default: true }).first();
  assert.ok(pipeline, 'run the CRM seed first');
  const stages = await db('pipeline_stages').where({ pipeline_id: pipeline.id }).orderBy('position');
  const stage = (key) => stages.find((s) => s.key === key);
  const productLine = await db('product_lines').where({ company_id: satnpaper.id, audience: 'b2c', active: true }).orderBy('position').first();
  const product = await db('products').where({ product_line_id: productLine.id, active: true }).first();
  const lostReason = await db('lost_reasons').where({ company_id: satnpaper.id, kind: 'b2c', requires_note: false, active: true }).first();
  const users = new Map((await db('users').select('id', 'email')).map((u) => [u.email, u.id]));
  const ritikaId = users.get('ritika@phoenix.test');
  const kabirId = users.get('kabir@phoenix.test');

  const sessions = {};
  for (const [name, email] of [
    ['owner', 'owner@phoenix.test'],
    ['ritika', 'ritika@phoenix.test'],
    ['kabir', 'kabir@phoenix.test'],
    ['pvAdmin', 'admin.pivector@phoenix.test'],
  ]) {
    sessions[name] = client(base);
    const login = await sessions[name]('POST', '/auth/login', { email, password: env.SEED_PASSWORD });
    assert.equal(login.status, 200, `${email} signs in`);
  }
  const { owner, ritika, kabir, pvAdmin } = sessions;

  const newLead = async (as, overrides = {}) => {
    const res = await as('POST', '/deals', {
      unitId: satAdmissions.id,
      kind: 'b2c',
      contact: { firstName: 'Meera', lastName: `Test${RUN}`, phones: [fakePhone()] },
      tags: [TAG],
      ...overrides,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    created.push(res.body.data.id);
    return res.body.data;
  };

  await t.test('the list pages through every deal once, for every sort', async () => {
    const expected = Number(
      (await db('deals').where({ company_id: satnpaper.id }).whereNull('archived_at').count({ n: '*' }))[0].n,
    );
    const seen = new Set();
    let cursor;
    do {
      const page = await owner('GET', `/deals?${qs({ unitId: satnpaper.id, limit: 100, cursor })}`);
      assert.equal(page.status, 200);
      for (const deal of page.body.data) {
        assert.ok(!seen.has(deal.id), 'no deal twice');
        seen.add(deal.id);
      }
      cursor = page.body.nextCursor ?? undefined;
    } while (cursor);
    assert.equal(seen.size, expected);

    const value = (deal, key) =>
      ({
        updatedAt: deal.updatedAt,
        createdAt: deal.createdAt,
        lastActivityAt: deal.lastActivityAt,
        value: deal.value.valueMinor,
        slaDueAt: deal.slaDueAt ?? '9999',
        expectedCloseOn: deal.expectedCloseOn ?? '9999',
        stageEnteredAt: deal.stageEnteredAt,
        title: deal.title.toLowerCase(),
      })[key];
    for (const sort of ['-createdAt', 'value', '-value', 'slaDueAt', 'expectedCloseOn', 'title', '-title', 'stageEnteredAt']) {
      const first = await owner('GET', `/deals?${qs({ unitId: satnpaper.id, limit: 15, sort, status: 'open' })}`);
      assert.equal(first.status, 200, sort);
      assert.ok(first.body.nextCursor, `${sort} has a second page`);
      const second = await owner('GET', `/deals?${qs({ unitId: satnpaper.id, limit: 15, sort, status: 'open', cursor: first.body.nextCursor })}`);
      const rows = [...first.body.data, ...second.body.data];
      assert.equal(new Set(rows.map((d) => d.id)).size, rows.length, `${sort}: pages don't overlap`);
      const key = sort.replace('-', '');
      const desc = sort.startsWith('-');
      for (let i = 1; i < rows.length; i += 1) {
        const a = value(rows[i - 1], key);
        const b = value(rows[i], key);
        if (key === 'title') continue; // collation order is the database's; overlap and count are what matter
        assert.ok(desc ? a >= b : a <= b, `${sort} is ordered (${a} / ${b})`);
      }
    }
  });

  await t.test('filters run on the server', async () => {
    const list = async (params) => {
      const res = await owner('GET', `/deals?${qs({ unitId: satnpaper.id, limit: 100, ...params })}`);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      return res.body.data;
    };
    const whatsapp = await list({ channel: 'whatsapp', status: 'open' });
    assert.ok(whatsapp.length > 0);
    assert.ok(whatsapp.every((d) => d.channel === 'whatsapp' && d.status === 'open'));
    const mine = await list({ owner: 'me' });
    assert.equal(mine.length, 0, 'the group owner owns no SatnPaper deal');
    const ritikas = await list({ owner: ritikaId });
    assert.ok(ritikas.length > 0 && ritikas.every((d) => d.owner?.id === ritikaId));
    const atStage = await list({ stageId: stage('contacted').id });
    assert.ok(atStage.every((d) => d.stage.key === 'contacted'));
    const byLine = await list({ productLineId: productLine.id });
    assert.ok(byLine.every((d) => d.productLine?.id === productLine.id));
    const breached = await list({ sla: 'breached' });
    assert.ok(breached.length > 0);
    assert.ok(breached.every((d) => d.slaBreached || d.firstReplyOverdue));
    const stageBreached = await list({ slaBreached: 'true' });
    assert.ok(stageBreached.every((d) => d.slaBreached));
    const dueSoon = await list({ sla: 'due_soon' });
    assert.ok(dueSoon.every((d) => !d.slaBreached && !d.firstReplyOverdue && d.status === 'open'));
    const since = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const recent = await list({ createdFrom: since });
    assert.ok(recent.every((d) => d.createdAt >= since));
    const updatedRecently = await list({ updatedFrom: since });
    assert.ok(updatedRecently.every((d) => d.updatedAt >= since));
    const campaign = await db('deals').where({ company_id: satnpaper.id }).whereNull('archived_at').whereRaw("first_touch->>'campaign' is not null").first();
    if (campaign) {
      const byCampaign = await list({ campaign: campaign.first_touch.campaign });
      assert.ok(byCampaign.some((d) => d.id === campaign.id));
    }
    const sample = whatsapp[0];
    const byRef = await list({ q: sample.ref.toLowerCase() });
    assert.deepEqual(byRef.map((d) => d.id), [sample.id]);
    const surname = sample.primaryContact?.lastName;
    if (surname) assert.ok((await list({ q: surname })).some((d) => d.id === sample.id), 'q matches a participant name');

    assert.equal((await owner('GET', `/deals?${qs({ unitId: satnpaper.id, channel: 'carrier_pigeon' })}`)).status, 422);
    assert.equal((await owner('GET', `/deals?${qs({ unitId: satnpaper.id, cursor: 'not-a-cursor' })}`)).status, 400);
    assert.equal((await owner('GET', `/deals?${qs({ unitId: satnpaper.id, bogus: '1' })}`)).status, 422);
  });

  let lead;
  await t.test('a counsellor adds a lead by hand; the person is de-duplicated', async () => {
    const phone = fakePhone();
    lead = await newLead(ritika, { contact: { firstName: 'Anita', lastName: `Rao${RUN}`, phones: [phone] }, channel: 'whatsapp' });
    assert.match(lead.ref, /^SP-\d+$/);
    assert.equal(lead.owner.id, ritikaId);
    assert.equal(lead.stage.key, stage('new_enquiry').key);
    assert.equal(lead.status, 'open');
    assert.equal(lead.isNew, false, 'the creator owns it and has seen it');
    assert.ok(lead.firstReplyDueAt, 'WhatsApp leads get a first-reply target');
    assert.ok(lead.slaDueAt, 'the first stage has an SLA');
    assert.equal(lead.primaryContact.primaryPhone, phone);
    assert.equal(lead.title, `Anita Rao${RUN} – Enquiry`);

    const audit = await db('audit_logs').where({ entity_type: 'deal', entity_id: lead.id, action: 'deal.created' }).first();
    assert.ok(audit, 'audited');
    const event = await db('outbox_events').where({ type: 'deal.created', aggregate_id: lead.id }).first();
    assert.equal(event.payload.channel, 'whatsapp');
    const entry = await db('timeline_events').where({ deal_id: lead.id, kind: 'system' }).first();
    assert.equal(entry.title, 'Lead created');
    const doc = await db('search_documents').where({ entity_type: 'deal', entity_id: lead.id }).first();
    assert.ok(doc.keywords.includes(lead.ref.toLowerCase()));

    // Same number again: the pre-check finds the person and the open lead.
    const check = await ritika('POST', '/deals/check-duplicates', { unitId: satAdmissions.id, kind: 'b2c', phones: [phone] });
    assert.equal(check.status, 200);
    assert.equal(check.body.data.contact.id, lead.primaryContact.id);
    assert.deepEqual(check.body.data.openDeals.map((d) => d.id), [lead.id]);

    // Pi Vector's admin can't learn anything about SatnPaper's lead.
    const elsewhere = await pvAdmin('POST', '/deals/check-duplicates', { unitId: pivector.id, kind: 'b2c', phones: [phone] });
    assert.equal(elsewhere.status, 200);
    assert.equal(elsewhere.body.data.contact, null);
    assert.equal(elsewhere.body.data.knownElsewhere, true);
    assert.deepEqual(elsewhere.body.data.openDeals, []);
    assert.equal(elsewhere.body.data.hiddenOpenDealCount, 0);

    // A second lead for the same number reuses the contact.
    const again = await newLead(ritika, { contact: { firstName: 'Anita', lastName: `Rao${RUN}`, phones: [phone] } });
    assert.equal(again.primaryContact.id, lead.primaryContact.id);

    // Counsellors add leads only for themselves.
    const forKabir = await ritika('POST', '/deals', { unitId: satAdmissions.id, kind: 'b2c', ownerUserId: kabirId, contact: { firstName: 'X', phones: [fakePhone()] } });
    assert.equal(forKabir.status, 403);
    const noPerson = await ritika('POST', '/deals', { unitId: satAdmissions.id, kind: 'b2c' });
    assert.equal(noPerson.status, 422);
  });

  await t.test('scoping: own deals, a manager’s branch, other companies are 404', async () => {
    const ritikaList = await ritika('GET', `/deals?${qs({ unitId: satnpaper.id, limit: 100 })}`);
    assert.equal(ritikaList.status, 200);
    assert.ok(ritikaList.body.data.length > 0);
    assert.ok(ritikaList.body.data.every((d) => d.owner?.id === ritikaId), 'counsellors see only their own deals');

    const kabirList = await kabir('GET', `/deals?${qs({ unitId: satnpaper.id, limit: 100 })}`);
    const onlineUnits = new Set(units.filter((u) => u.path.startsWith(online.path)).map((u) => u.id));
    assert.ok(kabirList.body.data.some((d) => d.owner?.id !== kabirId), 'a manager sees the team’s deals');
    assert.ok(kabirList.body.data.every((d) => onlineUnits.has(d.unit.id)), 'only SatnPaper › Online');

    const kabirsDeal = kabirList.body.data.find((d) => d.owner?.id === kabirId);
    assert.equal((await ritika('GET', `/deals/${kabirsDeal.id}`)).status, 404, 'another counsellor’s lead is 404');
    assert.equal((await pvAdmin('GET', `/deals/${lead.id}`)).status, 404, 'another company’s lead is 404');
    assert.equal((await pvAdmin('GET', `/deals?${qs({ unitId: satnpaper.id })}`)).status, 404, 'another company’s unit is 404');
    assert.equal((await pvAdmin('POST', `/deals/${lead.id}/move`, { stageId: stage('contacted').id })).status, 404);
    assert.equal((await pvAdmin('GET', `/deals/${lead.id}/stage-history`)).status, 404);

    const detail = await owner('GET', `/deals/${lead.id}`);
    assert.equal(detail.status, 200);
    assert.deepEqual(detail.body.data.can, { manage: true, assign: true, archive: true });
    const own = await ritika('GET', `/deals/${lead.id}`);
    assert.deepEqual(own.body.data.can, { manage: true, assign: false, archive: false });
  });

  await t.test('stage rules: required fields, allowed previous stages, stale moves', async () => {
    const blocked = await ritika('POST', `/deals/${lead.id}/move`, { stageId: stage('demo_booked').id });
    assert.equal(blocked.status, 422);
    assert.equal(blocked.body.error.code, 'stage_rules');
    assert.deepEqual(
      blocked.body.error.details.missing.map((m) => m.key),
      ['productLineId', 'students', 'custom.grade'],
    );

    // Filling some fields in the same request isn't enough without a student; nothing is saved.
    const partial = await ritika('POST', `/deals/${lead.id}/move`, {
      stageId: stage('demo_booked').id,
      fields: { productLineId: productLine.id, custom: { grade: 'class_11' } },
    });
    assert.equal(partial.status, 422);
    assert.deepEqual(partial.body.error.details.missing.map((m) => m.key), ['students']);
    const unchanged = await ritika('GET', `/deals/${lead.id}`);
    assert.equal(unchanged.body.data.productLine, null, 'the failed move rolled the fields back');

    const student = await ritika('POST', `/deals/${lead.id}/contacts`, { role: 'student', contact: { firstName: 'Ishaan', lastName: `Rao${RUN}` } });
    assert.equal(student.status, 201, JSON.stringify(student.body));
    assert.deepEqual(student.body.data.studentNames, [`Ishaan Rao${RUN}`]);

    const moved = await ritika('POST', `/deals/${lead.id}/move`, {
      stageId: stage('demo_booked').id,
      fromStageId: stage('new_enquiry').id,
      fields: { productLineId: productLine.id, custom: { grade: 'class_11' } },
    });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.body.data.stage.key, 'demo_booked');
    assert.equal(moved.body.data.custom.grade, 'class_11');
    assert.ok(moved.body.data.household, 'the parent and the student became a family');

    const stale = await ritika('POST', `/deals/${lead.id}/move`, { stageId: stage('demo_done').id, fromStageId: stage('new_enquiry').id });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'stage_changed');
    assert.equal(stale.body.error.details.currentStageId, stage('demo_booked').id);

    const notFrom = await ritika('POST', `/deals/${lead.id}/move`, { stageId: stage('enrolled').id, fields: { productId: product.id, valueMinor: 5_500_000 } });
    assert.equal(notFrom.status, 422);
    assert.equal(notFrom.body.error.code, 'stage_rules');
    assert.deepEqual(notFrom.body.error.details.allowedFrom, ['demo_done', 'fee_proposed']);

    const history = await ritika('GET', `/deals/${lead.id}/stage-history`);
    assert.equal(history.status, 200);
    assert.equal(history.body.data[0].toStage.key, 'demo_booked');
    assert.equal(history.body.data[0].fromStage.key, 'new_enquiry');
    assert.equal(history.body.data.at(-1).fromStage, null);
    const entry = await db('timeline_events').where({ deal_id: lead.id, kind: 'stage_change' }).first();
    assert.equal(entry.title, 'Moved to Demo booked');
    assert.equal((await db('outbox_events').where({ type: 'deal.stage_changed', aggregate_id: lead.id }).count({ n: '*' }))[0].n, '1');
  });

  await t.test('lost needs a reason and goes to nurture; reopening returns to the stage it left', async () => {
    const noReason = await ritika('POST', `/deals/${lead.id}/lose`, {});
    assert.equal(noReason.status, 422);
    const lost = await ritika('POST', `/deals/${lead.id}/lose`, { lostReasonId: lostReason.id, lostNote: 'Call again in March' });
    assert.equal(lost.status, 200, JSON.stringify(lost.body));
    assert.equal(lost.body.data.status, 'lost');
    assert.equal(lost.body.data.lostReason.id, lostReason.id);
    assert.equal(lost.body.data.nurture, true, 'deals.nurtureOnLost defaults to true');
    assert.ok(lost.body.data.closedAt);
    assert.equal(lost.body.data.slaDueAt, null);

    const recently = await ritika('POST', '/deals/check-duplicates', { unitId: satAdmissions.id, contactId: lead.primaryContact.id });
    assert.ok(recently.body.data.recentlyLost.some((d) => d.id === lead.id), 'the pre-check offers to reopen it');

    const reopened = await ritika('POST', `/deals/${lead.id}/reopen`, {});
    assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
    assert.equal(reopened.body.data.status, 'open');
    assert.equal(reopened.body.data.stage.key, 'demo_booked');
    assert.equal(reopened.body.data.lostReason, null);
    assert.equal(reopened.body.data.nurture, false);
    assert.equal(reopened.body.data.closedAt, null);
    assert.equal((await ritika('POST', `/deals/${lead.id}/reopen`, {})).status, 409, 'only won or lost leads reopen');
    const events = await db('outbox_events').where({ aggregate_id: lead.id }).whereIn('type', ['deal.lost', 'deal.reopened']).pluck('type');
    assert.deepEqual(events.sort(), ['deal.lost', 'deal.reopened']);
  });

  await t.test('assignment: managers assign, counsellors can’t, owners must work there', async () => {
    assert.equal((await ritika('POST', `/deals/${lead.id}/assign`, { ownerUserId: kabirId })).status, 403);
    const wrongPlace = await kabir('POST', `/deals/${lead.id}/assign`, { ownerUserId: users.get('admin.pivector@phoenix.test') });
    assert.equal(wrongPlace.status, 422);
    const toKabir = await kabir('POST', `/deals/${lead.id}/assign`, { ownerUserId: kabirId });
    assert.equal(toKabir.status, 200);
    assert.equal(toKabir.body.data.owner.id, kabirId);
    assert.equal((await ritika('GET', `/deals/${lead.id}`)).status, 404, 'no longer hers');
    const back = await kabir('POST', `/deals/${lead.id}/assign`, { ownerUserId: ritikaId });
    assert.equal(back.body.data.owner.id, ritikaId);
    assert.equal(back.body.data.isNew, true, 'the new owner hasn’t opened it yet');
    const seen = await ritika('POST', `/deals/${lead.id}/seen`);
    assert.equal(seen.status, 204);
    const after = await ritika('GET', `/deals/${lead.id}`);
    assert.equal(after.body.data.isNew, false);
    const entry = await db('timeline_events').where({ deal_id: lead.id, kind: 'system' }).orderBy('id', 'desc').first();
    assert.equal(entry.title, 'Assigned to Ritika Sharma');
  });

  await t.test('PATCH validates fields and records significant changes', async () => {
    const patched = await ritika('PATCH', `/deals/${lead.id}`, { valueMinor: 5_500_000, productId: product.id, title: `Renamed ${RUN}` });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.data.value.valueMinor, 5_500_000);
    assert.equal(patched.body.data.product.id, product.id);
    assert.equal(patched.body.data.productLine.id, productLine.id);
    assert.equal(patched.body.data.title, `Renamed ${RUN}`);
    const entry = await db('timeline_events').where({ deal_id: lead.id, kind: 'system' }).whereRaw("meta->>'action' = 'deal.updated'").orderBy('id', 'desc').first();
    assert.match(entry.title, /Value changed to/);
    const audit = await db('audit_logs').where({ entity_id: lead.id, action: 'deal.updated' }).orderBy('id', 'desc').first();
    assert.equal(audit.after.valueMinor, 5_500_000);

    const pvProduct = await db('products').where({ company_id: pivector.id }).first();
    const wrongCompany = await ritika('PATCH', `/deals/${lead.id}`, { productId: pvProduct.id });
    assert.equal(wrongCompany.status, 422);
    assert.equal(wrongCompany.body.error.details[0].path, 'body.productId');
    const badGrade = await ritika('PATCH', `/deals/${lead.id}`, { custom: { grade: 'class_99' } });
    assert.equal(badGrade.status, 422);
    const otherCompanyUnit = await ritika('PATCH', `/deals/${lead.id}`, { unitId: pivector.id });
    assert.equal(otherCompanyUnit.status, 422);
  });

  await t.test('bulk actions report per record, for ids and for a filter', async () => {
    const other = await newLead(ritika);
    const pvDeal = await db('deals').where({ company_id: pivector.id }).whereNull('archived_at').first();
    const tagged = await kabir('POST', '/deals/bulk', { action: 'addTags', ids: [lead.id, other.id, pvDeal.id], tags: [`${TAG}-b`] });
    assert.equal(tagged.status, 200, JSON.stringify(tagged.body));
    assert.deepEqual(tagged.body.data.updated, [lead.id, other.id]);
    assert.deepEqual(tagged.body.data.failed, [{ id: pvDeal.id, code: 'not_found', message: 'Lead not found' }]);
    const again = await kabir('POST', '/deals/bulk', { action: 'addTags', ids: [lead.id], tags: [`${TAG}-b`] });
    assert.deepEqual(again.body.data.unchanged, [lead.id]);

    // Move both to Fee proposed: one has a product and a value, the other doesn't.
    const moved = await kabir('POST', '/deals/bulk', { action: 'move', ids: [lead.id, other.id], stageId: stage('fee_proposed').id });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.deepEqual(moved.body.data.updated, [lead.id]);
    assert.equal(moved.body.data.failed.length, 1);
    assert.equal(moved.body.data.failed[0].id, other.id);
    assert.equal(moved.body.data.failed[0].code, 'stage_rules');
    assert.equal(moved.body.data.failed[0].message, 'Fill Product and Value to move to Fee proposed');
    const audit = await db('audit_logs').where({ entity_id: lead.id, action: 'deal.stage_changed' }).orderBy('id', 'desc').first();
    assert.deepEqual(audit.meta, { bulk: true });

    // By filter: every lead of this run's tag (and only those).
    const filter = { unitId: satnpaper.id, tag: [`${TAG}-b`] };
    const lostAll = await kabir('POST', '/deals/bulk', { action: 'lose', filter, lostReasonId: lostReason.id });
    assert.equal(lostAll.status, 200, JSON.stringify(lostAll.body));
    assert.equal(lostAll.body.data.total, 2);
    assert.deepEqual([...lostAll.body.data.updated].sort(), [lead.id, other.id].sort());
    const reasons = await db('deals').whereIn('id', [lead.id, other.id]).pluck('lost_reason_id');
    assert.ok(reasons.every((id) => id === lostReason.id));

    // Counsellors can't archive; managers can, and archived leads leave the list.
    const denied = await ritika('POST', '/deals/bulk', { action: 'archive', ids: [other.id] });
    assert.equal(denied.body.data.failed[0].code, 'forbidden');
    const archived = await kabir('POST', '/deals/bulk', { action: 'archive', ids: [other.id] });
    assert.deepEqual(archived.body.data.updated, [other.id]);
    const listed = await kabir('GET', `/deals?${qs({ unitId: satnpaper.id, tag: `${TAG}-b` })}`);
    assert.deepEqual(listed.body.data.map((d) => d.id), [lead.id]);
    const archivedList = await kabir('GET', `/deals?${qs({ unitId: satnpaper.id, tag: `${TAG}-b`, archived: 'true' })}`);
    assert.deepEqual(archivedList.body.data.map((d) => d.id), [other.id]);
    assert.equal((await ritika('GET', `/deals?${qs({ unitId: satnpaper.id, archived: 'true' })}`)).status, 403);
    const restored = await kabir('POST', `/deals/${other.id}/restore`);
    assert.equal(restored.status, 200);
    assert.equal(restored.body.data.archivedAt, null);

    const both = await kabir('POST', '/deals/bulk', { action: 'assign', ids: [lead.id], ownerUserId: kabirId, filter });
    assert.equal(both.status, 422, 'ids or filter, not both');
    const nothing = await owner('POST', '/deals/bulk', { action: 'setNurture', filter: { unitId: group.id, tag: [`${TAG}-none`] }, nurture: false });
    assert.deepEqual(nothing.body.data, { updated: [], unchanged: [], failed: [], total: 0 });
  });

  await t.test('saved views: personal, shared within the team, permissions', async () => {
    const personal = await ritika('POST', '/saved-views', { unitId: satAdmissions.id, name: `Mine ${RUN}`, filters: { owner: ['me'], sla: 'breached' }, sort: 'slaDueAt' });
    assert.equal(personal.status, 201, JSON.stringify(personal.body));
    assert.equal(personal.body.data.visibility, 'personal');
    assert.equal((await ritika('POST', '/saved-views', { unitId: satAdmissions.id, name: `Shared ${RUN}`, visibility: 'shared' })).status, 403);
    const shared = await kabir('POST', '/saved-views', { unitId: online.id, name: `Team ${RUN}`, visibility: 'shared', filters: { status: ['open'] } });
    assert.equal(shared.status, 201);

    const listed = await ritika('GET', `/saved-views?unitId=${satAdmissions.id}`);
    const names = listed.body.data.map((v) => v.name);
    assert.ok(names.includes(`Mine ${RUN}`) && names.includes(`Team ${RUN}`));
    assert.ok(names.indexOf(`Mine ${RUN}`) < names.indexOf(`Team ${RUN}`), 'personal views first');
    const teamView = listed.body.data.find((v) => v.name === `Team ${RUN}`);
    assert.equal(teamView.can.edit, false);
    assert.equal((await ritika('PATCH', `/saved-views/${teamView.id}`, { name: 'Hijacked' })).status, 403);
    assert.equal((await pvAdmin('PATCH', `/saved-views/${teamView.id}`, { name: 'Hijacked' })).status, 404);
    assert.equal((await pvAdmin('DELETE', `/saved-views/${personal.body.data.id}`)).status, 404);
    assert.equal((await ritika('PATCH', `/saved-views/${personal.body.data.id}`, { name: `Mine again ${RUN}` })).body.data.name, `Mine again ${RUN}`);
    assert.equal((await kabir('DELETE', `/saved-views/${teamView.id}`)).status, 204);
    assert.equal((await ritika('DELETE', `/saved-views/${personal.body.data.id}`)).status, 204);
  });

  await t.test('PII is masked for a viewer without contacts.view_pii', async () => {
    const analyst = await db('roles').whereNull('group_id').where({ key: 'analyst' }).first();
    const [assignment] = await db('role_assignments')
      .insert({ user_id: users.get('admin.pivector@phoenix.test'), role_id: analyst.id, org_unit_id: satnpaper.id })
      .returning('id');
    analystAssignmentId = assignment.id;
    await bumpAccessVersion();
    const detail = await pvAdmin('GET', `/deals/${lead.id}`);
    assert.equal(detail.status, 200, 'analysts read every deal');
    assert.equal(detail.body.data.primaryContact.piiMasked, true);
    assert.match(detail.body.data.primaryContact.primaryPhone, /•/);
    assert.deepEqual(detail.body.data.can, { manage: false, assign: false, archive: false });
    const listed = await pvAdmin('GET', `/deals?${qs({ unitId: satnpaper.id, tag: TAG, limit: 5 })}`);
    assert.ok(listed.body.data.every((d) => !d.primaryContact || d.primaryContact.piiMasked));
    assert.equal((await pvAdmin('POST', `/deals/${lead.id}/move`, { stageId: stage('contacted').id })).status, 403, 'visible but read-only');
    await db('role_assignments').where({ id: analystAssignmentId }).delete();
    analystAssignmentId = null;
    await bumpAccessVersion();
  });

  await t.test('the SLA sweep flags overdue leads once', async () => {
    const fresh = await newLead(ritika, { channel: 'whatsapp' });
    await db('deals').where({ id: fresh.id }).update({ sla_due_at: new Date(Date.now() - 60_000), first_reply_due_at: new Date(Date.now() - 60_000) });
    await sweepSlaBreaches({ db });
    const row = await db('deals').where({ id: fresh.id }).first();
    assert.ok(row.sla_breached_at && row.first_reply_breached_at);
    await sweepSlaBreaches({ db });
    const events = await db('outbox_events').where({ aggregate_id: fresh.id }).whereIn('type', ['deal.sla_breached', 'deal.first_reply_overdue']).pluck('type');
    assert.deepEqual(events.sort(), ['deal.first_reply_overdue', 'deal.sla_breached']);
  });
});
