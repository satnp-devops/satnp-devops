import QRCode from 'qrcode';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { db } from '../../lib/db.js';
import { redis } from '../../lib/redis.js';
import { errors } from '../../lib/errors.js';
import { validate } from '../../lib/validate.js';
import { emailSchema, idParams, nameSchema, passwordSchema } from '../../lib/schemas.js';
import {
  DUMMY_PASSWORD_HASH,
  decrypt,
  encrypt,
  hashPassword,
  randomToken,
  sha256,
  verifyPassword,
} from '../../lib/crypto.js';
import {
  generateRecoveryCodes,
  generateTotpSecret,
  normaliseRecoveryCode,
  otpauthUrl,
  verifyTotp,
} from '../../lib/totp.js';
import { requireAuth } from '../../core/guards.js';
import { writeAudit } from '../../core/audit.js';
import { emitEvent } from '../../core/events.js';
import { enqueueMail } from '../../core/queue.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import { listVisibleUnits } from '../org/service.js';
import { presentUser } from '../users/present.js';
import { homeUnitForUser } from '../users/service.js';
import {
  clearSessionCookie,
  createSession,
  findValidToken,
  forgetSessionCache,
  markMfaVerified,
  revokeSession,
  revokeUserSessions,
  setSessionCookie,
} from './sessions.js';

const ISSUER = 'Phoenix Platform';
const codeBody = z.object({ code: z.string().trim().min(6).max(16) });

/** Accept a TOTP code (once per time step) or a one-time recovery code. Returns the method used, or null. */
async function checkSecondFactor(user, code) {
  const secret = decrypt(user.mfa_secret, env.encryptionKey);
  const counter = verifyTotp(secret, code);
  if (counter !== null) {
    const key = `mfa:last:${user.id}`;
    const lastUsed = Number((await redis.get(key)) ?? -1);
    if (counter <= lastUsed) return null; // the same code can't be used twice
    await redis.set(key, String(counter), 'EX', 300);
    return 'totp';
  }
  const normalised = normaliseRecoveryCode(code);
  if (normalised.length !== 10) return null;
  const hash = sha256(normalised);
  const updated = await db('users')
    .where({ id: user.id })
    .whereRaw('? = any(mfa_recovery_codes)', [hash])
    .update({ mfa_recovery_codes: db.raw('array_remove(mfa_recovery_codes, ?)', [hash]) });
  return updated ? 'recovery_code' : null;
}

