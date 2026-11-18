import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from './logger.js';

/** Shared connection for caching, rate limits and small lookups. Connects on first use. */
export const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: true });
redis.on('error', (err) => logger.error({ err }, 'Redis connection error'));

/** BullMQ needs its own connections with maxRetriesPerRequest disabled. */
export function createQueueConnection() {
  const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  connection.on('error', (err) => logger.error({ err }, 'Redis queue connection error'));
  return connection;
}
