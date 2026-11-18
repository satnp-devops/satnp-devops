import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { IntegrationError } from '../../src/integrations/index.js';
import { ModelCallError, backoffMs, callModel } from '../../src/core/ai/model.js';

// The model-call layer (core/ai/model.js): retries with backoff, timeouts, schema validation with
// one corrective turn, refusals, and the mock substitution. Fake adapters; no network, no database.

const schema = z.object({ answer: z.string(), confidence: z.number().min(0).max(1) });
const request = { purpose: 'ai.test', system: 'x', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100, responseFormat: 'json', jsonSchema: {} };
const quiet = { warn() {}, info() {}, error() {} };
const answer = (json, extra = {}) => ({ text: JSON.stringify(json), json, model: 'claude-test', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 }, ...extra });

function fakeAdapter(steps, { mock = false } = {}) {
  const calls = [];
  return {
    calls,
    adapter: {
      kind: 'ai',
      provider: mock ? 'mock' : 'anthropic',
      mock,
      connection: { id: null },
      async complete(input) {
        calls.push(input);
        const step = steps[Math.min(calls.length - 1, steps.length - 1)];
        if (step instanceof Error) throw step;
        if (typeof step === 'function') return step(input);
        return step;
      },
    },
  };
}

const run = (adapter, extra = {}) => {
  const waits = [];
  const promise = callModel({ companyId: 'c', request, schema, mockAnswer: () => ({ answer: 'from rules', confidence: 0.8 }), adapter, log: quiet, sleep: async (ms) => waits.push(ms), maxAttempts: 3, timeoutMs: 1000, ...extra });
  return { promise, waits };
};

const retryable = (reason, retryAfterSeconds) =>
  new IntegrationError('integration_provider_error', 'busy', { retryable: true, details: { reason, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) } });

test('a valid answer is returned with usage and the model', async () => {
  const { adapter } = fakeAdapter([answer({ answer: 'ok', confidence: 0.9 })]);
  const result = await run(adapter).promise;
  assert.deepEqual(result.output, { answer: 'ok', confidence: 0.9 });
  assert.equal(result.attempts, 1);
  assert.equal(result.model, 'claude-test');
  assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 5 });
});

test('rate limits and overloads are retried with backoff, honouring retry-after', async () => {
  const { adapter, calls } = fakeAdapter([retryable('rate_limited', 3), retryable('overloaded'), answer({ answer: 'ok', confidence: 0.9 })]);
  const { promise, waits } = run(adapter);
  const result = await promise;
  assert.equal(result.attempts, 3);
  assert.equal(calls.length, 3);
  assert.deepEqual(waits, [3000, 1000]);
  assert.equal(backoffMs(1), 500);
  assert.equal(backoffMs(10), 10_000);
});

test('non-retryable errors and exhausted retries fail with a ModelCallError', async () => {
  const auth = new IntegrationError('integration_provider_error', 'Anthropic refused the API key', { retryable: false, details: { reason: 'unauthorized' } });
  const { adapter, calls } = fakeAdapter([auth]);
  await assert.rejects(run(adapter).promise, (error) => error instanceof ModelCallError && error.code === 'ai_provider_error' && error.attempts === 1);
  assert.equal(calls.length, 1);
  const busy = fakeAdapter([retryable('overloaded')]);
  await assert.rejects(run(busy.adapter).promise, (error) => error.code === 'ai_provider_error' && error.attempts === 3 && error.retryable);
});

test('a hung provider times out and is retried', async () => {
  const { adapter } = fakeAdapter([() => new Promise(() => {}), answer({ answer: 'ok', confidence: 0.7 })]);
  const result = await run(adapter, { timeoutMs: 10 }).promise;
  assert.equal(result.attempts, 2);
});

test('an answer that breaks the schema gets one corrective turn saying what was wrong', async () => {
  const { adapter, calls } = fakeAdapter([answer({ answer: 42 }), answer({ answer: 'fixed', confidence: 0.6 })]);
  const result = await run(adapter).promise;
  assert.equal(result.output.answer, 'fixed');
  assert.equal(calls[1].messages.length, 3);
  assert.equal(calls[1].messages[1].role, 'assistant');
  assert.match(calls[1].messages[2].content, /did not match the schema/);
  const never = fakeAdapter([answer({ wrong: true })]);
  await assert.rejects(run(never.adapter).promise, (error) => error.code === 'ai_invalid_output' && error.usage.inputTokens === 30);
});

test('a cut-off answer is retried with a larger token limit', async () => {
  const { adapter, calls } = fakeAdapter([answer(undefined, { text: '{"answer": "trunc', stopReason: 'max_tokens' }), answer({ answer: 'ok', confidence: 0.9 })]);
  await run(adapter).promise;
  assert.equal(calls[1].maxTokens, 200);
});

test('a refusal is not retried', async () => {
  const { adapter, calls } = fakeAdapter([answer(undefined, { text: '', stopReason: 'refusal' })]);
  await assert.rejects(run(adapter).promise, (error) => error.code === 'ai_refused');
  assert.equal(calls.length, 1);
});

test('with a mock connection the rules answer, after the mock adapter recorded the call', async () => {
  const { adapter, calls } = fakeAdapter([answer({ placeholder: '' })], { mock: true });
  const result = await run(adapter).promise;
  assert.deepEqual(result.output, { answer: 'from rules', confidence: 0.8 });
  assert.equal(result.mock, true);
  assert.equal(calls.length, 1);
});
