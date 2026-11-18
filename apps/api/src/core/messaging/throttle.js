import { setTimeout as sleep } from 'node:timers/promises';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { redis as sharedRedis } from '../../lib/redis.js';
import { THROTTLE_MAX_WAIT_MS } from './constants.js';

// Outbound throttling: a token bucket per connection in Redis, so every API process and worker
// shares one budget per WhatsApp number, inbox or SMS sender. A send takes one token; tokens refill
// at `ratePerSecond` up to `burst`. When none is left the send waits (up to THROTTLE_MAX_WAIT_MS)
// and is then refused with 429 message_throttled, which a background job simply retries.
//
// The webhooks and jobs slice may ship a shared throttle helper; this one is small on purpose and
// can be swapped for it without touching callers (throttleOutbound's signature stays).

/**
 * One token-bucket step. Pure: the Lua script below does exactly this inside Redis.
 * @param {{ tokens: number | null, updatedAtMs: number | null }} state
 * @param {number} nowMs
 * @param {{ ratePerSecond: number, burst: number, cost?: number }} limits
 * @returns {{ allowed: boolean, tokens: number, waitMs: number }}
 */
export function takeFromBucket(state, nowMs, { ratePerSecond, burst, cost = 1 }) {
  const last = state.updatedAtMs ?? nowMs;
  const start = state.tokens ?? burst;
  const tokens = Math.min(burst, start + (Math.max(0, nowMs - last) / 1000) * ratePerSecond);
  if (tokens >= cost) return { allowed: true, tokens: tokens - cost, waitMs: 0 };
  return { allowed: false, tokens, waitMs: Math.ceil(((cost - tokens) / ratePerSecond) * 1000) };
}

// KEYS[1] bucket; ARGV: rate per second, burst, cost. Uses the Redis clock so API servers with
// skewed clocks share one bucket correctly. Returns { allowed (0/1), waitMs }.
const TAKE_SCRIPT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local rate = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local data = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(data[1]) or burst
local ts = tonumber(data[2]) or now
tokens = math.min(burst, tokens + (math.max(0, now - ts) / 1000) * rate)
local allowed = 0
local wait = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  wait = math.ceil(((cost - tokens) / rate) * 1000)
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', tostring(now))
redis.call('PEXPIRE', KEYS[1], math.ceil((burst / rate) * 1000) + 1000)
return { allowed, wait }
`;

/** The Redis key of a connection's bucket. */
export const throttleKey = (connectionKey) => `msg:tb:${connectionKey}`;

/**
 * Take one send token for a connection, waiting briefly when the bucket is empty.
 * Redis being down must not stop messages, so the throttle then lets the send through and logs it.
 * @param {{ key: string, ratePerSecond: number, burst: number, maxWaitMs?: number, redis?: import('ioredis').Redis, log?: object }} input
 * @returns {Promise<{ waitedMs: number }>}
 */
export async function throttleOutbound({ key, ratePerSecond, burst, maxWaitMs = THROTTLE_MAX_WAIT_MS, redis = sharedRedis, log = logger }) {
  let waitedMs = 0;
  for (;;) {
    let allowed;
    let waitMs;
    try {
      [allowed, waitMs] = await redis.eval(TAKE_SCRIPT, 1, throttleKey(key), ratePerSecond, burst, 1);
    } catch (err) {
      log.warn({ err, key }, 'Outbound throttle unavailable: sending without it');
      return { waitedMs };
    }
    if (Number(allowed) === 1) return { waitedMs };
    if (waitedMs + Number(waitMs) > maxWaitMs) {
      throw new AppError(429, 'message_throttled', 'Too many messages are going out on this connection right now. Try again in a moment.', {
        retryAfterMs: Number(waitMs),
      });
    }
    await sleep(Number(waitMs));
    waitedMs += Number(waitMs);
  }
}
