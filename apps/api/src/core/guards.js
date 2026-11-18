import { db } from '../lib/db.js';
import { errors } from '../lib/errors.js';
import { loadAccess } from './access.js';

/**
 * Require a signed-in user and load their access context onto req.access.
 *
 * mfa:
 *   'enforce' (default)  verified 2FA when enabled, and 2FA set up when policy requires it
 *   'pending'            allow sessions still waiting for the 2FA code
 *   'setup'              allow users who must set up 2FA but haven't yet
 *   'any'                allow both
 */
export function requireAuth({ mfa = 'enforce' } = {}) {
  return async (req, _res, next) => {
    if (!req.auth) throw errors.unauthorized();
    const { user, session } = req.auth;
    // API keys arrive with their access context built from the key's scopes (modules/integrations/apiKeys/auth.js).
    const access = req.auth.access ?? (await loadAccess(user.id, req.app.locals.registry));
    req.access = access;

    const waitingForCode = user.mfa_enabled && !session.mfaVerified;
    const mustSetUp = !user.mfa_enabled && access.mfaRequired;
    if (waitingForCode && mfa !== 'pending' && mfa !== 'any') throw errors.mfaRequired();
    if (mustSetUp && mfa !== 'setup' && mfa !== 'any') throw errors.mfaSetupRequired();
    next();
  };
}

export function loadUnit(id, trx = db) {
  return trx('org_units').where({ id }).first();
}

/**
 * Load a unit the user can see, optionally checking a permission on it.
 * Units the user can't see return 404 so their existence isn't revealed.
 */
export async function requireUnit(req, unitId, permission, trx = db) {
  const unit = await loadUnit(unitId, trx);
  if (!unit || !req.access.canSee(unit.path)) throw errors.notFound('Unit');
  if (permission && !req.access.can(permission, unit.path)) throw errors.forbidden();
  return unit;
}
