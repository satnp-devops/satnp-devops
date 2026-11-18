import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  APPROVAL_DECIDED,
  EFFECT_RESULT,
  advance,
  canStartRun,
  cancelRun,
  matchTrigger,
  startRun,
} from '../../src/core/automation/interpreter.js';
import { assertValidFlow } from '../../src/core/automation/validate.js';
import { DAY, HOUR, NOW, at, chaserFlow, enquiryEvent, flowWith, followupFlow, ids, paymentEvent, registry, welcomeFlow } from './fixtures.js';

const valid = (def) => assertValidFlow(def, registry);
/** Applies an advance() result to a run, as the runner would after saving it. */
const apply = (run, result) => ({ ...run, status: result.status, state: result.state });
const step = (flow, run, options) => {
  const result = advance(flow, run, { registry, ...options });
  return { result, run: apply(run, result) };
};
const begin = (flow, event = enquiryEvent(), now = NOW) => step(flow, startRun(flow, { runId: 'run-1', event, now }), { now });
const resultEvent = (key, extra = {}) => ({ id: `res-${key}`, type: EFFECT_RESULT, idempotencyKey: key, ok: true, ...extra });
const decision = (key, extra) => ({ id: `dec-${key}`, type: APPROVAL_DECIDED, idempotencyKey: key, ...extra });
const deepFreeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
};

test('startRun pins the run to the flow version and records the trigger', () => {
  const flow = valid(welcomeFlow());
  const run = startRun(flow, { runId: 'run-1', event: enquiryEvent(), now: NOW });
  assert.equal(run.flowKey, 'new-enquiry-welcome');
  assert.equal(run.flowVersion, 1);
  assert.equal(run.status, 'running');
  assert.deepEqual(run.subject, { type: 'deal', id: ids.deal });
  assert.equal(run.startedAt, '2026-11-05T04:30:00.000Z');
  assert.equal(run.state.cursor, 'classify');
  assert.deepEqual(run.state.processedEventIds, ['evt-enquiry-1']);
  assert.throws(() => startRun(flow, { event: enquiryEvent(), now: NOW }), /runId/);
  assert.throws(() => startRun(flow, { runId: 'r', event: { payload: {} }, now: NOW }), /needs a type/);
  assert.throws(() => startRun(flow, { runId: 'r', event: enquiryEvent(), now: 'yesterday' }), /ISO 8601/);
});

test('a run only advances on the version it is pinned to', () => {
  const v1 = valid(welcomeFlow());
  const v2 = valid({ ...welcomeFlow(), version: 2 });
  const run = startRun(v1, { runId: 'run-1', event: enquiryEvent(), now: NOW });
  assert.throws(() => advance(v2, run, { registry, now: NOW }), (e) => e.code === 'VERSION_MISMATCH' && e.details.flowVersion === 1);
  assert.throws(() => advance(valid({ ...welcomeFlow(), key: 'other' }), run, { registry, now: NOW }), /VERSION_MISMATCH|pinned/);
  assert.throws(() => advance(v1, run, { now: NOW }), (e) => e.code === 'REGISTRY_REQUIRED');
  assert.throws(() => advance(v1, run, { registry, now: NOW, event: { id: 'x' } }), (e) => e.code === 'EVENT_INVALID');
});

test('matchTrigger checks event type, trigger config and the filter', () => {
  const flow = valid(welcomeFlow());
  assert.deepEqual(matchTrigger(flow, registry, enquiryEvent(), { now: NOW }), { matched: true });
  assert.equal(matchTrigger(flow, registry, { ...enquiryEvent(), type: 'deal.updated' }, { now: NOW }).reason, 'event_type');
  assert.equal(matchTrigger(flow, registry, enquiryEvent({ channel: 'import' }), { now: NOW }).reason, 'filter');
  const configured = valid({ ...welcomeFlow(), trigger: { type: 'enquiry.new', config: { channels: ['form'] } } });
  assert.equal(matchTrigger(configured, registry, enquiryEvent(), { now: NOW }).reason, 'config');
  const broken = valid({ ...welcomeFlow(), trigger: { type: 'enquiry.new', filter: 'trigger.payload.course > 5' } });
  const result = matchTrigger(broken, registry, enquiryEvent(), { now: NOW });
  assert.equal(result.reason, 'filter_error');
  assert.equal(result.error.code, 'EXPR_TYPE');
  const byRecord = valid({ ...welcomeFlow(), trigger: { type: 'enquiry.new', filter: "record.city == 'Pune'" } });
  assert.equal(matchTrigger(byRecord, registry, enquiryEvent(), { now: NOW, context: { record: { city: 'Pune' } } }).matched, true);
  assert.equal(matchTrigger(byRecord, registry, enquiryEvent(), { now: NOW }).matched, false);
});

