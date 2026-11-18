import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BACKOFF_TYPE, backoffStrategy, nextAttemptAt, retryDelay, retryOptions } from '../../src/core/jobs/policy.js';
import { DEFAULT_LIMITS, limitFor, parseLimitOverrides } from '../../src/core/jobs/limits.js';

// Retry policy (exponential, capped, deterministic jitter) and the outbound throttling limits.

const policy = { baseMs: 10_000, maxMs: 3_600_000 };

test('delays double from the base, within ±20 % jitter, and stop at the cap', () => {
  for (let failures = 1; failures <= 8; failures += 1) {
    const expected = Math.min(policy.maxMs, policy.baseMs * 2 ** (failures - 1));
    const delay = retryDelay(failures, policy, 'job-1');
    assert.ok(delay >= expected * 0.8 - 1 && delay <= Math.min(policy.maxMs, expected * 1.2) + 1, `attempt ${failures}: ${delay}`);
  }
  for (const failures of [10, 20, 60]) assert.ok(retryDelay(failures, policy, 'job-1') <= policy.maxMs);
  assert.ok(retryDelay(12, policy, 'job-1') >= policy.maxMs * 0.8);
});

test('the jitter is stable per job and attempt, and differs between jobs', () => {
  assert.equal(retryDelay(3, policy, 'a'), retryDelay(3, policy, 'a'));
  const spread = new Set(['a', 'b', 'c', 'd', 'e'].map((seed) => retryDelay(3, policy, seed)));
  assert.ok(spread.size > 1);
});

test('the queue strategy uses the job backoff delay and only our type', () => {
  const job = { id: 'evt-1', queueName: 'webhooks', opts: { backoff: { type: BACKOFF_TYPE, delay: 50 } } };
  assert.equal(backoffStrategy(1, BACKOFF_TYPE, null, job), retryDelay(1, { baseMs: 50, maxMs: 3_600_000 }, 'evt-1'));
  assert.ok(backoffStrategy(1, BACKOFF_TYPE, null, job) < 100);
  assert.equal(backoffStrategy(1, 'linear', null, job), -1);
  assert.deepEqual(retryOptions({ attempts: 12, baseMs: 10_000 }), { attempts: 12, backoff: { type: BACKOFF_TYPE, delay: 10_000 } });
  assert.deepEqual(retryOptions({ attempts: 12, baseMs: 10_000 }, { attempts: 2, backoffMs: 20 }), { attempts: 2, backoff: { type: BACKOFF_TYPE, delay: 20 } });
});

test('the next attempt time is shown until the last attempt', () => {
  const now = Date.parse('2026-11-06T10:00:00Z');
  const next = nextAttemptAt({ failures: 1, maxAttempts: 3, ...policy, seed: 'x', now });
  assert.equal(next.getTime(), now + retryDelay(1, policy, 'x'));
  assert.equal(nextAttemptAt({ failures: 3, maxAttempts: 3, ...policy, seed: 'x', now }), null);
});

test('throttle limits: provider or channel name, the messaging. prefix, then the default', () => {
  const limits = { ...DEFAULT_LIMITS, whatsapp_cloud: { perSecond: 50, burst: 50 } };
  assert.deepEqual(limitFor('whatsapp', limits), DEFAULT_LIMITS.whatsapp);
  assert.deepEqual(limitFor('messaging.whatsapp', limits), DEFAULT_LIMITS.whatsapp);
  assert.deepEqual(limitFor('whatsapp_cloud', limits), { perSecond: 50, burst: 50 });
  assert.deepEqual(limitFor('somebody_new', limits), DEFAULT_LIMITS.default);
});

test('THROTTLE_LIMITS overrides are checked', () => {
  assert.deepEqual(parseLimitOverrides(''), {});
  assert.deepEqual(parseLimitOverrides(undefined), {});
  assert.deepEqual(parseLimitOverrides('{"whatsapp":{"perSecond":20,"burst":40}}'), { whatsapp: { perSecond: 20, burst: 40 } });
  assert.throws(() => parseLimitOverrides('{whatsapp'), /must be JSON/);
  assert.throws(() => parseLimitOverrides('{"whatsapp":{"perSecond":0,"burst":40}}'), /invalid/);
  assert.throws(() => parseLimitOverrides('{"whatsapp":{"perSecond":5}}'), /invalid/);
  assert.throws(() => parseLimitOverrides('{"WhatsApp":{"perSecond":5,"burst":5}}'), /invalid/);
});
