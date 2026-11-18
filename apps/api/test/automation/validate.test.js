import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { assertValidFlow, validateFlow } from '../../src/core/automation/validate.js';
import { createAutomationRegistry } from '../../src/core/automation/registry.js';
import { chaserFlow, flowWith, followupFlow, ids, registry, welcomeFlow } from './fixtures.js';

const codes = (result) => result.errors.map((e) => e.code);
const errorFor = (result, code) => result.errors.find((e) => e.code === code);
const end = (id = 'done') => ({ id, type: 'end' });
const task = (id, next, title = 'Call') => ({ id, type: 'action', action: 'tasks.create', params: { title }, ...(next ? { next } : {}) });

test('the sample flows are valid and normalised with defaults', () => {
  for (const flow of [welcomeFlow(), followupFlow(), chaserFlow()]) {
    const result = validateFlow(flow, registry);
    assert.deepEqual(result.errors, [], flow.key);
    assert.equal(result.ok, true);
    assert.deepEqual(result.flow.settings, { timeZone: 'Asia/Kolkata', maxStepsPerRun: 500, reentry: 'skip_if_active' });
  }
  const result = validateFlow(welcomeFlow(), registry);
  assert.deepEqual(result.stats, { steps: 7, maxChain: 4, pausingSteps: 2 });
  assert.equal(result.flow.steps.find((s) => s.id === 'done').outcome, 'completed');
});

test('schema errors carry paths, step ids and readable messages', () => {
  const result = validateFlow(
    flowWith([
      { id: 'a', type: 'teleport' },
      { id: 'b', type: 'wait', mode: 'forever' },
      { id: 'c', type: 'condition', if: 'x = 1', then: 'a', colour: 'red' },
      { id: 'D', type: 'end' },
      { id: 'e', type: 'wait', mode: 'duration', duration: '3 days' },
    ]),
    registry,
  );
  assert.equal(result.ok, false);
  assert.equal(result.flow, null);
  const byStep = Object.fromEntries(result.errors.filter((e) => e.stepId).map((e) => [`${e.stepId}:${e.path.slice(2).join('.')}`, e]));
  assert.match(byStep['a:type'].message, /Unknown type; use one of: condition, branch, wait/);
  assert.match(byStep['b:mode'].message, /Unknown mode; use one of: duration, until, event/);
  assert.equal(byStep['c:if'].code, 'EXPR_SYNTAX');
  assert.match(byStep['c:if'].message, /Use == to compare values \(column 3\)/);
  assert.match(byStep['c:'].message, /Unknown field: colour/);
  assert.match(byStep['D:id'].message, /lowercase/);
  assert.match(byStep['e:duration'].message, /not a duration/);
  assert.ok(codes(validateFlow({ ...flowWith([end('a')]), key: 'Bad Key' }, registry)).includes('SCHEMA'));
  assert.ok(codes(validateFlow({ ...flowWith([end('a')]), version: 0 }, registry)).includes('SCHEMA'));
  assert.ok(codes(validateFlow(flowWith([]), registry)).includes('SCHEMA'));
  assert.equal(validateFlow(null, registry).ok, false);
});

test('graph integrity: start, pointers, duplicates, reachability', () => {
  let result = validateFlow({ ...flowWith([task('a', 'ghost'), end('done')]), start: 'nowhere' }, registry);
  assert.deepEqual(codes(result), ['UNKNOWN_STEP', 'UNKNOWN_STEP'], 'reachability is skipped without a start');
  assert.ok(result.errors.some((e) => e.code === 'UNKNOWN_STEP' && e.path.join('.') === 'start'));
  assert.ok(result.errors.some((e) => e.code === 'UNKNOWN_STEP' && e.stepId === 'a' && e.path.join('.') === 'steps.0.next'));

  result = validateFlow(flowWith([task('a', 'done'), task('a', 'done'), end('done')]), registry);
  assert.ok(codes(result).includes('DUPLICATE_STEP'));

  result = validateFlow(flowWith([task('a', 'done'), task('orphan', 'done'), end('done'), end('also_orphan')]), registry);
  assert.deepEqual(result.errors.filter((e) => e.code === 'UNREACHABLE_STEP').map((e) => e.stepId), ['orphan', 'also_orphan']);

  const branch = flowWith([
    { id: 'a', type: 'branch', cases: [{ when: 'true', next: 'x' }, { when: 'false', next: 'missing' }], otherwise: 'y' },
    end('x'),
    end('y'),
  ]);
  result = validateFlow(branch, registry);
  assert.deepEqual(result.errors.map((e) => [e.code, e.path.join('.')]), [['UNKNOWN_STEP', 'steps.0.cases.1.next']]);
});

