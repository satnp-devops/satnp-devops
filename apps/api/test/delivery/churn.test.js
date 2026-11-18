import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dueReminders, scoreChurnRisk, upsellFlags } from '../../src/modules/delivery/churn.js';

const rules = { inactiveDays: 30, mediumScore: 30, highScore: 60 };
const healthy = {
  daysSinceActivity: 3,
  overdueTasks: 0,
  recentLostDeals: 0,
  implementation: { status: 'live', overdue: false },
  consentWithdrawn: false,
  daysToRenewal: 80,
  autoRenew: true,
  openDeals: 0,
};

test('a healthy account is low risk with no signals', () => {
  assert.deepEqual(scoreChurnRisk(healthy, rules), { score: 0, level: 'low', signals: [] });
});

test('signals add up to medium and high', () => {
  const quiet = scoreChurnRisk({ ...healthy, daysSinceActivity: 40, overdueTasks: 2 }, rules);
  assert.equal(quiet.score, 30);
  assert.equal(quiet.level, 'medium');
  assert.deepEqual(quiet.signals.map((s) => s.key), ['quiet', 'overdue_tasks']);
  const bad = scoreChurnRisk({ ...healthy, daysSinceActivity: null, implementation: { status: 'in_progress', overdue: true }, daysToRenewal: 12, autoRenew: false }, rules);
  assert.deepEqual(bad.signals.map((s) => s.key), ['never_contacted', 'implementation_overdue', 'renewal_unattended']);
  assert.equal(bad.score, 70);
  assert.equal(bad.level, 'high');
});

test('the score is capped at 100 and very quiet replaces quiet', () => {
  const worst = scoreChurnRisk(
    { daysSinceActivity: 90, overdueTasks: 9, recentLostDeals: 2, implementation: { status: 'cancelled', overdue: true }, consentWithdrawn: true, daysToRenewal: 5, autoRenew: false, openDeals: 0 },
    rules,
  );
  assert.equal(worst.score, 100);
  assert.ok(worst.signals.some((s) => s.key === 'very_quiet'));
  assert.ok(!worst.signals.some((s) => s.key === 'quiet'));
  assert.equal(worst.signals.find((s) => s.key === 'overdue_tasks').points, 15);
});

test('an open deal or auto-renew means the renewal is looked after', () => {
  assert.equal(scoreChurnRisk({ ...healthy, daysToRenewal: 10, autoRenew: false, openDeals: 1 }, rules).score, 0);
  assert.equal(scoreChurnRisk({ ...healthy, daysToRenewal: 10, autoRenew: true }, rules).score, 0);
});

test('upsell flags: more students than seats, and lines not bought yet', () => {
  const flags = upsellFlags({ seats: 200, studentCount: 350, ownedLineIds: ['erp'], offeredLines: [{ id: 'erp', name: 'Coaching ERP' }, { id: 'te', name: 'Test Engine' }] });
  assert.deepEqual(flags.map((f) => f.key), ['seats_exceeded', 'cross_sell']);
  assert.equal(flags[1].label, 'Not using Test Engine');
  assert.deepEqual(flags[1].productLineIds, ['te']);
  assert.deepEqual(upsellFlags({ seats: 400, studentCount: 350, ownedLineIds: [], offeredLines: [{ id: 'te', name: 'Test Engine' }] }), []);
});

test('reminders: only the closest offset reached is sent, once per term', () => {
  const offsets = [90, 60, 30, 7];
  assert.deepEqual(dueReminders({ daysToRenewal: 100, offsets, sent: [] }), { send: null, markSent: [] });
  assert.deepEqual(dueReminders({ daysToRenewal: 90, offsets, sent: [] }), { send: 90, markSent: [90] });
  assert.deepEqual(dueReminders({ daysToRenewal: 20, offsets, sent: [] }), { send: 30, markSent: [30, 60, 90] });
  assert.deepEqual(dueReminders({ daysToRenewal: 20, offsets, sent: [90, 60, 30] }), { send: null, markSent: [] });
  assert.deepEqual(dueReminders({ daysToRenewal: 7, offsets, sent: [90, 60, 30] }), { send: 7, markSent: [7] });
  assert.deepEqual(dueReminders({ daysToRenewal: -1, offsets, sent: [] }), { send: null, markSent: [] });
});
