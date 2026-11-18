import { env } from '../../config/env.js';
import { db, json } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { randomToken, sha256 } from '../../lib/crypto.js';
import { decodeCursor, encodeCursor } from '../../lib/pagination.js';
import { bumpAccessVersion } from '../../core/access.js';
import { writeAudit } from '../../core/audit.js';
import { emitEvent } from '../../core/events.js';
import { enqueueMail } from '../../core/queue.js';
import { systemRolePermissions } from '../../core/systemRoles.js';
import { normalizeName } from '../../core/crm/normalize.js';
import { applyUnitFilter, companyOf, listScope, requireCreateUnit, unitsIndex, userLevelAt, usersWithPermissionAt } from '../../core/crm/scope.js';
import { minorFromDb } from '../../core/crm/money.js';
import { revokeUserSessions } from '../auth/sessions.js';
import { linksWith, loadVisibleLink, loadVisiblePartner, portalCoversAny, portalRoleUnits, requireOnLink } from './access.js';
import { PARTNER_ROLE, PARTNER_ROLE_KEY, PERMISSIONS } from './constants.js';
import { openPayoutDetails, payoutHint, sealPayoutDetails } from './payoutDetails.js';
import { loadRefs, presentPartner } from './present.js';
import { lockKey, normalizeContactPoints } from './util.js';

// Partners and their relationship with each company, payout details and portal access.

const INVITE_TTL_MS = 7 * 86_400_000;
const linkUnit = (link) => ({ id: link.unit_id, root_id: link.group_id });

// ---------- Reading ----------

/** GET /partners: partners with a company link in the working scope, by name. */
export async function listPartners(req, { unitId, q, status, ownerUserId, cursor, limit }) {
  const scope = await listScope(req, PERMISSIONS.view, { unitId });
  const after = decodeCursor(cursor);
  const query = db('partners as p')
    .where('p.group_id', scope.groupId)
    .whereExists(function linked() {
      this.select(db.raw('1')).from('partner_companies as l').whereRaw('l.partner_id = p.id');
      if (scope.company) this.where('l.company_id', scope.company.id);
      if (status) this.where('l.status', status);
      if (ownerUserId) this.where('l.owner_user_id', ownerUserId);
      applyUnitFilter(this, scope, { unitColumn: 'l.unit_id', ownerColumns: ['l.owner_user_id'] });
    })
    .select('p.*')
    .orderBy([
      { column: 'p.name_normalized', order: 'asc' },
      { column: 'p.id', order: 'asc' },
    ])
    .limit(limit + 1);
  if (q) {
    const term = normalizeName(q);
    const lower = q.trim().toLowerCase();
    query.where((w) => {
      if (term) w.orWhere('p.name_normalized', 'like', `%${term.replace(/[%_\\]/g, '\\$&')}%`);
      w.orWhere('p.email', lower);
      const digits = q.replace(/\D/g, '');
      if (digits.length >= 6) w.orWhere('p.phone', 'like', `%${digits}`);
    });
  }
  if (after) {
    if (typeof after.n !== 'string' || typeof after.id !== 'string') throw errors.badRequest('Invalid cursor');
    query.whereRaw('(p.name_normalized, p.id) > (?, ?::uuid)', [after.n, after.id]);
  }
  const rows = await query;
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const data = await presentPartners(req, page);
  const last = page.at(-1);
  return { data, nextCursor: hasMore && last ? encodeCursor({ n: last.name_normalized, id: last.id }) : null };
}

