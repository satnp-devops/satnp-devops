import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccessContext } from '../../src/core/accessContext.js';
import { matchTrigger, simulate, validateFlow } from '../../src/core/automation/index.js';
import { buildRegistry } from '../../src/registry.js';
import { canDecideApproval, canSeeApproval, checkEditedData, isNamedApprover } from '../../src/modules/automations/approvals.js';
import {
  ACTION_PERMISSIONS,
  clearActionExecutors,
  developmentOutput,
  executorFor,
  registerActionExecutor,
  requiredPermissions,
} from '../../src/modules/automations/actions.js';
import { buildFlow, engineFieldErrors, stableJson } from '../../src/modules/automations/flows.js';
import { getAutomationRegistry } from '../../src/modules/automations/registry.js';
import { sampleDealRecord, subjectOf } from '../../src/modules/automations/subjects.js';
import { FLOW_TEMPLATES, templateByKey } from '../../src/modules/automations/templates.js';

const registry = getAutomationRegistry();
const coreRegistry = buildRegistry();
const flowOf = (key) => {
  const t = templateByKey.get(key);
  return validateFlow({ key: t.key, version: 1, name: t.name, ...t.definition }, registry).flow;
};

// ---------- Templates ----------

test('every template is a valid flow, and nurture templates are of the nurture kind', () => {
  assert.ok(FLOW_TEMPLATES.length >= 5);
  for (const t of FLOW_TEMPLATES) {
    const result = validateFlow({ key: t.key, version: 1, name: t.name, ...t.definition }, registry);
    assert.ok(result.ok, `${t.key}: ${JSON.stringify(result.errors)}`);
    assert.deepEqual(result.warnings, [], t.key);
  }
  assert.ok(FLOW_TEMPLATES.filter((t) => t.kind === 'nurture').every((t) => t.definition.trigger.type === 'deal.stage_changed'));
});

test('trigger matching: welcome only for B2C enquiries that are not imports', () => {
  const flow = flowOf('new-enquiry-welcome');
  const event = (payload) => ({ id: 'e1', type: 'deal.created', subject: { type: 'deal', id: 'd1' }, payload });
  const now = Date.parse('2026-11-06T05:00:00Z');
  const b2c = { record: { kind: 'b2c' } };
  assert.equal(matchTrigger(flow, registry, event({ channel: 'whatsapp' }), { now, context: b2c }).matched, true);
  assert.equal(matchTrigger(flow, registry, event({ channel: 'import' }), { now, context: b2c }).matched, false);
  assert.equal(matchTrigger(flow, registry, event({ channel: 'form' }), { now, context: { record: { kind: 'b2b' } } }).matched, false);
  assert.equal(matchTrigger(flow, registry, { ...event({}), type: 'deal.updated' }, { now, context: b2c }).reason, 'event_type');
});

test('trigger matching: nurture starts on lost with nurture on; no-show and payment triggers use their config', () => {
  const now = Date.parse('2026-11-06T05:00:00Z');
  const nurture = flowOf('lost-lead-nurture');
  const moved = (toStatus) => ({ id: 'e', type: 'deal.stage_changed', subject: { type: 'deal', id: 'd' }, payload: { toStatus, toStage: 'lost' } });
  assert.equal(matchTrigger(nurture, registry, moved('lost'), { now, context: { record: { nurture: true } } }).matched, true);
  assert.equal(matchTrigger(nurture, registry, moved('lost'), { now, context: { record: { nurture: false } } }).matched, false);
  assert.equal(matchTrigger(nurture, registry, moved('open'), { now, context: { record: { nurture: true } } }).matched, false);

  const noShow = flowOf('booking-no-show-rebook');
  const ended = (attendance) => ({ id: 'm', type: 'meeting.ended', subject: { type: 'deal', id: 'd' }, payload: { attendance } });
  assert.equal(matchTrigger(noShow, registry, ended('no_show'), { now }).matched, true);
  assert.equal(matchTrigger(noShow, registry, ended('attended'), { now }).matched, false);

  const chaser = flowOf('payment-failed-chaser');
  assert.equal(matchTrigger(chaser, registry, { id: 'p', type: 'payment.failed', subject: null, payload: {} }, { now }).matched, true);
  assert.equal(matchTrigger(chaser, registry, { id: 'p', type: 'payment.succeeded', subject: null, payload: {} }, { now }).matched, false);
});

