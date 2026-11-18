import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { automationRegistryFromModules, createAutomationRegistry } from '../../src/core/automation/registry.js';
import { nextScheduleFire, noActivityCutoff, noActivityEventId } from '../../src/core/automation/catalog.js';

const sendLink = {
  key: 'payments.send_link',
  label: 'Send payment link',
  sideEffect: true,
  params: z.strictObject({ amountMinor: z.int().min(1), currency: z.string().regex(/^[A-Z]{3}$/) }),
};

test('the core registry holds the triggers, actions and agents from the brief', () => {
  const registry = createAutomationRegistry();
  assert.deepEqual([...registry.triggers.keys()], ['enquiry.new', 'deal.stage_changed', 'booking.event', 'meeting.ended', 'payment.event', 'schedule', 'no_activity']);
  assert.deepEqual(
    [...registry.actions.values()].filter((a) => !a.internal).map((a) => a.key),
    ['messaging.send_template', 'tasks.create', 'deals.change_stage', 'records.assign', 'records.update_field', 'http.call_webhook'],
  );
  assert.deepEqual([...registry.agents.keys()], ['intake_extraction', 'classifier', 'reply_assistant', 'meeting_summariser', 'followup_writer', 'payment_chaser', 'b2b_qualifier']);
  assert.equal(registry.agent('followup_writer').requiresApproval, true);
  assert.equal(registry.agent('classifier').requiresApproval, false);
  assert.equal(registry.action('ai.run').internal, true);
  assert.equal(registry.action('nope.nothing'), null);
  assert.deepEqual(registry.triggersForEvent('payment.failed').map((t) => t.key), ['payment.event']);
  assert.deepEqual(registry.triggersForEvent('unknown.event'), []);
  assert.ok(registry.eventTypes().includes('booking.rescheduled'));
});

test('every core agent and action sample satisfies its own schema', () => {
  const registry = createAutomationRegistry();
  for (const agent of registry.agents.values()) assert.ok(agent.output.safeParse(agent.sampleOutput).success, agent.key);
  for (const action of registry.actions.values()) {
    if (action.output && action.sampleOutput !== undefined) assert.ok(action.output.safeParse(action.sampleOutput).success, action.key);
  }
  for (const trigger of registry.triggers.values()) {
    assert.ok(trigger.sample && trigger.events.includes(trigger.sample.type), `${trigger.key} sample uses one of its events`);
  }
});

test('modules add actions, triggers and agents; definitions are checked', () => {
  const registry = automationRegistryFromModules([
    { name: 'payments', automation: { actions: [sendLink], triggers: [{ key: 'payments.mandate_failed', label: 'Mandate failed', events: ['mandate.failed'] }] } },
    { name: 'org' },
  ]);
  assert.equal(registry.action('payments.send_link').module, 'payments');
  assert.equal(registry.trigger('payments.mandate_failed').subject, null, 'defaults filled in');
  assert.ok(registry.trigger('payments.mandate_failed').config.safeParse({}).success);
  assert.ok(registry.action('tasks.create'), 'core still present');
  assert.equal(createAutomationRegistry({ actions: [sendLink] }, { includeCore: false }).actions.size, 1);
});

test('bad or duplicate definitions are refused at start-up', () => {
  const make = (actions = [], triggers = [], agents = []) => () => createAutomationRegistry({ actions, triggers, agents });
  assert.throws(make([sendLink, sendLink]), /Duplicate automation action "payments.send_link"/);
  assert.throws(make([{ ...sendLink, key: 'tasks.create' }]), /Duplicate automation action "tasks.create"/);
  assert.throws(make([{ ...sendLink, key: 'NoDot' }]), /must look like module.action/);
  assert.throws(make([{ ...sendLink, label: '' }]), /needs a label/);
  assert.throws(make([{ ...sendLink, params: { a: 1 } }]), /zod params schema/);
  assert.throws(make([{ ...sendLink, sideEffect: undefined }]), /side effects/);
  assert.throws(make([], [{ key: 'x.y', label: 'X', events: [] }]), /domain event types/);
  assert.throws(make([], [{ key: 'x.y', label: 'X', events: ['Bad Event'] }]), /domain event types/);
  assert.throws(make([], [{ key: 'x.y', label: 'X', events: ['x.happened'], match: 'yes' }]), /match must be a function/);
  assert.throws(make([], [], [{ key: 'agent', label: 'A', input: z.object({}), output: z.object({}) }]), /requires approval/);
  assert.throws(make([], [], [{ key: 'classifier', label: 'A', input: z.object({}), output: z.object({}), requiresApproval: false }]), /Duplicate automation agent/);
});

