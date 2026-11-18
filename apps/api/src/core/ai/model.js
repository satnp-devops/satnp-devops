import { getAdapter, isIntegrationError, IntegrationError } from '../../integrations/index.js';
import { aiEnv } from '../../integrations/ai/config.js';
import { logger } from '../../lib/logger.js';

// One structured model call with timeouts, retries and output validation, behind the company's
// `ai` connection (docs/platform/INTEGRATIONS.md). With a mock connection the answer comes from
// the agent's deterministic rules (core/ai/mock/), after the mock adapter has recorded the call in
// the sandbox outbox and applied its failure simulation, so tests and local runs work offline.

export class ModelCallError extends Error {
  /**
   * @param {string} code ai_provider_error | ai_timeout | ai_refused | ai_invalid_output | ai_not_connected
   * @param {string} message safe to show
   * @param {{ attempts: number, usage: { inputTokens: number, outputTokens: number }, retryable?: boolean, provider?: string|null, model?: string|null, cause?: unknown }} info
   */
  constructor(code, message, info) {
    super(message);
    this.name = 'ModelCallError';
    this.code = code;
    this.attempts = info.attempts;
    this.usage = info.usage;
    this.retryable = info.retryable ?? false;
    this.provider = info.provider ?? null;
    this.model = info.model ?? null;
    this.connectionId = info.connectionId ?? null;
    this.mock = info.mock ?? false;
    if (info.cause) this.cause = info.cause;
  }
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait before the next attempt: retry-after when the provider gives one, else 0.5 s, 1 s, 2 s... (max 10 s). */
export function backoffMs(attempt, error) {
  const after = error?.details?.retryAfterSeconds;
  if (Number.isFinite(after) && after > 0) return Math.min(after * 1000, 10_000);
  return Math.min(500 * 2 ** (attempt - 1), 10_000);
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new IntegrationError('integration_provider_error', 'The AI model took too long to answer', { retryable: true, kind: 'ai', details: { reason: 'timeout' } })),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const issuesText = (issues) =>
  issues
    .slice(0, 8)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');

/**
 * Call the model and return output that passed `schema`.
 * @param {{
 *   companyId: string, request: object, schema: import('zod').ZodType, mockAnswer: () => unknown,
 *   maxAttempts?: number, timeoutMs?: number, sleep?: (ms: number) => Promise<void>, log?: object,
 *   adapter?: object,
 * }} options  `adapter` skips the connection lookup (tests).
 * @returns {Promise<{ output, raw, model, provider, mock, connectionId, usage, attempts, stopReason }>}
 */
export async function callModel({ companyId, request, schema, mockAnswer, maxAttempts = aiEnv.maxAttempts, timeoutMs = aiEnv.timeoutMs, sleep = realSleep, log = logger, adapter }) {
  const usage = { inputTokens: 0, outputTokens: 0 };
  let ai = adapter;
  if (!ai) {
    try {
      ai = await getAdapter({ companyId, kind: 'ai', log });
    } catch (error) {
      throw new ModelCallError('ai_not_connected', isIntegrationError(error) ? error.message : 'No AI connection', { attempts: 0, usage, cause: error });
    }
  }
  const meta = { provider: ai.provider, mock: Boolean(ai.mock), connectionId: ai.connection?.id ?? null };
  const messages = [...request.messages];
  let maxTokens = request.maxTokens;
  let lastProblem = null;
  let model = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let answer;
    try {
      answer = await withTimeout(ai.complete({ ...request, messages, maxTokens }), timeoutMs + 1000);
    } catch (error) {
      const retryable = isIntegrationError(error) && error.retryable;
      const timeout = error?.details?.reason === 'timeout';
      if (retryable && attempt < maxAttempts) {
        log.warn({ companyId, purpose: request.purpose, attempt, reason: error.details?.reason }, 'AI call failed, retrying');
        await sleep(backoffMs(attempt, error));
        continue;
      }
      throw new ModelCallError(timeout ? 'ai_timeout' : 'ai_provider_error', isIntegrationError(error) ? error.message : 'The AI model failed', {
        attempts: attempt,
        usage,
        retryable,
        ...meta,
        model,
        cause: error,
      });
    }
    usage.inputTokens += answer.usage?.inputTokens ?? 0;
    usage.outputTokens += answer.usage?.outputTokens ?? 0;
    model = answer.model;
    if (answer.stopReason === 'refusal') {
      throw new ModelCallError('ai_refused', 'The AI model declined this request', { attempts: attempt, usage, ...meta, model });
    }

    const raw = meta.mock ? mockAnswer() : answer.json;
    const parsed = schema.safeParse(raw);
    if (parsed.success) return { output: parsed.data, raw, model, ...meta, usage, attempts: attempt, stopReason: answer.stopReason };

    lastProblem = answer.stopReason === 'max_tokens' ? 'The answer was cut off' : `The answer did not match the schema (${issuesText(parsed.error.issues)})`;
    log.warn({ companyId, purpose: request.purpose, attempt, problem: lastProblem }, 'AI output rejected');
    if (attempt < maxAttempts) {
      if (answer.stopReason === 'max_tokens') {
        maxTokens = Math.min(maxTokens * 2, 8192);
      } else {
        // Ask once more, saying what was wrong (a normal follow-up turn, not a prefill).
        messages.push({ role: 'assistant', content: answer.text || '(no answer)' });
        messages.push({ role: 'user', content: `${lastProblem}. Answer again with JSON that matches the schema exactly.` });
      }
    }
  }
  throw new ModelCallError('ai_invalid_output', lastProblem ?? 'The AI answer was not usable', { attempts: maxAttempts, usage, ...meta, model });
}