test('re-entry rules', () => {
  const flow = (reentry) => ({ settings: { reentry } });
  assert.equal(canStartRun(flow('allow'), { activeRuns: 3, totalRuns: 9 }), true);
  assert.equal(canStartRun(flow('skip_if_active'), { activeRuns: 1, totalRuns: 1 }), false);
  assert.equal(canStartRun(flow('skip_if_active'), { activeRuns: 0, totalRuns: 4 }), true);
  assert.equal(canStartRun(flow('once'), { activeRuns: 0, totalRuns: 1 }), false);
  assert.equal(canStartRun(flow('once'), { activeRuns: 0, totalRuns: 0 }), true);
  assert.equal(canStartRun({}, { activeRuns: 1, totalRuns: 1 }), false, 'default is skip_if_active');
});

test('branching: the hot path and the otherwise path, with a trace for the UI', () => {
  const flow = valid(welcomeFlow());
  let { result, run } = begin(flow);
  assert.equal(result.status, 'waiting');
  assert.deepEqual(result.effects, [
    {
      action: 'ai.run',
      params: { agent: 'classifier', input: { text: 'JEE 2027 enquiry from instagram', labels: ['hot', 'warm', 'cold'] } },
      idempotencyKey: 'run-1:classify:1',
      runId: 'run-1',
      stepId: 'classify',
      subject: { type: 'deal', id: ids.deal },
      await: true,
    },
  ]);
  assert.deepEqual(result.waitingFor, { kind: 'effect', stepId: 'classify', until: '2026-11-05T05:30:00.000Z', idempotencyKey: 'run-1:classify:1' });

  const hot = step(flow, run, { now: at(1000), event: resultEvent('run-1:classify:1', { output: { label: 'hot', confidence: 0.92 } }) });
  assert.equal(hot.result.status, 'waiting');
  assert.deepEqual(hot.result.effects.map((e) => [e.action, e.idempotencyKey]), [
    ['records.assign', 'run-1:assign_senior:1'],
    ['messaging.send_template', 'run-1:welcome:1'],
  ]);
  assert.deepEqual(hot.result.effects[1].params, { channel: 'whatsapp', template: 'welcome_v1', recipient: 'contact', variables: { course: 'JEE 2027' } });
  assert.deepEqual(
    hot.result.trace.map((t) => [t.phase, t.stepId, t.outcome]),
    [
      ['resume', 'classify', 'result'],
      ['run', 'route', 'case'],
      ['run', 'assign_senior', 'emitted'],
      ['run', 'welcome', 'emitted'],
      ['run', 'wait_booking', 'waiting'],
    ],
  );
  assert.deepEqual(hot.result.trace[1].detail, { index: 0, label: 'Hot' });
  assert.equal(hot.result.trace[1].next, 'assign_senior');
  assert.equal(hot.run.state.steps.classify.output.label, 'hot');

  ({ result } = step(flow, run, { now: at(1000), event: resultEvent('run-1:classify:1', { output: { label: 'cold', confidence: 0.7 } }) }));
  assert.deepEqual(result.trace.filter((t) => t.phase === 'run').map((t) => [t.stepId, t.outcome]), [
    ['route', 'otherwise'],
    ['welcome', 'emitted'],
    ['wait_booking', 'waiting'],
  ]);
});