test('catalog() is JSON for the flow editor, without internal actions', () => {
  const catalog = createAutomationRegistry().catalog();
  const json = JSON.parse(JSON.stringify(catalog));
  assert.equal(json.actions.length, 6);
  assert.ok(!json.actions.some((a) => a.key === 'ai.run'));
  const task = json.actions.find((a) => a.key === 'tasks.create');
  assert.equal(task.paramsSchema.type, 'object');
  assert.ok(task.paramsSchema.properties.title);
  assert.equal(task.sideEffect, true);
  assert.ok(json.triggers.find((t) => t.key === 'schedule').configSchema.properties.timeOfDay);
  assert.ok(json.agents.every((a) => a.inputSchema && a.outputSchema));
  assert.ok(json.functions.local_hour);
});

test('trigger config matching: stage, payment kind, booking kind, attendance, channels, no-activity stages', () => {
  const registry = createAutomationRegistry();
  const match = (key, config, event) => {
    const trigger = registry.trigger(key);
    return trigger.match(trigger.config.parse(config), event);
  };
  assert.ok(match('deal.stage_changed', { toStage: 'won' }, { type: 'deal.stage_changed', payload: { toStage: 'won' } }));
  assert.ok(!match('deal.stage_changed', { toStage: 'won' }, { type: 'deal.stage_changed', payload: { toStage: 'lost' } }));
  assert.ok(match('payment.event', { kinds: ['failed', 'instalment_overdue'] }, { type: 'instalment.overdue' }));
  assert.ok(!match('payment.event', { kinds: ['failed'] }, { type: 'payment.succeeded' }));
  assert.ok(match('payment.event', {}, { type: 'payment.refunded' }));
  assert.ok(match('booking.event', { kinds: ['rescheduled'] }, { type: 'booking.rescheduled' }));
  assert.ok(!match('booking.event', { kinds: ['rescheduled'] }, { type: 'booking.created' }));
  assert.ok(!match('meeting.ended', { attendance: 'no_show' }, { type: 'meeting.ended', payload: { attendance: 'attended' } }));
  assert.ok(match('enquiry.new', { channels: ['whatsapp'] }, { type: 'deal.created', payload: { channel: 'whatsapp' } }));
  assert.ok(!match('enquiry.new', { channels: ['whatsapp'] }, { type: 'deal.created', payload: { channel: 'form' } }));
  assert.ok(match('no_activity', { after: '3d', stages: ['new'] }, { type: 'automation.no_activity', subject: { type: 'deal' }, payload: { stage: 'new' } }));
  assert.ok(!match('no_activity', { after: '3d', entity: 'contact' }, { type: 'automation.no_activity', subject: { type: 'deal' }, payload: {} }));
  assert.ok(!registry.trigger('no_activity').config.safeParse({ after: '10m' }).success, 'at least an hour');
  assert.ok(!registry.trigger('schedule').config.safeParse({ timeOfDay: '9:00', timeZone: 'Asia/Kolkata' }).success);
});

