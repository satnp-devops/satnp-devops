import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coversPermission, permissionLevel } from '../src/core/permissions.js';
import { AccessContext } from '../src/core/accessContext.js';

test('permissionLevel understands exact, wildcard and own-scoped grants', () => {
  assert.equal(permissionLevel(['users.view'], 'users.view'), 'all');
  assert.equal(permissionLevel(['users.*'], 'users.manage'), 'all');
  assert.equal(permissionLevel(['*'], 'anything.at_all'), 'all');
  assert.equal(permissionLevel(['leads.view:own'], 'leads.view'), 'own');
  assert.equal(permissionLevel(['leads.*:own'], 'leads.edit'), 'own');
  assert.equal(permissionLevel(['leads.view:own', 'leads.view'], 'leads.view'), 'all');
  assert.equal(permissionLevel(['users.view'], 'users.manage'), null);
  assert.equal(permissionLevel(['user.view'], 'users.view'), null);
});

test('coversPermission blocks privilege escalation', () => {
  assert.ok(coversPermission(['*'], 'roles.manage'));
  assert.ok(coversPermission(['users.*'], 'users.manage'));
  assert.ok(coversPermission(['leads.view'], 'leads.view:own'));
  assert.ok(!coversPermission(['leads.view:own'], 'leads.view'));
  assert.ok(!coversPermission(['users.view', 'users.manage'], 'users.*'));
  assert.ok(!coversPermission(['users.*'], '*'));
});

// group → company A (→ branch → team) and company B
const GROUP = '/g/';
const COMPANY_A = '/g/a/';
const BRANCH = '/g/a/b/';
const TEAM = '/g/a/b/t/';
const COMPANY_B = '/g/c/';

const access = new AccessContext({
  userId: 'u1',
  assignments: [
    { unitPath: COMPANY_A, groupId: 'g', permissions: ['org.view', 'users.view', 'users.manage'] },
    { unitPath: TEAM, groupId: 'g', permissions: ['leads.view:own'] },
  ],
});

test('a role at a unit applies to every unit below it, and not to siblings or parents', () => {
  assert.ok(access.can('users.manage', COMPANY_A));
  assert.ok(access.can('users.manage', BRANCH));
  assert.ok(access.can('users.manage', TEAM));
  assert.ok(!access.can('users.manage', COMPANY_B));
  assert.ok(!access.can('users.manage', GROUP));
  assert.equal(access.level('leads.view', TEAM), 'own');
  assert.equal(access.level('leads.view', BRANCH), null);
});

test('ancestors are visible for context, unrelated units are not', () => {
  assert.ok(access.canSee(GROUP));
  assert.ok(access.canSee(TEAM));
  assert.ok(!access.canSee(COMPANY_B));
});

test('canGrant only allows handing out permissions the user holds there', () => {
  assert.ok(access.canGrant(['users.view'], BRANCH));
  assert.ok(!access.canGrant(['roles.manage'], BRANCH));
  assert.ok(!access.canGrant(['users.view'], COMPANY_B));
});

test('rootsFor returns the outermost units for list filters', () => {
  const multi = new AccessContext({
    userId: 'u2',
    assignments: [
      { unitPath: COMPANY_A, permissions: ['users.view'] },
      { unitPath: BRANCH, permissions: ['users.view'] },
      { unitPath: COMPANY_B, permissions: ['org.view'] },
    ],
  });
  assert.deepEqual(multi.rootsFor('users.view'), [COMPANY_A]);
  assert.ok(multi.canAnywhereWithin('users.view', GROUP));
  assert.ok(!multi.canAnywhereWithin('users.view', COMPANY_B));
});

test('access context survives a JSON round trip (it is cached in Redis)', () => {
  const restored = new AccessContext(JSON.parse(JSON.stringify(access)));
  assert.ok(restored.can('users.manage', TEAM));
  assert.equal(restored.userId, 'u1');
});
