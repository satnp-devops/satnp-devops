import { db } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { minorFromDb } from '../../core/crm/money.js';
import { unitsIndex } from '../../core/crm/scope.js';
import { loadPortalPartner } from './access.js';
import { changeLink, insertLink, presentLinks } from './links.js';
import { companyRef, presentPortalCommission, presentPortalLead, presentPortalPayout } from './present.js';
import { presentPayoutHint } from './payoutDetails.js';
import { cursorAt, newestFirst, newestPage } from './util.js';

// The partner portal: a partner signs in and sees only their own referral links, the leads they
// referred (masked: "Priya S.", "+91 ••••• •3210", the outcome), their commissions and payouts.
// Every query here filters by the partner the signed-in person is (partners.user_id) and by the
// companies whose partnership the sign-in covers (access.js loadPortalPartner); nothing takes a
// partner id from the client, and a company id from the client only narrows that list.

/** GET /partner-portal/me */
export async function portalMe(req) {
  const { partner, links, companyIds } = await loadPortalPartner(req);
  const index = await unitsIndex(req);
  const [activeLinks, leads, commissions, owners] = await Promise.all([
    db('partner_referral_links').where({ partner_id: partner.id, active: true }).whereIn('company_id', companyIds).count({ n: '*' }).first(),
    db('partner_attributions as a')
      .join('deals as d', 'd.id', 'a.deal_id')
      .where('a.partner_id', partner.id)
      .whereIn('a.company_id', companyIds)
      .select(db.raw('count(distinct a.deal_id)::int as total'), db.raw("count(distinct a.deal_id) filter (where d.status = 'won')::int as enrolled"))
      .first(),
    db('partner_commissions')
      .where({ partner_id: partner.id })
      .whereIn('company_id', companyIds)
      .whereNot('status', 'rejected')
      .groupBy('status', 'currency')
      .select('status', 'currency', db.raw('sum(amount_minor - clawed_back_minor) as total')),
    db('partner_companies as pc')
      .join('users as u', 'u.id', 'pc.owner_user_id')
      .where('pc.partner_id', partner.id)
      .whereIn('pc.company_id', companyIds)
      .select('pc.company_id', 'u.name'),
  ]);
  const ownerByCompany = new Map(owners.map((o) => [o.company_id, o.name]));
  const totals = {};
  for (const row of commissions) (totals[row.status] ??= []).push({ valueMinor: minorFromDb(row.total), currency: row.currency });
  return {
    id: partner.id,
    kind: partner.kind,
    name: partner.name,
    code: partner.code ?? null,
    email: partner.email ?? null,
    phone: partner.phone ?? null,
    city: partner.city ?? null,
    payout: presentPayoutHint(partner.payout_hint),
    companies: links.map((link) => ({
      company: companyRef(index.get(link.company_id)),
      status: link.status,
      contactName: ownerByCompany.get(link.company_id) ?? null,
      joinedAt: link.joined_at instanceof Date ? link.joined_at.toISOString() : link.joined_at,
      canCreateLinks: link.status === 'active',
    })),
    stats: {
      activeLinks: Number(activeLinks?.n ?? 0),
      referredLeads: leads?.total ?? 0,
      enrolled: leads?.enrolled ?? 0,
      commissions: totals,
    },
  };
}

/** GET /partner-portal/links */
export async function portalLinks(req, { companyId, cursor, limit }) {
  const { partner, companyIds } = await loadPortalPartner(req);
  const query = db('partner_referral_links as rl')
    .where('rl.partner_id', partner.id)
    .whereIn('rl.company_id', companyIds)
    .select('rl.*', cursorAt('rl.created_at'));
  if (companyId) query.where('rl.company_id', companyId);
  newestFirst(query, { cursor, limit, createdColumn: 'rl.created_at', idColumn: 'rl.id' });
  const { page, nextCursor } = newestPage(await query, limit);
  return { data: await presentLinks(req, page), nextCursor };
}

/** POST /partner-portal/links: a partner makes a link for one of their active partnerships. */
export async function portalCreateLink(req, body) {
  const { partner, companyIds } = await loadPortalPartner(req);
  const id = await db.transaction(async (trx) => {
    const link = companyIds.includes(body.companyId)
      ? await trx('partner_companies').where({ partner_id: partner.id, company_id: body.companyId }).forUpdate().first()
      : null;
    if (!link) throw errors.validation([{ path: 'body.companyId', message: 'Pick one of your partnerships' }]);
    return (await insertLink(trx, req, link, body, { byPartner: true })).id;
  });
  return (await presentLinks(req, [await db('partner_referral_links').where({ id }).first()]))[0];
}

