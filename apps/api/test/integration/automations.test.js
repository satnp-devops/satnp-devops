import { test } from 'node:test';
import assert from 'node:assert/strict';
import { env } from '../../src/config/env.js';
import { db } from '../../src/lib/db.js';
import { redis } from '../../src/lib/redis.js';
import { closeQueues } from '../../src/core/queue.js';
import { createApp } from '../../src/app.js';
import { buildRegistry } from '../../src/registry.js';
import { modules } from '../../src/modules/index.js';
import { handleEvent, tick } from '../../src/modules/automations/runner.js';

// Automations end to end against the seeded database (02_crm.js, 33_automations.js): flows CRUD
// and validation, the event router (trigger matching, duplicate events), waits advanced by the
// scheduler tick, approvals, webhook URL safety and scoping as different seeded people.
//   npm run db:migrate && npm run db:seed && INTEGRATION=1 npm test

const enabled = process.env.INTEGRATION === '1';
const RUN = Date.now().toString(36);
const silent = { info() {}, warn() {}, error() {}, debug() {}, child() { return silent; } };

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

test('Automations', { skip: !enabled && 'set INTEGRATION=1 to run' }, async (t) => {
  const app = createApp({ registry: buildRegistry(), modules });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const created = [];

  const limits = await redis.keys('rl:*');
  if (limits.length) await redis.del(...limits);

  const signIn = async (email) => {
    const call = client(base);
    const res = await call('POST', '/auth/login', { email, password: env.SEED_PASSWORD });
    assert.equal(res.status, 200, `${email}: ${JSON.stringify(res.body)}`);
    return call;
  };
  const owner = await signIn('owner@phoenix.test');
  const spAdmin = await signIn('admin.satnpaper@phoenix.test');
  const pvAdmin = await signIn('admin.pivector@phoenix.test');
  const ritika = await signIn('ritika@phoenix.test');
  const kabir = await signIn('kabir@phoenix.test');

  t.after(async () => {
    // Remove what this run made (flows, runs, effects, approvals); audit rows and outbox events stay.
    if (created.length) {
      await db('automation_approvals').whereIn('flow_id', created).delete();
      await db('automation_runs').whereIn('flow_id', created).delete();
      await db('automation_flows').whereIn('id', created).delete();
    }
    server.close();
    await closeQueues();
    await db.destroy();
    await redis.quit();
  });

  const group = await db('org_units').whereNull('parent_id').where({ code: 'phoenix' }).first();
  const units = await db('org_units').where({ root_id: group.id });
  const satnpaper = units.find((u) => u.code === 'satnpaper');
  const pivector = units.find((u) => u.code === 'pi-vector');
  const ritikaId = (await db('users').where({ email: 'ritika@phoenix.test' }).first('id')).id;
  const deal = await db('deals').where({ company_id: satnpaper.id, owner_user_id: ritikaId, status: 'open' }).orderBy('created_at').first();
  const deal2 = await db('deals').where({ company_id: satnpaper.id, owner_user_id: ritikaId, status: 'open' }).whereNot('id', deal.id).orderBy('created_at').first();
  assert.ok(deal && deal2, 'Ritika owns open SatnPaper deals (CRM seed)');

  // Events as the outbox delivers them. The filter keeps seeded flows (welcome skips imports) and
  // other tests' flows out of the way.
  const marker = `it_${RUN}`;
  const enquiry = (d, n) => ({
    id: `it-${RUN}-${n}`,
    type: 'deal.created',
    groupId: group.id,
    unitId: d.unit_id,
    aggregateType: 'deal',
    aggregateId: d.id,
    payload: { dealId: d.id, companyId: d.company_id, channel: 'import', testRun: marker },
  });
  const filter = `trigger.payload.channel == 'import' and trigger.payload.testRun == '${marker}'`;
  const runsOf = (flowId) => db('automation_runs').where({ flow_id: flowId }).orderBy('started_at');

  const createFlow = async (call, name, steps, extra = {}) => {
    const res = await call('POST', '/automations/flows', {
      companyId: satnpaper.id,
      name: `${name} ${RUN}`,
      definition: { trigger: { type: 'enquiry.new', filter }, start: steps[0].id, steps, settings: { timeZone: 'Asia/Kolkata', reentry: 'allow' } },
      ...extra,
    });
    if (res.status === 201) created.push(res.body.data.id);
    return res;
  };

  let flow;
  await t.test('catalog and templates; people without automations.view are refused', async () => {
    const catalog = await owner('GET', '/automations/catalog');
    assert.equal(catalog.status, 200);
    assert.ok(catalog.body.data.actions.some((a) => a.key === 'http.call_webhook' && a.paramsSchema));
    assert.equal(catalog.body.data.executors['http.call_webhook'], 'automations');
    assert.equal(catalog.body.data.executors['tasks.create'], 'development');
    const templates = await spAdmin('GET', '/automations/templates');
    assert.ok(templates.body.data.some((tpl) => tpl.kind === 'nurture'));
    assert.equal((await ritika('GET', '/automations/catalog')).status, 403);
  });

  await t.test('saving validates the flow with the engine (field paths, webhook URL safety)', async () => {
    const bad = await createFlow(spAdmin, 'Broken', [{ id: 'a', type: 'action', action: 'tasks.create', params: { title: 'x' }, next: 'nowhere' }]);
    assert.equal(bad.status, 422);
    assert.ok(bad.body.error.details.some((d) => d.code === 'UNKNOWN_STEP' && d.path.startsWith('body.definition')));

    const privateHook = await createFlow(spAdmin, 'Private hook', [{ id: 'hook', type: 'action', action: 'http.call_webhook', params: { url: 'https://169.254.169.254/latest/meta-data' } }]);
    assert.equal(privateHook.status, 422);
    assert.ok(privateHook.body.error.details.some((d) => d.path.startsWith('body.definition.steps.0.params.url')));
    const dynamicHost = await createFlow(spAdmin, 'Dynamic host', [{ id: 'hook', type: 'action', action: 'http.call_webhook', params: { url: 'https://{{ record.id }}.example.com/x' } }]);
    assert.equal(dynamicHost.status, 422);
    const wholeExpr = await createFlow(spAdmin, 'Expr URL', [{ id: 'hook', type: 'action', action: 'http.call_webhook', params: { url: { $expr: 'record.custom.hook' } } }]);
    assert.equal(wholeExpr.status, 422);

    const check = await spAdmin('POST', '/automations/validate', { companyId: satnpaper.id, definition: { trigger: { type: 'nope.never' }, start: 'a', steps: [{ id: 'a', type: 'end' }] } });
    assert.equal(check.status, 200);
    assert.equal(check.body.data.ok, false);
    assert.equal(check.body.data.errors[0].code, 'UNKNOWN_TRIGGER');
  });

  await t.test('a company admin creates, saves (versions) and turns on a flow', async () => {
    const res = await createFlow(spAdmin, 'Welcome then task', [
      { id: 'welcome', type: 'action', action: 'messaging.send_template', params: { channel: 'whatsapp', template: 'enquiry_welcome', variables: { name: '{{ record.name }}' } }, next: 'pause' },
      { id: 'pause', type: 'wait', mode: 'duration', duration: '1h', next: 'task' },
      { id: 'task', type: 'action', action: 'tasks.create', params: { title: 'Call {{ record.name }}', dueIn: '2h' }, next: 'done' },
      { id: 'done', type: 'end' },
    ]);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    flow = res.body.data;
    assert.equal(flow.status, 'draft');
    assert.equal(flow.version, 1);
    assert.match(flow.key, /^welcome-then-task/);

    // Same definition again: no new version.
    const same = await spAdmin('PATCH', `/automations/flows/${flow.id}`, { definition: flow.definition, baseVersion: 1 });
    assert.equal(same.status, 200);
    assert.equal(same.body.data.version, 1);
    assert.equal(same.body.data.savedVersion, null);

    const on = await spAdmin('POST', `/automations/flows/${flow.id}/activate`);
    assert.equal(on.status, 200);
    assert.equal(on.body.data.status, 'active');
    assert.equal(on.body.data.activeVersion, 1);

    const steps = structuredClone(flow.definition.steps);
    steps[1].duration = '2h';
    const saved = await spAdmin('PATCH', `/automations/flows/${flow.id}`, { definition: { ...flow.definition, steps }, baseVersion: 1, note: 'Longer pause' });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.data.version, 2);
    assert.equal(saved.body.data.activeVersion, 2, 'active flows start new runs on the latest version');
    const stale = await spAdmin('PATCH', `/automations/flows/${flow.id}`, { name: `Renamed ${RUN}`, baseVersion: 1 });
    assert.equal(stale.status, 409);

    const versions = await spAdmin('GET', `/automations/flows/${flow.id}/versions`);
    assert.deepEqual(versions.body.data.map((v) => v.version), [2, 1]);
    const restored = await spAdmin('POST', `/automations/flows/${flow.id}/versions/1/restore`, { baseVersion: 2 });
    assert.equal(restored.status, 200);
    assert.equal(restored.body.data.version, 3);
    assert.equal(restored.body.data.definition.steps[1].duration, '1h');
    flow = restored.body.data;
  });

  await t.test('scoping: other companies get 404, managers read but cannot change, counsellors see nothing', async () => {
    assert.equal((await pvAdmin('GET', `/automations/flows/${flow.id}`)).status, 404);
    assert.equal((await pvAdmin('PATCH', `/automations/flows/${flow.id}`, { name: 'Hijack' })).status, 404);
    assert.equal((await pvAdmin('POST', `/automations/flows/${flow.id}/pause`)).status, 404);
    assert.equal((await pvAdmin('GET', `/automations/flows?unitId=${satnpaper.id}`)).status, 404);
    const own = await pvAdmin('GET', `/automations/flows?unitId=${pivector.id}`);
    assert.equal(own.status, 200);
    assert.ok(own.body.data.length > 0 && own.body.data.every((f) => f.companyId === pivector.id));
    const create = await pvAdmin('POST', '/automations/flows', { companyId: satnpaper.id, templateKey: 'quiet-deal-nudge' });
    assert.equal(create.status, 404);

    assert.equal((await ritika('GET', `/automations/flows/${flow.id}`)).status, 404);
    const manager = await kabir('GET', `/automations/flows/${flow.id}`);
    assert.equal(manager.status, 200);
    assert.equal(manager.body.data.canManage, false);
    assert.equal((await kabir('PATCH', `/automations/flows/${flow.id}`, { name: 'Nope' })).status, 403);

    const sim = await pvAdmin('POST', '/automations/simulate', { companyId: satnpaper.id, definition: flow.definition, dealId: deal.id });
    assert.equal(sim.status, 404);
    const theirDeal = await pvAdmin('POST', '/automations/simulate', { companyId: pivector.id, definition: flow.definition, dealId: deal.id });
    assert.equal(theirDeal.status, 422, 'a deal of another company is "not found" on the field');
  });

  await t.test('the test panel simulates against a real deal', async () => {
    const sim = await spAdmin('POST', '/automations/simulate', { companyId: satnpaper.id, flowId: flow.id, dealId: deal.id, event: { payload: { channel: 'import', testRun: marker } } });
    assert.equal(sim.status, 200, JSON.stringify(sim.body));
    assert.equal(sim.body.data.matched, true);
    assert.equal(sim.body.data.status, 'completed');
    assert.deepEqual(sim.body.data.path, ['welcome', 'pause', 'task', 'done']);
    assert.equal(sim.body.data.record.id, deal.id);
    const unmatched = await spAdmin('POST', '/automations/simulate', { companyId: satnpaper.id, flowId: flow.id });
    assert.equal(unmatched.body.data.status, 'not_started');
  });

  let runId;
  await t.test('an event starts one run, even when delivered twice; the wait is advanced by the tick', async () => {
    const event = enquiry(deal, 1);
    await handleEvent(event, { db, log: silent });
    await handleEvent(event, { db, log: silent });
    const runs = await runsOf(flow.id);
    assert.equal(runs.length, 1, 'one run per flow and trigger event');
    const [run] = runs;
    runId = run.id;
    assert.equal(run.status, 'waiting');
    assert.equal(run.waiting_kind, 'timer');
    assert.equal(run.flow_version, 3);
    assert.equal(run.unit_id, deal.unit_id, "the run belongs to the deal's unit");
    const effects = await db('automation_effects').where({ run_id: run.id });
    assert.deepEqual(effects.map((e) => [e.step_id, e.status]), [['welcome', 'recorded']]);

    // Not due yet: nothing happens.
    await tick(db, { now: Date.now() + 10 * 60_000, log: silent });
    assert.equal((await db('automation_runs').where({ id: run.id }).first()).status, 'waiting');
    await tick(db, { now: Date.now() + 2 * 3_600_000, log: silent });
    const after = await db('automation_runs').where({ id: run.id }).first();
    assert.equal(after.status, 'completed');
    const all = await db('automation_effects').where({ run_id: run.id }).orderBy('created_at');
    assert.deepEqual(all.map((e) => e.step_id), ['welcome', 'task']);
    assert.equal(all[1].params.title, `Call ${(await db('contacts').where({ id: deal.primary_contact_id }).first())?.display_name ?? deal.title}`);
    // A second tick (or a re-delivered event) changes nothing.
    await tick(db, { now: Date.now() + 3 * 3_600_000, log: silent });
    await handleEvent(event, { db, log: silent });
    assert.equal((await db('automation_effects').where({ run_id: run.id })).length, 2);
    assert.equal((await runsOf(flow.id)).length, 1);

    // A paused flow starts nothing.
    await spAdmin('POST', `/automations/flows/${flow.id}/pause`);
    await handleEvent(enquiry(deal, 2), { db, log: silent });
    assert.equal((await runsOf(flow.id)).length, 1);
    await spAdmin('POST', `/automations/flows/${flow.id}/activate`);
  });

  await t.test('runs list and trace are scoped; deal titles need deals.view', async () => {
    const list = await spAdmin('GET', `/automations/runs?unitId=${satnpaper.id}&flowId=${flow.id}`);
    assert.equal(list.status, 200);
    assert.equal(list.body.data.length, 1);
    assert.equal(list.body.data[0].subject.id, deal.id);
    assert.ok(list.body.data[0].subject.ref);
    const detail = await spAdmin('GET', `/automations/runs/${runId}`);
    assert.equal(detail.status, 200);
    const outcomes = detail.body.data.steps.map((s) => `${s.stepId}:${s.outcome}`);
    assert.ok(outcomes.includes('welcome:emitted') && outcomes.includes('pause:waiting') && outcomes.includes('task:emitted'), outcomes.join(' '));
    assert.equal(detail.body.data.effects.length, 2);
    assert.equal(detail.body.data.definition.version, 3);

    assert.equal((await pvAdmin('GET', `/automations/runs/${runId}`)).status, 404);
    assert.equal((await pvAdmin('GET', `/automations/runs?unitId=${satnpaper.id}`)).status, 404);
    const pvRuns = await pvAdmin('GET', `/automations/runs?unitId=${pivector.id}&limit=100`);
    assert.ok(pvRuns.body.data.every((r) => r.companyId === pivector.id));
    assert.equal((await ritika('GET', `/automations/runs?unitId=${satnpaper.id}`)).status, 403);

    // Keyset pages don't repeat rows.
    const page1 = await owner('GET', `/automations/runs?unitId=${satnpaper.id}&limit=2`);
    assert.equal(page1.body.data.length, 2);
    const page2 = await owner('GET', `/automations/runs?unitId=${satnpaper.id}&limit=2&cursor=${page1.body.nextCursor}`);
    assert.ok(page2.body.data.every((r) => !page1.body.data.some((p) => p.id === r.id)));
  });

  await t.test('a run waiting for an event resumes on it; other deals do not wake it', async () => {
    const res = await createFlow(spAdmin, 'Wait for booking', [
      { id: 'wait', type: 'wait', mode: 'event', event: 'booking.created', filter: 'event.payload.dealId == trigger.payload.dealId', timeout: '1d', next: 'thanks', onTimeout: 'chase' },
      { id: 'thanks', type: 'action', action: 'messaging.send_template', params: { channel: 'whatsapp', template: 'booking_thanks' }, next: 'done' },
      { id: 'chase', type: 'action', action: 'tasks.create', params: { title: 'Chase booking' }, next: 'done' },
      { id: 'done', type: 'end' },
    ]);
    assert.equal(res.status, 201);
    await spAdmin('POST', `/automations/flows/${res.body.data.id}/activate`);
    await handleEvent(enquiry(deal2, 3), { db, log: silent });
    const [run] = await runsOf(res.body.data.id);
    assert.equal(run.waiting_kind, 'event');
    const booking = (d, n) => ({ id: `it-${RUN}-b${n}`, type: 'booking.created', groupId: group.id, unitId: d.unit_id, aggregateType: 'booking', aggregateId: `bk-${n}`, payload: { dealId: d.id } });
    await handleEvent(booking(deal, 1), { db, log: silent });
    assert.equal((await db('automation_runs').where({ id: run.id }).first()).status, 'waiting');
    await handleEvent(booking(deal2, 2), { db, log: silent });
    await handleEvent(booking(deal2, 2), { db, log: silent });
    const done = await db('automation_runs').where({ id: run.id }).first();
    assert.equal(done.status, 'completed');
    assert.deepEqual((await db('automation_effects').where({ run_id: run.id })).map((e) => e.step_id), ['thanks']);
  });

  let approvalId;
  let approvalFlowId;
  await t.test('approvals: the owner approves an edited draft; others cannot', async () => {
    const res = await createFlow(spAdmin, 'Approve follow-up', [
      { id: 'write', type: 'ai_step', agent: 'followup_writer', input: { purpose: 'Follow up', channel: 'whatsapp' }, next: 'review' },
      { id: 'review', type: 'approval', title: 'Send to {{ record.name }}?', approvers: { owner: true }, data: { draft: { $expr: 'steps.write.output.draft' } }, timeout: '2d', next: 'send', onReject: 'done' },
      { id: 'send', type: 'action', action: 'messaging.send_template', params: { channel: 'whatsapp', template: 'nurture_followup', variables: { message: '{{ steps.review.output.data.draft }}' } }, next: 'done' },
      { id: 'done', type: 'end' },
    ]);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    approvalFlowId = res.body.data.id;
    await spAdmin('POST', `/automations/flows/${approvalFlowId}/activate`);
    await handleEvent(enquiry(deal, 4), { db, log: silent });
    await handleEvent(enquiry(deal2, 5), { db, log: silent });
    const runs = await runsOf(approvalFlowId);
    assert.equal(runs.length, 2);
    assert.ok(runs.every((r) => r.status === 'waiting' && r.waiting_kind === 'approval'), 'the AI draft (development executor) led to the approval');

    const queue = await ritika('GET', `/automations/approvals?unitId=${satnpaper.id}&flowId=${approvalFlowId}`);
    assert.equal(queue.status, 200);
    assert.equal(queue.body.data.length, 2, 'both deals are hers');
    const item = queue.body.data.find((a) => a.dealId === deal.id);
    approvalId = item.id;
    assert.equal(item.canDecide, true);
    assert.ok(item.data.draft.length > 0);

    assert.equal((await pvAdmin('GET', `/automations/approvals/${approvalId}`)).status, 404);
    assert.equal((await pvAdmin('POST', `/automations/approvals/${approvalId}/approve`, {})).status, 404);
    assert.equal((await pvAdmin('GET', `/automations/approvals?unitId=${satnpaper.id}`)).status, 404);

    const injected = await ritika('POST', `/automations/approvals/${approvalId}/approve`, { data: { url: 'https://evil.test' } });
    assert.equal(injected.status, 422);
    const approved = await ritika('POST', `/automations/approvals/${approvalId}/approve`, { data: { draft: `Edited ${RUN}` }, comment: 'Shorter' });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.data.status, 'approved');
    assert.equal(approved.body.data.edited, true);
    assert.equal(approved.body.data.runStatus, 'completed');
    const sent = await db('automation_effects').where({ run_id: approved.body.data.runId, step_id: 'send' }).first();
    assert.equal(sent.params.variables.message, `Edited ${RUN}`);
    assert.equal((await ritika('POST', `/automations/approvals/${approvalId}/approve`, {})).status, 409);

    const other = queue.body.data.find((a) => a.dealId === deal2.id);
    const rejected = await spAdmin('POST', `/automations/approvals/${other.id}/reject`, { comment: 'Not now' });
    assert.equal(rejected.status, 200, 'company admins decide any approval in their company');
    const run2 = await db('automation_runs').where({ id: other.runId }).first();
    assert.equal(run2.status, 'completed');
    assert.equal((await db('automation_effects').where({ run_id: other.runId, step_id: 'send' })).length, 0);
    const audit = await db('audit_logs').where({ entity_type: 'automation_approval', entity_id: approvalId }).first();
    assert.equal(audit.action, 'automation_approval.approved');
    assert.ok(!JSON.stringify(audit.after).includes(`Edited ${RUN}`), 'drafts stay out of the audit log');
  });

  await t.test('cancelling a run and archiving a flow', async () => {
    await handleEvent(enquiry(deal, 6), { db, log: silent });
    const waiting = (await runsOf(approvalFlowId)).find((r) => r.status === 'waiting');
    assert.ok(waiting);
    assert.equal((await kabir('POST', `/automations/runs/${waiting.id}/cancel`)).status, 403);
    const archived = await spAdmin('DELETE', `/automations/flows/${approvalFlowId}`);
    assert.equal(archived.status, 200);
    assert.equal(archived.body.data.cancelledRuns, 1);
    assert.equal((await db('automation_runs').where({ id: waiting.id }).first()).status, 'cancelled');
    assert.equal((await db('automation_approvals').where({ run_id: waiting.id }).first()).status, 'cancelled', 'its approval is withdrawn');
    assert.equal((await spAdmin('PATCH', `/automations/flows/${approvalFlowId}`, { name: 'x' })).status, 409);
  });
});