export function authRoutes(router) {
  const loginLimit = rateLimit({
    name: 'login',
    limit: 10,
    windowSeconds: 900,
    key: (req) => `${req.ip}:${String(req.body?.email ?? '').toLowerCase()}`,
  });
  const codeLimit = rateLimit({ name: 'mfa', limit: 8, windowSeconds: 900, key: (req) => req.auth?.session.id ?? req.ip });
  const tokenLimit = rateLimit({ name: 'token', limit: 20, windowSeconds: 900, key: (req) => req.ip });

  router.post(
    '/auth/login',
    loginLimit,
    validate({ body: z.object({ email: emailSchema, password: z.string().min(1).max(200) }) }),
    async (req, res) => {
      const { email, password } = req.valid.body;
      const user = await db('users').whereRaw('lower(email) = ?', [email]).first();
      const passwordOk = await verifyPassword(password, user?.password_hash ?? DUMMY_PASSWORD_HASH);
      if (!user || !passwordOk || user.status !== 'active') {
        if (user) {
          await writeAudit(db, req, {
            action: 'auth.login_failed',
            entityType: 'user',
            entityId: user.id,
            actorUserId: user.id,
            meta: { reason: passwordOk ? `account_${user.status}` : 'wrong_password' },
          });
        }
        throw errors.invalidCredentials();
      }
      const { token, session } = await createSession(user, req, { mfaVerified: !user.mfa_enabled });
      await db('users').where({ id: user.id }).update({ last_login_at: db.fn.now() });
      await writeAudit(db, req, {
        action: 'auth.login',
        entityType: 'user',
        entityId: user.id,
        actorUserId: user.id,
        meta: { mfaPending: user.mfa_enabled },
      });
      setSessionCookie(res, token, session.expires_at);
      res.json({ data: { mfaRequired: user.mfa_enabled } });
    },
  );

  router.post('/auth/logout', async (req, res) => {
    if (req.auth) {
      await revokeSession(req.auth.session.id);
      await writeAudit(db, req, { action: 'auth.logout', entityType: 'user', entityId: req.auth.user.id });
    }
    clearSessionCookie(res);
    res.status(204).end();
  });

  router.get('/auth/me', requireAuth({ mfa: 'any' }), async (req, res) => {
    const { user, session } = req.auth;
    const access = req.access;
    const mfaPending = user.mfa_enabled && !session.mfaVerified;
    const base = {
      user: presentUser(user),
      session: {
        mfaVerified: session.mfaVerified,
        mfaPending,
        mfaSetupRequired: !user.mfa_enabled && access.mfaRequired,
      },
    };
    if (mfaPending) return res.json({ data: { ...base, assignments: [], units: [], grants: [] } });

    res.json({
      data: {
        ...base,
        assignments: access.assignments.map((a) => ({
          id: a.id,
          unitId: a.unitId,
          unitName: a.unitName,
          unitType: a.unitType,
          groupId: a.groupId,
          role: { id: a.roleId, key: a.roleKey, name: a.roleName },
        })),
        units: await listVisibleUnits(access),
        grants: access.assignments.map((a) => ({ unitId: a.unitId, permissions: a.permissions })),
      },
    });
  });

  // ---------- Two-step verification ----------

  router.post('/auth/mfa/verify', requireAuth({ mfa: 'any' }), codeLimit, validate({ body: codeBody }), async (req, res) => {
    const { user, session, sessionHash } = req.auth;
    if (!user.mfa_enabled) throw errors.badRequest('Two-step verification is not turned on for this account');
    const method = await checkSecondFactor(user, req.valid.body.code);
    if (!method) {
      await writeAudit(db, req, { action: 'auth.mfa_failed', entityType: 'user', entityId: user.id });
      throw errors.invalidCode();
    }
    await markMfaVerified(session.id, sessionHash);
    await writeAudit(db, req, { action: 'auth.mfa_verified', entityType: 'user', entityId: user.id, meta: { method } });
    res.json({ data: { verified: true, method } });
  });

  router.post('/auth/mfa/setup', requireAuth({ mfa: 'setup' }), async (req, res) => {
    const { user } = req.auth;
    if (user.mfa_enabled) throw errors.conflict('Two-step verification is already on');
    const secret = generateTotpSecret();
    await db('users')
      .where({ id: user.id })
      .update({ mfa_pending_secret: encrypt(secret, env.encryptionKey), updated_at: db.fn.now() });
    const url = otpauthUrl({ secret, account: user.email, issuer: ISSUER });
    const qrDataUrl = await QRCode.toDataURL(url, { margin: 1, width: 220 });
    res.json({ data: { secret, otpauthUrl: url, qrDataUrl } });
  });

  router.post('/auth/mfa/enable', requireAuth({ mfa: 'setup' }), codeLimit, validate({ body: codeBody }), async (req, res) => {
    const { user, session, sessionHash } = req.auth;
    if (user.mfa_enabled) throw errors.conflict('Two-step verification is already on');
    if (!user.mfa_pending_secret) throw errors.badRequest('Start the setup first');
    const counter = verifyTotp(decrypt(user.mfa_pending_secret, env.encryptionKey), req.valid.body.code);
    if (counter === null) throw errors.invalidCode();

    const recoveryCodes = generateRecoveryCodes();
    await db.transaction(async (trx) => {
      await trx('users')
        .where({ id: user.id })
        .update({
          mfa_enabled: true,
          mfa_secret: user.mfa_pending_secret,
          mfa_pending_secret: null,
          mfa_recovery_codes: recoveryCodes.map((code) => sha256(normaliseRecoveryCode(code))),
          updated_at: trx.fn.now(),
        });
      await trx('sessions').where({ id: session.id }).update({ mfa_verified: true });
      await writeAudit(trx, req, { action: 'auth.mfa_enabled', entityType: 'user', entityId: user.id });
      await emitEvent(trx, { type: 'auth.mfa_enabled', aggregateType: 'user', aggregateId: user.id, actorUserId: user.id });
    });
    await redis.set(`mfa:last:${user.id}`, String(counter), 'EX', 300);
    await forgetSessionCache(sessionHash);
    // Other devices never proved the second factor, so sign them out.
    await revokeUserSessions(user.id, { exceptSessionId: session.id });
    res.json({ data: { recoveryCodes } });
  });

  router.post(
    '/auth/mfa/disable',
    requireAuth(),
    codeLimit,
    validate({ body: z.object({ password: z.string().min(1).max(200), code: z.string().trim().min(6).max(16) }) }),
    async (req, res) => {
      const { user } = req.auth;
      if (!user.mfa_enabled) throw errors.badRequest('Two-step verification is already off');
      if (req.access.mfaRequired) throw errors.conflict('Your organisation requires two-step verification');
      if (!(await verifyPassword(req.valid.body.password, user.password_hash))) throw errors.invalidCredentials();
      if (!(await checkSecondFactor(user, req.valid.body.code))) throw errors.invalidCode();
      await db.transaction(async (trx) => {
        await trx('users')
          .where({ id: user.id })
          .update({ mfa_enabled: false, mfa_secret: null, mfa_pending_secret: null, mfa_recovery_codes: [], updated_at: trx.fn.now() });
        await writeAudit(trx, req, { action: 'auth.mfa_disabled', entityType: 'user', entityId: user.id });
        await emitEvent(trx, { type: 'auth.mfa_disabled', aggregateType: 'user', aggregateId: user.id, actorUserId: user.id });
      });
      res.json({ data: { disabled: true } });
    },
  );

  router.post(
    '/auth/mfa/recovery-codes',
    requireAuth(),
    validate({ body: z.object({ password: z.string().min(1).max(200) }) }),
    async (req, res) => {
      const { user } = req.auth;
      if (!user.mfa_enabled) throw errors.badRequest('Turn on two-step verification first');
      if (!(await verifyPassword(req.valid.body.password, user.password_hash))) throw errors.invalidCredentials();
      const recoveryCodes = generateRecoveryCodes();
      await db('users')
        .where({ id: user.id })
        .update({ mfa_recovery_codes: recoveryCodes.map((code) => sha256(normaliseRecoveryCode(code))), updated_at: db.fn.now() });
      await writeAudit(db, req, { action: 'auth.recovery_codes_regenerated', entityType: 'user', entityId: user.id });
      res.json({ data: { recoveryCodes } });
    },
  );

  // ---------- Passwords ----------

  router.post(
    '/auth/password/change',
    requireAuth(),
    validate({ body: z.object({ currentPassword: z.string().min(1).max(200), newPassword: passwordSchema }) }),
    async (req, res) => {
      const { user, session } = req.auth;
      const { currentPassword, newPassword } = req.valid.body;
      if (!(await verifyPassword(currentPassword, user.password_hash))) {
        throw errors.validation([{ path: 'body.currentPassword', message: 'Your current password is incorrect' }]);
      }
      const hash = await hashPassword(newPassword);
      await db.transaction(async (trx) => {
        await trx('users').where({ id: user.id }).update({ password_hash: hash, updated_at: trx.fn.now() });
        await writeAudit(trx, req, { action: 'auth.password_changed', entityType: 'user', entityId: user.id });
      });
      const otherSessionsSignedOut = await revokeUserSessions(user.id, { exceptSessionId: session.id });
      res.json({ data: { otherSessionsSignedOut } });
    },
  );

  router.post(
    '/auth/password/forgot',
    rateLimit({ name: 'forgot', limit: 5, windowSeconds: 3600, key: (req) => req.ip }),
    validate({ body: z.object({ email: emailSchema }) }),
    async (req, res) => {
      const user = await db('users').whereRaw('lower(email) = ?', [req.valid.body.email]).first();
      if (user && user.status === 'active') {
        const token = randomToken();
        await db.transaction(async (trx) => {
          await trx('user_tokens')
            .where({ user_id: user.id, type: 'password_reset' })
            .whereNull('used_at')
            .update({ used_at: trx.fn.now() });
          await trx('user_tokens').insert({
            user_id: user.id,
            type: 'password_reset',
            token_hash: sha256(token),
            expires_at: new Date(Date.now() + 3_600_000),
          });
          await writeAudit(trx, req, {
            action: 'auth.password_reset_requested',
            entityType: 'user',
            entityId: user.id,
            actorUserId: user.id,
          });
        });
        await enqueueMail({
          to: user.email,
          subject: 'Reset your Phoenix Platform password',
          text: `Hi ${user.name},\n\nUse this link to choose a new password. It works once and expires in 1 hour:\n${env.APP_URL}/reset-password?token=${token}\n\nIf you didn't ask for this, you can ignore this email.`,
        });
      }
      // Same answer whether or not the account exists.
      res.json({ data: { sent: true } });
    },
  );

  router.post(
    '/auth/password/reset',
    tokenLimit,
    validate({ body: z.object({ token: z.string().min(20).max(200), password: passwordSchema }) }),
    async (req, res) => {
      const row = await findValidToken('password_reset', req.valid.body.token);
      if (!row) throw errors.badRequest('This reset link is invalid or has expired. Ask for a new one.');
      const hash = await hashPassword(req.valid.body.password);
      await db.transaction(async (trx) => {
        await trx('users').where({ id: row.user_id }).update({ password_hash: hash, updated_at: trx.fn.now() });
        await trx('user_tokens').where({ id: row.id }).update({ used_at: trx.fn.now() });
        await writeAudit(trx, req, {
          action: 'auth.password_reset',
          entityType: 'user',
          entityId: row.user_id,
          actorUserId: row.user_id,
        });
      });
      await revokeUserSessions(row.user_id);
      res.json({ data: { reset: true } });
    },
  );

  // ---------- Invitations ----------

  router.get('/auth/invites/:token', tokenLimit, async (req, res) => {
    const row = await findValidToken('invite', req.params.token);
    if (!row) throw errors.notFound('Invitation');
    const user = await db('users').where({ id: row.user_id }).first();
    const inviter = row.created_by ? await db('users').where({ id: row.created_by }).first() : null;
    res.json({ data: { email: user.email, name: user.name, invitedBy: inviter?.name ?? null } });
  });

  router.post(
    '/auth/invites/accept',
    tokenLimit,
    validate({ body: z.object({ token: z.string().min(20).max(200), name: nameSchema.optional(), password: passwordSchema }) }),
    async (req, res) => {
      const { token, name, password } = req.valid.body;
      const row = await findValidToken('invite', token);
      if (!row) throw errors.badRequest('This invitation is invalid or has expired. Ask for a new one.');
      const user = await db('users').where({ id: row.user_id }).first();
      if (!user || user.status === 'disabled') throw errors.badRequest('This account is not available. Contact your admin.');

      const hash = await hashPassword(password);
      await db.transaction(async (trx) => {
        await trx('users')
          .where({ id: user.id })
          .update({ password_hash: hash, status: 'active', name: name ?? user.name, updated_at: trx.fn.now() });
        await trx('user_tokens').where({ id: row.id }).update({ used_at: trx.fn.now() });
        const home = await homeUnitForUser(user.id, trx);
        await writeAudit(trx, req, {
          action: 'user.activated',
          entityType: 'user',
          entityId: user.id,
          unit: home,
          actorUserId: user.id,
          before: { status: user.status },
          after: { status: 'active' },
        });
        await emitEvent(trx, {
          type: 'user.activated',
          groupId: home?.root_id,
          unitId: home?.id,
          aggregateType: 'user',
          aggregateId: user.id,
          actorUserId: user.id,
        });
      });

      const { token: sessionToken, session } = await createSession(user, req, { mfaVerified: !user.mfa_enabled });
      setSessionCookie(res, sessionToken, session.expires_at);
      res.json({ data: { activated: true } });
    },
  );

  // ---------- Devices ----------

  router.get('/auth/sessions', requireAuth(), async (req, res) => {
    const rows = await db('sessions')
      .where({ user_id: req.auth.user.id })
      .whereNull('revoked_at')
      .where('expires_at', '>', db.fn.now())
      .orderBy('last_seen_at', 'desc')
      .limit(50);
    res.json({
      data: rows.map((s) => ({
        id: s.id,
        ip: s.ip,
        userAgent: s.user_agent,
        createdAt: s.created_at,
        lastSeenAt: s.last_seen_at,
        current: s.id === req.auth.session.id,
      })),
    });
  });

  router.delete('/auth/sessions/:id', requireAuth(), validate({ params: idParams }), async (req, res) => {
    const session = await db('sessions').where({ id: req.valid.params.id, user_id: req.auth.user.id }).first();
    if (!session) throw errors.notFound('Session');
    await revokeSession(session.id);
    await writeAudit(db, req, { action: 'auth.session_revoked', entityType: 'session', entityId: session.id });
    res.status(204).end();
  });
}