test('condition steps take then or else; a missing pointer ends the run', () => {
  const flow = valid(
    flowWith([
      { id: 'a', type: 'condition', if: "trigger.payload.channel == 'whatsapp'", then: 'yes', else: 'no' },
      { id: 'yes', type: 'action', action: 'tasks.create', params: { title: 'WhatsApp lead' } },
      { id: 'no', type: 'condition', if: 'false', then: 'yes' },
    ]),
  );
  let { result } = begin(flow);
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.trace.map((t) => [t.stepId, t.outcome]), [['a', 'then'], ['yes', 'emitted'], [null, 'completed']]);
  ({ result } = begin(flow, enquiryEvent({ channel: 'form' })));
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.effects, []);
  assert.deepEqual(result.trace.map((t) => [t.stepId, t.outcome]), [['a', 'else'], ['no', 'else'], [null, 'completed']]);
});

test('wait for a duration: early or repeated timers are ignored, the due timer resumes', () => {
  const flow = valid(
    flowWith([
      { id: 'pause', type: 'wait', mode: 'duration', duration: '2h', next: 'call' },
      { id: 'call', type: 'action', action: 'tasks.create', params: { title: 'Call now' } },
    ]),
  );
  let { result, run } = begin(flow);
  assert.equal(result.status, 'waiting');
  assert.equal(result.nextWakeAt, '2026-11-05T06:30:00.000Z');
  assert.deepEqual(result.waitingFor, { kind: 'timer', stepId: 'pause', until: '2026-11-05T06:30:00.000Z' });

  const early = advance(flow, run, { registry, now: at(HOUR) });
  assert.equal(early.changed, false);
  assert.equal(early.ignored, 'not_due');
  assert.equal(early.state, run.state, 'state untouched');
  assert.equal(advance(flow, run, { registry, now: at(HOUR), event: { id: 'e', type: 'booking.created' } }).ignored, 'not_waiting_for_event');

  ({ result, run } = step(flow, run, { now: at(2 * HOUR) }));
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.effects.map((e) => e.idempotencyKey), ['run-1:call:1']);
  assert.equal(run.state.steps.pause.status, 'done');
  assert.equal(advance(flow, run, { registry, now: at(3 * HOUR) }).ignored, 'finished', 'a second timer after the end is a no-op');
});

test('wait until a local time of day uses the step zone, else the flow zone', () => {
  const flow = valid(
    flowWith(
      [
        { id: 'a', type: 'wait', mode: 'until', until: { timeOfDay: '09:00', daysOfWeek: [1, 2, 3, 4, 5] }, next: 'b' },
        { id: 'b', type: 'wait', mode: 'until', until: { timeOfDay: '09:00', timeZone: 'America/New_York' }, next: 'c' },
        { id: 'c', type: 'end' },
      ],
      { settings: { timeZone: 'Asia/Kolkata' } },
    ),
  );
  let { result, run } = begin(flow);
  assert.equal(result.nextWakeAt, '2026-11-06T03:30:00.000Z', 'next weekday 09:00 IST');
  ({ result, run } = step(flow, run, { now: Date.parse('2026-11-06T03:30:00Z') }));
  assert.equal(result.nextWakeAt, '2026-11-06T14:00:00.000Z', '09:00 EST');
  ({ result } = step(flow, run, { now: Date.parse('2026-11-06T14:00:00Z') }));
  assert.equal(result.status, 'completed');
});

test('wait until an expression time: future waits, past continues, empty fails', () => {
  const flow = valid(
    flowWith([
      { id: 'a', type: 'wait', mode: 'until', until: { at: 'trigger.payload.startsAt - 1h' }, next: 'remind' },
      { id: 'remind', type: 'action', action: 'tasks.create', params: { title: 'Session in an hour' } },
    ]),
  );
  let { result } = begin(flow, enquiryEvent({ startsAt: '2026-11-06T04:30:00Z' }));
  assert.equal(result.nextWakeAt, '2026-11-06T03:30:00.000Z');
  ({ result } = begin(flow, enquiryEvent({ startsAt: '2026-11-05T05:00:00Z' })));
  assert.equal(result.status, 'completed', 'an hour before is already past');
  assert.deepEqual(result.trace[0].detail, { until: '2026-11-05T04:00:00.000Z' });
  assert.equal(result.trace[0].outcome, 'passed');
  ({ result } = begin(flow, enquiryEvent()));
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.error, { stepId: 'a', code: 'WAIT_TIME_INVALID', message: '"trigger.payload.startsAt - 1h" did not give a time' });
});

