import { db, json, PG } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { writeAudit } from '../../core/audit.js';
import { emitEvent } from '../../core/events.js';
import { crmSetting } from '../../core/crm/settings.js';
import { listScope, unitsIndex } from '../../core/crm/scope.js';
import { loadVisibleLink, requireOnLink, scopeThroughLink } from './access.js';
import { PERMISSIONS } from './constants.js';
import { loadRefs, presentReferralLink } from './present.js';
import { generateReferralCode } from './rules.js';
import { defaultLandingUrlSetting, maxLinksPerPartnerSetting } from './settings.js';
import { companyPrefix, cursorAt, newestFirst, newestPage } from './util.js';

// Referral links: a code (and a shareable URL) per partner, company and optionally product line.
// Staff create them for partners; partners create their own from the portal (portal.js).

const CODE_ATTEMPTS = 5;

/** Present link rows with their partner, product line, default landing page and lead counts. */
export async function presentLinks(req, rows, { trx = db, unitsById } = {}) {
  if (rows.length === 0) return [];
  const companyIds = [...new Set(rows.map((r) => r.company_id))];
  const [index, refs, counts, landingPairs] = await Promise.all([
    unitsById ? Promise.resolve(unitsById) : unitsIndex(req, trx),
    loadRefs({ partnerIds: rows.map((r) => r.partner_id), productLineIds: rows.map((r) => r.product_line_id) }, trx),
    trx('partner_attributions')
      .whereIn(
        'referral_link_id',
        rows.map((r) => r.id),
      )
      .groupBy('referral_link_id')
      .select('referral_link_id', trx.raw('count(distinct deal_id)::int as n')),
    Promise.all(
      companyIds.map(async (id) => {
        const company = await trx('org_units').where({ id }).first('id', 'path', 'root_id', 'type');
        return [id, company ? await crmSetting(company, defaultLandingUrlSetting, trx) : null];
      }),
    ),
  ]);
  const leadCounts = new Map(counts.map((c) => [c.referral_link_id, c.n]));
  const defaultLandingUrls = new Map(landingPairs);
  return rows.map((row) => presentReferralLink(row, { unitsById: index, refs, leadCounts, defaultLandingUrls }));
}

/** GET /partner-links: referral links of partners in scope, newest first. */
export async function listLinks(req, { unitId, partnerId, active, q, cursor, limit }) {
  const scope = await listScope(req, PERMISSIONS.view, { unitId });
  const query = scopeThroughLink(db('partner_referral_links as rl'), scope, 'rl').select('rl.*', cursorAt('rl.created_at'));
  if (partnerId) query.where('rl.partner_id', partnerId);
  if (active !== undefined) query.where('rl.active', active);
  if (q) query.where('rl.code', 'ilike', `%${q.replace(/[%_\\]/g, '\\$&')}%`);
  newestFirst(query, { cursor, limit, createdColumn: 'rl.created_at', idColumn: 'rl.id' });
  const { page, nextCursor } = newestPage(await query, limit);
  return { data: await presentLinks(req, page), nextCursor };
}

async function checkProductLine(trx, companyId, productLineId, path = 'body.productLineId') {
  if (!productLineId) return null;
  const line = await trx('product_lines').where({ id: productLineId, company_id: companyId }).first('id', 'active');
  if (!line) throw errors.validation([{ path, message: 'Pick a product line of this company' }]);
  return line.id;
}

/**
 * Insert a referral link for a partner's company link, generating a code unless one is given.
 * Shared by staff (POST /partner-links) and the portal. The caller has checked access.
 */
export async function insertLink(trx, req, link, body, { byPartner = false } = {}) {
  if (link.status === 'terminated' || link.status === 'suspended') {
    throw errors.conflict(`Links can’t be added while the partnership is ${link.status}`);
  }
  const company = await trx('org_units').where({ id: link.company_id }).first('id', 'path', 'root_id', 'type', 'name');
  const max = await crmSetting(company, maxLinksPerPartnerSetting, trx);
  const active = await trx('partner_referral_links').where({ partner_id: link.partner_id, company_id: link.company_id, active: true }).count({ n: '*' }).first();
  if (Number(active?.n ?? 0) >= max) throw errors.conflict(`A partner can have up to ${max} active links with ${company.name}. Turn one off first.`);
  const productLineId = await checkProductLine(trx, link.company_id, body.productLineId);
  const prefix = await companyPrefix(company, trx);
  const values = {
    group_id: link.group_id,
    company_id: link.company_id,
    partner_id: link.partner_id,
    product_line_id: productLineId,
    label: body.label ?? null,
    landing_url: body.landingUrl ?? null,
    utm: json(body.utm ?? {}),
    active: true,
    created_by: req.auth.user.id,
    created_by_partner: byPartner,
  };
  for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt += 1) {
    const code = body.code ?? generateReferralCode(prefix);
    try {
      // A savepoint, so a duplicate code doesn't abort the transaction.
      const [row] = await trx.transaction((sp) => sp('partner_referral_links').insert({ ...values, code }).returning('*'));
      await writeAudit(trx, req, {
        action: 'partner.link_created',
        entityType: 'partner',
        entityId: link.partner_id,
        unit: { id: link.unit_id, root_id: link.group_id },
        after: { linkId: row.id, code: row.code, companyId: row.company_id, productLineId, byPartner },
      });
      await emitEvent(trx, {
        type: 'partner.link_created',
        groupId: link.group_id,
        unitId: link.unit_id,
        aggregateType: 'partner',
        aggregateId: link.partner_id,
        actorUserId: req.auth.user.id,
        payload: { linkId: row.id, partnerId: link.partner_id, companyId: link.company_id, code: row.code, byPartner },
      });
      return row;
    } catch (error) {
      if (error.code !== PG.UNIQUE_VIOLATION) throw error;
      if (body.code) throw errors.validation([{ path: 'body.code', message: 'This code is taken; try another' }]);
    }
  }
  throw errors.conflict('Couldn’t generate a free code; try again');
}

