import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { createHash } from 'node:crypto';
import { z } from 'zod';

// Load the shared .env at the repo root. Real environment variables always win.
const envFile = fileURLToPath(new URL('../../../../.env', import.meta.url));
if (existsSync(envFile)) {
  const fromFile = parseEnv(readFileSync(envFile, 'utf8'));
  for (const [key, value] of Object.entries(fromFile)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_URL: z.url().default('http://localhost:3000'),
  API_PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1).default('postgres://phoenix:phoenix@localhost:5432/phoenix'),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  APP_ENCRYPTION_KEY: z.string().optional(),
  SESSION_COOKIE_NAME: z.string().min(1).default('phx_session'),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  TRUST_PROXY: z.string().default('loopback'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  MAIL_PROVIDER: z.enum(['console']).default('console'),
  MAIL_FROM: z.string().default('Phoenix Platform <no-reply@phoenix.test>'),
  SEED_PASSWORD: z.string().min(10).default('Phoenix@12345'),
  // Integration framework (docs/platform/INTEGRATIONS.md). Mock adapters: auto = on outside
  // production, off in production; on/off force it (e.g. on for a staging server running NODE_ENV=production).
  INTEGRATIONS_MOCKS: z.enum(['auto', 'on', 'off']).default('auto'),
  // Where the local-disk storage mock keeps files (default: <repo>/.data/storage).
  INTEGRATIONS_LOCAL_STORAGE_DIR: z.string().optional(),
  // Requests per minute allowed for each API key.
  API_KEY_RATE_LIMIT: z.coerce.number().int().min(1).max(100_000).default(600),
  // Webhooks and background jobs (docs/platform/WEBHOOKS_AND_JOBS.md): attempts before a webhook
  // event or job is dead-lettered, and the exponential backoff between attempts (first delay, cap).
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(50).default(12),
  JOB_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(50).default(5),
  RETRY_BASE_DELAY_MS: z.coerce.number().int().min(10).max(3_600_000).default(10_000),
  RETRY_MAX_DELAY_MS: z.coerce.number().int().min(10).max(86_400_000).default(3_600_000),
  // Days processed webhook events are kept (de-duplication works within this window).
  WEBHOOK_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  // The public webhook URL: deliveries per connection per minute, and refused deliveries (unknown
  // connection, bad signature, unreadable body) per source IP per 10 minutes before that IP gets 429s.
  WEBHOOK_RATE_LIMIT: z.coerce.number().int().min(1).max(1_000_000).default(1200),
  WEBHOOK_FAILURE_LIMIT: z.coerce.number().int().min(1).max(1_000_000).default(100),
  // Outbound throttling overrides as JSON: {"whatsapp":{"perSecond":20,"burst":40}} (core/jobs/limits.js).
  THROTTLE_LIMITS: z.string().optional(),
  // AI service (docs/platform/AI.md). The Claude API key is a credential of the company's AI
  // connection, not an env var. Model used when the connection sets none; per-call timeout and
  // attempts on retryable errors; server-side refusal fallbacks; Messages API base URL (for a proxy).
  AI_MODEL: z.string().regex(/^[a-z0-9][a-z0-9.-]{2,80}$/, 'A model id such as claude-opus-5-5').default('claude-opus-5-5'),
  AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600_000).default(60_000),
  AI_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(6).default(3),
  AI_REFUSAL_FALLBACK: z.enum(['on', 'off']).default('on'),
  ANTHROPIC_BASE_URL: z.url({ protocol: /^https?$/ }).default('https://api.anthropic.com'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  process.exit(1);
}
const values = parsed.data;

function resolveEncryptionKey() {
  if (values.APP_ENCRYPTION_KEY) {
    const key = Buffer.from(values.APP_ENCRYPTION_KEY, 'base64');
    if (key.length !== 32) {
      console.error('APP_ENCRYPTION_KEY must be 32 bytes encoded as base64.');
      process.exit(1);
    }
    return key;
  }
  if (values.NODE_ENV === 'production') {
    console.error('APP_ENCRYPTION_KEY is required in production.');
    process.exit(1);
  }
  // Development only: a fixed key so local data stays readable across restarts.
  return createHash('sha256').update('phoenix-local-development-key').digest();
}

function parseTrustProxy(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

export const env = Object.freeze({
  ...values,
  APP_URL: values.APP_URL.replace(/\/+$/, ''),
  encryptionKey: resolveEncryptionKey(),
  trustProxy: parseTrustProxy(values.TRUST_PROXY),
  isProd: values.NODE_ENV === 'production',
  isTest: values.NODE_ENV === 'test',
  integrationMocks: values.INTEGRATIONS_MOCKS === 'on' || (values.INTEGRATIONS_MOCKS === 'auto' && values.NODE_ENV !== 'production'),
  localStorageDir: values.INTEGRATIONS_LOCAL_STORAGE_DIR || fileURLToPath(new URL('../../../../.data/storage', import.meta.url)),
});
