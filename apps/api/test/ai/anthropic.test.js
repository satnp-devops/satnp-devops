import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANTHROPIC_VERSION, FALLBACK_BETA, THINKING_HEADROOM, createClaudeAdapter, errorForStatus, toClaudeSchema } from '../../src/integrations/ai/anthropic.js';
import { getKind, guardAdapter } from '../../src/integrations/index.js';
import { getProvider } from '../../src/integrations/framework/catalog.js';

// The Claude adapter (integrations/ai/anthropic.js) against a recorded-style fake fetch. Tests
// never call the real API.

const MESSAGE = {
  id: 'msg_01',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content: [
    { type: 'thinking', thinking: '', signature: 'sig' },
    { type: 'text', text: '{"answer":"Pune","confidence":0.9}' },
  ],
  stop_reason: 'end_turn',
  stop_details: null,
  usage: { input_tokens: 120, cache_creation_input_tokens: 0, cache_read_input_tokens: 30, output_tokens: 18 },
};

function fakeFetch(responses) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (next instanceof Error) throw next;
    const { status = 200, body = MESSAGE, headers = {} } = next;
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  };
  return { fetch, calls };
}

const ctx = (config = {}) => ({ config: { model: 'claude-opus-5-5', effort: 'low', ...config }, credentials: { apiKey: 'sk-ant-test-key' } });
const input = {
  purpose: 'ai.intake.extract',
  system: 'You are the intake agent.',
  messages: [{ role: 'user', content: 'Where do they live?' }],
  maxTokens: 512,
  responseFormat: 'json',
  jsonSchema: {
    type: 'object',
    properties: { answer: { type: 'string', maxLength: 80, pattern: '^[A-Z]' }, confidence: { type: 'number', minimum: 0, maximum: 1 }, when: { type: 'string', format: 'date' } },
    required: ['answer', 'confidence'],
    additionalProperties: false,
  },
};

test('the request: headers, model, effort, structured output, server-side fallback', async () => {
  const { fetch, calls } = fakeFetch([{}]);
  const adapter = createClaudeAdapter(ctx(), { fetch, baseUrl: 'https://api.test', timeoutMs: 5000, refusalFallback: true });
  const out = await adapter.complete(input);
  const [call] = calls;
  assert.equal(call.url, 'https://api.test/v1/messages');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers['x-api-key'], 'sk-ant-test-key');
  assert.equal(call.init.headers['anthropic-version'], ANTHROPIC_VERSION);
  assert.equal(call.init.headers['anthropic-beta'], FALLBACK_BETA);
  assert.equal(call.body.model, 'claude-opus-5-5');
  assert.equal(call.body.max_tokens, 512 + THINKING_HEADROOM, 'room for adaptive thinking on top of the answer');
  assert.equal(call.body.system, 'You are the intake agent.');
  assert.equal(call.body.fallbacks, 'default');
  assert.equal(call.body.output_config.effort, 'low');
  assert.equal(call.body.output_config.format.type, 'json_schema');
  assert.equal(call.body.thinking, undefined);
  assert.equal(call.body.temperature, undefined);
  const schema = call.body.output_config.format.schema;
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.answer.maxLength, undefined);
  assert.equal(schema.properties.answer.pattern, undefined);
  assert.equal(schema.properties.confidence.minimum, undefined);
  assert.equal(schema.properties.when.format, 'date');
  // The answer: text blocks only, usage including cached input.
  assert.deepEqual(out.json, { answer: 'Pune', confidence: 0.9 });
  assert.equal(out.stopReason, 'end_turn');
  assert.deepEqual(out.usage, { inputTokens: 150, outputTokens: 18 });
});

test('no fallbacks for models without them (Haiku) or when switched off; the call input may override the model', async () => {
  const { fetch, calls } = fakeFetch([{}, {}]);
  await createClaudeAdapter(ctx({ model: 'claude-haiku-5-5' }), { fetch, refusalFallback: true }).complete(input);
  assert.equal(calls[0].body.fallbacks, undefined);
  assert.equal(calls[0].init.headers['anthropic-beta'], undefined);
  await createClaudeAdapter(ctx(), { fetch, refusalFallback: false }).complete({ ...input, model: 'claude-sonnet-5-5' });
  assert.equal(calls[1].body.model, 'claude-sonnet-5-5');
  assert.equal(calls[1].body.fallbacks, undefined);
});

