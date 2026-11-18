import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccessContext } from '../../src/core/accessContext.js';
import {
  applyListScope,
  canViewPiiAt,
  companyOf,
  decideRecordAccess,
  levelForRecord,
  narrowPaths,
  scopeFromPaths,
  scopePaths,
  unitIdsWithin,
} from '../../src/core/crm/scope.js';
import { db } from '../../src/lib/db.js';

// A small tree: Phoenix › SatnPaper › Online › SAT admissions, Phoenix › SatnPaper › Software sales,
// Phoenix › Pi Vector.
const unit = (id, type, path, root = 'g') => ({ id, type, path, root_id: root, name: id, status: 'active' });
const UNITS = new Map(
  [
    unit('g', 'group', '/g/'),
    unit('sp', 'company', '/g/sp/'),
    unit('online', 'branch', '/g/sp/online/'),
    unit('sat', 'team', '/g/sp/online/sat/'),
    unit('sw', 'team', '/g/sp/sw/'),
    unit('pv', 'company', '/g/pv/'),
  ].map((u) => [u.id, u]),
);

const kabir = new AccessContext({
  userId: 'kabir',
  assignments: [
    { unitPath: '/g/sp/online/', groupId: 'g', permissions: ['deals.view', 'deals.manage', 'contacts.view', 'contacts.view_pii'] },
    { unitPath: '/g/sp/online/sat/', groupId: 'g', permissions: ['deals.view:own', 'deals.manage:own', 'contacts.view'] },
  ],
});
const ritika = new AccessContext({
  userId: 'ritika',
  assignments: [{ unitPath: '/g/sp/online/sat/', groupId: 'g', permissions: ['deals.view:own', 'contacts.view', 'contacts.view_pii'] }],
});
const analyst = new AccessContext({
  userId: 'ana',
  assignments: [{ unitPath: '/g/', groupId: 'g', permissions: ['deals.view', 'contacts.view'] }],
});

test('companyOf finds the nearest company at or above a unit', () => {
  assert.equal(companyOf(UNITS.get('sat'), UNITS).id, 'sp');
  assert.equal(companyOf(UNITS.get('sp'), UNITS).id, 'sp');
  assert.equal(companyOf(UNITS.get('g'), UNITS), null);
  assert.equal(companyOf(null, UNITS), null);
});

test('scopePaths drops own paths already covered by an all path', () => {
  assert.deepEqual(scopePaths(kabir, 'deals.view'), { all: ['/g/sp/online/'], own: [] });
  assert.deepEqual(scopePaths(ritika, 'deals.view'), { all: [], own: ['/g/sp/online/sat/'] });
  assert.deepEqual(scopePaths(ritika, 'deals.archive'), { all: [], own: [] });
});

test('narrowPaths clips to the working unit', () => {
  assert.deepEqual(narrowPaths(['/g/'], '/g/sp/'), ['/g/sp/']);
  assert.deepEqual(narrowPaths(['/g/sp/online/'], '/g/sp/'), ['/g/sp/online/']);
  assert.deepEqual(narrowPaths(['/g/pv/'], '/g/sp/'), []);
  assert.deepEqual(narrowPaths(['/g/sp/', '/g/sp/sw/'], null), ['/g/sp/']);
});

test('unitIdsWithin lists every unit under the paths', () => {
  assert.deepEqual(unitIdsWithin(UNITS, ['/g/sp/online/']).sort(), ['online', 'sat']);
  assert.deepEqual(unitIdsWithin(UNITS, []), []);
});

test('scopeFromPaths: a group analyst working in SatnPaper sees every SatnPaper unit', () => {
  const scope = scopeFromPaths({ permission: 'deals.view', userId: 'ana', unit: UNITS.get('sp'), unitsById: UNITS, paths: scopePaths(analyst, 'deals.view') });
  assert.equal(scope.company.id, 'sp');
  assert.equal(scope.groupId, 'g');
  assert.deepEqual(scope.allUnitIds.sort(), ['online', 'sat', 'sp', 'sw']);
  assert.equal(scope.ownOnly, false);
});

test('scopeFromPaths: a counsellor gets own units only, and a group scope has no company', () => {
  const scope = scopeFromPaths({ permission: 'deals.view', userId: 'ritika', unit: UNITS.get('g'), unitsById: UNITS, paths: scopePaths(ritika, 'deals.view') });
  assert.equal(scope.company, null);
  assert.deepEqual(scope.allUnitIds, []);
  assert.deepEqual(scope.ownUnitIds, ['sat']);
  assert.equal(scope.ownOnly, true);
});

