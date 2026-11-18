import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  childPath,
  commonAncestorId,
  depthOfPath,
  idsFromPath,
  isAllowedParent,
  isWithin,
  outermostPaths,
  rebasePath,
} from '../src/core/orgTree.js';
import { unitTypes } from '../src/modules/org/unitTypes.js';

test('paths are built from ancestor ids', () => {
  const group = childPath(null, 'g');
  const company = childPath(group, 'c');
  const team = childPath(company, 't');
  assert.equal(group, '/g/');
  assert.equal(team, '/g/c/t/');
  assert.deepEqual(idsFromPath(team), ['g', 'c', 't']);
  assert.equal(depthOfPath(team), 2);
  assert.ok(isWithin(team, company));
  assert.ok(!isWithin(company, team));
  assert.ok(!isWithin('/g/cc/', '/g/c/'), 'prefixes end at a slash, so siblings never match');
});

test('moving a subtree rewrites the path prefix', () => {
  assert.equal(rebasePath('/g/a/b/t/', '/g/a/b/', '/g/c/b/'), '/g/c/b/t/');
  assert.throws(() => rebasePath('/g/x/', '/g/a/', '/g/c/'));
});

test('outermostPaths drops nested paths', () => {
  assert.deepEqual(outermostPaths(['/g/a/b/', '/g/a/', '/g/c/', '/g/a/']), ['/g/a/', '/g/c/']);
});

test('commonAncestorId finds the narrowest unit covering every path', () => {
  assert.equal(commonAncestorId(['/g/c/b/t1/', '/g/c/b/t2/']), 'b');
  assert.equal(commonAncestorId(['/g/c/b/t1/', '/g/c/x/']), 'c');
  assert.equal(commonAncestorId(['/g/c/', '/g/c/b/']), 'c');
  assert.equal(commonAncestorId(['/g/c/b/']), 'b');
  assert.equal(commonAncestorId(['/g1/c/', '/g2/c/']), null, 'different groups share nothing');
  assert.equal(commonAncestorId([]), null);
});

test('the unit type registry controls which levels can nest', () => {
  const types = new Map(unitTypes.map((t) => [t.key, t]));
  assert.ok(isAllowedParent(types, 'group', null));
  assert.ok(isAllowedParent(types, 'company', 'group'));
  assert.ok(isAllowedParent(types, 'region', 'region'));
  assert.ok(isAllowedParent(types, 'branch', 'region'));
  assert.ok(isAllowedParent(types, 'team', 'team'));
  assert.ok(!isAllowedParent(types, 'company', 'company'));
  assert.ok(!isAllowedParent(types, 'branch', 'team'));
  assert.ok(!isAllowedParent(types, 'company', null));
  assert.ok(!isAllowedParent(types, 'unknown', 'group'));
});

test('company profiles validate Indian tax ids and contact details', () => {
  const company = unitTypes.find((t) => t.key === 'company');
  assert.ok(company.profile.safeParse({ gstin: '27ABCDE1234F1Z5', pan: 'ABCDE1234F', businessLines: ['b2c', 'b2b'] }).success);
  assert.ok(!company.profile.safeParse({ gstin: '27ABCDE1234F1Z' }).success);
  assert.ok(!company.profile.safeParse({ address: { pincode: '012345' } }).success);
  assert.ok(!company.profile.safeParse({ unexpected: true }).success, 'unknown fields are rejected');
});