/** PATCH /partner-portal/links/:id: rename it, or turn it off and on. */
export async function portalUpdateLink(req, linkId, body) {
  const { partner, companyIds } = await loadPortalPartner(req);
  await db.transaction(async (trx) => {
    const row = await trx('partner_referral_links').where({ id: linkId, partner_id: partner.id }).whereIn('company_id', companyIds).forUpdate().first();
    if (!row) throw errors.notFound('Referral link');
    await changeLink(trx, req, row, body, { byPartner: true });
  });
  return (await presentLinks(req, [await db('partner_referral_links').where({ id: linkId }).first()]))[0];
}

/**
 * GET /partner-portal/leads: one row per referred lead. When the partner holds both touches of a
 * deal, the first-touch row stands for it.
 */
export async function portalLeads(req, { companyId, cursor, limit }) {
  const { partner, companyIds } = await loadPortalPartner(req);
  const index = await unitsIndex(req);
  const query = db('partner_attributions as a')
    .join('deals as d', 'd.id', 'a.deal_id')
    .leftJoin('contacts as ct', 'ct.id', 'd.primary_contact_id')
    .leftJoin('product_lines as pl', 'pl.id', 'd.product_line_id')
    .where('a.partner_id', partner.id)
    .whereIn('a.company_id', companyIds)
    .whereNot(function bothTouches() {
      this.where('a.touch', 'last').whereExists(function firstToo() {
        this.select(db.raw('1')).from('partner_attributions as f').whereRaw("f.deal_id = a.deal_id and f.partner_id = a.partner_id and f.touch = 'first'");
      });
    })
    .select(
      'a.id',
      'a.company_id',
      'a.touch',
      'a.touched_at',
      'd.ref as deal_ref',
      'd.status as deal_status',
      'd.product_line_id',
      'pl.name as product_line_name',
      'ct.display_name',
      'ct.primary_phone',
      'ct.erased_at',
      cursorAt('a.created_at'),
    );
  if (companyId) query.where('a.company_id', companyId);
  newestFirst(query, { cursor, limit, createdColumn: 'a.created_at', idColumn: 'a.id' });
  const { page, nextCursor } = newestPage(await query, limit);
  return { data: page.map((row) => presentPortalLead(row, { unitsById: index })), nextCursor };
}

/** GET /partner-portal/commissions */
export async function portalCommissions(req, { companyId, cursor, limit }) {
  const { partner, companyIds } = await loadPortalPartner(req);
  const index = await unitsIndex(req);
  const query = db('partner_commissions as c')
    .join('deals as d', 'd.id', 'c.deal_id')
    .where('c.partner_id', partner.id)
    .whereIn('c.company_id', companyIds)
    .select('c.*', 'd.ref as deal_ref', cursorAt('c.created_at'));
  if (companyId) query.where('c.company_id', companyId);
  newestFirst(query, { cursor, limit, createdColumn: 'c.created_at', idColumn: 'c.id' });
  const { page, nextCursor } = newestPage(await query, limit);
  return { data: page.map((row) => presentPortalCommission(row, { unitsById: index })), nextCursor };
}

/** GET /partner-portal/payouts: approved and paid batches, the partner's own line only. */
export async function portalPayouts(req, { companyId, cursor, limit }) {
  const { partner, companyIds } = await loadPortalPartner(req);
  const index = await unitsIndex(req);
  const query = db('partner_payout_lines as l')
    .join('partner_payouts as po', 'po.id', 'l.payout_id')
    .where('l.partner_id', partner.id)
    .whereIn('po.company_id', companyIds)
    .whereIn('po.status', ['approved', 'paid'])
    .select(
      'po.id',
      'po.ref',
      'po.company_id',
      'po.period_start',
      'po.period_end',
      'po.status',
      'po.currency',
      'po.paid_at',
      'po.reference',
      'l.net_minor',
      'l.deduction_minor',
      'l.commission_count',
      'l.reference as line_reference',
      cursorAt('po.created_at'),
    );
  if (companyId) query.where('po.company_id', companyId);
  newestFirst(query, { cursor, limit, createdColumn: 'po.created_at', idColumn: 'po.id' });
  const { page, nextCursor } = newestPage(await query, limit);
  return { data: page.map((row) => presentPortalPayout(row, { unitsById: index })), nextCursor };
}
