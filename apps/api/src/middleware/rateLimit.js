import { redis } from '../lib/redis.js';
import { errors } from '../lib/errors.js';

/** Fixed-window rate limit backed by Redis, so it holds across API instances. */
export function rateLimit({ name, limit, windowSeconds, key }) {
  return async (req, _res, next) => {
    const bucket = `rl:${name}:${key(req)}`;
    const count = await redis.incr(bucket);
    if (count === 1) await redis.expire(bucket, windowSeconds);
    if (count > limit) throw errors.tooMany();
    next();
  };
}