test('wait for an event: matching events resume, others are ignored, the timeout takes onTimeout', () => {
  const flow = valid(welcomeFlow());
  let { run } = begin(flow);
  ({ run } = step(flow, run, { now: at(1000), event: resultEvent('run-1:classify:1', { output: { label: 'warm', confidence: 0.5 } }) }));
  assert.equal(run.state.waiting.kind, 'event');
  assert.equal(run.state.waiting.wakeAt, new Date(at(1000) + 3 * DAY).toISOString());

  const otherDeal = advance(flow, run, { registry, now: at(HOUR), event: { id: 'b1', type: 'booking.created', payload: { dealId: 'someone-else' } } });
  assert.equal(otherDeal.ignored, 'not_matching');
  const otherType = advance(flow, run, { registry, now: at(HOUR), event: { id: 'm1', type: 'meeting.ended', payload: { dealId: ids.deal } } });
  assert.equal(otherType.ignored, 'not_matching');

  const booking = { id: 'b2', type: 'booking.created', payload: { dealId: ids.deal, startsAt: '2026-11-07T05:30:00Z' } };
  const booked = step(flow, run, { now: at(HOUR), event: booking });
  assert.equal(booked.result.status, 'completed');
  assert.equal(booked.result.consumed, true);
  assert.deepEqual(booked.run.state.steps.wait_booking.output, booking);
  assert.equal(booked.run.state.steps.wait_booking.timedOut, false);
  assert.deepEqual(booked.run.state.lastEvent, booking, 'later steps see it as event');
  assert.ok(booked.run.state.processedEventIds.includes('b2'));

  const late = step(flow, run, { now: at(3 * DAY + 1000) });
  assert.equal(late.result.status, 'completed');
  assert.deepEqual(late.result.trace.map((t) => [t.stepId, t.outcome]), [['wait_booking', 'timeout'], ['nudge', 'emitted'], ['done', 'completed']]);
  assert.deepEqual(late.result.effects[0].params, { title: 'Call the JEE 2027 enquiry', dueIn: '2h', assignee: 'owner', priority: 'normal' });
  assert.equal(late.run.state.steps.wait_booking.timedOut, true);

  const alsoLate = step(flow, run, { now: at(3 * DAY + 1000), event: { id: 'x', type: 'deal.updated' } });
  assert.equal(alsoLate.result.consumed, false, 'an unrelated event after the deadline fires the timeout but is not consumed');
  assert.equal(alsoLate.result.status, 'completed');
});

test('an event wait without onTimeout continues at next with timedOut set; filter errors ignore the event', () => {
  const flow = valid(
    flowWith([
      { id: 'w', type: 'wait', mode: 'event', event: 'meeting.ended', filter: 'event.payload.minutes > 10', timeout: '1d', next: 'check' },
      { id: 'check', type: 'condition', if: 'steps.w.timedOut', then: 'missed', else: 'met' },
      { id: 'missed', type: 'action', action: 'tasks.create', params: { title: 'No meeting' } },
      { id: 'met', type: 'action', action: 'tasks.create', params: { title: 'Met for {{ event.payload.minutes }} minutes' } },
    ]),
  );
  const { run } = begin(flow);
  const bad = advance(flow, run, { registry, now: at(HOUR), event: { id: 'm0', type: 'meeting.ended', payload: { minutes: 'long' } } });
  assert.equal(bad.ignored, 'filter_error');
  assert.equal(bad.eventError.code, 'EXPR_TYPE');
  const met = step(flow, run, { now: at(HOUR), event: { id: 'm1', type: 'meeting.ended', payload: { minutes: 30 } } });
  assert.equal(met.result.effects[0].params.title, 'Met for 30 minutes');
  const missed = step(flow, run, { now: at(DAY) });
  assert.equal(missed.result.effects[0].params.title, 'No meeting');
});

