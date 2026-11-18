import { db } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { writeAudit } from '../../core/audit.js';
import { emitEvent } from '../../core/events.js';
import { listScope, loadVisible, unitsIndex } from '../../core/crm/scope.js';
import { dealVisibility, loadVisibleLink, requireOnLink, scopeThroughLink } from './access.js';
import { PERMISSIONS } from './constants.js';
import { loadRefs, presentAttribution } from './present.js';
import { resolveTouch } from './referrals.js';
import { cursorAt, instantOr, lockKey, newestFirst, newestPage } from './util.js';

// Attributions: which partner brought a lead, at its first and at its last touch. Written by the
// deal event handlers from the touch sources intake stores on the deal, or set by hand.

const dealUnit = (deal) => ({ id: deal.unit_id, root_id: deal.group_id });

function attributionEvent(row, deal, { actorUserId = null, created }) {
  return {
    type: 'partner.lead_attributed',
    groupId: deal.group_id,
    unitId: deal.unit_id,
    aggregateType: 'partner',
    aggregateId: row.partner_id,
    actorUserId,
    payload: {
      attributionId: row.id,
      partnerId: row.partner_id,
      dealId: deal.id,
      companyId: deal.company_id,
      touch: row.touch,
      source: row.source,
      referralLinkId: row.referral_link_id ?? null,
      created,
    },
  };
}

/**
 * Bring a deal's attributions in line with its touch sources. Safe to run any number of times.
 *   first touch: set once, from deals.first_touch; never replaced automatically.
 *   last touch:  the latest touch that carried a partner (deals.last_touch, else the first touch);
 *                replaced when a later touch names another partner. Attributions set by hand are
 *                never replaced.
 * @returns {Promise<{ created: number, updated: number }>}
 */
export async function syncDealAttributions(trx, dealId, { actorUserId = null } = {}) {
  await lockKey(trx, `partners:attribution:${dealId}`);
  const deal = await trx('deals')
    .where({ id: dealId })
    .first('id', 'group_id', 'company_id', 'unit_id', 'first_touch', 'last_touch', 'primary_contact_id', 'source_event_id', 'created_at');
  if (!deal) return { created: 0, updated: 0 };
  const scope = { companyId: deal.company_id, groupId: deal.group_id, trx };
  const first = await resolveTouch(deal.first_touch, scope);
  const last = deal.last_touch ? ((await resolveTouch(deal.last_touch, scope)) ?? null) : first;
  const existing = await trx('partner_attributions').where({ deal_id: dealId }).forUpdate();
  const byTouch = new Map(existing.map((row) => [row.touch, row]));
  const result = { created: 0, updated: 0 };

  const rowFor = (touch, resolved, source) => ({
    group_id: deal.group_id,
    company_id: deal.company_id,
    partner_id: resolved.partnerId,
    referral_link_id: resolved.referralLinkId,
    deal_id: deal.id,
    contact_id: deal.primary_contact_id ?? null,
    touch,
    source: resolved.source,
    code: resolved.code,
    enquiry_ref: deal.source_event_id ?? null,
    touched_at: instantOr(source?.at, deal.created_at),
  });

  for (const [touch, resolved, source] of [
    ['first', first, deal.first_touch],
    ['last', last ?? (byTouch.has('last') ? null : first), deal.last_touch ?? deal.first_touch],
  ]) {
    if (!resolved) continue;
    const current = byTouch.get(touch);
    if (!current) {
      const [row] = await trx('partner_attributions').insert(rowFor(touch, resolved, source)).onConflict(['deal_id', 'touch']).ignore().returning('*');
      if (!row) continue;
      result.created += 1;
      await writeAudit(trx, null, {
        action: 'partner.lead_attributed',
        entityType: 'deal',
        entityId: deal.id,
        unit: dealUnit(deal),
        actorUserId,
        after: { partnerId: row.partner_id, touch, source: row.source, referralLinkId: row.referral_link_id },
      });
      await emitEvent(trx, attributionEvent(row, deal, { actorUserId, created: true }));
      continue;
    }
    const changed = current.partner_id !== resolved.partnerId || (current.referral_link_id ?? null) !== (resolved.referralLinkId ?? null);
    if (touch === 'first' || current.source === 'manual' || !changed) continue;
    const [row] = await trx('partner_attributions')
      .where({ id: current.id })
      .update({ ...rowFor(touch, resolved, source), updated_at: trx.fn.now() })
      .returning('*');
    result.updated += 1;
    await writeAudit(trx, null, {
      action: 'partner.lead_attributed',
      entityType: 'deal',
      entityId: deal.id,
      unit: dealUnit(deal),
      actorUserId,
      before: { partnerId: current.partner_id, referralLinkId: current.referral_link_id },
      after: { partnerId: row.partner_id, touch, source: row.source, referralLinkId: row.referral_link_id },
    });
    await emitEvent(trx, attributionEvent(row, deal, { actorUserId, created: false }));
  }
  return result;
}

// ---------- Endpoints ----------

