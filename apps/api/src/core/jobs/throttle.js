import { setTimeout as sleep } from 'node:timers/promises';
import { AppError } from '../../lib/errors.js';
import { redis as sharedRedis } from '../../lib/redis.js';
import { limitFor } from './limits.js';

/**
 * Outbound throttling: a token bucket in Redis per name and connection, shared by every API and
 * worker process. Adapters and the messaging service call it before each provider request:
 *
 *   await throttle('whatsapp', connectionId);            // waits for a token (up to 30 s)
 *   const { allowed, retryAfterMs } = await tryThrottle('email', connectionId);   // never waits
 *
 * Limits come from core/jobs/limits.js (THROTTLE_LIMITS overrides them). The bucket uses Redis'
 * own clock, so processes on different machines agree.
 */

// KEYS[1] bucket; ARGV: tokens per second, burst, cost. Returns 0 when a token was taken, otherwise
// the milliseconds until enough tokens will be there (nothing is taken then).
const TOKEN_BUCKET = `
local rate = tonumber(ARGV[1]) / 1000
local burst = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts = tonumber(state[2])
if tokens == nil or ts == nil then
  tokens = burst
  ts = now
end
if now > ts then
  tokens = math.min(burst, tokens + (now - ts) * rate)
end
local wait = 0
if tokens >= cost then
  tokens = tokens - cost
else
  wait = math.ceil((cost - tokens) / rate)
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', tostring(now))
redis.call('PEXPIRE', KEYS[1], math.ceil(burst / rate) + 1000)
return wait
`;

const defined = new WeakSet();

function bucket(client) {
  if (!defined.has(client)) {
    client.defineCommand('phoenixTokenBucket', { numberOfKeys: 1, lua: TOKEN_BUCKET });
    defined.add(client);
  }
  return client;
}

/** Thrown when a token isn't available within maxWaitMs. Retryable: a background job tries again later. */
export class ThrottledError extends AppError {
  constructor(name, retryAfterMs) {
    super(429, 'throttled', `Too many ${name} requests right now. Try again in a moment.`, { retryAfterMs });
    this.name = 'ThrottledError';
    this.retryable = true;
    this.retryAfterMs = retryAfterMs;
  }
}

export const throttleKey = (name, connectionId) => `throttle:${name}:${connectionId ?? 'default'}`;

function checkedLimit(name, cost, limits) {
  if (typeof name !== 'string' || !/^[a-z][a-z0-9_.]{0,63}$/.test(name)) throw new Error(`Invalid throttle name "${name}"`);
  const limit = limits ? (limits[name] ?? limitFor(name)) : limitFor(name);
  if (!Number.isInteger(cost) || cost < 1 || cost > limit.burst) {
    throw new Error(`Throttle cost must be a whole number from 1 to the burst (${limit.burst}) for "${name}"`);
  }
  return limit;
}

/** Take `cost` tokens if they are there. Never waits. */
export async function tryThrottle(name, connectionId, { cost = 1, redis = sharedRedis, limits } = {}) {
  const limit = checkedLimit(name, cost, limits);
  const wait = Number(await bucket(redis).phoenixTokenBucket(throttleKey(name, connectionId), limit.perSecond, limit.burst, cost));
  return { allowed: wait === 0, retryAfterMs: wait };
}

/**
 * Wait until `cost` tokens are available and take them. Throws ThrottledError (429, retryable)
 * when that would take longer than maxWaitMs, so a request fails fast and a job retries later.
 */
export async function throttle(name, connectionId, { cost = 1, maxWaitMs = 30_000, redis = sharedRedis, limits } = {}) {
  const started = Date.now();
  for (;;) {
    const { allowed, retryAfterMs } = await tryThrottle(name, connectionId, { cost, redis, limits });
    if (allowed) return { waitedMs: Date.now() - started };
    if (Date.now() - started + retryAfterMs > maxWaitMs) throw new ThrottledError(name, retryAfterMs);
    await sleep(retryAfterMs);
  }
}
