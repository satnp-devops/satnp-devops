import { IntegrationError } from '../framework/errors.js';
import { aiEnv } from './config.js';

// The `ai` kind for Anthropic Claude, over the Messages API with fetch (no SDK).
// docs/platform/AI.md "The Claude adapter" explains the choices:
//   - POST /v1/messages with `anthropic-version: 2026-10-21`.
//   - Structured output: `output_config.format = { type: 'json_schema', schema }`. The schema is
//     reduced to what structured outputs accept (no min/max/length/pattern keywords, every object
//     closed with additionalProperties: false); the runner validates the full zod schema afterwards.
//   - Effort from the connection (`output_config.effort`); thinking is left to the model's default
//     (adaptive, always on with Claude Opus 5.5). Thinking counts toward max_tokens, so the request
//     adds THINKING_HEADROOM to the caller's output limit (only tokens actually used are billed).
//   - Refusals: on models that support it, `fallbacks: "default"` (beta server-side-fallback-2026-07-01)
//     re-runs a declined request on the model Anthropic recommends; a final refusal comes back as
//     stopReason "refusal". AI_REFUSAL_FALLBACK=off turns it off.
//   - Errors map to IntegrationError with `retryable` and details.reason; 429 and 529 carry
//     details.retryAfterSeconds from the retry-after header. Vendor messages are never shown.

export const ANTHROPIC_VERSION = '2026-10-21';
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
/** Models that accept server-side fallbacks (Claude Haiku 5.5 does not). */
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-fable-5']);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
/** Room for adaptive thinking on top of the visible answer; non-streaming requests stay at 16k or less. */
export const THINKING_HEADROOM = 4096;
const MAX_NON_STREAMING_TOKENS = 16_000;

const SCHEMA_KEYS = new Set(['type', 'properties', 'required', 'items', 'enum', 'const', 'anyOf', 'allOf', '$ref', '$defs', 'description']);
const FORMATS = new Set(['date-time', 'time', 'date', 'duration', 'email', 'hostname', 'uri', 'ipv4', 'ipv6', 'uuid']);

/** A JSON Schema reduced to what Claude's structured outputs accept. */
export function toClaudeSchema(schema) {
  if (Array.isArray(schema)) return schema.map(toClaudeSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'format') {
      if (FORMATS.has(value)) out.format = value;
    } else if (key === 'properties' || key === '$defs') {
      out[key] = Object.fromEntries(Object.entries(value).map(([name, sub]) => [name, toClaudeSchema(sub)]));
    } else if (SCHEMA_KEYS.has(key)) {
      out[key] = typeof value === 'object' ? toClaudeSchema(value) : value;
    }
  }
  const isObject = out.type === 'object' || (Array.isArray(out.type) && out.type.includes('object')) || out.properties;
  if (isObject) {
    out.properties ??= {};
    out.additionalProperties = false;
    out.required ??= Object.keys(out.properties);
  }
  return out;
}

/** The request body for one `complete` call. */
export function buildRequestBody(input, { model, effort, fallback }) {
  const outputConfig = {};
  if (EFFORTS.has(effort)) outputConfig.effort = effort;
  if (input.responseFormat === 'json' && input.jsonSchema) {
    outputConfig.format = { type: 'json_schema', schema: toClaudeSchema(input.jsonSchema) };
  }
  const system =
    input.responseFormat === 'json' && !input.jsonSchema
      ? `${input.system ? `${input.system}\n\n` : ''}Answer with one JSON value and nothing else.`
      : input.system;
  return {
    model,
    max_tokens: Math.min(input.maxTokens + THINKING_HEADROOM, MAX_NON_STREAMING_TOKENS),
    ...(system ? { system } : {}),
    messages: input.messages.map((m) => ({ role: m.role, content: m.content })),
    ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
    ...(fallback ? { fallbacks: 'default' } : {}),
  };
}

const STOP_REASONS = new Set(['end_turn', 'max_tokens', 'stop_sequence', 'refusal']);