test('the nurture template drafts, asks the owner and sends the edited draft (simulated)', () => {
  const t = templateByKey.get('lost-lead-nurture');
  const out = simulate({ key: t.key, version: 1, name: t.name, ...t.definition }, registry, {
    now: '2026-11-06T05:00:00Z',
    event: { type: 'deal.stage_changed', subject: { type: 'deal', id: 'd' }, payload: { toStatus: 'lost' } },
    context: { record: { ...sampleDealRecord(), status: 'lost', nurture: true } },
    approvals: { review: { decision: 'approved', data: { draft: 'Edited by Ritika' } } },
  });
  assert.equal(out.status, 'completed', JSON.stringify(out.error));
  const send = out.effects.find((e) => e.stepId === 'send');
  assert.equal(send.params.variables.message, 'Edited by Ritika');
  assert.equal(send.params.variables.name, 'Priya');
  const rejected = simulate({ key: t.key, version: 1, name: t.name, ...t.definition }, registry, {
    now: '2026-11-06T05:00:00Z',
    event: { payload: { toStatus: 'lost' } },
    context: { record: { ...sampleDealRecord(), status: 'lost', nurture: true } },
    approvals: { review: 'rejected' },
  });
  assert.equal(rejected.effects.filter((e) => e.action === 'messaging.send_template').length, 0, 'nothing is sent after a rejection');
});

// ---------- Helpers ----------

test('stableJson ignores key order (jsonb reorders keys) but not values', () => {
  assert.equal(stableJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } }), stableJson({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }));
  assert.notEqual(stableJson({ a: [1, 2] }), stableJson({ a: [2, 1] }));
  assert.equal(stableJson({ a: undefined, b: 1 }), stableJson({ b: 1 }));
});

test('buildFlow takes key, version and name from the flow, never from the client', () => {
  const flow = buildFlow({ key: 'evil', version: 99, name: 'x', trigger: { type: 'schedule' } }, { key: 'mine', version: 3, name: 'Mine' });
  assert.deepEqual(flow, { key: 'mine', version: 3, name: 'Mine', trigger: { type: 'schedule' } });
});

test('engine errors become field errors under body.definition', () => {
  const result = validateFlow(
    {
      key: 'x-flow',
      version: 1,
      name: 'X',
      trigger: { type: 'enquiry.new' },
      start: 'a',
      steps: [{ id: 'a', type: 'action', action: 'http.call_webhook', params: { url: 'https://10.0.0.1/hook' } }],
    },
    registry,
  );
  assert.equal(result.ok, false);
  const [first] = engineFieldErrors(result.errors);
  assert.match(first.path, /^body\.definition\.steps\.0\.params\.url/);
  assert.equal(first.code, 'PARAMS_INVALID');
  assert.equal(first.stepId, 'a');
});

test('subjectOf prefers the deal of an event', () => {
  assert.deepEqual(subjectOf({ aggregateType: 'deal', aggregateId: 'd1', payload: {} }), { type: 'deal', id: 'd1' });
  assert.deepEqual(subjectOf({ aggregateType: 'booking', aggregateId: 'b1', payload: { dealId: 'd2', contactId: 'c' } }), { type: 'deal', id: 'd2' });
  assert.deepEqual(subjectOf({ aggregateType: 'contact', aggregateId: 'c1', payload: {} }), { type: 'contact', id: 'c1' });
  assert.equal(subjectOf({ type: 'x', payload: {} }), null);
});

// ---------- Action registry ----------

test('flows need the permissions of the actions they perform (no escalation through flows)', () => {
  const definition = {
    steps: [
      { id: 'a', type: 'action', action: 'http.call_webhook' },
      { id: 'b', type: 'action', action: 'deals.change_stage' },
      { id: 'c', type: 'action', action: 'tasks.create' },
      { id: 'd', type: 'wait' },
    ],
  };
  const needed = requiredPermissions(definition, coreRegistry);
  assert.deepEqual(needed.get('automations.webhooks'), ['a']);
  assert.deepEqual(needed.get('deals.manage'), ['b']);
  assert.deepEqual(needed.get('tasks.manage'), ['c']);
  for (const perms of Object.values(ACTION_PERMISSIONS)) for (const p of perms) assert.ok(coreRegistry.permissions.has(p), p);
});