test('idempotency: re-running the same input gives the same effects and keys; nothing is mutated', () => {
  const flow = deepFreeze(valid(welcomeFlow()));
  const run = deepFreeze(startRun(flow, { runId: 'run-7', event: enquiryEvent(), now: NOW }));
  const first = advance(flow, run, { registry, now: NOW });
  const second = advance(flow, run, { registry, now: NOW });
  assert.deepEqual(second, first, 'deterministic');
  assert.equal(first.effects[0].idempotencyKey, 'run-7:classify:1');
  assert.equal(run.state.cursor, 'classify', 'input run untouched');

  const resumed = apply(run, first);
  const result = resultEvent('run-7:classify:1', { output: { label: 'hot', confidence: 1 } });
  const a = advance(flow, resumed, { registry, now: at(5), event: result });
  const b = advance(flow, resumed, { registry, now: at(5), event: result });
  assert.deepEqual(a.effects, b.effects, 'a crash before saving replays the same keys for the executor to skip');
});

test('idempotency: re-delivered events are ignored once consumed', () => {
  const flow = valid(welcomeFlow());
  let { run } = begin(flow);
  assert.equal(advance(flow, run, { registry, now: NOW, event: enquiryEvent() }).ignored, 'duplicate', 'the trigger event again');
  const result = resultEvent('run-1:classify:1', { output: { label: 'warm', confidence: 0.4 } });
  ({ run } = step(flow, run, { now: at(10), event: result }));
  const again = advance(flow, run, { registry, now: at(20), event: result });
  assert.equal(again.ignored, 'duplicate');
  assert.equal(again.changed, false);
  assert.deepEqual(again.effects, []);
  const booking = { id: 'b9', type: 'booking.created', payload: { dealId: ids.deal } };
  ({ run } = step(flow, run, { now: at(30), event: booking }));
  assert.equal(run.status, 'completed');
  assert.equal(advance(flow, run, { registry, now: at(40), event: booking }).ignored, 'finished');
});

test('idempotency keys count visits, so loops get a fresh key each time round', () => {
  const flow = valid(chaserFlow());
  let { result, run } = begin(flow, paymentEvent());
  const keys = [];
  for (let round = 1; round <= 3; round += 1) {
    const ai = result.effects.find((e) => e.action === 'ai.run');
    assert.equal(ai.idempotencyKey, `run-1:chase:${round}`);
    assert.equal(ai.params.input.attempt, round);
    keys.push(ai.idempotencyKey);
    ({ result, run } = step(flow, run, {
      now: at((round - 1) * DAY + 1000),
      event: resultEvent(ai.idempotencyKey, { output: { message: `Reminder ${round}`, tone: 'gentle', escalate: false } }),
    }));
    assert.equal(result.effects[0].params.variables.text, `Reminder ${round}`);
    keys.push(result.effects[0].idempotencyKey);
    ({ result, run } = step(flow, run, { now: at(round * DAY + 1000) }));
  }
  assert.equal(result.status, 'completed');
  assert.equal(run.state.endReason, 'three reminders sent');
  assert.deepEqual(keys, ['run-1:chase:1', 'run-1:remind:1', 'run-1:chase:2', 'run-1:remind:2', 'run-1:chase:3', 'run-1:remind:3']);
  assert.equal(new Set(keys).size, keys.length);
});

