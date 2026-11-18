import { test } from 'node:test';
import assert from 'node:assert/strict';
import { portalCoversAny } from '../../src/modules/partners/access.js';
import { presentPartner } from '../../src/modules/partners/present.js';

// A shared partner's portal sign-in covers only the partnerships whose company invited them
// (the partner role is held at that partnership's unit, or above it).

const units = new Map(
  [
    { id: 'g', path: '/g/', type: 'group' },
    { id: 'sat', path: '/g/sat/', type: 'company' },
    { id: 'sat-adm', path: '/g/sat/sat-adm/', type: 'team' },
    { id: 'pv', path: '/g/pv/', type: 'company' },
    { id: 'pv-adm', path: '/g/pv/pv-adm/', type: 'team' },
  ].map((u) => [u.id, u]),
);
const satLink = { id: 'l1', company_id: 'sat', unit_id: 'sat-adm' };
const pvLink = { id: 'l2', company_id: 'pv', unit_id: 'pv-adm' };

test('portalCoversAny: a role at the partnership unit, or above it, covers it', () => {
  assert.equal(portalCoversAny(['sat-adm'], [satLink], units), true);
  assert.equal(portalCoversAny(['sat'], [satLink], units), true, 'company-level role covers its teams');
  assert.equal(portalCoversAny(['sat-adm'], [pvLink], units), false, 'SatnPaper’s invitation does not cover Pi Vector’s partnership');
  assert.equal(portalCoversAny(['sat-adm'], [pvLink, satLink], units), true);
  assert.equal(portalCoversAny([], [satLink], units), false);
  assert.equal(portalCoversAny(undefined, [satLink], units), false);
  assert.equal(portalCoversAny(['unknown'], [satLink], units), false);
});

test('presentPartner: hasPortalAccess needs a sign-in that covers the viewer’s partnerships', () => {
  const refs = { users: new Map(), plans: new Map() };
  const partner = { id: 'p', kind: 'organisation', name: 'Agency', user_id: 'u1', payout_hint: null };
  const show = (opts) => presentPartner(partner, { links: [], unitsById: units, refs, canViewPii: true, ...opts }).hasPortalAccess;
  assert.equal(show({ hasPortalAccess: true }), true);
  assert.equal(show({ hasPortalAccess: false }), false);
  assert.equal(show({}), false, 'defaults to not covered');
  assert.equal(presentPartner({ ...partner, user_id: null }, { links: [], unitsById: units, refs, canViewPii: true, hasPortalAccess: true }).hasPortalAccess, false);
});