/** Present partner rows with the links the viewer can see (one query for links, one per ref kind). */
async function presentPartners(req, partners, trx = db) {
  if (partners.length === 0) return [];
  const index = await unitsIndex(req, trx);
  const links = await trx('partner_companies').whereIn('partner_id', partners.map((p) => p.id)).orderBy('created_at');
  const visible = linksWith(req, index, PERMISSIONS.view, links);
  const [refs, roleUnits] = await Promise.all([
    loadRefs({ userIds: visible.map((l) => l.owner_user_id), planIds: visible.map((l) => l.commission_plan_id) }, trx),
    portalRoleUnits(partners.map((p) => p.user_id), trx),
  ]);
  return partners.map((partner) => {
    const mine = visible.filter((link) => link.partner_id === partner.id);
    const canViewPii = mine.some((link) => {
      const unit = index.get(link.unit_id);
      return unit ? req.access.can('contacts.view_pii', unit.path) : false;
    });
    const hasPortalAccess = portalCoversAny(roleUnits.get(partner.user_id), mine, index);
    return presentPartner(partner, { links: mine, unitsById: index, refs, canViewPii, hasPortalAccess });
  });
}

/**
 * Bank details are one record per partner, shared by every company that pays them: changing them
 * needs partners.payout_details at every one of the partner's companies (in practice group finance
 * once a partner is shared), so one company can't redirect what another company pays. Reading
 * needs the permission at any visible partnership, and is audited.
 */
const canChangePayoutDetails = (req, unitsById, links) =>
  links.length > 0 && linksWith(req, unitsById, PERMISSIONS.payoutDetails, links).length === links.length;

/** GET /partners/:id: the partner, their visible company links, portal access and totals. */
export async function getPartner(req, partnerId, trx = db) {
  const { partner, links, visibleLinks, canViewPii, unitsById } = await loadVisiblePartner(req, partnerId, { trx });
  const companyIds = visibleLinks.map((link) => link.company_id);
  const [refs, portalUser, roleUnits, linkCount, attributionCount, totals] = await Promise.all([
    loadRefs({ userIds: visibleLinks.map((l) => l.owner_user_id), planIds: visibleLinks.map((l) => l.commission_plan_id) }, trx),
    partner.user_id ? trx('users').where({ id: partner.user_id }).first('id', 'email', 'status') : null,
    portalRoleUnits([partner.user_id], trx),
    trx('partner_referral_links').where({ partner_id: partnerId, active: true }).whereIn('company_id', companyIds).count({ n: '*' }).first(),
    trx('partner_attributions').where({ partner_id: partnerId }).whereIn('company_id', companyIds).countDistinct({ n: 'deal_id' }).first(),
    trx('partner_commissions')
      .where({ partner_id: partnerId })
      .whereIn('company_id', companyIds)
      .groupBy('status', 'currency')
      .select('status', 'currency', trx.raw('sum(amount_minor - clawed_back_minor) as total')),
  ]);
  const totalsByStatus = {};
  for (const row of totals) (totalsByStatus[row.status] ??= []).push({ valueMinor: minorFromDb(row.total), currency: row.currency });
  const manageLinks = linksWith(req, unitsById, PERMISSIONS.manage, visibleLinks);
  const hasPortalAccess = portalCoversAny(roleUnits.get(partner.user_id), visibleLinks, unitsById);
  return {
    ...presentPartner(partner, { links: visibleLinks, unitsById, refs, canViewPii, hasPortalAccess }),
    notes: partner.notes ?? null,
    contactId: partner.contact_id ?? null,
    accountId: partner.account_id ?? null,
    portalUser: portalUser ? { id: portalUser.id, email: canViewPii ? portalUser.email : null, status: portalUser.status } : null,
    stats: {
      activeLinks: Number(linkCount?.n ?? 0),
      referredLeads: Number(attributionCount?.n ?? 0),
      commissions: totalsByStatus,
    },
    can: {
      manage: manageLinks.length > 0,
      payoutDetails: linksWith(req, unitsById, PERMISSIONS.payoutDetails, visibleLinks).length > 0,
      changePayoutDetails: canChangePayoutDetails(req, unitsById, links),
      approveCommissions: linksWith(req, unitsById, PERMISSIONS.approveCommissions, visibleLinks).length > 0,
    },
  };
}

// ---------- Creating and changing ----------

async function checkOwner(trx, unit, ownerUserId, path) {
  if (!ownerUserId) return null;
  const level = await userLevelAt(ownerUserId, unit, 'deals.manage', { trx });
  if (!level) throw errors.validation([{ path, message: "This person can't own leads here" }]);
  return ownerUserId;
}