test('triggers must be known and their config valid; filters only read trigger, event and record', () => {
  let result = validateFlow({ ...flowWith([end('a')]), trigger: { type: 'lead.teleported' } }, registry);
  assert.deepEqual(codes(result), ['UNKNOWN_TRIGGER']);
  result = validateFlow({ ...flowWith([end('a')]), trigger: { type: 'payment.event', config: { kinds: ['stolen'] } } }, registry);
  assert.equal(errorFor(result, 'TRIGGER_CONFIG_INVALID').path.slice(0, 3).join('.'), 'trigger.config.kinds');
  result = validateFlow({ ...flowWith([end('a')]), trigger: { type: 'schedule' } }, registry);
  assert.ok(codes(result).includes('TRIGGER_CONFIG_INVALID'), 'schedule needs a time');
  result = validateFlow({ ...flowWith([end('a')]), trigger: { type: 'enquiry.new', filter: "steps.a.output == 1 or secret.x == 2" } }, registry);
  assert.deepEqual(result.errors.map((e) => e.code), ['UNKNOWN_ROOT', 'UNKNOWN_ROOT']);
  assert.match(result.errors[0].message, /Unknown name "steps"\. Start with one of: trigger, event, record/);
  result = validateFlow({ ...flowWith([end('a')]), trigger: { type: 'enquiry.new', filter: "trigger.payload.channel == 'x' and record.stage == 'new'" } }, registry);
  assert.equal(result.ok, true);
});

test('expressions in steps may read trigger, event, steps, record, run and caller-declared roots', () => {
  const flow = flowWith([{ id: 'a', type: 'condition', if: "contact.city == 'Pune' and run.id != null", then: 'b' }, end('b')]);
  assert.deepEqual(codes(validateFlow(flow, registry)), ['UNKNOWN_ROOT']);
  assert.equal(validateFlow(flow, registry, { roots: ['contact'] }).ok, true);
});

test('step references: unknown steps are errors, steps that have not run yet are warnings', () => {
  const flow = flowWith([
    { id: 'a', type: 'condition', if: "steps.b.status == 'emitted' or steps.nope.output == 1", then: 'b' },
    task('b', 'c'),
    { id: 'c', type: 'condition', if: "steps.b.status == 'emitted'", then: 'done' },
    end('done'),
  ]);
  const result = validateFlow(flow, registry);
  assert.deepEqual(codes(result), ['UNKNOWN_STEP_REF']);
  assert.deepEqual(result.warnings.map((w) => [w.code, w.stepId]), [['STEP_NOT_BEFORE', 'a']]);
});

test('actions must be known, not internal, with valid params; dynamic values are checked when resolved', () => {
  let result = validateFlow(flowWith([{ id: 'a', type: 'action', action: 'sms.blast', params: {} }]), registry);
  assert.deepEqual(codes(result), ['UNKNOWN_ACTION']);
  result = validateFlow(flowWith([{ id: 'a', type: 'action', action: 'ai.run', params: { agent: 'x', input: {} } }]), registry);
  assert.deepEqual(codes(result), ['INTERNAL_ACTION']);

  result = validateFlow(flowWith([{ id: 'a', type: 'action', action: 'tasks.create', params: { priority: 'urgent', colour: 1 } }]), registry);
  const problems = result.errors.filter((e) => e.code === 'PARAMS_INVALID').map((e) => e.path.join('.'));
  assert.ok(problems.includes('steps.0.params.title'), 'title is required');
  assert.ok(problems.includes('steps.0.params.priority'));
  assert.ok(problems.includes('steps.0.params'), 'unknown key colour');

  result = validateFlow(
    flowWith([{ id: 'a', type: 'action', action: 'records.assign', params: { strategy: 'user', userId: { $expr: 'record.ownerId' } } }]),
    registry,
  );
  assert.equal(result.ok, true, 'a dynamic userId is not judged as a uuid until it is resolved');
  result = validateFlow(flowWith([{ id: 'a', type: 'action', action: 'tasks.create', params: { title: 'Call {{ record.name' } }]), registry);
  assert.equal(errorFor(result, 'EXPR_SYNTAX').path.join('.'), 'steps.0.params.title');
  result = validateFlow(flowWith([{ id: 'a', type: 'action', action: 'tasks.create', params: { title: { $expr: 'secrets.key' } } }]), registry);
  assert.deepEqual(codes(result), ['UNKNOWN_ROOT']);
});