/** POST /partner-links: a new referral link for a partner and company. */
export async function createLink(req, body) {
  const id = await db.transaction(async (trx) => {
    const link = await loadVisibleLink(req, { partnerId: body.partnerId, companyId: body.companyId, trx, forUpdate: true });
    await requireOnLink(req, PERMISSIONS.manage, link, trx);
    return (await insertLink(trx, req, link, body)).id;
  });
  return (await presentLinks(req, [await db('partner_referral_links').where({ id }).first()]))[0];
}

/**
 * Change a link: label, product line, landing page, UTM tags, on or off. The code never changes
 * (it is printed on flyers). Shared by staff and the portal (which may only change label and active).
 */
export async function changeLink(trx, req, row, body, { byPartner = false } = {}) {
  const patch = {};
  if (body.label !== undefined) patch.label = body.label;
  if (body.landingUrl !== undefined) patch.landing_url = body.landingUrl;
  if (body.utm !== undefined) patch.utm = json(body.utm);
  if (body.productLineId !== undefined) patch.product_line_id = await checkProductLine(trx, row.company_id, body.productLineId);
  if (body.active !== undefined && body.active !== row.active) {
    if (body.active) {
      const link = await trx('partner_companies').where({ partner_id: row.partner_id, company_id: row.company_id }).first();
      if (!link || link.status === 'terminated' || link.status === 'suspended') throw errors.conflict('The partnership isn’t active');
      const company = await trx('org_units').where({ id: row.company_id }).first('id', 'path', 'root_id', 'type', 'name');
      const max = await crmSetting(company, maxLinksPerPartnerSetting, trx);
      const active = await trx('partner_referral_links').where({ partner_id: row.partner_id, company_id: row.company_id, active: true }).count({ n: '*' }).first();
      if (Number(active?.n ?? 0) >= max) throw errors.conflict(`A partner can have up to ${max} active links with ${company.name}.`);
    }
    patch.active = body.active;
    patch.deactivated_at = body.active ? null : trx.fn.now();
  }
  const changed = Object.keys(patch).filter((key) => key !== 'deactivated_at');
  if (changed.length === 0) return row;
  const [updated] = await trx('partner_referral_links')
    .where({ id: row.id })
    .update({ ...patch, updated_at: trx.fn.now() })
    .returning('*');
  const link = await trx('partner_companies').where({ partner_id: row.partner_id, company_id: row.company_id }).first('unit_id', 'group_id');
  await writeAudit(trx, req, {
    action: 'partner.link_updated',
    entityType: 'partner',
    entityId: row.partner_id,
    unit: { id: link.unit_id, root_id: link.group_id },
    before: { label: row.label, landingUrl: row.landing_url, active: row.active, productLineId: row.product_line_id },
    after: { label: updated.label, landingUrl: updated.landing_url, active: updated.active, productLineId: updated.product_line_id },
    meta: { linkId: row.id, code: row.code, byPartner },
  });
  await emitEvent(trx, {
    type: 'partner.referral_link_updated',
    groupId: row.group_id,
    unitId: link.unit_id,
    aggregateType: 'partner',
    aggregateId: row.partner_id,
    actorUserId: req.auth.user.id,
    payload: {
      linkId: row.id,
      partnerId: row.partner_id,
      companyId: row.company_id,
      changes: changed.map((key) => ({ landing_url: 'landingUrl', product_line_id: 'productLineId' })[key] ?? key),
      active: updated.active,
      byPartner,
    },
  });
  return updated;
}

/** PATCH /partner-links/:id */
export async function updateLink(req, linkId, body) {
  await db.transaction(async (trx) => {
    const row = await trx('partner_referral_links').where({ id: linkId }).forUpdate().first();
    if (!row) throw errors.notFound('Referral link');
    const link = await loadVisibleLink(req, { partnerId: row.partner_id, companyId: row.company_id, trx, notFound: 'Referral link' });
    await requireOnLink(req, PERMISSIONS.manage, link, trx);
    await changeLink(trx, req, row, body);
  });
  return (await presentLinks(req, [await db('partner_referral_links').where({ id: linkId }).first()]))[0];
}