async function checkPlan(trx, companyId, planId, path) {
  if (!planId) return null;
  const plan = await trx('commission_plans').where({ id: planId, company_id: companyId }).first('id');
  if (!plan) throw errors.validation([{ path, message: 'Pick a commission plan of this company' }]);
  return plan.id;
}

async function checkPartnerCode(trx, groupId, code, exceptId = null) {
  if (!code) return;
  const query = trx('partners').where({ group_id: groupId, code }).first('id');
  if (exceptId) query.whereNot('id', exceptId);
  if (await query) throw errors.validation([{ path: 'body.code', message: 'Another partner already uses this code' }]);
}

/** POST /partners: add a partner at a unit, or link the existing partner with the same email or phone. */
export async function createPartner(req, body) {
  const { unit, company } = await requireCreateUnit(req, body.unitId, PERMISSIONS.manage);
  const contact = await normalizeContactPoints(company, { email: body.email ?? null, phone: body.phone ?? null });
  const actorId = req.auth.user.id;

  const partnerId = await db.transaction(async (trx) => {
    const ownerUserId = await checkOwner(trx, unit, body.ownerUserId, 'body.ownerUserId');
    const planId = await checkPlan(trx, company.id, body.commissionPlanId, 'body.commissionPlanId');
    for (const value of [contact.email, contact.phone].filter(Boolean)) await lockKey(trx, `partners:${unit.root_id}:${value}`);

    let partner = null;
    if (contact.email || contact.phone) {
      partner = await trx('partners')
        .where('group_id', unit.root_id)
        .where((w) => {
          if (contact.email) w.orWhere('email', contact.email);
          if (contact.phone) w.orWhere('phone', contact.phone);
        })
        .orderBy('created_at')
        .forUpdate()
        .first();
    }
    let created = false;
    if (partner) {
      const existingLink = await trx('partner_companies').where({ partner_id: partner.id, company_id: company.id }).first('id');
      if (existingLink) throw errors.conflict(`${partner.name} is already a partner of ${company.name}`, { partnerId: partner.id });
      const blanks = {};
      if (!partner.legal_name && body.legalName) blanks.legal_name = body.legalName;
      if (!partner.city && body.city) blanks.city = body.city;
      if (!partner.code && body.code && !(await trx('partners').where({ group_id: unit.root_id, code: body.code }).first('id'))) blanks.code = body.code;
      if (!partner.email && contact.email) blanks.email = contact.email;
      if (!partner.phone && contact.phone) blanks.phone = contact.phone;
      if (Object.keys(blanks).length) await trx('partners').where({ id: partner.id }).update({ ...blanks, updated_at: trx.fn.now() });
    } else {
      await checkPartnerCode(trx, unit.root_id, body.code);
      [partner] = await trx('partners')
        .insert({
          group_id: unit.root_id,
          kind: body.kind,
          name: body.name,
          name_normalized: normalizeName(body.name),
          code: body.code ?? null,
          legal_name: body.legalName ?? null,
          email: contact.email,
          phone: contact.phone,
          city: body.city ?? null,
          notes: body.notes ?? null,
          created_by: actorId,
        })
        .returning('*');
      created = true;
    }
    const [link] = await trx('partner_companies')
      .insert({
        partner_id: partner.id,
        group_id: unit.root_id,
        company_id: company.id,
        unit_id: unit.id,
        owner_user_id: ownerUserId,
        status: body.status,
        commission_plan_id: planId,
        created_by: actorId,
      })
      .returning('*');

    if (created) {
      await writeAudit(trx, req, {
        action: 'partner.created',
        entityType: 'partner',
        entityId: partner.id,
        unit,
        after: { name: partner.name, kind: partner.kind, changed: ['email', 'phone'].filter((k) => contact[k]) },
      });
    }
    await writeAudit(trx, req, {
      action: 'partner.company_linked',
      entityType: 'partner',
      entityId: partner.id,
      unit,
      after: { companyId: company.id, unitId: unit.id, ownerUserId, status: link.status, commissionPlanId: planId },
    });
    await emitEvent(trx, {
      type: created ? 'partner.created' : 'partner.company_linked',
      groupId: unit.root_id,
      unitId: unit.id,
      aggregateType: 'partner',
      aggregateId: partner.id,
      actorUserId: actorId,
      payload: { partnerId: partner.id, companyId: company.id, unitId: unit.id, kind: partner.kind, ownerUserId, status: link.status },
    });
    return partner.id;
  });
  return getPartner(req, partnerId);
}