test('awaited actions: wrong keys are ignored, failures go to onError or fail the run, slow results time out', () => {
  const def = (onError) =>
    valid(
      flowWith([
        { id: 'hook', type: 'action', action: 'http.call_webhook', params: { url: 'https://hooks.example.com/x', body: { deal: '{{ trigger.payload.dealId }}' } }, await: true, timeout: '10m', next: 'ok', ...(onError ? { onError } : {}) },
        { id: 'ok', type: 'action', action: 'tasks.create', params: { title: 'Synced (status {{ steps.hook.output.status }})' } },
        ...(onError ? [{ id: 'oops', type: 'action', action: 'tasks.create', params: { title: 'Sync failed: {{ steps.hook.error.message }}' } }] : []),
      ]),
    );
  const withHandler = valid({ ...def('oops') });
  let { result, run } = begin(withHandler);
  assert.equal(result.effects[0].params.body.deal, ids.deal);
  assert.equal(result.effects[0].await, true);
  assert.equal(advance(withHandler, run, { registry, now: at(1), event: resultEvent('run-1:other:1') }).ignored, 'not_matching');

  const done = step(withHandler, run, { now: at(1), event: resultEvent('run-1:hook:1', { output: { status: 204 } }) });
  assert.equal(done.result.effects[0].params.title, 'Synced (status 204)');

  const failed = step(withHandler, run, { now: at(1), event: resultEvent('run-1:hook:1', { ok: false, error: { code: 'HTTP_500', message: 'Server error' } }) });
  assert.equal(failed.result.status, 'completed');
  assert.equal(failed.result.effects[0].params.title, 'Sync failed: Server error');
  assert.equal(failed.run.state.steps.hook.status, 'error');

  const slow = step(withHandler, run, { now: at(10 * 60_000) });
  assert.equal(slow.run.state.steps.hook.error.code, 'EFFECT_TIMEOUT');

  const noHandler = valid(def());
  ({ run } = begin(noHandler));
  ({ result } = step(noHandler, run, { now: at(1), event: resultEvent('run-1:hook:1', { ok: false }) }));
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.error, { stepId: 'hook', code: 'EFFECT_FAILED', message: 'The action failed' });
  assert.equal(result.waitingFor, null);
});

test('AI steps: inputs are validated before the call and outputs against the agent schema', () => {
  const flow = valid(welcomeFlow());
  let { run } = begin(flow);
  const invalid = step(flow, run, { now: at(1), event: resultEvent('run-1:classify:1', { output: { label: 'hot' } }) });
  assert.equal(invalid.run.state.steps.classify.error.code, 'AI_OUTPUT_INVALID');
  assert.match(invalid.run.state.steps.classify.error.message, /confidence/);
  assert.deepEqual(invalid.result.trace.map((t) => t.stepId).slice(0, 2), ['classify', 'welcome'], 'onError goes on to the welcome');

  const dynamicLabels = valid(
    flowWith([{ id: 'c', type: 'ai_step', agent: 'classifier', input: { text: 'hello', labels: { $expr: 'record.labels' } } }]),
  );
  ({ run } = { run: startRun(dynamicLabels, { runId: 'r', event: enquiryEvent(), now: NOW }) });
  const bad = advance(dynamicLabels, run, { registry, now: NOW, context: { record: { labels: ['only'] } } });
  assert.equal(bad.status, 'failed');
  assert.equal(bad.error.code, 'PARAMS_INVALID');
  assert.match(bad.error.message, /labels/);
  const good = advance(dynamicLabels, run, { registry, now: NOW, context: { record: { labels: ['a', 'b'] } } });
  assert.deepEqual(good.effects[0].params.input.labels, ['a', 'b']);
});

