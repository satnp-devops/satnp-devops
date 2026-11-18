import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry, isKnownPermission, permissionCatalog } from '../src/core/registry.js';
import { SYSTEM_ROLES, systemRolePermissions } from '../src/core/systemRoles.js';
import { modules } from '../src/modules/index.js';

test('the installed modules build a consistent registry', () => {
  const registry = createRegistry(modules);
  assert.ok(registry.permissions.has('org.manage'));
  assert.ok(registry.unitTypes.has('company'));
  assert.ok(registry.settings.has('security.requireMfa'));
  assert.deepEqual(systemRolePermissions(registry, 'group_owner'), ['*']);
  assert.ok(systemRolePermissions(registry, 'company_admin').includes('users.manage'));
  for (const role of SYSTEM_ROLES) {
    for (const permission of systemRolePermissions(registry, role.key)) assert.ok(isKnownPermission(registry, permission));
  }
  assert.ok(permissionCatalog(registry).some((group) => group.module === 'users'));
});

test('a new module extends permissions, roles, settings, levels and events without core changes', () => {
  const calls = [];
  const leads = {
    name: 'leads',
    permissions: [{ key: 'leads.view', label: 'See leads', supportsOwn: true }],
    roleGrants: { counsellor: ['leads.view:own'] },
    settings: [{ key: 'leads.slaMinutes', default: 15, levels: ['company'] }],
    unitTypes: [{ key: 'zone', label: 'Zone', parents: ['company'], fields: [] }],
    eventHandlers: { 'lead.created': async (event) => calls.push(event.type) },
  };
  const registry = createRegistry([...modules, leads]);
  assert.ok(isKnownPermission(registry, 'leads.view:own'));
  assert.ok(isKnownPermission(registry, 'leads.*'));
  assert.ok(!isKnownPermission(registry, 'org.view:own'), 'own scope only where the module allows it');
  assert.ok(systemRolePermissions(registry, 'counsellor').includes('leads.view:own'));
  assert.ok(registry.settings.has('leads.slaMinutes'));
  assert.ok(registry.unitTypes.has('zone'));
  assert.equal(registry.eventHandlers.get('lead.created').length, 1);
});

test('conflicting modules are rejected at startup', () => {
  const twin = { name: 'twin', permissions: [{ key: 'org.view', label: 'again' }] };
  assert.throws(() => createRegistry([...modules, twin]), /Duplicate permission/);
  const badGrant = { name: 'bad', roleGrants: { counsellor: ['nothing.here'] } };
  assert.throws(() => createRegistry([...modules, badGrant]), /unknown permission/);
});