/** PATCH /partners/:id: basic details (shared by every company that works with the partner). */
export async function updatePartner(req, partnerId, body) {
  await db.transaction(async (trx) => {
    const { partner, visibleLinks, unitsById } = await loadVisiblePartner(req, partnerId, { trx, forUpdate: true });
    const manageable = linksWith(req, unitsById, PERMISSIONS.manage, visibleLinks);
    if (manageable.length === 0) throw errors.forbidden();
    const company = unitsById.get(manageable[0].company_id);
    const contact = await normalizeContactPoints(company, { email: body.email, phone: body.phone }, trx);
    const patch = {};
    if (body.kind !== undefined) patch.kind = body.kind;
    if (body.name !== undefined) {
      patch.name = body.name;
      patch.name_normalized = normalizeName(body.name);
    }
    if (body.legalName !== undefined) patch.legal_name = body.legalName;
    if (body.code !== undefined) {
      await checkPartnerCode(trx, partner.group_id, body.code, partnerId);
      patch.code = body.code;
    }
    if (body.city !== undefined) patch.city = body.city;
    if (body.notes !== undefined) patch.notes = body.notes;
    if (contact.email !== undefined) patch.email = contact.email;
    if (contact.phone !== undefined) patch.phone = contact.phone;
    const changed = Object.keys(patch).filter((key) => key !== 'name_normalized' && String(partner[key] ?? '') !== String(patch[key] ?? ''));
    if (changed.length === 0) return;
    await trx('partners').where({ id: partnerId }).update({ ...patch, updated_at: trx.fn.now() });
    const safe = (row) => ({ name: row.name, kind: row.kind, legalName: row.legal_name ?? null, city: row.city ?? null });
    await writeAudit(trx, req, {
      action: 'partner.updated',
      entityType: 'partner',
      entityId: partnerId,
      unit: linkUnit(manageable[0]),
      before: safe(partner),
      after: { ...safe({ ...partner, ...patch }), changed },
    });
    await emitEvent(trx, {
      type: 'partner.updated',
      groupId: partner.group_id,
      unitId: manageable[0].unit_id,
      aggregateType: 'partner',
      aggregateId: partnerId,
      actorUserId: req.auth.user.id,
      payload: { partnerId, changes: changed.map((key) => (key === 'legal_name' ? 'legalName' : key)) },
    });
  });
  return getPartner(req, partnerId);
}