test('approvals: approve with edits, reject, time out, bad decisions', () => {
  const flow = valid(followupFlow());
  const meeting = { id: 'meet-1', type: 'meeting.ended', subject: { type: 'deal', id: ids.deal }, payload: { dealId: ids.deal, attendance: 'attended', notes: 'weekend batch' } };
  let { result, run } = begin(flow, meeting);
  assert.equal(result.effects[0].params.input.purpose, 'Follow up on weekend batch');
  ({ result, run } = step(flow, run, { now: at(1), event: resultEvent('run-1:write:1', { output: { draft: 'Hi! About the weekend batch...' } }) }));
  assert.deepEqual(result.effects, [
    {
      action: 'automation.request_approval',
      params: {
        title: `Approve the follow-up for deal ${ids.deal}`,
        approvers: { owner: true },
        expiresAt: new Date(at(1) + DAY).toISOString(),
        data: { draft: 'Hi! About the weekend batch...' },
      },
      idempotencyKey: 'run-1:review:1',
      runId: 'run-1',
      stepId: 'review',
      subject: { type: 'deal', id: ids.deal },
      await: true,
    },
  ]);
  assert.equal(result.waitingFor.kind, 'approval');

  const edited = step(flow, run, { now: at(HOUR), event: decision('run-1:review:1', { decision: 'approved', decidedBy: ids.senior, data: { draft: 'Edited by counsellor' } }) });
  assert.equal(edited.result.status, 'completed');
  assert.equal(edited.result.effects[0].params.variables.body, 'Edited by counsellor');
  assert.equal(edited.run.state.steps.review.output.edited, true);
  assert.equal(edited.run.state.steps.review.output.decidedBy, ids.senior);

  const asIs = step(flow, run, { now: at(HOUR), event: decision('run-1:review:1', { decision: 'approved' }) });
  assert.equal(asIs.result.effects[0].params.variables.body, 'Hi! About the weekend batch...');

  const rejected = step(flow, run, { now: at(HOUR), event: decision('run-1:review:1', { decision: 'rejected', comment: 'Too pushy' }) });
  assert.deepEqual(rejected.result.effects.map((e) => e.stepId), ['task']);
  assert.equal(rejected.run.state.steps.review.output.comment, 'Too pushy');

  const timedOut = step(flow, run, { now: at(DAY + 1) });
  assert.deepEqual(timedOut.result.effects.map((e) => e.stepId), ['task']);
  assert.equal(timedOut.run.state.steps.review.status, 'timed_out');

  assert.equal(advance(flow, run, { registry, now: at(HOUR), event: decision('run-1:review:1', { decision: 'maybe' }) }).ignored, 'bad_decision');
  assert.equal(advance(flow, run, { registry, now: at(HOUR), event: decision('run-1:other:1', { decision: 'approved' }) }).ignored, 'not_matching');
});

test('a rejection or approval timeout without a pointer ends the run', () => {
  const flow = valid(flowWith([{ id: 'ask', type: 'approval', title: 'Go?', approvers: { permission: 'deals.manage' }, next: 'go' }, { id: 'go', type: 'end' }]));
  const { run, result } = begin(flow);
  assert.equal(result.nextWakeAt, null, 'no timeout: waits until decided');
  const rejected = step(flow, run, { now: at(1), event: decision('run-1:ask:1', { decision: 'rejected' }) });
  assert.equal(rejected.result.status, 'completed');
  assert.equal(advance(flow, run, { registry, now: at(365 * DAY) }).ignored, 'not_due');
});

test('runtime problems: bad params and expression type errors fail the run with the step and reason', () => {
  const flow = valid(flowWith([{ id: 'give', type: 'action', action: 'records.assign', params: { strategy: 'user', userId: { $expr: 'record.ownerId' } } }]));
  const run = startRun(flow, { runId: 'r', event: enquiryEvent(), now: NOW });
  const bad = advance(flow, run, { registry, now: NOW, context: { record: { ownerId: 'not-a-uuid' } } });
  assert.equal(bad.status, 'failed');
  assert.equal(bad.error.stepId, 'give');
  assert.equal(bad.error.code, 'PARAMS_INVALID');
  assert.match(bad.error.message, /^userId: /);
  const good = advance(flow, run, { registry, now: NOW, context: { record: { ownerId: ids.senior } } });
  assert.equal(good.effects[0].params.userId, ids.senior);

  const typed = valid(flowWith([{ id: 'c', type: 'condition', if: 'trigger.payload.course > 5', then: 'd' }, { id: 'd', type: 'end' }]));
  const failed = advance(typed, startRun(typed, { runId: 'r', event: enquiryEvent(), now: NOW }), { registry, now: NOW });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.code, 'EXPR_TYPE');
  assert.equal(failed.error.stepId, 'c');
  assert.match(failed.error.message, /Cannot compare text with a number \(column 24\)/);

  const tpl = valid(flowWith([{ id: 't', type: 'action', action: 'tasks.create', params: { title: 'X {{ trigger.payload.course - 1 }}' }, onError: 'e' }, { id: 'e', type: 'end', reason: 'bad title' }]));
  const routed = advance(tpl, startRun(tpl, { runId: 'r', event: enquiryEvent(), now: NOW }), { registry, now: NOW });
  assert.equal(routed.status, 'completed', 'expression errors in params go to onError');
  assert.match(routed.state.steps.t.error.message, /^params\.title: Cannot apply "-"/);
});