test('executors: registered ones win; others run on the development executor', async () => {
  clearActionExecutors();
  assert.equal(executorFor('tasks.create'), null);
  assert.deepEqual(developmentOutput({ action: 'tasks.create', params: {} }), { taskId: 'task_sample_1' });
  assert.deepEqual(developmentOutput({ action: 'ai.run', params: { agent: 'classifier' } }), { label: 'admission_enquiry', confidence: 0.91 });
  registerActionExecutor('tasks.create', async () => ({ taskId: 't1' }), { module: 'tasks' });
  assert.equal(executorFor('tasks.create').module, 'tasks');
  assert.throws(() => registerActionExecutor('tasks.create', async () => ({})), /already registered/);
  assert.equal(executorFor('http.call_webhook').module, 'automations');
  clearActionExecutors();
});

// ---------- Approvals ----------

const UNIT = { id: 'u-team', path: '/g/c/team/' };
const access = (assignments) => new AccessContext({ userId: 'x', assignments });
const approval = (over = {}) => ({ approver_user_ids: [], owner_user_id: null, approver_permission: null, ...over });

test('approvers: named people and the owner (own level), anyone with the all level unless a permission is named', () => {
  const counsellor = access([{ unitPath: '/g/c/team/', permissions: ['automations.approve:own'] }]);
  const manager = access([{ unitPath: '/g/c/', permissions: ['automations.approve', 'deals.view'] }]);
  const outsider = access([{ unitPath: '/g/other/', permissions: ['automations.approve'] }]);

  const mine = approval({ owner_user_id: 'ritika' });
  assert.equal(isNamedApprover(mine, 'ritika'), true);
  assert.equal(canSeeApproval(counsellor, UNIT, mine, 'ritika'), true);
  assert.equal(canDecideApproval(counsellor, UNIT, mine, 'ritika'), true);
  assert.equal(canSeeApproval(counsellor, UNIT, mine, 'someone-else'), false);
  assert.equal(canDecideApproval(counsellor, UNIT, approval({ owner_user_id: 'other' }), 'ritika'), false);

  assert.equal(canSeeApproval(manager, UNIT, mine, 'kabir'), true);
  assert.equal(canDecideApproval(manager, UNIT, mine, 'kabir'), true);
  assert.equal(canDecideApproval(manager, UNIT, approval({ approver_permission: 'deals.assign' }), 'kabir'), false, 'named permission required');
  assert.equal(canDecideApproval(manager, UNIT, approval({ approver_permission: 'deals.view' }), 'kabir'), true);

  assert.equal(canSeeApproval(outsider, UNIT, mine, 'nisha'), false);
  assert.equal(canDecideApproval(outsider, UNIT, mine, 'nisha'), false);
  assert.equal(canSeeApproval(manager, null, mine, 'kabir'), false);
});

test('approvers may edit only the proposed fields, keeping text as text', () => {
  const proposed = { draft: 'Hello', subject: 'Hi' };
  assert.deepEqual(checkEditedData(proposed, undefined), { ok: true, data: null });
  assert.deepEqual(checkEditedData(proposed, { draft: 'Hello' }), { ok: true, data: null }, 'unchanged is not an edit');
  assert.deepEqual(checkEditedData(proposed, { draft: 'Hello there' }), { ok: true, data: { draft: 'Hello there', subject: 'Hi' } });
  assert.equal(checkEditedData(proposed, { url: 'https://evil.test' }).ok, false);
  assert.equal(checkEditedData(proposed, { draft: 5 }).ok, false);
  assert.equal(checkEditedData(proposed, { draft: 'x'.repeat(5001) }).ok, false);
  assert.equal(checkEditedData(proposed, ['a']).ok, false);
  assert.equal(checkEditedData(null, { draft: 'x' }).ok, false);
});