/** POST /partners/:id/companies: start working with a partner another company already knows. */
export async function linkCompany(req, partnerId, body) {
  await loadVisiblePartner(req, partnerId);
  const { unit, company } = await requireCreateUnit(req, body.unitId, PERMISSIONS.manage);
  await db.transaction(async (trx) => {
    const partner = await trx('partners').where({ id: partnerId }).forUpdate().first();
    if (partner.group_id !== unit.root_id) throw errors.validation([{ path: 'body.unitId', message: 'Pick a unit of the partner’s group' }]);
    const exists = await trx('partner_companies').where({ partner_id: partnerId, company_id: company.id }).first('id');
    if (exists) throw errors.conflict(`${partner.name} is already a partner of ${company.name}`);
    const ownerUserId = await checkOwner(trx, unit, body.ownerUserId, 'body.ownerUserId');
    const planId = await checkPlan(trx, company.id, body.commissionPlanId, 'body.commissionPlanId');
    await trx('partner_companies').insert({
      partner_id: partnerId,
      group_id: unit.root_id,
      company_id: company.id,
      unit_id: unit.id,
      owner_user_id: ownerUserId,
      status: body.status,
      commission_plan_id: planId,
      created_by: req.auth.user.id,
    });
    await writeAudit(trx, req, {
      action: 'partner.company_linked',
      entityType: 'partner',
      entityId: partnerId,
      unit,
      after: { companyId: company.id, unitId: unit.id, ownerUserId, status: body.status, commissionPlanId: planId },
    });
    await emitEvent(trx, {
      type: 'partner.company_linked',
      groupId: unit.root_id,
      unitId: unit.id,
      aggregateType: 'partner',
      aggregateId: partnerId,
      actorUserId: req.auth.user.id,
      payload: { partnerId, companyId: company.id, unitId: unit.id, ownerUserId, status: body.status },
    });
  });
  return getPartner(req, partnerId);
}

/** PATCH /partners/:id/companies/:companyId: status, owning unit, the counsellor who owns their leads, plan. */
export async function updateCompanyLink(req, partnerId, companyId, body) {
  let portalMoved = false;
  await db.transaction(async (trx) => {
    const link = await loadVisibleLink(req, { partnerId, companyId, trx, forUpdate: true });
    await requireOnLink(req, PERMISSIONS.manage, link, trx);
    const index = await unitsIndex(req, trx);
    const patch = {};
    let unit = index.get(link.unit_id);
    if (body.unitId !== undefined && body.unitId !== link.unit_id) {
      const target = await requireCreateUnit(req, body.unitId, PERMISSIONS.manage, { trx });
      if (target.company.id !== link.company_id) {
        throw errors.validation([{ path: 'body.unitId', message: 'Pick a unit inside the same company' }]);
      }
      unit = target.unit;
      patch.unit_id = unit.id;
    }
    if (body.ownerUserId !== undefined) patch.owner_user_id = await checkOwner(trx, unit, body.ownerUserId, 'body.ownerUserId');
    else if (patch.unit_id && link.owner_user_id && !(await userLevelAt(link.owner_user_id, unit, 'deals.manage', { trx }))) {
      throw errors.validation([{ path: 'body.ownerUserId', message: 'The current owner can’t own leads in that unit; pick another' }]);
    }
    if (body.commissionPlanId !== undefined) patch.commission_plan_id = await checkPlan(trx, link.company_id, body.commissionPlanId, 'body.commissionPlanId');
    if (body.status !== undefined && body.status !== link.status) {
      patch.status = body.status;
      patch.ended_at = body.status === 'terminated' ? trx.fn.now() : null;
    }
    const changed = Object.keys(patch).filter((key) => key !== 'ended_at' && patch[key] !== link[key]);
    if (changed.length === 0) return;
    await trx('partner_companies').where({ id: link.id }).update({ ...patch, updated_at: trx.fn.now() });
    if (patch.unit_id) portalMoved = await movePortalRole(trx, req, partnerId, link, patch.unit_id);
    const pick = (row) => ({ unitId: row.unit_id, ownerUserId: row.owner_user_id, status: row.status, commissionPlanId: row.commission_plan_id });
    await writeAudit(trx, req, {
      action: 'partner.link_updated',
      entityType: 'partner',
      entityId: partnerId,
      unit: { id: unit.id, root_id: link.group_id },
      before: pick(link),
      after: pick({ ...link, ...patch }),
      meta: { companyId },
    });
    await emitEvent(trx, {
      type: 'partner.link_updated',
      groupId: link.group_id,
      unitId: unit.id,
      aggregateType: 'partner',
      aggregateId: partnerId,
      actorUserId: req.auth.user.id,
      payload: {
        partnerId,
        companyId,
        changes: changed.map((key) => ({ unit_id: 'unitId', owner_user_id: 'ownerUserId', commission_plan_id: 'commissionPlanId' })[key] ?? key),
        status: patch.status ?? link.status,
      },
    });
  });
  if (portalMoved) await bumpAccessVersion();
  return getPartner(req, partnerId);
}