test('context roots: record and extra roots are readable, reserved roots cannot be replaced', () => {
  const flow = assertValidFlow(
    flowWith([{ id: 'a', type: 'action', action: 'tasks.create', params: { title: '{{ record.name }} / {{ contact.city }} / {{ trigger.type }} / {{ run.subject.type }}' } }]),
    registry,
    { roots: ['contact'] },
  );
  const run = startRun(flow, { runId: 'r', event: enquiryEvent(), now: NOW });
  const result = advance(flow, run, { registry, now: NOW, context: { record: { name: 'Aarav' }, contact: { city: 'Pune' }, trigger: { type: 'forged' }, steps: { x: 1 } } });
  assert.equal(result.effects[0].params.title, 'Aarav / Pune / deal.created / deal');
});

test('limits: steps per advance and steps per run', () => {
  // A pause-free loop can't pass validation; the interpreter still defends itself.
  const spinning = { ...flowWith([{ id: 'a', type: 'condition', if: 'true', then: 'a' }]), settings: { maxStepsPerRun: 500 } };
  const run = startRun(spinning, { runId: 'r', event: enquiryEvent(), now: NOW });
  const result = advance(spinning, run, { registry, now: NOW, limits: { maxStepsPerAdvance: 25 } });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'STEP_LIMIT');
  assert.equal(result.state.stepCount, 25);

  const chaser = valid({ ...chaserFlow(), settings: { maxStepsPerRun: 6 } });
  let { result: r, run: current } = begin(chaser, paymentEvent());
  ({ result: r, run: current } = step(chaser, current, { now: at(1), event: resultEvent('run-1:chase:1', { output: { message: 'm', tone: 'gentle', escalate: false } }) }));
  ({ result: r, run: current } = step(chaser, current, { now: at(DAY + 1) }));
  ({ result: r, run: current } = step(chaser, current, { now: at(DAY + 2), event: resultEvent('run-1:chase:2', { output: { message: 'm', tone: 'firm', escalate: false } }) }));
  assert.equal(r.status, 'failed');
  assert.equal(r.error.code, 'RUN_STEP_LIMIT');
});

test('trace and remembered event ids are bounded', () => {
  const flow = valid(chaserFlow());
  let { run } = begin(flow, paymentEvent());
  const limits = { traceSize: 5, processedEvents: 2 };
  for (let round = 1; round <= 3; round += 1) {
    ({ run } = step(flow, run, { now: at(round * DAY), limits, event: resultEvent(`run-1:chase:${round}`, { output: { message: 'm', tone: 'gentle', escalate: false } }) }));
    ({ run } = step(flow, run, { now: at(round * DAY + DAY), limits }));
  }
  assert.equal(run.status, 'completed');
  assert.equal(run.state.trace.length, 5);
  assert.ok(run.state.traceDropped > 0);
  assert.equal(run.state.trace.at(-1).seq, run.state.traceSeq - 1);
  assert.deepEqual(run.state.processedEventIds, ['res-run-1:chase:2', 'res-run-1:chase:3']);
});

test('end steps can cancel; cancelRun stops a waiting run', () => {
  const flow = valid(flowWith([{ id: 'stop', type: 'end', outcome: 'cancelled', reason: 'duplicate enquiry' }]));
  const { result } = begin(flow);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.state.endReason, 'duplicate enquiry');

  const waiting = begin(valid(welcomeFlow())).run;
  const cancelled = cancelRun(waiting, { now: at(5), reason: 'deal closed' });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.state.waiting, null);
  assert.equal(cancelled.state.trace.at(-1).outcome, 'cancelled');
  assert.equal(waiting.state.waiting.kind, 'effect', 'input untouched');
  assert.equal(cancelRun({ ...waiting, status: 'completed' }, { now: at(5) }).changed, false);
});

test('a waiting run without a wait record is reported, not guessed at', () => {
  const flow = valid(welcomeFlow());
  const { run } = begin(flow);
  assert.throws(() => advance(flow, { ...run, state: { ...run.state, waiting: null } }, { registry, now: NOW }), (e) => e.code === 'RUN_STATE_INVALID');
});