test('schemas are closed and fully required for structured outputs', () => {
  const out = toClaudeSchema({
    type: 'object',
    properties: { list: { type: 'array', maxItems: 3, items: { type: 'object', properties: { a: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] } } } } },
  });
  assert.deepEqual(out, {
    type: 'object',
    properties: { list: { type: 'array', items: { type: 'object', properties: { a: { anyOf: [{ type: 'string' }, { type: 'null' }] } }, additionalProperties: false, required: ['a'] } } },
    additionalProperties: false,
    required: ['list'],
  });
});

test('rate limits, overloads and server errors are retryable with retry-after; auth and bad requests are not', async () => {
  const limited = errorForStatus(429, new Headers({ 'retry-after': '12' }), 'rate_limit_error');
  assert.equal(limited.retryable, true);
  assert.equal(limited.details.reason, 'rate_limited');
  assert.equal(limited.details.retryAfterSeconds, 12);
  assert.equal(errorForStatus(529, new Headers(), 'overloaded_error').details.reason, 'overloaded');
  assert.equal(errorForStatus(500, new Headers(), 'api_error').retryable, true);
  assert.equal(errorForStatus(401, new Headers(), 'authentication_error').retryable, false);
  assert.equal(errorForStatus(404, new Headers(), 'not_found_error').details.reason, 'model_not_found');
  assert.equal(errorForStatus(400, new Headers(), 'invalid_request_error').details.reason, 'invalid_request');

  const { fetch } = fakeFetch([{ status: 429, body: { type: 'error', error: { type: 'rate_limit_error', message: 'Number of requests has exceeded your rate limit' } }, headers: { 'retry-after': '7' } }]);
  await assert.rejects(createClaudeAdapter(ctx(), { fetch }).complete(input), (error) => {
    assert.equal(error.code, 'integration_provider_error');
    assert.equal(error.details.retryAfterSeconds, 7);
    assert.ok(!error.message.includes('Number of requests'), 'vendor messages are not shown');
    return true;
  });
});

test('network failures and timeouts are retryable provider errors', async () => {
  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const { fetch } = fakeFetch([timeout]);
  await assert.rejects(createClaudeAdapter(ctx(), { fetch }).complete(input), (error) => error.retryable && error.details.reason === 'timeout');
  const { fetch: down } = fakeFetch([new TypeError('fetch failed')]);
  await assert.rejects(createClaudeAdapter(ctx(), { fetch: down }).complete(input), (error) => error.retryable && error.details.reason === 'network');
});

test('a refusal comes back as stopReason refusal without JSON', async () => {
  const refusal = { ...MESSAGE, content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' } };
  const { fetch } = fakeFetch([{ body: refusal }]);
  const out = await createClaudeAdapter(ctx(), { fetch }).complete(input);
  assert.equal(out.stopReason, 'refusal');
  assert.equal(out.json, undefined);
});

test('the health check reads the model without side effects', async () => {
  const { fetch, calls } = fakeFetch([{ body: { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' } }, { status: 401, body: { error: { type: 'authentication_error' } } }]);
  const adapter = createClaudeAdapter(ctx(), { fetch, baseUrl: 'https://api.test' });
  assert.deepEqual(await adapter.healthCheck(), { ok: true, message: 'Connected: Claude Opus 5.5 is available' });
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].url, 'https://api.test/v1/models/claude-opus-5-5');
  const failed = await adapter.healthCheck();
  assert.equal(failed.ok, false);
  assert.equal(failed.details.reason, 'unauthorized');
});

test('the catalogue builds it as an implemented provider that fits the ai kind', async () => {
  const provider = getProvider('ai', 'anthropic');
  assert.equal(provider.implemented, true);
  const { fetch } = fakeFetch([{}]);
  const guarded = guardAdapter(getKind('ai'), createClaudeAdapter(ctx(), { fetch }), { checkOutputs: true });
  const out = await guarded.complete({ purpose: 'ai.check', messages: [{ role: 'user', content: 'hi' }], responseFormat: 'json' });
  assert.equal(out.model, 'claude-opus-5-5');
});