/**
 * A partnership moved to another unit: the partner's portal role at the old unit (if the company
 * had given them a sign-in) moves with it, so the portal keeps covering exactly the partnerships
 * whose company invited them.
 * @returns {Promise<boolean>} whether a role assignment changed
 */
async function movePortalRole(trx, req, partnerId, link, unitId) {
  const partner = await trx('partners').where({ id: partnerId }).first('user_id');
  if (!partner?.user_id) return false;
  const role = await trx('roles').whereNull('group_id').where({ key: PARTNER_ROLE_KEY }).first('id');
  if (!role) return false;
  const held = await trx('role_assignments').where({ user_id: partner.user_id, role_id: role.id, org_unit_id: link.unit_id }).first('id');
  if (!held) return false;
  await trx('role_assignments')
    .insert({ user_id: partner.user_id, role_id: role.id, org_unit_id: unitId, created_by: req.auth.user.id })
    .onConflict(['user_id', 'role_id', 'org_unit_id'])
    .ignore();
  const stillUsed = await trx('partner_companies').where({ partner_id: partnerId, unit_id: link.unit_id }).whereNot({ id: link.id }).first('id');
  if (!stillUsed) await trx('role_assignments').where({ id: held.id }).del();
  return true;
}

// ---------- Payout details ----------

async function payoutDetailsLink(req, partnerId, trx, { change = false } = {}) {
  const found = await loadVisiblePartner(req, partnerId, { trx, forUpdate: true });
  const allowed = linksWith(req, found.unitsById, PERMISSIONS.payoutDetails, found.visibleLinks);
  if (allowed.length === 0) throw errors.forbidden('Only finance can see or change payout details');
  if (change && !canChangePayoutDetails(req, found.unitsById, found.links)) {
    throw errors.forbidden('This partner is paid by more than one company: only finance for all of them can change where the money goes');
  }
  return { ...found, link: allowed[0] };
}

/** PUT /partners/:id/payout-details: store them encrypted; the audit log only says they changed. */
export async function setPayoutDetails(req, partnerId, details) {
  await db.transaction(async (trx) => {
    const { partner, link } = await payoutDetailsLink(req, partnerId, trx, { change: true });
    await trx('partners')
      .where({ id: partnerId })
      .update({
        payout_method: details.method,
        payout_details_enc: sealPayoutDetails(details),
        payout_hint: json(payoutHint(details)),
        payout_details_updated_at: trx.fn.now(),
        payout_details_updated_by: req.auth.user.id,
        updated_at: trx.fn.now(),
      });
    await writeAudit(trx, req, {
      action: 'partner.payout_details_changed',
      entityType: 'partner',
      entityId: partnerId,
      unit: linkUnit(link),
      before: { payoutMethod: partner.payout_method ?? null },
      after: { payoutMethod: details.method, changed: ['payoutDetails'] },
    });
    await emitEvent(trx, {
      type: 'partner.payout_details_changed',
      groupId: partner.group_id,
      unitId: link.unit_id,
      aggregateType: 'partner',
      aggregateId: partnerId,
      actorUserId: req.auth.user.id,
      payload: { partnerId, method: details.method },
    });
  });
  return getPartner(req, partnerId);
}

/** GET /partners/:id/payout-details: the decrypted details, for finance. Every read is audited. */
export async function readPayoutDetails(req, partnerId) {
  return db.transaction(async (trx) => {
    const { partner, link } = await payoutDetailsLink(req, partnerId, trx);
    const details = openPayoutDetails(partner.payout_details_enc);
    await writeAudit(trx, req, {
      action: 'partner.payout_details_viewed',
      entityType: 'partner',
      entityId: partnerId,
      unit: linkUnit(link),
      meta: { method: partner.payout_method ?? null },
    });
    return { details, updatedAt: partner.payout_details_updated_at ?? null };
  });
}

