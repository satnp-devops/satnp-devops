import { db } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { permissionLevel } from '../../core/permissions.js';
import { applyListScope, canViewPiiAt, levelForRecord, unitsIndex } from '../../core/crm/scope.js';
import { isWithin } from '../../core/orgTree.js';
import { PARTNER_ROLE_KEY, PERMISSIONS } from './constants.js';

// Scoping for partner records, built on the CRM scope helpers (docs/crm/PHASE2_CONTRACT.md §4).
//
// A partner is stored once per group, like a contact. A company works with them through a link
// (partner_companies) that carries the owning unit and the counsellor who owns their leads. A
// user sees a partner when they hold partners.view at one of its links' units (":own": links they
// own). Everything a company keeps about a partner (referral links, attributions, commissions)
// carries the company and is visible through the partner's link with that company. Payout batches
// belong to the company itself. Anything outside the user's scope is 404.

/** Options for applyListScope/levelForRecord on partner_companies rows. */
export const LINK_SCOPE = { unitColumn: 'unit_id', ownerColumns: ['owner_user_id'] };

/**
 * Keep company-owned partner rows (alias.partner_id, alias.company_id) whose partner link is in scope.
 * Joins partner_companies as `pc`.
 */
export function scopeThroughLink(query, scope, alias) {
  query.join('partner_companies as pc', function joinLink() {
    this.on('pc.partner_id', '=', `${alias}.partner_id`).andOn('pc.company_id', '=', `${alias}.company_id`);
  });
  return applyListScope(query, scope, {
    unitColumn: 'pc.unit_id',
    ownerColumns: ['pc.owner_user_id'],
    companyColumn: `${alias}.company_id`,
    groupColumn: `${alias}.group_id`,
  });
}

/** 'all' | 'own' | null for a permission on one partner link. */
export async function linkLevel(req, permission, link, trx = db) {
  const index = await unitsIndex(req, trx);
  return levelForRecord(req.access, index, permission, link, { userId: req.auth.user.id, ...LINK_SCOPE });
}

/**
 * Load a partner the user can see, with every company link and the ones they can see.
 *   404 when no link is visible.
 * @returns {Promise<{ partner: object, links: object[], visibleLinks: object[], canViewPii: boolean }>}
 */
export async function loadVisiblePartner(req, partnerId, { trx = db, forUpdate = false } = {}) {
  const index = await unitsIndex(req, trx);
  const query = trx('partners').where({ id: partnerId }).first();
  if (forUpdate) query.forUpdate();
  const partner = await query;
  if (!partner || !req.access.groupIds().includes(partner.group_id)) throw errors.notFound('Partner');
  const links = await trx('partner_companies').where({ partner_id: partnerId }).orderBy('created_at');
  const userId = req.auth.user.id;
  const visibleLinks = links.filter((link) => levelForRecord(req.access, index, PERMISSIONS.view, link, { userId, ...LINK_SCOPE }));
  if (visibleLinks.length === 0) throw errors.notFound('Partner');
  const canViewPii = canViewPiiAt(req.access, index, visibleLinks.map((link) => link.unit_id));
  return { partner, links, visibleLinks, canViewPii, unitsById: index };
}

/** Links of a visible partner where the user holds a permission (at the link's unit, own respected). */
export function linksWith(req, unitsById, permission, links) {
  const userId = req.auth.user.id;
  return links.filter((link) => levelForRecord(req.access, unitsById, permission, link, { userId, ...LINK_SCOPE }));
}

/**
 * The partner's link with one company, visible to the user, or 404.
 * @returns {Promise<object>} the partner_companies row
 */
export async function loadVisibleLink(req, { partnerId, companyId, permission = PERMISSIONS.view, trx = db, notFound = 'Partner', forUpdate = false }) {
  const query = trx('partner_companies').where({ partner_id: partnerId, company_id: companyId }).first();
  if (forUpdate) query.forUpdate();
  const link = await query;
  if (!link) throw errors.notFound(notFound);
  const level = await linkLevel(req, permission, link, trx);
  if (!level) throw errors.notFound(notFound);
  return link;
}