/** GET /partner-attributions: referred leads of the partners in scope, newest first. */
export async function listAttributions(req, { unitId, partnerId, dealId, touch, onePerLead, cursor, limit }) {
  const scope = await listScope(req, PERMISSIONS.view, { unitId });
  const query = scopeThroughLink(db('partner_attributions as a'), scope, 'a').select('a.*', cursorAt('a.created_at'));
  if (onePerLead && !touch) {
    // When the partner holds both touches of a lead, the first-touch row stands for it.
    const same = 'o.deal_id = a.deal_id and o.partner_id = a.partner_id';
    query
      .whereNot((w) =>
        w.where('a.touch', 'last').whereExists(
          db('partner_attributions as o')
            .select(db.raw('1'))
            .whereRaw(`${same} and o.touch = 'first'`),
        ),
      )
      .select(db.raw(`(a.touch = 'first' and exists (select 1 from partner_attributions o where ${same} and o.touch = 'last')) as both_touches`));
  }
  if (partnerId) query.where('a.partner_id', partnerId);
  if (dealId) query.where('a.deal_id', dealId);
  if (touch) query.where('a.touch', touch);
  newestFirst(query, { cursor, limit, createdColumn: 'a.created_at', idColumn: 'a.id' });
  const { page, nextCursor } = newestPage(await query, limit);
  return { data: await presentAttributions(req, page), nextCursor };
}

async function presentAttributions(req, rows, trx = db) {
  if (rows.length === 0) return [];
  const [index, refs] = await Promise.all([
    unitsIndex(req, trx),
    loadRefs({ dealIds: rows.map((r) => r.deal_id), partnerIds: rows.map((r) => r.partner_id), contactIds: rows.map((r) => r.contact_id) }, trx),
  ]);
  const { visibleDealIds, piiUnitIds } = await dealVisibility(req, [...refs.deals.values()], trx);
  return rows.map((row) => presentAttribution(row, { unitsById: index, refs, visibleDealIds, piiUnitIds }));
}

/**
 * POST /partner-attributions: credit a partner for a lead by hand (first or last touch). Replaces
 * the attribution of that touch. The deal must be visible; the partner must work with the deal's
 * company and the user must manage that partner link. Commissions already accrued don't move.
 */
export async function setAttribution(req, { dealId, partnerId, touch, referralLinkId }) {
  const id = await db.transaction(async (trx) => {
    const { row: deal } = await loadVisible(req, { table: 'deals', id: dealId, permission: 'deals.view', notFound: 'Deal', trx });
    const link = await trx('partner_companies').where({ partner_id: partnerId, company_id: deal.company_id }).first();
    if (!link) throw errors.validation([{ path: 'body.partnerId', message: 'This partner doesn’t work with the deal’s company' }]);
    await loadVisibleLink(req, { partnerId, companyId: deal.company_id, trx }).catch(() => {
      throw errors.validation([{ path: 'body.partnerId', message: 'Partner not found' }]);
    });
    await requireOnLink(req, PERMISSIONS.manage, link, trx);
    let code = null;
    if (referralLinkId) {
      const referral = await trx('partner_referral_links').where({ id: referralLinkId, partner_id: partnerId, company_id: deal.company_id }).first('id', 'code');
      if (!referral) throw errors.validation([{ path: 'body.referralLinkId', message: 'Pick one of this partner’s links for this company' }]);
      code = referral.code;
    }
    await lockKey(trx, `partners:attribution:${dealId}`);
    const before = await trx('partner_attributions').where({ deal_id: dealId, touch }).forUpdate().first();
    const values = {
      group_id: deal.group_id,
      company_id: deal.company_id,
      partner_id: partnerId,
      referral_link_id: referralLinkId ?? null,
      deal_id: dealId,
      contact_id: deal.primary_contact_id ?? null,
      touch,
      source: 'manual',
      code,
      enquiry_ref: deal.source_event_id ?? null,
      touched_at: trx.fn.now(),
      created_by: req.auth.user.id,
    };
    const [row] = await trx('partner_attributions')
      .insert(values)
      .onConflict(['deal_id', 'touch'])
      .merge({ ...values, updated_at: trx.fn.now() })
      .returning('*');
    await writeAudit(trx, req, {
      action: 'partner.attribution_set',
      entityType: 'deal',
      entityId: dealId,
      unit: dealUnit(deal),
      before: before ? { partnerId: before.partner_id, source: before.source } : undefined,
      after: { partnerId, touch, source: 'manual', referralLinkId: referralLinkId ?? null },
    });
    await emitEvent(trx, attributionEvent(row, deal, { actorUserId: req.auth.user.id, created: !before }));
    return row.id;
  });
  const row = await db('partner_attributions').where({ id }).first();
  return (await presentAttributions(req, [row]))[0];
}

/** DELETE /partner-attributions/:id: remove a wrong attribution. Commissions already accrued stay. */
export async function removeAttribution(req, attributionId) {
  await db.transaction(async (trx) => {
    const row = await trx('partner_attributions').where({ id: attributionId }).forUpdate().first();
    if (!row) throw errors.notFound('Attribution');
    const link = await loadVisibleLink(req, { partnerId: row.partner_id, companyId: row.company_id, trx, notFound: 'Attribution' });
    await requireOnLink(req, PERMISSIONS.manage, link, trx);
    await trx('partner_attributions').where({ id: attributionId }).del();
    const deal = await trx('deals').where({ id: row.deal_id }).first('id', 'group_id', 'company_id', 'unit_id');
    await writeAudit(trx, req, {
      action: 'partner.attribution_removed',
      entityType: 'deal',
      entityId: row.deal_id,
      unit: dealUnit(deal),
      before: { partnerId: row.partner_id, touch: row.touch, source: row.source },
    });
    await emitEvent(trx, {
      type: 'partner.attribution_removed',
      groupId: deal.group_id,
      unitId: deal.unit_id,
      aggregateType: 'partner',
      aggregateId: row.partner_id,
      actorUserId: req.auth.user.id,
      payload: { attributionId, partnerId: row.partner_id, dealId: row.deal_id, companyId: row.company_id, touch: row.touch },
    });
  });
}
