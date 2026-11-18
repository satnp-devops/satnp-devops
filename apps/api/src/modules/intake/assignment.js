import { json } from '../../lib/db.js';
import { assignOwner, initialState } from '../../core/intake/index.js';
import { isWithin } from '../../core/orgTree.js';
import { usersWithPermissionAt } from '../../core/crm/scope.js';

// Owner assignment for new leads: the company's assignment pools (configuration rows) feed the
// engine's assignOwner (round-robin with capacity, language and time zone; partner leads stay
// with the partner's counsellor; returning families keep their counsellor). The fairness state is
// one row per pool, locked FOR UPDATE so concurrent intakes take turns.

/**
 * Pick the pool for a lead and the unit it lands in.
 *  - pools of the company, active, matching the kind (or for both kinds) and the product line (or any);
 *  - with an explicit unit (a form's or a channel's), only pools at, above or inside it;
 *  - a pool naming the product line beats a general one, then the default pool, then position.
 * The lead lands in the pool's unit, or in the explicit unit when that is inside the pool's unit.
 */
export async function choosePoolAndUnit(trx, { company, kind, productLineId, explicitUnitId }) {
  const explicit = explicitUnitId && explicitUnitId !== company.id ? await trx('org_units').where({ id: explicitUnitId, status: 'active' }).first() : null;
  const usableExplicit = explicit && isWithin(explicit.path, company.path) ? explicit : null;
  const pools = await trx('intake_assignment_pools as p')
    .join('org_units as u', 'u.id', 'p.unit_id')
    .where({ 'p.company_id': company.id, 'p.active': true, 'u.status': 'active' })
    .where((q) => q.whereNull('p.kind').orWhere('p.kind', kind))
    .orderBy('p.position')
    .select('p.*', 'u.path as unit_path');
  const candidates = pools
    .filter((p) => !p.product_line_ids.length || (productLineId && p.product_line_ids.includes(productLineId)))
    .filter((p) => !usableExplicit || isWithin(p.unit_path, usableExplicit.path) || isWithin(usableExplicit.path, p.unit_path));
  const rank = (p) => (productLineId && p.product_line_ids.includes(productLineId) ? 0 : 2) + (p.is_default ? 0 : 1);
  const pool = candidates.sort((a, b) => rank(a) - rank(b) || a.position - b.position)[0] ?? null;
  let unit = usableExplicit ?? company;
  if (pool) {
    unit = usableExplicit && isWithin(usableExplicit.path, pool.unit_path) && usableExplicit.id !== pool.unit_id
      ? usableExplicit
      : await trx('org_units').where({ id: pool.unit_id }).first();
  }
  return { pool, unit };
}

async function lockState(trx, poolId) {
  await trx('intake_assignment_state').insert({ pool_id: poolId, state: json(initialState()) }).onConflict('pool_id').ignore();
  const row = await trx('intake_assignment_state').where({ pool_id: poolId }).forUpdate().first();
  return row.state;
}

async function openLeadCounts(trx, companyId, userIds) {
  if (!userIds.length) return new Map();
  const rows = await trx('deals')
    .where({ company_id: companyId, status: 'open' })
    .whereNull('archived_at')
    .whereIn('owner_user_id', userIds)
    .groupBy('owner_user_id')
    .select('owner_user_id')
    .count({ count: '*' });
  return new Map(rows.map((r) => [r.owner_user_id, Number(r.count)]));
}

/**
 * Choose the owner of a new (or reopened) lead.
 * @returns {Promise<{ decision: 'assigned' | 'unassigned', ownerId: string | null, method: string | null, poolId: string | null, reasons: object[], excluded: object[] }>}
 */
