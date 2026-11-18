import { json } from '../lib/db.js';

const SENSITIVE_KEYS = new Set([
  'password',
  'password_hash',
  'mfa_secret',
  'mfa_pending_secret',
  'mfa_recovery_codes',
  'token',
  'token_hash',
]);

function redact(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = SENSITIVE_KEYS.has(key) ? '[redacted]' : item;
  return out;
}

/** Keep only the fields that changed, so audit rows stay small and readable. */
export function diffObjects(before, after) {
  if (!before || !after) return { before: redact(before) ?? null, after: redact(after) ?? null };
  const b = {};
  const a = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      b[key] = before[key];
      a[key] = after[key];
    }
  }
  return { before: redact(b), after: redact(a) };
}

/**
 * Write an audit entry inside the same transaction as the change.
 * @param {import('knex').Knex | import('knex').Knex.Transaction} trx
 * @param {import('express').Request | null} req
 */
export async function writeAudit(trx, req, entry) {
  const { before, after } = diffObjects(entry.before, entry.after);
  const unit = entry.unit ?? null;
  await trx('audit_logs').insert({
    group_id: unit?.root_id ?? entry.groupId ?? null,
    org_unit_id: unit?.id ?? null,
    actor_user_id: entry.actorUserId ?? req?.auth?.user?.id ?? null,
    // 'api_key': a request made with an API key; actor_user_id is then the key's service user.
    actor_type: entry.actorType ?? (req?.auth?.apiKey ? 'api_key' : req?.auth || entry.actorUserId ? 'user' : 'system'),
    action: entry.action,
    entity_type: entry.entityType ?? null,
    entity_id: entry.entityId != null ? String(entry.entityId) : null,
    before: before && Object.keys(before).length ? json(before) : null,
    after: after && Object.keys(after).length ? json(after) : null,
    meta: entry.meta ? json(entry.meta) : null,
    ip: req?.ip ?? null,
    user_agent: req?.get?.('user-agent')?.slice(0, 400) ?? null,
    request_id: req?.id ?? null,
  });
}