/** Read JSON from a model's text, tolerating a ```json fence. */
export function parseJsonText(text) {
  const trimmed = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/** A Messages API response as the kind's output. */
export function readResponse(body, input) {
  const text = (body.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
  const stopReason = STOP_REASONS.has(body.stop_reason) ? body.stop_reason : 'other';
  const usage = body.usage ?? {};
  const json = input.responseFormat === 'json' && stopReason !== 'refusal' ? parseJsonText(text) : undefined;
  return {
    text,
    ...(json !== undefined ? { json } : {}),
    model: String(body.model ?? ''),
    stopReason,
    usage: {
      inputTokens: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
      outputTokens: usage.output_tokens ?? 0,
    },
  };
}

const retryAfter = (headers) => {
  const value = Number(headers?.get?.('retry-after'));
  return Number.isFinite(value) && value >= 0 ? Math.min(value, 300) : null;
};

/** Map an HTTP failure to the framework's error. */
export function errorForStatus(status, headers, errorType) {
  const base = { kind: 'ai', provider: 'anthropic', details: { reason: 'provider_error', status, type: errorType ?? null } };
  const make = (reason, message, retryable, extra = {}) =>
    new IntegrationError('integration_provider_error', message, { ...base, retryable, details: { ...base.details, reason, ...extra } });
  if (status === 401) return make('unauthorized', 'Anthropic refused the API key', false);
  if (status === 403) return make('forbidden', 'This API key may not use that model or feature', false);
  if (status === 404) return make('model_not_found', 'The model is not available to this Anthropic account', false);
  if (status === 413) return make('request_too_large', 'The request is too large for the model', false);
  if (status === 429) return make('rate_limited', 'Anthropic rate limit reached; try again shortly', true, { retryAfterSeconds: retryAfter(headers) });
  if (status === 529) return make('overloaded', 'Anthropic is overloaded; try again shortly', true, { retryAfterSeconds: retryAfter(headers) });
  if (status >= 500) return make('provider_unavailable', 'Anthropic had a temporary problem', true, { retryAfterSeconds: retryAfter(headers) });
  if (status === 400 && errorType === 'billing_error') return make('billing', 'The Anthropic account has a billing problem', false);
  return make('invalid_request', 'Anthropic rejected the request', false);
}

/**
 * @param {{ config: { model?: string, effort?: string }, credentials: { apiKey?: string } }} ctx
 * @param {{ fetch?: typeof fetch, baseUrl?: string, timeoutMs?: number, defaultModel?: string, refusalFallback?: boolean }} [options]
 */
export function createClaudeAdapter(ctx, options = {}) {
  const doFetch = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl ?? aiEnv.anthropicBaseUrl;
  const timeoutMs = options.timeoutMs ?? aiEnv.timeoutMs;
  const defaultModel = ctx.config.model || options.defaultModel || aiEnv.model;
  const allowFallback = options.refusalFallback ?? aiEnv.refusalFallback;

  async function request(method, path, body) {
    const apiKey = ctx.credentials.apiKey;
    if (!apiKey) throw new IntegrationError('integration_unavailable', 'The connection has no API key', { kind: 'ai', provider: 'anthropic' });
    const fallback = body?.fallbacks !== undefined;
    let response;
    try {
      response = await doFetch(`${baseUrl}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          ...(fallback ? { 'anthropic-beta': FALLBACK_BETA } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      throw new IntegrationError('integration_provider_error', timedOut ? 'The AI model took too long to answer' : 'Could not reach Anthropic', {
        kind: 'ai',
        provider: 'anthropic',
        retryable: true,
        details: { reason: timedOut ? 'timeout' : 'network' },
        cause: error,
      });
    }
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!response.ok) {
      const error = errorForStatus(response.status, response.headers, json?.error?.type);
      error.cause = new Error(`Anthropic ${response.status} ${json?.error?.type ?? ''} (request ${response.headers.get('request-id') ?? 'unknown'})`);
      throw error;
    }
    if (!json) {
      throw new IntegrationError('integration_provider_error', 'Anthropic sent an unreadable answer', { kind: 'ai', provider: 'anthropic', retryable: true, details: { reason: 'bad_response' } });
    }
    return json;
  }

  return {
    kind: 'ai',
    provider: 'anthropic',
    mock: false,
    async healthCheck() {
      try {
        const model = await request('GET', `/v1/models/${encodeURIComponent(defaultModel)}`);
        return { ok: true, message: `Connected: ${model.display_name ?? model.id ?? defaultModel} is available` };
      } catch (error) {
        return { ok: false, message: error instanceof IntegrationError ? error.message : 'The check failed', details: { reason: error?.details?.reason ?? 'unknown' } };
      }
    },
    async complete(input) {
      const model = input.model ?? defaultModel;
      const body = buildRequestBody(input, { model, effort: ctx.config.effort ?? 'medium', fallback: allowFallback && FALLBACK_MODELS.has(model) });
      return readResponse(await request('POST', '/v1/messages', body), input);
    },
  };
}