export async function assignLead(trx, { pool, unit, companyId, productLineId, enquiry, partner, existingOwner, now = new Date(), returningOwnerDays = 365 }) {
  const members = pool
    ? await trx('intake_pool_members as m')
        .join('users as u', 'u.id', 'm.user_id')
        .where('m.pool_id', pool.id)
        .select('m.*', 'u.status as user_status', 'u.time_zone as user_time_zone')
    : [];
  const extraIds = [partner?.owner_user_id, existingOwner?.ownerId].filter((id) => id && !members.some((m) => m.user_id === id));
  const extraUsers = extraIds.length ? await trx('users').whereIn('id', extraIds).select('id', 'status', 'time_zone') : [];
  const allIds = [...members.map((m) => m.user_id), ...extraUsers.map((u) => u.id)];
  // One connection per transaction: queries run one after another.
  const eligible = allIds.length ? await usersWithPermissionAt(unit, 'deals.manage', { trx, userIds: allIds }) : [];
  const counts = await openLeadCounts(trx, companyId, allIds);
  const canWork = new Set(eligible.map((u) => u.id));
  const nowMs = now.getTime();
  const partnerIds = (id) => (partner && partner.owner_user_id === id ? [partner.partner_id] : []);
  const poolOwners = members.map((m) => ({
    id: m.user_id,
    active: m.active && m.user_status === 'active' && canWork.has(m.user_id),
    away: m.away_until && new Date(m.away_until).getTime() > nowMs ? [{ from: 0, to: new Date(m.away_until).getTime() }] : [],
    companyIds: [companyId],
    languages: m.languages ?? [],
    timeZone: m.time_zone ?? m.user_time_zone ?? undefined,
    openLeads: counts.get(m.user_id) ?? 0,
    capacity: m.capacity,
    partnerIds: partnerIds(m.user_id),
  }));
  const extras = extraUsers.map((u) => ({
    id: u.id,
    active: u.status === 'active' && canWork.has(u.id),
    companyIds: [companyId],
    timeZone: u.time_zone ?? undefined,
    openLeads: counts.get(u.id) ?? 0,
    capacity: null,
    partnerIds: partnerIds(u.id),
  }));
  const options = {
    languageMatch: pool?.language_match ?? 'prefer',
    workingHours: pool?.working_hours ?? 'prefer',
    timeZoneMatch: pool?.time_zone_match ?? 'prefer',
    returningWindowDays: returningOwnerDays,
  };
  const lead = {
    companyId,
    ...(productLineId ? { productLineId } : {}),
    ...(enquiry.contact?.language ? { language: enquiry.contact.language } : {}),
    ...(enquiry.contact?.timeZone ? { timeZone: enquiry.contact.timeZone } : {}),
  };
  const state = pool ? await lockState(trx, pool.id) : initialState();
  const reasons = [];
  let result = null;

  // 1. Partner leads and returning families: pool plus the sticky owners, used only when sticky.
  const sticky = {
    ...(partner ? { partnerId: partner.partner_id, ...(partner.owner_user_id ? { partnerOwnerId: partner.owner_user_id } : {}) } : {}),
    ...(existingOwner?.ownerId && returningOwnerDays > 0
      ? { existingOwnerId: existingOwner.ownerId, ...(existingOwner.lastActivityAt ? { existingOwnerLastActivityAt: new Date(existingOwner.lastActivityAt).getTime() } : {}) }
      : {}),
  };
  if (Object.keys(sticky).length) {
    const first = assignOwner({ lead: { ...lead, ...sticky }, owners: [...poolOwners, ...extras], state, now: nowMs, options });
    if (first.method === 'partner' || first.method === 'existing_owner') result = first;
    else reasons.push(...first.reasons.filter((r) => !['round_robin', 'assigned'].includes(r.code)));
  }
  // 2. Round-robin over the pool.
  if (!result) {
    result = poolOwners.length
      ? assignOwner({ lead, owners: poolOwners, state, now: nowMs, options })
      : { decision: 'unassigned', ownerId: null, method: null, reasons: [{ code: 'no_pool', message: 'No assignment pool covers this lead' }], excluded: [], state };
  }
  if (pool && result.state) {
    await trx('intake_assignment_state').where({ pool_id: pool.id }).update({ state: json(result.state), updated_at: trx.fn.now() });
  }
  return {
    decision: result.decision,
    ownerId: result.ownerId ?? null,
    method: result.method ?? null,
    poolId: pool?.id ?? null,
    reasons: [...reasons, ...result.reasons],
    excluded: result.excluded ?? [],
  };
}

