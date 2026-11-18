import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulate } from '../../src/core/automation/simulate.js';
import { chaserFlow, enquiryEvent, flowWith, followupFlow, ids, NOW, paymentEvent, registry, welcomeFlow } from './fixtures.js';

test('an invalid flow returns its validation errors instead of a run', () => {
  const result = simulate(flowWith([{ id: 'a', type: 'action', action: 'sms.blast' }]), registry, { now: NOW });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'UNKNOWN_ACTION');
});

test('the trigger filter decides whether a run starts; force runs it anyway', () => {
  const skipped = simulate(welcomeFlow(), registry, { now: NOW, event: enquiryEvent({ channel: 'import' }) });
  assert.equal(skipped.ok, true);
  assert.equal(skipped.matched, false);
  assert.equal(skipped.matchReason, 'filter');
  assert.equal(skipped.status, 'not_started');
  assert.deepEqual(skipped.effects, []);
  const forced = simulate(welcomeFlow(), registry, { now: NOW, event: enquiryEvent({ channel: 'import' }), force: true });
  assert.equal(forced.status, 'completed');
});

test('the default sample event and sample AI output drive a full dry run', () => {
  const result = simulate(welcomeFlow(), registry, { now: NOW });
  assert.equal(result.matched, true);
  assert.equal(result.event.type, 'deal.created', "the trigger's sample event");
  assert.equal(result.event.payload.channel, 'form');
  assert.equal(result.status, 'completed');
  // The classifier sample says admission_enquiry, so the otherwise branch runs; no booking arrives, so the wait times out.
  assert.deepEqual(result.path, ['classify', 'route', 'welcome', 'wait_booking', 'nudge', 'done']);
  assert.deepEqual(result.branches, [{ stepId: 'route', outcome: 'otherwise' }]);
  assert.deepEqual(result.effects.map((e) => [e.action, e.stepId, e.at, e.simulated, e.sideEffect]), [
    ['ai.run', 'classify', '2026-11-05T04:30:00.000Z', true, false],
    ['messaging.send_template', 'welcome', '2026-11-05T04:30:00.000Z', true, true],
    ['tasks.create', 'nudge', '2026-11-08T04:30:00.000Z', true, true],
  ]);
  assert.deepEqual(result.waits.map((w) => [w.kind, w.stepId, w.from, w.until]), [
    ['effect', 'classify', '2026-11-05T04:30:00.000Z', '2026-11-05T05:30:00.000Z'],
    ['event', 'wait_booking', '2026-11-05T04:30:00.000Z', '2026-11-08T04:30:00.000Z'],
  ]);
  assert.equal(result.endedAt, '2026-11-08T04:30:00.000Z');
  assert.equal(result.error, null);
});

