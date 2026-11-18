import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { env } from '../config/env.js';
import { db } from '../lib/db.js';
import { redis } from '../lib/redis.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { childPath } from '../core/orgTree.js';
import { bumpAccessVersion } from '../core/access.js';
import { syncSystemRoles } from '../core/systemRoles.js';
import { buildRegistry } from '../registry.js';

// Create a new top-level group with an owner, e.g. to run another organisation on the same platform:
//   npm run org:create-group -w @phoenix/api -- --name "Acme Learning" --code acme \
//     --owner-email owner@acme.example --owner-name "Asha Mehta"

const { values } = parseArgs({
  options: {
    name: { type: 'string' },
    code: { type: 'string' },
    'owner-email': { type: 'string' },
    'owner-name': { type: 'string' },
  },
});

const name = values.name?.trim();
const code = values.code?.trim().toLowerCase();
const ownerEmail = values['owner-email']?.trim().toLowerCase();
const ownerName = values['owner-name']?.trim();

if (!name || !code || !ownerEmail || !ownerName || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(code)) {
  console.error('Usage: create-group --name "Group name" --code group-code --owner-email you@example.com --owner-name "Your Name"');
  process.exit(1);
}

try {
  await syncSystemRoles(db, buildRegistry());
  const inviteUrl = await db.transaction(async (trx) => {
    const id = randomUUID();
    await trx('org_units').insert({ id, parent_id: null, root_id: id, type: 'group', name, code, path: childPath(null, id), depth: 0 });
    let user = await trx('users').whereRaw('lower(email) = ?', [ownerEmail]).first();
    if (!user) [user] = await trx('users').insert({ email: ownerEmail, name: ownerName, status: 'invited' }).returning('*');
    const owner = await trx('roles').whereNull('group_id').where({ key: 'group_owner' }).first();
    await trx('role_assignments').insert({ user_id: user.id, role_id: owner.id, org_unit_id: id });
    if (user.status !== 'invited') return null;
    const token = randomToken();
    await trx('user_tokens').insert({
      user_id: user.id,
      type: 'invite',
      token_hash: sha256(token),
      expires_at: new Date(Date.now() + 7 * 86_400_000),
    });
    return `${env.APP_URL}/accept-invite?token=${token}`;
  });
  await bumpAccessVersion();
  console.log(`Created group "${name}".`);
  console.log(inviteUrl ? `Owner invitation link (valid 7 days):\n${inviteUrl}` : `${ownerEmail} already has an account and is now the owner.`);
} catch (err) {
  console.error(err.message ?? err);
  process.exitCode = 1;
} finally {
  await db.destroy();
  redis.disconnect();
}