// ---------- Portal access ----------

/** The built-in partner role (created here until core/systemRoles.js lists it; see the report). */
export async function ensurePartnerRole(trx, registry) {
  const permissions = systemRolePermissions(registry, PARTNER_ROLE_KEY);
  const existing = await trx('roles').whereNull('group_id').where({ key: PARTNER_ROLE_KEY }).first();
  if (existing) {
    const same = [...(existing.permissions ?? [])].sort().join(',') === permissions.join(',');
    if (!same) await trx('roles').where({ id: existing.id }).update({ permissions, updated_at: trx.fn.now() });
    return existing;
  }
  const [role] = await trx('roles')
    .insert({ key: PARTNER_ROLE.key, name: PARTNER_ROLE.name, description: PARTNER_ROLE.description, permissions, is_system: true, group_id: null })
    .returning('*');
  return role;
}

/**
 * POST /partners/:id/portal-access: give the partner a sign-in. Creates (or reuses) the account,
 * assigns the partner role at each company link the requester manages, and emails an invitation.
 * Staff accounts can't be used: one person is either staff or a partner.
 */
export async function grantPortalAccess(req, partnerId, { email, name }) {
  const registry = req.app.locals.registry;
  const inviter = req.auth.user;
  const result = await db.transaction(async (trx) => {
    const { partner, visibleLinks, unitsById } = await loadVisiblePartner(req, partnerId, { trx, forUpdate: true });
    const manageable = linksWith(req, unitsById, PERMISSIONS.manage, visibleLinks).filter((link) => link.status !== 'terminated');
    if (manageable.length === 0) throw errors.forbidden();
    const role = await ensurePartnerRole(trx, registry);

    let user = await trx('users').whereRaw('lower(email) = ?', [email]).forUpdate().first();
    // One sign-in per partner. Another company may have given it: invite the same email to add
    // your partnership to it; replacing it would take it away from that company's side.
    if (partner.user_id && partner.user_id !== user?.id) {
      throw errors.conflict('This partner already signs in with another email. Invite that email to add your partnership, or remove the sign-in first.');
    }
    if (user) {
      if (user.status === 'disabled') throw errors.conflict('This account is disabled.');
      const other = await trx('role_assignments').where({ user_id: user.id }).whereNot({ role_id: role.id }).first('id');
      if (other) throw errors.conflict('This email belongs to a staff account. Use a different email for the partner.');
      const taken = await trx('partners').where({ user_id: user.id }).whereNot({ id: partnerId }).first('id');
      if (taken) throw errors.conflict('This email already signs in for another partner.');
    } else {
      [user] = await trx('users').insert({ email, name: name ?? partner.name, status: 'invited' }).returning('*');
    }
    for (const link of manageable) {
      await trx('role_assignments')
        .insert({ user_id: user.id, role_id: role.id, org_unit_id: link.unit_id, created_by: inviter.id })
        .onConflict(['user_id', 'role_id', 'org_unit_id'])
        .ignore();
    }
    await trx('partners').where({ id: partnerId }).update({ user_id: user.id, updated_at: trx.fn.now() });

    let inviteUrl = null;
    if (user.status === 'invited') {
      const token = randomToken();
      await trx('user_tokens').where({ user_id: user.id, type: 'invite' }).whereNull('used_at').update({ used_at: trx.fn.now() });
      await trx('user_tokens').insert({
        user_id: user.id,
        type: 'invite',
        token_hash: sha256(token),
        expires_at: new Date(Date.now() + INVITE_TTL_MS),
        created_by: inviter.id,
      });
      inviteUrl = `${env.APP_URL}/accept-invite?token=${token}`;
    }
    await writeAudit(trx, req, {
      action: 'partner.portal_access_granted',
      entityType: 'partner',
      entityId: partnerId,
      unit: linkUnit(manageable[0]),
      after: { userId: user.id, units: manageable.map((link) => link.unit_id) },
    });
    await emitEvent(trx, {
      type: 'partner.portal_access_granted',
      groupId: partner.group_id,
      unitId: manageable[0].unit_id,
      aggregateType: 'partner',
      aggregateId: partnerId,
      actorUserId: inviter.id,
      payload: { partnerId, userId: user.id },
    });
    return { user, inviteUrl, partnerName: partner.name };
  });

  await bumpAccessVersion();
  if (result.inviteUrl) {
    await enqueueMail({
      to: result.user.email,
      subject: `${inviter.name} invited you to the Phoenix partner portal`,
      text: `Hi ${result.user.name},\n\n${inviter.name} has set up your partner portal for ${result.partnerName}: your referral links, referred leads, commissions and payouts in one place. Set your password to get started:\n${result.inviteUrl}\n\nThis link works once and expires in 7 days.`,
    });
  }
  return {
    partner: await getPartner(req, partnerId),
    // Handy in development; in production the link only travels by email.
    inviteUrl: env.isProd ? undefined : (result.inviteUrl ?? undefined),
  };
}