test('schedule and no-activity helpers for the scheduler', () => {
  const config = { timeOfDay: '09:00', timeZone: 'Asia/Kolkata', daysOfWeek: [1, 2, 3, 4, 5] };
  assert.equal(nextScheduleFire(config, '2026-11-05T04:30:00Z'), Date.parse('2026-11-06T03:30:00Z'));
  assert.equal(nextScheduleFire(config, '2026-11-06T03:30:00Z'), Date.parse('2026-11-09T03:30:00Z'), 'strictly after, skipping the weekend');
  assert.equal(noActivityCutoff({ after: '3d' }, '2026-11-05T04:30:00Z'), Date.parse('2026-11-02T04:30:00Z'));
  assert.throws(() => noActivityCutoff({ after: 'soon' }, 0), /not a duration/);
  assert.equal(
    noActivityEventId('nudge', { type: 'deal', id: 'd1' }, '2026-11-01T06:00:00Z'),
    'nudge:no_activity:deal:d1:2026-11-01T06:00:00Z',
  );
});

test('core action params: defaults, refinements and safety rules', () => {
  const registry = createAutomationRegistry();
  const parse = (key, params) => registry.action(key).params.safeParse(params);
  assert.deepEqual(parse('tasks.create', { title: 'Call' }).data, { title: 'Call', assignee: 'owner', priority: 'normal' });
  assert.ok(!parse('tasks.create', { title: 'Call', dueIn: '1d', dueAt: '2026-11-05T04:30:00Z' }).success);
  assert.ok(!parse('tasks.create', { title: '' }).success);
  assert.ok(!parse('records.assign', { strategy: 'user' }).success, 'user needs userId');
  assert.ok(!parse('records.assign', { strategy: 'round_robin' }).success, 'round robin needs a team');
  assert.ok(parse('records.assign', { strategy: 'round_robin', teamUnitId: '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e' }).success);
  assert.ok(!parse('records.update_field', { field: 'ownerId', value: 'x' }).success, 'owner has its own action');
  assert.ok(!parse('records.update_field', { field: 'custom.__proto__', value: 1 }).success);
  assert.ok(parse('records.update_field', { field: 'custom.grade', value: '12' }).success);
  assert.ok(!parse('records.update_field', { field: 'custom.big', value: 'x'.repeat(70_000) }).success);
  assert.ok(!parse('messaging.send_template', { channel: 'telegram', template: 'x' }).success);
  assert.ok(!parse('http.call_webhook', { url: 'https://127.0.0.1/' }).success);
  assert.ok(!parse('http.call_webhook', { url: 'https://hooks.example.com/', headers: { Authorization: 'Bearer x' } }).success);
  assert.ok(!parse('http.call_webhook', { url: 'https://hooks.example.com/', headers: { Host: 'internal' } }).success);
  assert.ok(!parse('http.call_webhook', { url: 'https://hooks.example.com/', headers: { 'X-Thing': 'a\r\nInjected: 1' } }).success);
  assert.ok(!parse('http.call_webhook', { url: 'https://hooks.example.com/', timeoutMs: 60_000 }).success);
  assert.deepEqual(parse('http.call_webhook', { url: 'https://hooks.example.com/', headers: { 'X-Source': 'phoenix' } }).data, {
    url: 'https://hooks.example.com/',
    method: 'POST',
    headers: { 'X-Source': 'phoenix' },
    timeoutMs: 10_000,
  });
});

test('the engine index exposes the public API', async () => {
  const engine = await import('../../src/core/automation/index.js');
  for (const name of [
    'flowSchema', 'parse', 'evaluate', 'evaluateSource', 'testCondition', 'explainError', 'renderTemplate', 'resolveParams',
    'validateFlow', 'assertValidFlow', 'advance', 'startRun', 'cancelRun', 'matchTrigger', 'canStartRun', 'simulate',
    'createAutomationRegistry', 'automationRegistryFromModules', 'checkWebhookUrl', 'checkResolvedAddresses',
    'nextScheduleFire', 'noActivityCutoff', 'noActivityEventId', 'parseDuration', 'nextTimeOfDay',
  ]) {
    assert.equal(typeof engine[name] === 'function' || typeof engine[name] === 'object', true, name);
  }
  assert.equal(engine.testCondition("x == 'y'", { x: 'y' }, { now: 0 }), true);
});
