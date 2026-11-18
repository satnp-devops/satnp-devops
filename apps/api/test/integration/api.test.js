import { test } from 'node:test';
import assert from 'node:assert/strict';
import { env } from '../../src/config/env.js';
import { db } from '../../src/lib/db.js';
import { redis } from '../../src/lib/redis.js';
import { base32Decode, totp } from '../../src/lib/totp.js';
import { closeQueues } from '../../src/core/queue.js';
import { createApp } from '../../src/app.js';
import { buildRegistry } from '../../src/registry.js';
import { modules } from '../../src/modules/index.js';

// End-to-end API test against a real Postgres + Redis.
// Needs a migrated and seeded database:  npm run db:reset && npm run test:integration
// It creates uniquely named records, so it can run repeatedly.

const enabled = process.env.INTEGRATION === '1';
const RUN = Date.now().toString(36);

function client(base) {
  let cookie = '';
  return async function call(method, path, body) {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', 'x-phoenix-client': 'integration-test', ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const header of res.headers.getSetCookie()) {
      const [pair] = header.split(';');
      if (pair.startsWith(`${env.SESSION_COOKIE_NAME}=`)) cookie = pair.endsWith('=') ? '' : pair;
    }
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
}

test('API end to end', { skip: !enabled && 'set INTEGRATION=1 to run' }, async (t) => {
  const app = createApp({ registry: buildRegistry(), modules });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const password = env.SEED_PASSWORD;

  t.after(async () => {
    server.close();
    await closeQueues();
    await db.destroy();
    await redis.quit();
  });

  // Repeated local runs would otherwise trip the sign-in and token rate limits.
  const limits = await redis.keys('rl:*');
  if (limits.length) await redis.del(...limits);

  const owner = client(base);
  const counsellor = client(base);
  const companyAdmin = client(base);
  const newcomer = client(base);
  let units;
  const unit = (name) => units.find((u) => u.name === name);

  await t.test('health and sign-in', async () => {
    const health = await owner('GET', '/health');
    assert.equal(health.status, 200);
    const wrong = await owner('POST', '/auth/login', { email: 'owner@phoenix.test', password: 'not-the-password' });
    assert.equal(wrong.status, 401);
    const login = await owner('POST', '/auth/login', { email: 'OWNER@phoenix.test ', password });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    const me = await owner('GET', '/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.data.user.email, 'owner@phoenix.test');
    units = me.body.data.units;
    assert.ok(unit('Phoenix Educational Institute'));
    assert.ok(unit('SAT admissions'));
  });

  await t.test('writes need the client header', async () => {
    const res = await fetch(`${base}/auth/logout`, { method: 'POST' });
    assert.equal(res.status, 403);
  });

  let newTeam;
  await t.test('owner creates a unit; duplicate codes and wrong levels are rejected', async () => {
    const created = await owner('POST', '/org/units', {
      parentId: unit('Pune centre').id,
      type: 'team',
      name: `Weekend batch team ${RUN}`,
      code: `weekend-${RUN}`,
      profile: { function: 'admissions', description: '' },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    newTeam = created.body.data;
    assert.equal(newTeam.depth, 3);
    assert.ok(newTeam.path.startsWith(unit('Pune centre').path));

    const duplicate = await owner('POST', '/org/units', {
      parentId: unit('Pune centre').id,
      type: 'team',
      name: 'Copy',
      code: `weekend-${RUN}`,
    });
    assert.equal(duplicate.status, 409);

    const wrongLevel = await owner('POST', '/org/units', {
      parentId: newTeam.id,
      type: 'company',
      name: 'Nested company',
      code: `nested-${RUN}`,
    });
    assert.equal(wrongLevel.status, 422);

    const badProfile = await owner('POST', '/org/units', {
      parentId: unit('Phoenix Educational Institute').id,
      type: 'company',
      name: `Bad GST ${RUN}`,
      code: `bad-gst-${RUN}`,
      profile: { gstin: 'NOT-A-GSTIN' },
    });
    assert.equal(badProfile.status, 422);
  });

  await t.test('a counsellor sees their own area but cannot manage it', async () => {
    assert.equal((await counsellor('POST', '/auth/login', { email: 'ritika@phoenix.test', password })).status, 200);
    const me = await counsellor('GET', '/auth/me');
    const names = me.body.data.units.map((u) => u.name);
    assert.ok(names.includes('SAT admissions'));
    assert.ok(names.includes('SatnPaper'), 'ancestors are visible for context');
    assert.ok(!names.includes('Pi Vector'), 'other companies are hidden');

    const create = await counsellor('POST', '/org/units', {
      parentId: unit('SAT admissions').id,
      type: 'team',
      name: 'Not allowed',
      code: `nope-${RUN}`,
    });
    assert.equal(create.status, 403);
    const people = await counsellor('GET', `/users?unitId=${unit('SatnPaper').id}`);
    assert.equal(people.status, 403);
    const otherCompany = await counsellor('GET', `/org/units/${unit('Pi Vector').id}`);
    assert.equal(otherCompany.status, 404);
  });

  let invitedUser;
  let inviteUrl;
  await t.test('owner invites someone; they accept and sign in', async () => {
    const roles = await owner('GET', '/roles');
    const counsellorRole = roles.body.data.find((r) => r.key === 'counsellor');
    const invite = await owner('POST', '/users/invite', {
      email: `new.${RUN}@phoenix.test`,
      name: 'New Counsellor',
      assignments: [{ roleId: counsellorRole.id, unitId: newTeam.id }],
    });
    assert.equal(invite.status, 201, JSON.stringify(invite.body));
    invitedUser = invite.body.data.user;
    inviteUrl = invite.body.data.inviteUrl;
    assert.equal(invitedUser.status, 'invited');
    assert.ok(inviteUrl.includes('/accept-invite?token='));

    const token = new URL(inviteUrl).searchParams.get('token');
    const info = await newcomer('GET', `/auth/invites/${token}`);
    assert.equal(info.status, 200);
    assert.equal(info.body.data.invitedBy, 'Anand Rao');
    const weak = await newcomer('POST', '/auth/invites/accept', { token, password: 'short' });
    assert.equal(weak.status, 422);
    const accepted = await newcomer('POST', '/auth/invites/accept', { token, password: 'a-strong-password-1' });
    assert.equal(accepted.status, 200);
    const again = await client(base)('POST', '/auth/invites/accept', { token, password: 'a-strong-password-1' });
    assert.equal(again.status, 400, 'invite links work once');
    const me = await newcomer('GET', '/auth/me');
    assert.equal(me.body.data.user.status, 'active');
    assert.equal(me.body.data.assignments[0].role.key, 'counsellor');
  });

  await t.test('company admins cannot hand out permissions they do not have', async () => {
    assert.equal((await companyAdmin('POST', '/auth/login', { email: 'admin.satnpaper@phoenix.test', password })).status, 200);
    const roles = await companyAdmin('GET', '/roles');
    assert.equal(roles.status, 200);
    const groupAdmin = roles.body.data.find((r) => r.key === 'group_admin');
    const counsellorRole = roles.body.data.find((r) => r.key === 'counsellor');
    const escalate = await companyAdmin('POST', `/users/${invitedUser.id}/assignments`, {
      roleId: groupAdmin.id,
      unitId: unit('SatnPaper').id,
    });
    assert.equal(escalate.status, 403);
    const outside = await companyAdmin('POST', `/users/${invitedUser.id}/assignments`, {
      roleId: counsellorRole.id,
      unitId: unit('Pi Vector').id,
    });
    assert.equal(outside.status, 404);
    const allowed = await companyAdmin('POST', `/users/${invitedUser.id}/assignments`, {
      roleId: counsellorRole.id,
      unitId: unit('SAT admissions').id,
    });
    assert.equal(allowed.status, 201, JSON.stringify(allowed.body));
    const archiveOwnCompany = await companyAdmin('PATCH', `/org/units/${unit('SatnPaper').id}`, { status: 'archived' });
    assert.equal(archiveOwnCompany.status, 403, 'archiving is decided one level up');
    const list = await companyAdmin('GET', `/users?unitId=${unit('SatnPaper').id}&q=new.${RUN}`);
    assert.equal(list.body.data.length, 1);
    assert.equal(list.body.data[0].assignments.length, 2);
  });

  await t.test('settings inherit down the tree', async () => {
    const set = await owner('PUT', '/settings/locale.currency', { unitId: unit('SatnPaper').id, value: 'AED' });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    const team = await owner('GET', `/settings?unitId=${unit('SAT admissions').id}`);
    const currency = team.body.data.values['locale.currency'];
    assert.equal(currency.value, 'AED');
    assert.equal(currency.sourceUnitId, unit('SatnPaper').id);
    assert.equal(currency.inherited, true);
    const invalid = await owner('PUT', '/settings/locale.timeZone', { unitId: unit('SatnPaper').id, value: 'Mars/Base' });
    assert.equal(invalid.status, 422);
    const wrongLevel = await owner('PUT', '/settings/branding.primaryColor', { unitId: unit('Pune centre').id, value: '#000000' });
    assert.equal(wrongLevel.status, 422);
    assert.equal((await owner('DELETE', `/settings/locale.currency?unitId=${unit('SatnPaper').id}`)).status, 204);
    const after = await owner('GET', `/settings?unitId=${unit('SAT admissions').id}`);
    assert.equal(after.body.data.values['locale.currency'].value, 'INR');
  });

  await t.test('two-step verification: setup, sign-in challenge, recovery code', async () => {
    const setup = await newcomer('POST', '/auth/mfa/setup');
    assert.equal(setup.status, 200);
    assert.ok(setup.body.data.qrDataUrl.startsWith('data:image/png;base64,'));
    const key = base32Decode(setup.body.data.secret);
    const enable = await newcomer('POST', '/auth/mfa/enable', { code: totp(key) });
    assert.equal(enable.status, 200, JSON.stringify(enable.body));
    const [recoveryCode] = enable.body.data.recoveryCodes;

    assert.equal((await newcomer('POST', '/auth/logout')).status, 204);
    const login = await newcomer('POST', '/auth/login', { email: `new.${RUN}@phoenix.test`, password: 'a-strong-password-1' });
    assert.equal(login.body.data.mfaRequired, true);
    const blocked = await newcomer('GET', '/org/units');
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error.code, 'mfa_required');
    const wrong = await newcomer('POST', '/auth/mfa/verify', { code: '000000' });
    assert.equal(wrong.status, 401);
    const verify = await newcomer('POST', '/auth/mfa/verify', { code: recoveryCode.toLowerCase() });
    assert.equal(verify.status, 200);
    assert.equal(verify.body.data.method, 'recovery_code');
    assert.equal((await newcomer('GET', '/org/units')).status, 200);
    const reuse = await newcomer('POST', '/auth/mfa/verify', { code: recoveryCode });
    assert.equal(reuse.status, 401, 'recovery codes work once');
  });

  await t.test('owner can require 2FA for a company', async () => {
    assert.equal((await owner('PUT', '/settings/security.requireMfa', { unitId: unit('SatnPaper').id, value: true })).status, 200);
    const blocked = await counsellor('GET', '/org/units');
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error.code, 'mfa_setup_required');
    const me = await counsellor('GET', '/auth/me');
    assert.equal(me.body.data.session.mfaSetupRequired, true);
    assert.equal((await owner('DELETE', `/settings/security.requireMfa?unitId=${unit('SatnPaper').id}`)).status, 204);
    assert.equal((await counsellor('GET', '/org/units')).status, 200);
  });

  await t.test('moving a unit moves everything under it', async () => {
    const region = await owner('POST', '/org/units', {
      parentId: unit('SatnPaper').id,
      type: 'region',
      name: `West ${RUN}`,
      code: `west-${RUN}`,
    });
    assert.equal(region.status, 201);
    const moved = await owner('POST', `/org/units/${unit('Pune centre').id}/move`, { parentId: region.body.data.id });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.ok(moved.body.data.path.startsWith(region.body.data.path));
    const team = await owner('GET', `/org/units/${newTeam.id}`);
    assert.ok(team.body.data.path.startsWith(moved.body.data.path));
    assert.equal(team.body.data.depth, 4);
    const intoItself = await owner('POST', `/org/units/${region.body.data.id}/move`, { parentId: newTeam.id });
    assert.equal(intoItself.status, 409);
    const back = await owner('POST', `/org/units/${unit('Pune centre').id}/move`, { parentId: unit('SatnPaper').id });
    assert.equal(back.status, 200);
  });

  await t.test('custom roles: create, edit, delete', async () => {
    const created = await owner('POST', '/roles', {
      groupId: unit('Phoenix Educational Institute').id,
      name: `Admissions lead ${RUN}`,
      permissions: ['org.view', 'users.view', 'users.view'],
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.deepEqual(created.body.data.permissions, ['org.view', 'users.view']);
    const unknown = await owner('PATCH', `/roles/${created.body.data.id}`, { permissions: ['made.up'] });
    assert.equal(unknown.status, 422);
    const edited = await owner('PATCH', `/roles/${created.body.data.id}`, { permissions: ['org.view', 'users.*'] });
    assert.equal(edited.status, 200);
    const builtIn = (await owner('GET', '/roles')).body.data.find((r) => r.key === 'manager');
    assert.equal((await owner('PATCH', `/roles/${builtIn.id}`, { name: 'Boss' })).status, 409);
    assert.equal((await owner('DELETE', `/roles/${created.body.data.id}`)).status, 204);
  });

  await t.test('the audit log records who changed what', async () => {
    // Changes to a person are recorded at the narrowest unit covering everywhere they work.
    const disabled = await companyAdmin('PATCH', `/users/${invitedUser.id}`, { status: 'disabled' });
    assert.equal(disabled.status, 200, JSON.stringify(disabled.body));
    assert.equal((await companyAdmin('PATCH', `/users/${invitedUser.id}`, { status: 'active' })).status, 200);

    const log = await owner('GET', `/audit?unitId=${unit('SatnPaper').id}&limit=100`);
    assert.equal(log.status, 200);
    const actions = new Set(log.body.data.map((entry) => entry.action));
    for (const action of [
      'org_unit.created',
      'org_unit.moved',
      'user.invited',
      'user.activated',
      'user.disabled',
      'user.enabled',
      'settings.updated',
      'role_assignment.added',
    ]) {
      assert.ok(actions.has(action), `missing ${action}`);
    }
    const page = await owner('GET', `/audit?unitId=${unit('SatnPaper').id}&limit=2`);
    assert.equal(page.body.data.length, 2);
    assert.ok(page.body.nextCursor);
    const next = await owner('GET', `/audit?unitId=${unit('SatnPaper').id}&limit=2&cursor=${page.body.nextCursor}`);
    assert.ok(Number(next.body.data[0].id) < Number(page.body.data[1].id));
    const denied = await counsellor('GET', `/audit?unitId=${unit('SatnPaper').id}`);
    assert.equal(denied.status, 403);
  });

  await t.test('domain events land in the outbox', async () => {
    const { n } = await db('outbox_events').where('type', 'user.invited').count({ n: '*' }).first();
    assert.ok(Number(n) >= 1);
  });
});