/**
 * DELETE /partners/:id/portal-access: take the requester's partnerships out of the partner's
 * portal. Another company's part of the same sign-in stays; when nothing is left the sign-in is
 * detached from the partner and its sessions end. Someone who manages every partnership removes
 * the partner role everywhere.
 */
export async function revokePortalAccess(req, partnerId) {
  const outcome = await db.transaction(async (trx) => {
    const { partner, links, visibleLinks, unitsById } = await loadVisiblePartner(req, partnerId, { trx, forUpdate: true });
    const manageable = linksWith(req, unitsById, PERMISSIONS.manage, visibleLinks);
    if (manageable.length === 0) throw errors.forbidden();
    if (!partner.user_id) return null;
    const role = await trx('roles').whereNull('group_id').where({ key: PARTNER_ROLE_KEY }).first('id');
    const everywhere = manageable.length === links.length;
    let removed = 0;
    let remaining = null;
    if (role) {
      const mine = trx('role_assignments').where({ user_id: partner.user_id, role_id: role.id });
      if (!everywhere) mine.whereIn('org_unit_id', manageable.map((link) => link.unit_id));
      removed = await mine.del();
      remaining = await trx('role_assignments').where({ user_id: partner.user_id, role_id: role.id }).first('id');
    }
    const detached = !remaining;
    if (removed === 0 && !detached) return null;
    if (detached) await trx('partners').where({ id: partnerId }).update({ user_id: null, updated_at: trx.fn.now() });
    const units = everywhere ? links.map((link) => link.unit_id) : manageable.map((link) => link.unit_id);
    await writeAudit(trx, req, {
      action: 'partner.portal_access_revoked',
      entityType: 'partner',
      entityId: partnerId,
      unit: linkUnit(manageable[0]),
      before: { userId: partner.user_id },
      after: { units, signInRemoved: detached },
    });
    await emitEvent(trx, {
      type: 'partner.portal_access_revoked',
      groupId: partner.group_id,
      unitId: manageable[0].unit_id,
      aggregateType: 'partner',
      aggregateId: partnerId,
      actorUserId: req.auth.user.id,
      payload: { partnerId, userId: partner.user_id, signInRemoved: detached },
    });
    return { userId: partner.user_id, detached };
  });
  if (outcome) {
    await bumpAccessVersion();
    if (outcome.detached) await revokeUserSessions(outcome.userId);
  }
  return getPartner(req, partnerId);
}

/** GET /partners/owners: people who can own a partner's leads at a unit (for the counsellor picker). */
export async function listOwners(req, unitId) {
  const index = await unitsIndex(req);
  const unit = index.get(unitId);
  if (!unit || !req.access.canSee(unit.path)) throw errors.notFound('Unit');
  if (!req.access.can(PERMISSIONS.manage, unit.path)) throw errors.forbidden();
  if (!companyOf(unit, index)) return [];
  const people = await usersWithPermissionAt(unit, 'deals.manage');
  return people.map(({ id, name }) => ({ id, name }));
}