test('webhook targets are checked when the flow is saved', () => {
  const hook = (url) => validateFlow(flowWith([{ id: 'a', type: 'action', action: 'http.call_webhook', params: { url } }]), registry);
  assert.equal(hook('https://hooks.example.com/phoenix').ok, true);
  assert.equal(hook('https://hooks.example.com/deals/{{ trigger.payload.dealId }}').ok, true);
  for (const url of [
    'http://hooks.example.com/',
    'https://169.254.169.254/latest/meta-data',
    'https://[::ffff:127.0.0.1]/',
    'https://localhost/',
    'https://{{ record.host }}/x',
    'https://10.0.0.5/{{ record.id }}',
    { $expr: 'record.webhookUrl' },
  ]) {
    const result = hook(url);
    assert.equal(result.ok, false, JSON.stringify(url));
    assert.equal(result.errors[0].code, 'PARAMS_INVALID');
    assert.equal(result.errors[0].path.join('.'), 'steps.0.params.url');
  }
});

test('AI steps: agent known, input valid', () => {
  let result = validateFlow(flowWith([{ id: 'a', type: 'ai_step', agent: 'fortune_teller', input: {} }]), registry);
  assert.deepEqual(codes(result), ['UNKNOWN_AGENT']);
  result = validateFlow(flowWith([{ id: 'a', type: 'ai_step', agent: 'classifier', input: { text: 'x', labels: ['only-one'] } }]), registry);
  assert.equal(errorFor(result, 'PARAMS_INVALID').path.join('.'), 'steps.0.input.labels');
});

test('AI drafts that need approval must pass an approval step before a side-effect action uses them', () => {
  const unsafe = flowWith([
    { id: 'write', type: 'ai_step', agent: 'followup_writer', input: { purpose: 'x', channel: 'sms' }, next: 'send' },
    { id: 'send', type: 'action', action: 'messaging.send_template', params: { channel: 'sms', template: 't', variables: { body: '{{ steps.write.output.draft }}' } } },
  ]);
  const result = validateFlow(unsafe, registry);
  assert.deepEqual(codes(result), ['AI_NEEDS_APPROVAL']);
  assert.equal(result.errors[0].stepId, 'send');
  assert.match(result.errors[0].message, /Follow-up writer/);

  // A path that skips the approval is still unsafe.
  const bypass = flowWith([
    { id: 'write', type: 'ai_step', agent: 'followup_writer', input: { purpose: 'x', channel: 'sms' }, next: 'gate' },
    { id: 'gate', type: 'condition', if: 'record.vip', then: 'review', else: 'send' },
    { id: 'review', type: 'approval', title: 'Check', approvers: { owner: true }, next: 'send' },
    { id: 'send', type: 'action', action: 'messaging.send_template', params: { channel: 'sms', template: 't', variables: { body: '{{ steps.write.output.draft }}' } } },
  ]);
  assert.deepEqual(codes(validateFlow(bypass, registry)), ['AI_NEEDS_APPROVAL']);

  assert.equal(validateFlow(followupFlow(), registry).ok, true, 'approval in between');
  // Agents that don't require approval may feed actions directly.
  assert.equal(validateFlow(chaserFlow(), registry).ok, true);
});

test('loops must contain a wait; pause-free cycles are reported with their steps', () => {
  const spin = flowWith([
    { id: 'a', type: 'condition', if: 'true', then: 'b', else: 'done' },
    task('b', 'a'),
    end('done'),
  ]);
  const result = validateFlow(spin, registry);
  assert.deepEqual(codes(result), ['LOOP_WITHOUT_WAIT']);
  assert.match(result.errors[0].message, /a → b → a/);
  assert.equal(result.stats.maxChain, null);

  const self = flowWith([{ id: 'a', type: 'condition', if: 'true', then: 'a', else: 'done' }, end('done')]);
  assert.deepEqual(codes(validateFlow(self, registry)), ['LOOP_WITHOUT_WAIT']);

  // A wait until an expression's time may not pause (the time can be in the past), so it doesn't break a loop.
  const untilLoop = flowWith([
    { id: 'a', type: 'wait', mode: 'until', until: { at: 'record.callbackAt' }, next: 'b' },
    { id: 'b', type: 'condition', if: 'record.done', then: 'done', else: 'a' },
    end('done'),
  ]);
  assert.deepEqual(codes(validateFlow(untilLoop, registry)), ['LOOP_WITHOUT_WAIT']);

  const withWait = flowWith([
    { id: 'a', type: 'condition', if: 'true', then: 'b', else: 'done' },
    task('b', 'pause'),
    { id: 'pause', type: 'wait', mode: 'duration', duration: '1h', next: 'a' },
    end('done'),
  ]);
  assert.equal(validateFlow(withWait, registry).ok, true);
  const awaited = flowWith([
    { id: 'a', type: 'condition', if: 'true', then: 'b', else: 'done' },
    { ...task('b', 'a'), await: true },
    end('done'),
  ]);
  assert.equal(validateFlow(awaited, registry).ok, true, 'an awaited action pauses');
});