test('scripted AI results pick the branch; sample events arrive at their times', () => {
  const result = simulate(welcomeFlow(), registry, {
    now: NOW,
    event: enquiryEvent(),
    results: { classify: { label: 'hot', confidence: 0.95 } },
    events: [
      { after: '2h', event: { type: 'booking.created', payload: { dealId: 'another-deal' } } },
      { after: '1d', event: { type: 'booking.created', payload: { dealId: ids.deal } } },
    ],
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.path, ['classify', 'route', 'assign_senior', 'welcome', 'wait_booking', 'done']);
  assert.deepEqual(result.branches, [{ stepId: 'route', outcome: 'case', detail: { index: 0, label: 'Hot' } }]);
  assert.deepEqual(result.deliveries, [
    { eventId: 'sim-event-1', type: 'booking.created', at: '2026-11-05T06:30:00.000Z', consumed: false, ignored: 'not_matching' },
    { eventId: 'sim-event-2', type: 'booking.created', at: '2026-11-06T04:30:00.000Z', consumed: true, ignored: null },
  ]);
  assert.equal(result.endedAt, '2026-11-06T04:30:00.000Z');
  assert.ok(!result.effects.some((e) => e.action === 'tasks.create'), 'no nudge after a booking');
});

test('an event after the timeout is too late', () => {
  const result = simulate(welcomeFlow(), registry, {
    now: NOW,
    event: enquiryEvent(),
    events: [{ at: '2026-11-09T00:00:00Z', event: { type: 'booking.created', payload: { dealId: ids.deal } } }],
  });
  assert.deepEqual(result.path.slice(-2), ['nudge', 'done']);
  assert.deepEqual(result.deliveries, [], 'the run finished before it arrived');
});

test('failed AI calls follow onError', () => {
  const result = simulate(welcomeFlow(), registry, { now: NOW, results: { classify: { ok: false, error: { code: 'AI_UNAVAILABLE', message: 'Model busy' } } } });
  assert.deepEqual(result.path.slice(0, 2), ['classify', 'welcome']);
  assert.equal(result.finalState.steps.classify.error.code, 'AI_UNAVAILABLE');
});

test('approvals: approved by default, or scripted as rejected, edited or timed out', () => {
  const approved = simulate(followupFlow(), registry, { now: NOW });
  assert.deepEqual(approved.path, ['write', 'review', 'send']);
  assert.equal(approved.effects.at(-1).params.variables.body, registry.agent('followup_writer').sampleOutput.draft);

  const edited = simulate(followupFlow(), registry, { now: NOW, approvals: { review: { decision: 'approved', data: { draft: 'Shorter text' } } } });
  assert.equal(edited.effects.at(-1).params.variables.body, 'Shorter text');

  const rejected = simulate(followupFlow(), registry, { now: NOW, approvals: { review: 'rejected' } });
  assert.deepEqual(rejected.path, ['write', 'review', 'task']);

  const timedOut = simulate(followupFlow(), registry, { now: NOW, approvals: { review: 'timeout' } });
  assert.deepEqual(timedOut.path, ['write', 'review', 'task']);
  assert.equal(timedOut.endedAt, '2026-11-06T04:30:00.000Z');
});

test('meeting trigger config: a no-show does not start the follow-up', () => {
  const result = simulate(followupFlow(), registry, { now: NOW, event: { type: 'meeting.ended', payload: { attendance: 'no_show' } } });
  assert.equal(result.matched, false);
  assert.equal(result.matchReason, 'config');
});

test('loops through waits run to the end with per-visit results', () => {
  const result = simulate(chaserFlow(), registry, {
    now: NOW,
    event: paymentEvent(),
    results: {
      chase: [
        { message: 'Gentle reminder', tone: 'gentle', escalate: false },
        { message: 'Firm reminder', tone: 'firm', escalate: false },
        { message: 'Final reminder', tone: 'final', escalate: true },
      ],
    },
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(
    result.effects.filter((e) => e.action === 'messaging.send_template').map((e) => [e.params.variables.text, e.at]),
    [
      ['Gentle reminder', '2026-11-05T04:30:00.000Z'],
      ['Firm reminder', '2026-11-06T04:30:00.000Z'],
      ['Final reminder', '2026-11-07T04:30:00.000Z'],
    ],
  );
  assert.deepEqual(result.branches.map((b) => b.outcome), ['then', 'then', 'else']);
  assert.equal(result.path.at(-1), 'stop');
});

test('a run that would wait forever is reported, not looped', () => {
  const flow = flowWith([{ id: 'ask', type: 'approval', title: 'OK?', approvers: { owner: true }, next: 'done' }, { id: 'done', type: 'end' }]);
  const result = simulate(flow, registry, { now: NOW, approvals: { ask: 'timeout' } });
  assert.equal(result.status, 'waiting');
  assert.equal(result.error.code, 'WAITS_FOREVER');
  assert.equal(result.error.stepId, 'ask');
});

test('runtime failures show up with the step and reason', () => {
  const flow = flowWith([{ id: 'c', type: 'condition', if: 'trigger.payload.course > 3', then: 'd' }, { id: 'd', type: 'end' }]);
  const result = simulate(flow, registry, { now: NOW, event: enquiryEvent() });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'EXPR_TYPE');
  assert.equal(result.error.stepId, 'c');
});

test('simulation never performs anything and needs an explicit clock', () => {
  const result = simulate(welcomeFlow(), registry, { now: NOW });
  assert.ok(result.effects.every((e) => e.simulated === true));
  assert.throws(() => simulate(welcomeFlow(), registry, {}), /ISO 8601/);
});
