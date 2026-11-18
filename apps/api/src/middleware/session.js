import { env } from '../config/env.js';
import { db } from '../lib/db.js';
import { redis } from '../lib/redis.js';
import { sha256 } from '../lib/crypto.js';
import { findSession } from '../modules/auth/sessions.js';

const TOUCH_EVERY_SECONDS = 300;

/** Attach req.auth = { user, session, sessionHash } when the session cookie is valid. */
export async function loadSession(req, _res, next) {
  const token = req.cookies?.[env.SESSION_COOKIE_NAME];
  if (!token) return next();

  const sessionHash = sha256(token);
  const session = await findSession(sessionHash);
  if (!session) return next();

  const user = await db('users').where({ id: session.userId }).first();
  if (!user || user.status !== 'active') return next();

  req.auth = { user, session, sessionHash };

  // Record activity for the "where you're signed in" list, at most every few minutes.
  const touched = await redis.set(`sess:touch:${session.id}`, '1', 'EX', TOUCH_EVERY_SECONDS, 'NX');
  if (touched) {
    db('sessions')
      .where({ id: session.id })
      .update({ last_seen_at: db.fn.now() })
      .catch((err) => req.log.warn({ err }, 'Could not update session activity'));
  }
  next();
}