test('max depth: the longest pause-free stretch is limited', () => {
  const steps = Array.from({ length: 12 }, (_, i) => task(`s${i}`, i < 11 ? `s${i + 1}` : undefined));
  const result = validateFlow(flowWith(steps), registry, { limits: { maxChain: 10 } });
  assert.deepEqual(codes(result), ['CHAIN_TOO_LONG']);
  assert.match(result.errors[0].message, /Up to 12 steps/);
  assert.equal(validateFlow(flowWith(steps), registry).ok, true, 'within the default limit');
  const tooMany = Array.from({ length: 201 }, (_, i) => end(`s${i}`));
  assert.ok(codes(validateFlow(flowWith(tooMany), registry)).includes('SCHEMA'));
});

test('module-declared actions validate with their own schemas', () => {
  const custom = createAutomationRegistry({
    actions: [{ key: 'payments.send_link', label: 'Send link', sideEffect: true, params: z.strictObject({ amountMinor: z.int().min(1), currency: z.literal('INR') }) }],
  });
  const flow = (params) => flowWith([{ id: 'a', type: 'action', action: 'payments.send_link', params }]);
  assert.equal(validateFlow(flow({ amountMinor: 50000, currency: 'INR' }), custom).ok, true);
  assert.deepEqual(validateFlow(flow({ amountMinor: 0, currency: 'USD' }), custom).errors.map((e) => e.path.at(-1)), ['amountMinor', 'currency']);
  assert.deepEqual(codes(validateFlow(flow({ amountMinor: 1, currency: 'INR' }), registry)), ['UNKNOWN_ACTION'], 'not in the core registry');
});

test('wait, approval and until shapes', () => {
  const ok = flowWith([
    { id: 'a', type: 'wait', mode: 'until', until: { timeOfDay: '09:30', timeZone: 'Asia/Kolkata', daysOfWeek: [1, 2, 3, 4, 5] }, next: 'b' },
    { id: 'b', type: 'wait', mode: 'until', until: { at: 'trigger.payload.startsAt - 1h' }, next: 'c' },
    { id: 'c', type: 'approval', title: 'OK?', approvers: { userIds: [ids.senior] }, timeout: '2d', next: 'd' },
    end('d'),
  ]);
  assert.deepEqual(validateFlow(ok, registry).errors, []);
  const bad = flowWith([
    { id: 'a', type: 'wait', mode: 'until', until: { timeOfDay: '25:00' }, next: 'b' },
    { id: 'b', type: 'wait', mode: 'event', event: 'booking.created', next: 'c' },
    { id: 'c', type: 'approval', title: 'OK?', approvers: {}, next: 'd' },
    { id: 'd', type: 'wait', mode: 'duration', duration: '400d', next: 'e' },
    { id: 'e', type: 'wait', mode: 'until', until: { timeOfDay: '09:00', timeZone: 'India/Pune' } },
  ]);
  const result = validateFlow(bad, registry);
  assert.deepEqual(
    result.errors.map((e) => e.stepId),
    ['a', 'b', 'c', 'd', 'e'],
    JSON.stringify(result.errors),
  );
  assert.match(errorFor(result, 'SCHEMA').message, /.+/);
  assert.ok(result.errors.find((e) => e.stepId === 'b').path.includes('timeout'), 'event waits need a timeout');
  assert.match(result.errors.find((e) => e.stepId === 'c').message, /Say who can approve/);
});

test('assertValidFlow returns the normalised flow or throws with the errors', () => {
  assert.equal(assertValidFlow(welcomeFlow(), registry).settings.reentry, 'skip_if_active');
  assert.throws(
    () => assertValidFlow(flowWith([{ id: 'a', type: 'action', action: 'sms.blast' }]), registry),
    (e) => e.code === 'FLOW_INVALID' && e.errors[0].code === 'UNKNOWN_ACTION',
  );
});
