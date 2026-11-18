import { env } from '../../config/env.js';

// Environment for the AI model adapter and the AI runner (docs/platform/AI.md "Environment").
// The variables are validated with the rest of the environment in config/env.js. Model ids come
// from the environment so a model change needs no deploy of code; a connection's own "Model"
// setting wins over AI_MODEL.

export const aiEnv = Object.freeze({
  model: env.AI_MODEL,
  timeoutMs: env.AI_REQUEST_TIMEOUT_MS,
  maxAttempts: env.AI_MAX_ATTEMPTS,
  refusalFallback: env.AI_REFUSAL_FALLBACK === 'on',
  anthropicBaseUrl: env.ANTHROPIC_BASE_URL.replace(/\/+$/, ''),
});