test('applyListScope builds company + unit + owner filters with bindings', () => {
  const scope = { company: { id: 'sp' }, groupId: 'g', allUnitIds: ['online'], ownUnitIds: ['sat'], userId: 'ritika' };
  const { sql, bindings } = applyListScope(db('deals'), scope).toSQL();
  assert.match(sql, /"company_id" = \?/);
  assert.match(sql, /"unit_id" in \(\?\)/);
  assert.match(sql, /"owner_user_id" = \?/);
  assert.deepEqual(bindings, ['sp', 'online', 'sat', 'ritika']);

  const empty = applyListScope(db('deals'), { company: null, groupId: 'g', allUnitIds: [], ownUnitIds: [], userId: 'x' }).toSQL();
  assert.match(empty.sql, /"group_id" = \?/);
  assert.match(empty.sql, /false/);

  const tasks = applyListScope(db('tasks'), { ...scope, allUnitIds: [] }, { ownerColumns: ['assignee_user_id', 'created_by'] }).toSQL();
  assert.match(tasks.sql, /"assignee_user_id" = \? or "created_by" = \?/);
});

test('levelForRecord respects own scope', () => {
  const mine = { unit_id: 'sat', owner_user_id: 'ritika' };
  const theirs = { unit_id: 'sat', owner_user_id: 'kabir' };
  assert.equal(levelForRecord(ritika, UNITS, 'deals.view', mine, { userId: 'ritika' }), 'own');
  assert.equal(levelForRecord(ritika, UNITS, 'deals.view', theirs, { userId: 'ritika' }), null);
  assert.equal(levelForRecord(kabir, UNITS, 'deals.view', theirs, { userId: 'kabir' }), 'all');
  assert.equal(levelForRecord(kabir, UNITS, 'deals.view', { unit_id: 'pv', owner_user_id: 'kabir' }, { userId: 'kabir' }), null);
  assert.equal(levelForRecord(kabir, UNITS, 'deals.view', { unit_id: 'unknown' }, { userId: 'kabir' }), null);
});

test('decideRecordAccess: contacts are visible through a company link or a visible deal', () => {
  const links = [{ unit_id: 'sat', company_id: 'sp', owner_user_id: null }];
  const forRitika = decideRecordAccess({ access: ritika, unitsById: UNITS, userId: 'ritika', links });
  assert.equal(forRitika.canView, true);
  assert.equal(forRitika.canViewPii, true);
  assert.equal(forRitika.canManage, false);
  assert.deepEqual(forRitika.companyIds, ['sp']);

  const forAnalyst = decideRecordAccess({ access: analyst, unitsById: UNITS, userId: 'ana', links });
  assert.equal(forAnalyst.canView, true);
  assert.equal(forAnalyst.canViewPii, false, 'analysts see personal details masked');

  const pivectorOnly = decideRecordAccess({ access: kabir, unitsById: UNITS, userId: 'kabir', links: [{ unit_id: 'pv', company_id: 'pv' }] });
  assert.equal(pivectorOnly.canView, false, 'a person known only to Pi Vector is hidden from SatnPaper staff');

  const throughDeal = decideRecordAccess({
    access: ritika,
    unitsById: UNITS,
    userId: 'ritika',
    links: [],
    deals: [{ id: 'd1', unit_id: 'sat', company_id: 'sp', owner_user_id: 'ritika' }],
  });
  assert.equal(throughDeal.canView, true);
  assert.deepEqual(throughDeal.visibleDealIds, ['d1']);
});

test('decideRecordAccess: merge needs the permission at every company that knows the person', () => {
  const admin = new AccessContext({ userId: 'a', assignments: [{ unitPath: '/g/sp/', groupId: 'g', permissions: ['contacts.*'] }] });
  const links = [
    { unit_id: 'sat', company_id: 'sp' },
    { unit_id: 'pv', company_id: 'pv' },
  ];
  assert.equal(decideRecordAccess({ access: admin, unitsById: UNITS, userId: 'a', links }).canMerge, false);
  assert.equal(decideRecordAccess({ access: admin, unitsById: UNITS, userId: 'a', links: links.slice(0, 1) }).canMerge, true);
});

test('canViewPiiAt checks any of the units', () => {
  assert.equal(canViewPiiAt(ritika, UNITS, ['pv', 'sat']), true);
  assert.equal(canViewPiiAt(analyst, UNITS, ['sat']), false);
  assert.equal(canViewPiiAt(ritika, UNITS, ['missing']), false);
});

test.after(() => db.destroy());
