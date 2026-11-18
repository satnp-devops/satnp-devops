import { env } from '../../config/env.js';
import { db } from '../../lib/db.js';
import { redis } from '../../lib/redis.js';
import { randomToken, sha256 } from '../../lib/crypto.js';

// The cookie holds a random token; the database stores only its SHA-256 hash.
// Redis caches session lookups so most requests never touch the sessions table.

const CACHE_TTL_SECONDS = 600;
const cacheKey = (hash) => `sess:${hash}`;

export async function createSession(user, req, { mfaVerified }) {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + env.SESSION_TTL_DAYS * 86_400_000);
  const [session] = await db('sessions')
    .insert({
      user_id: user.id,
      token_hash: sha256(token),
      mfa_verified: mfaVerified,
      ip: req.ip ?? null,
      user_agent: req.get('user-agent')?.slice(0, 400) ?? null,
      expires_at: expiresAt,
    })
    .returning('*');
  return { token, session };
}

export async function findSession(hash) {
  const cached = await redis.get(cacheKey(hash));
  if (cached) {
    const session = JSON.parse(cached);
    if (new Date(session.expiresAt) > new Date()) return session;
    await redis.del(cacheKey(hash));
    return null;
  }
  const row = await db('sessions')
    .where({ token_hash: hash })
    .whereNull('revoked_at')
    .where('expires_at', '>', db.fn.now())
    .first();
  if (!row) return null;
  const session = {
    id: row.id,
    userId: row.user_id,
    mfaVerified: row.mfa_verified,
    expiresAt: new Date(row.expires_at).toISOString(),
  };
  await redis.set(cacheKey(hash), JSON.stringify(session), 'EX', CACHE_TTL_SECONDS);
  return session;
}

export const forgetSessionCache = (hash) => redis.del(cacheKey(hash));

export async function markMfaVerified(sessionId, hash) {
  await db('sessions').where({ id: sessionId }).update({ mfa_verified: true });
  await forgetSessionCache(hash);
}

export async function revokeSession(sessionId) {
  const [row] = await db('sessions')
    .where({ id: sessionId })
    .whereNull('revoked_at')
    .update({ revoked_at: db.fn.now() })
    .returning(['token_hash']);
  if (row) await forgetSessionCache(row.token_hash);
}

/** Sign a user out everywhere, optionally keeping the current session. */
export async function revokeUserSessions(userId, { exceptSessionId } = {}) {
  const rows = await db('sessions')
    .where({ user_id: userId })
    .whereNull('revoked_at')
    .modify((query) => {
      if (exceptSessionId) query.whereNot({ id: exceptSessionId });
    })
    .update({ revoked_at: db.fn.now() })
    .returning(['token_hash']);
  await Promise.all(rows.map((row) => forgetSessionCache(row.token_hash)));
  return rows.length;
}

const cookieOptions = () => ({ httpOnly: true, secure: env.isProd, sameSite: 'lax', path: '/' });

export function setSessionCookie(res, token, expiresAt) {
  res.cookie(env.SESSION_COOKIE_NAME, token, { ...cookieOptions(), expires: new Date(expiresAt) });
}

export function clearSessionCookie(res) {
  res.clearCookie(env.SESSION_COOKIE_NAME, cookieOptions());
}

/** One-time tokens for invites and password resets. */
export function findValidToken(type, token) {
  return db('user_tokens')
    .where({ type, token_hash: sha256(String(token)) })
    .whereNull('used_at')
    .where('expires_at', '>', db.fn.now())
    .first();
}
