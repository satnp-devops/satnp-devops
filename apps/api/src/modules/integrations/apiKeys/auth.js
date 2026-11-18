import { env } from '../../../config/env.js';
import { db } from '../../../lib/db.js';
import { errors } from '../../../lib/errors.js';
import { redis } from '../../../lib/redis.js';
import { apiKeyAccess, bearerToken, hashApiKey, keyStatus, looksLikeApiKey } from './keys.js';

const CACHE_SECONDS = 60;
const TOUCH_EVERY_SECONDS = 60;
const RATE_WINDOW_SECONDS = 60;

export const apiKeyCacheKey = (hash) => `apikey:${hash}`;

/** The key, its service user and its unit, cached briefly; revoking a key clears the cache. */
async function findKey(hash) {
  const cached = await redis.get(apiKeyCacheKey(hash));
  if (cached) return cached === 'none' ? null : JSON.parse(cached);
  const row = await db('api_keys as k')
    .join('users as u', 'u.id', 'k.service_user_id')
    .join('org_units as o', 'o.id', 'k.unit_id')
    .where('k.key_hash', hash)
    .first(
      'k.id',
      'k.name',
      'k.scopes',
      'k.service_user_id',
      'k.unit_id',
      'k.group_id',
      'k.expires_at',
      'k.revoked_at',
      'u.email as user_email',
      'u.name as user_name',
      'o.path as unit_path',
      'o.name as unit_name',
      'o.type as unit_type',
      'o.root_id as unit_root_id',
      'o.status as unit_status',
    );
  await redis.set(apiKeyCacheKey(hash), row ? JSON.stringify(row) : 'none', 'EX', CACHE_SECONDS);
  return row ?? null;
}

/**
 * `Authorization: Bearer phx_...` authenticates a service principal (docs/platform/INTEGRATIONS.md,
 * "API keys"). Mounted right after loadSession (app.js):
 *
 *   - Any Authorization header switches cookie auth off for the request. The CSRF guard lets such
 *     requests through without X-Phoenix-Client, so a cookie must never authenticate them.
 *   - A missing, malformed, unknown, revoked or expired key is 401; account endpoints (/auth/...) are 403.
 *   - req.auth becomes { user: the key's service user, session: { mfaVerified: true }, apiKey, access },
 *     and requireAuth() uses that access context: exactly the key's scopes at its unit.
 *   - Each key is rate limited (API_KEY_RATE_LIMIT requests a minute) and last_used_at is kept.
 * Provider webhooks (/webhooks/...) authenticate by signature instead and are left alone.
 */
export async function apiKeyAuth(req, _res, next) {
  const header = req.get('authorization');
  if (!header || req.path.startsWith('/webhooks/')) return next();
  req.auth = undefined;

  const token = bearerToken(header);
  if (!looksLikeApiKey(token)) throw errors.unauthorized('Send an API key as Authorization: Bearer phx_...');
  const key = await findKey(hashApiKey(token));
  if (!key || keyStatus(key) !== 'active' || key.unit_status !== 'active') {
    req.log?.info({ apiKey: key ? { id: key.id } : null }, 'API key refused');
    throw errors.unauthorized('This API key is invalid, revoked or expired');
  }
  if (req.path.startsWith('/auth/')) throw errors.forbidden('API keys cannot use account endpoints');

  const bucket = `rl:apikey:${key.id}`;
  const count = await redis.incr(bucket);
  if (count === 1) await redis.expire(bucket, RATE_WINDOW_SECONDS);
  if (count > env.API_KEY_RATE_LIMIT) throw errors.tooMany('This API key made too many requests. Slow down and retry in a minute.');

  const unit = { id: key.unit_id, path: key.unit_path, name: key.unit_name, type: key.unit_type, root_id: key.unit_root_id };
  req.auth = {
    user: { id: key.service_user_id, email: key.user_email, name: key.user_name, status: 'active', mfa_enabled: false, time_zone: null },
    session: { id: null, mfaVerified: true },
    apiKey: { id: key.id, name: key.name, unitId: key.unit_id, scopes: key.scopes },
    access: apiKeyAccess(key, unit),
  };
  req.log = req.log?.child?.({ apiKeyId: key.id }) ?? req.log;

  const touched = await redis.set(`apikey:touch:${key.id}`, '1', 'EX', TOUCH_EVERY_SECONDS, 'NX');
  if (touched) {
    db('api_keys')
      .where({ id: key.id })
      .update({ last_used_at: db.fn.now(), last_used_ip: req.ip ?? null })
      .catch((err) => req.log?.warn({ err }, 'Could not record API key use'));
  }
  next();
}
