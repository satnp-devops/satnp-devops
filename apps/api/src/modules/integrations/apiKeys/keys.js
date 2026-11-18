import { randomToken, sha256 } from '../../../lib/crypto.js';
import { AccessContext } from '../../../core/accessContext.js';

/**
 * API keys, the pure parts (unit-tested in test/integrations/apiKeys.test.js).
 *
 *   phx_<43 base64url characters>   32 random bytes; shown once when created
 *
 * The database keeps sha256(key) and the first 12 characters as a visible prefix. The key is
 * long and random, so a fast hash is enough (no password stretching needed), and looking a key
 * up is one indexed equality on key_hash.
 */

export const API_KEY_PREFIX = 'phx_';
const KEY_PATTERN = /^phx_[A-Za-z0-9_-]{43}$/;
const VISIBLE_PREFIX_LENGTH = 12;

/** Scopes a key may never carry: a key must not mint or revoke keys. */
export const DENIED_SCOPE_MODULES = Object.freeze(['api_keys']);

export function generateApiKey() {
  const secret = `${API_KEY_PREFIX}${randomToken(32)}`;
  return { secret, prefix: secret.slice(0, VISIBLE_PREFIX_LENGTH), hash: hashApiKey(secret) };
}

export const hashApiKey = (secret) => sha256(secret);

export const looksLikeApiKey = (value) => typeof value === 'string' && KEY_PATTERN.test(value);

/** The token of an `Authorization: Bearer <token>` header, or null for any other scheme. */
export function bearerToken(header) {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
  return match ? match[1] : null;
}

/**
 * Problems with a list of scopes, as { index, message }. Scopes are exact permission keys from
 * the registry (no "*", no "module.*", no ":own": a service principal owns no records), the
 * creator must hold each one at the key's unit, and api_keys.* is never allowed.
 * @param {{ permissions: Map<string, object> }} registry
 * @param {string[]} scopes
 * @param {(scope: string) => boolean} creatorHolds
 */
export function scopeProblems(registry, scopes, creatorHolds) {
  const problems = [];
  scopes.forEach((scope, index) => {
    const definition = registry.permissions.get(scope);
    if (!definition) problems.push({ index, message: `Unknown permission "${scope}"` });
    else if (DENIED_SCOPE_MODULES.includes(definition.module)) problems.push({ index, message: 'API keys cannot manage API keys' });
    else if (!creatorHolds(scope)) problems.push({ index, message: 'You can only give a key permissions you hold there' });
  });
  return problems;
}

/** Is the key usable at this moment? */
export function keyStatus(row, now = Date.now()) {
  if (row.revoked_at) return 'revoked';
  if (row.expires_at && new Date(row.expires_at).getTime() <= now) return 'expired';
  return 'active';
}

/**
 * The access context of a request made with a key: one assignment at the key's unit carrying
 * exactly its scopes, so req.access.can(), canSee() and rootsFor() answer as for a person
 * holding a role with those permissions there.
 * @param {{ id: string, name: string, scopes: string[], service_user_id: string }} key
 * @param {{ id: string, path: string, name: string, type: string, root_id: string }} unit
 */
export function apiKeyAccess(key, unit) {
  return new AccessContext({
    userId: key.service_user_id,
    mfaRequired: false,
    assignments: [
      {
        id: `api-key:${key.id}`,
        unitId: unit.id,
        unitPath: unit.path,
        unitName: unit.name,
        unitType: unit.type,
        groupId: unit.root_id,
        roleId: null,
        roleKey: 'api_key',
        roleName: `API key: ${key.name}`,
        permissions: [...key.scopes],
      },
    ],
  });
}

/** The users row that stands for a key in created_by columns and the audit log. It can never sign in. */
export function serviceUserFor(keyId, name) {
  return {
    email: `api-key-${keyId}@keys.phoenix.invalid`,
    name: `API key: ${name}`.slice(0, 200),
    status: 'disabled',
    password_hash: null,
  };
}
