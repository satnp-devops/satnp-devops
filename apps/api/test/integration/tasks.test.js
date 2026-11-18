import { test } from 'node:test';
import assert from 'node:assert/strict';
import { env } from '../../src/config/env.js';
import { db } from '../../src/lib/db.js';
import { redis } from '../../src/lib/redis.js';
import { closeQueues } from '../../src/core/queue.js';
import { createApp } from '../../src/app.js';
import { buildRegistry } from '../../src/registry.js';
import { modules } from '../../src/modules/index.js';
import { dayBounds, taskGroup } from '../../src/modules/tasks/dates.js';
import { processDueTaskReminders } from '../../src/modules/tasks/reminders.js';

// Tasks API against the seeded database (02_crm.js): own scope for counsellors, managers over
// their branch, 404 across companies, create/update/complete/reopen/cancel with audit, events and
// timeline entries, due groups in the viewer's time zone, and reminders.
//   npm run db:migrate && npm run db:seed && INTEGRATION=1 npm test

const enabled = process.env.INTEGRATION === '1';
const RUN = Date.now().toString(36);
const TZ = 'Asia/Kolkata';

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

test('Tasks API', { skip: !enabled && 'set INTEGRATION=1 to run' }, async (t) => {
  const app = createApp({ registry: buildRegistry(), modules });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const createdTasks = [];

  t.after(async () => {
    if (createdTasks.length) {
      await db('timeline_events').whereRaw("meta->>'taskId' = any(?)", [createdTasks]).del();
      await db('tasks').whereIn('id', createdTasks).del();
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
  const online = byCode('online');
  const satAdmissions = byCode('sat-admissions');
  assert.ok(satnpaper && pivector && online && satAdmissions);
  const users = new Map((await db('users').select('id', 'email')).map((u) => [u.email, u.id]));
  const ritikaId = users.get('ritika@phoenix.test');
  const kabirId = users.get('kabir@phoenix.test');

  const people = {};
  for (const [name, email] of [
    ['owner', 'owner@phoenix.test'],
    ['ritika', 'ritika@phoenix.test'],
    ['kabir', 'kabir@phoenix.test'],
    ['pvAdmin', 'admin.pivector@phoenix.test'],
    ['sales', 'sales.satnpaper@phoenix.test'],
  ]) {
    people[name] = client(base);
    assert.equal((await people[name]('POST', '/auth/login', { email, password: env.SEED_PASSWORD })).status, 200, `${email} signs in`);
  }
  const { owner, ritika, kabir, pvAdmin, sales } = people;

  const ritikaDeal = await db('deals').where({ owner_user_id: ritikaId, company_id: satnpaper.id }).whereNull('archived_at').first();
  const kabirDeal = await db('deals').where({ owner_user_id: kabirId, company_id: satnpaper.id }).whereNull('archived_at').first();
  const satTask = await db('tasks').where({ company_id: satnpaper.id }).whereNot({ assignee_user_id: ritikaId }).whereNot({ created_by: ritikaId }).first();
  assert.ok(ritikaDeal && kabirDeal && satTask, 'seeded deals and tasks');

  const create = async (who, body) => {
    const res = await who('POST', '/tasks', body);
    if (res.status === 201) createdTasks.push(res.body.data.id);
    return res;
  };

  await t.test('My tasks: a counsellor sees only her own tasks', async () => {
    const mine = await ritika('GET', `/tasks?unitId=${satnpaper.id}&limit=100`);
    assert.equal(mine.status, 200, JSON.stringify(mine.body));
    assert.ok(mine.body.data.length > 0, 'ritika has seeded tasks');
    assert.ok(mine.body.data.every((task) => task.assignee?.id === ritikaId && task.status === 'open'));
    const dues = mine.body.data.map((task) => task.dueAt ?? '9999');
    assert.deepEqual(dues, [...dues].sort(), 'sorted by due date, no date last');

    const kabirs = await ritika('GET', `/tasks?unitId=${satnpaper.id}&assignee=${kabirId}`);
    assert.equal(kabirs.status, 200);
    assert.ok(kabirs.body.data.every((task) => task.createdBy?.id === ritikaId), "only kabir's tasks she created");
    assert.equal((await ritika('GET', `/tasks/${satTask.id}`)).status, 404);
  });

  await t.test("a manager sees his branch's tasks; other companies get 404", async () => {
    const theirs = await kabir('GET', `/tasks?unitId=${online.id}&assignee=${ritikaId}&limit=5`);
    assert.equal(theirs.status, 200);
    assert.ok(theirs.body.data.length > 0);
    assert.ok(theirs.body.data.every((task) => task.can.manage));
    assert.equal((await pvAdmin('GET', `/tasks?unitId=${satnpaper.id}`)).status, 404);
    assert.equal((await pvAdmin('GET', `/tasks/${satTask.id}`)).status, 404);
    const pvOwn = await pvAdmin('GET', `/tasks?unitId=${pivector.id}&assignee=me,none`);
    assert.equal(pvOwn.status, 200);
    assert.ok(pvOwn.body.data.every((task) => task.companyId === pivector.id));
    const everyone = await owner('GET', `/tasks?unitId=${group.id}&assignee=${ritikaId},${kabirId}&limit=100`);
    assert.ok(everyone.body.data.length > 0);
  });

  await t.test('keyset pagination by due date has no gaps or repeats', async () => {
    const seen = [];
    let cursor = null;
    for (let page = 0; page < 10; page += 1) {
      const res = await owner('GET', `/tasks?unitId=${satnpaper.id}&assignee=${ritikaId},${kabirId}&limit=7${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      assert.equal(res.status, 200);
      seen.push(...res.body.data.map((task) => task.id));
      cursor = res.body.nextCursor;
      if (!cursor) break;
    }
    assert.equal(new Set(seen).size, seen.length);
    const done = await owner('GET', `/tasks?unitId=${satnpaper.id}&assignee=${ritikaId},${kabirId}&status=done&limit=3`);
    const times = done.body.data.map((task) => task.completedAt);
    assert.deepEqual(times, [...times].sort().reverse(), 'done tasks: most recent first');
    assert.equal((await owner('GET', `/tasks?unitId=${satnpaper.id}&cursor=garbage`)).status, 400);
  });

  await t.test('create on a deal: scoped, assigned to the creator, on the timeline, audited', async () => {
    const dueAt = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const res = await create(ritika, { dealId: ritikaDeal.id, title: `Call back about batch timings ${RUN}`, kind: 'call', dueAt });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const task = res.body.data;
    assert.equal(task.assignee.id, ritikaId);
    assert.equal(task.deal.id, ritikaDeal.id);
    assert.equal(task.unit.id, ritikaDeal.unit_id);
    assert.equal(task.contact?.id ?? null, ritikaDeal.primary_contact_id, 'the deal person comes along');
    assert.equal(task.dueAt, dueAt);
    assert.ok(task.can.manage);
    const entry = await db('timeline_events').where({ deal_id: ritikaDeal.id, kind: 'task' }).whereRaw("meta->>'taskId' = ?", [task.id]).first();
    assert.equal(entry?.title, `Task: Call back about batch timings ${RUN}`);
    assert.ok(await db('audit_logs').where({ action: 'task.created', entity_id: task.id }).first());
    assert.ok(await db('outbox_events').where({ type: 'task.created', aggregate_id: task.id }).first());

    const onDeal = await ritika('GET', `/tasks?unitId=${satnpaper.id}&dealId=${ritikaDeal.id}`);
    assert.ok(onDeal.body.data.some((item) => item.id === task.id));

    assert.equal((await create(ritika, { dealId: kabirDeal.id, title: 'Not my deal' })).status, 404);
    assert.equal((await create(pvAdmin, { dealId: ritikaDeal.id, title: 'Other company' })).status, 404);
    assert.equal((await create(ritika, { title: 'No unit' })).status, 422);
    assert.equal((await create(ritika, { unitId: group.id, title: 'At the group' })).status, 403, 'no tasks.manage at the group');
    assert.equal((await create(owner, { unitId: group.id, title: 'At the group' })).status, 422, 'tasks belong to a company');
    const notHere = await create(ritika, { dealId: ritikaDeal.id, title: 'Wrong assignee', assigneeUserId: users.get('admin.pivector@phoenix.test') });
    assert.equal(notHere.status, 422);
    assert.equal(notHere.body.error.details[0].path, 'body.assigneeUserId');
    const late = await create(ritika, { dealId: ritikaDeal.id, title: 'Bad reminder', dueAt, reminderAt: new Date(Date.parse(dueAt) + 60_000).toISOString() });
    assert.equal(late.status, 422);
    const pvContact = await db('contact_companies').where({ company_id: pivector.id }).whereNotExists(db('contact_companies as o').whereRaw('o.contact_id = contact_companies.contact_id').where('o.company_id', satnpaper.id).select(db.raw('1'))).first('contact_id');
    const wrongPerson = await create(owner, { unitId: satAdmissions.id, contactId: pvContact.contact_id, title: 'Unknown person' });
    assert.equal(wrongPerson.status, 422, 'the person must be known to the company');
  });

  await t.test('update, reassign, complete, reopen and cancel', async () => {
    const res = await create(ritika, { unitId: satAdmissions.id, title: `Follow up ${RUN}`, dueAt: new Date(Date.now() + 3_600_000).toISOString(), reminderAt: new Date(Date.now() - 60_000).toISOString() });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const task = res.body.data;

    // Reminders: due ones are marked once and emit task.reminder_due.
    assert.ok((await processDueTaskReminders({ db })) >= 1);
    const reminded = await db('tasks').where({ id: task.id }).first();
    assert.ok(reminded.reminder_sent_at);
    assert.ok(await db('outbox_events').where({ type: 'task.reminder_due', aggregate_id: task.id }).first());
    const newDue = new Date(Date.now() + 7_200_000).toISOString();
    const moved = await ritika('PATCH', `/tasks/${task.id}`, { dueAt: newDue, priority: 'high', notes: 'Private notes' });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.body.data.priority, 'high');
    assert.equal((await db('tasks').where({ id: task.id }).first()).reminder_sent_at, null, 'a new due time resets the reminder');
    const audit = await db('audit_logs').where({ action: 'task.updated', entity_id: task.id }).first();
    assert.ok(!JSON.stringify(audit.after ?? {}).includes('Private notes'), 'notes are not copied into the audit log');
    assert.equal((await ritika('PATCH', `/tasks/${task.id}`, { reminderAt: new Date(Date.parse(newDue) + 1000).toISOString() })).status, 422);

    // The manager reassigns it; ritika still sees it because she created it.
    const reassigned = await kabir('PATCH', `/tasks/${task.id}`, { assigneeUserId: kabirId });
    assert.equal(reassigned.status, 200);
    assert.equal(reassigned.body.data.assignee.id, kabirId);
    assert.ok(await db('outbox_events').where({ type: 'task.assigned', aggregate_id: task.id }).first());
    assert.equal((await ritika('GET', `/tasks/${task.id}`)).status, 200);
    assert.equal((await sales('PATCH', `/tasks/${task.id}`, { title: 'x' })).status, 404);

    const done = await ritika('POST', `/tasks/${task.id}/complete`);
    assert.equal(done.status, 200);
    assert.equal(done.body.data.status, 'done');
    assert.equal(done.body.data.completedBy.id, ritikaId);
    assert.ok(done.body.data.completedAt);
    assert.equal((await ritika('POST', `/tasks/${task.id}/complete`)).status, 409);
    assert.equal((await ritika('POST', `/tasks/${task.id}/cancel`)).status, 409);
    const reopened = await ritika('POST', `/tasks/${task.id}/reopen`);
    assert.equal(reopened.body.data.status, 'open');
    assert.equal(reopened.body.data.completedAt, null);
    assert.equal((await ritika('POST', `/tasks/${task.id}/reopen`)).status, 409);
    assert.equal((await ritika('POST', `/tasks/${task.id}/cancel`)).body.data.status, 'cancelled');
    for (const action of ['task.completed', 'task.reopened', 'task.cancelled']) {
      assert.ok(await db('audit_logs').where({ action, entity_id: task.id }).first(), `${action} audited`);
    }
  });

  await t.test("counts group open tasks by the viewer's day", async () => {
    const counts = async () => {
      const res = await ritika('GET', `/tasks/counts?unitId=${satnpaper.id}&tz=${encodeURIComponent(TZ)}`);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      return res.body.data;
    };
    const before = await counts();
    assert.equal(before.timeZone, TZ);
    const now = Date.now();
    const dues = [new Date(now - 3_600_000), new Date(now + 60_000), new Date(now + 3 * 86_400_000), null];
    for (const [i, dueAt] of dues.entries()) {
      assert.equal((await create(ritika, { unitId: satAdmissions.id, title: `Count ${i} ${RUN}`, dueAt: dueAt?.toISOString() ?? null })).status, 201);
    }
    const after = await counts();
    const bounds = { now: new Date(), ...dayBounds(new Date(), TZ) };
    const expected = { overdue: 0, today: 0, upcoming: 0, none: 0 };
    for (const dueAt of dues) expected[taskGroup({ status: 'open', dueAt }, bounds)] += 1;
    assert.equal(after.open - before.open, 4);
    assert.equal(after.overdue - before.overdue, expected.overdue);
    assert.equal(after.laterToday - before.laterToday, expected.today);
    assert.equal(after.upcoming - before.upcoming, expected.upcoming);
    assert.equal(after.noDueDate - before.noDueDate, 1);

    const lists = async (due) => (await ritika('GET', `/tasks?unitId=${satnpaper.id}&due=${due}&tz=${encodeURIComponent(TZ)}&limit=100`)).body.data;
    assert.equal((await lists('overdue')).length, after.overdue);
    assert.equal((await lists('later_today')).length, after.laterToday);
    assert.equal((await lists('none')).length, after.noDueDate);
    assert.ok((await lists('overdue')).every((task) => task.overdue));
    const today = await lists('today');
    assert.equal(today.length, after.today);
    assert.ok(today.every((task) => task.dueAt >= after.startOfToday && task.dueAt < after.startOfTomorrow));
  });

  await t.test('filters: company and related type', async () => {
    const onDeals = await owner('GET', `/tasks?unitId=${group.id}&assignee=${ritikaId}&related=deal&limit=100`);
    assert.ok(onDeals.body.data.length > 0);
    assert.ok(onDeals.body.data.every((task) => task.deal));
    const unrelated = await ritika('GET', `/tasks?unitId=${satnpaper.id}&related=none&limit=100`);
    assert.ok(unrelated.body.data.every((task) => !task.deal && !task.contact && !task.account));
    const otherCompany = await owner('GET', `/tasks?unitId=${group.id}&assignee=${ritikaId}&companyId=${pivector.id}`);
    assert.equal(otherCompany.body.data.length, 0);
  });
});