/** 403 unless the user holds `permission` on a partner link they can already see. */
export async function requireOnLink(req, permission, link, trx = db, message) {
  const level = await linkLevel(req, permission, link, trx);
  if (!level) throw errors.forbidden(message);
  return level;
}

/** Does the user hold a permission in any role, anywhere? (The partner portal is not tied to a unit.) */
export function holdsAnywhere(access, permission) {
  return access.assignments.some((assignment) => permissionLevel(assignment.permissions, permission) !== null);
}

/**
 * The partner record the signed-in person is, for the portal, with the partnerships the portal
 * covers. 403 without the portal permission, 404 when no partner profile is attached to their account.
 *
 * A partner shared by several companies is invited by each company separately: the partner role is
 * held at that company's partnership unit. The portal shows a company's side (links, leads,
 * commissions, payouts) only where the person holds partners.portal at that partnership's unit, so
 * one company can never open another company's data to a sign-in of its choosing.
 * @returns {Promise<{ partner: object, links: object[], companyIds: string[] }>}
 */
export async function loadPortalPartner(req, trx = db) {
  if (!holdsAnywhere(req.access, PERMISSIONS.portal)) throw errors.forbidden('This page is for partners');
  const partner = await trx('partners').where({ user_id: req.auth.user.id }).first();
  if (!partner) throw errors.notFound('Partner profile');
  const index = await unitsIndex(req, trx);
  const links = (await trx('partner_companies').where({ partner_id: partner.id }).orderBy('created_at')).filter((link) => {
    const unit = index.get(link.unit_id);
    return unit ? req.access.can(PERMISSIONS.portal, unit.path) : false;
  });
  return { partner, links, companyIds: links.map((link) => link.company_id) };
}

/**
 * Units (ids) where a portal user holds the partner role, for each user id. One query.
 * @returns {Promise<Map<string, string[]>>}
 */
export async function portalRoleUnits(userIds, trx = db) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return new Map();
  const rows = await trx('role_assignments as ra')
    .join('roles as r', 'r.id', 'ra.role_id')
    .whereNull('r.group_id')
    .where('r.key', PARTNER_ROLE_KEY)
    .whereIn('ra.user_id', ids)
    .select('ra.user_id', 'ra.org_unit_id');
  const byUser = new Map();
  for (const row of rows) (byUser.get(row.user_id) ?? byUser.set(row.user_id, []).get(row.user_id)).push(row.org_unit_id);
  return byUser;
}

/**
 * Does the partner's portal sign-in cover any of these partnership links? (The role is held at a
 * unit at or above the link's unit.) Pure.
 */
export function portalCoversAny(roleUnitIds, links, unitsById) {
  if (!roleUnitIds?.length) return false;
  const paths = roleUnitIds.map((id) => unitsById.get(id)?.path).filter(Boolean);
  return links.some((link) => {
    const unit = unitsById.get(link.unit_id);
    return unit ? paths.some((path) => isWithin(unit.path, path)) : false;
  });
}

/**
 * Which of these deals the viewer can see (deals.view, own respected), and at which deal units they
 * may see personal data. Used to decide what a partner record shows about a referred lead. Pure
 * over rows loaded by the caller.
 * @param {object[]} deals rows with id, unit_id, owner_user_id
 * @returns {Promise<{ visibleDealIds: Set<string>, piiUnitIds: Set<string> }>}
 */
export async function dealVisibility(req, deals, trx = db) {
  const index = await unitsIndex(req, trx);
  const userId = req.auth.user.id;
  const visibleDealIds = new Set();
  const piiUnitIds = new Set();
  for (const deal of deals) {
    if (levelForRecord(req.access, index, 'deals.view', deal, { userId })) visibleDealIds.add(deal.id);
    const unit = index.get(deal.unit_id);
    if (unit && req.access.can('contacts.view_pii', unit.path)) piiUnitIds.add(deal.unit_id);
  }
  return { visibleDealIds, piiUnitIds };
}
