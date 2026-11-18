import { db, json } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { writeAudit } from '../../core/audit.js';
import { emitEvent } from '../../core/events.js';
import { crmSetting } from '../../core/crm/settings.js';
import { companyOf, requireCompany, unitsIndex } from '../../core/crm/scope.js';
import { isWithin } from '../../core/orgTree.js';
import { PERMISSIONS } from './constants.js';
import { loadRefs, presentPayout, presentPayoutLine } from './present.js';
import { buildPayoutLines } from './rules.js';
import { holdDuringClawbackSetting } from './settings.js';
import { companyPrefix, cursorAt, lockKey, newestFirst, newestPage, nextSequence } from './util.js';

// Payout batches: finance gathers a company's approved commissions (minus clawbacks of commissions
// already paid) into one batch per currency, someone else approves it (maker-checker), then finance
// marks it paid with the bank reference. Batches belong to the company: people see them with
// partners.manage_payouts or partners.approve_payouts at the company (or above).

const PAYOUT_VIEW = [PERMISSIONS.managePayouts, PERMISSIONS.approvePayouts];
const DAY_MS = 86_400_000;

const canAt = (access, permission, company) => access.can(permission, company.path);
const canViewPayoutsAt = (access, company) => PAYOUT_VIEW.some((permission) => canAt(access, permission, company));

function payoutCan(req, row, company) {
  const me = req.auth.user.id;
  const manage = canAt(req.access, PERMISSIONS.managePayouts, company);
  const approve = canAt(req.access, PERMISSIONS.approvePayouts, company);
  return {
    approve: approve && row.status === 'draft' && row.created_by !== me && Number(row.total_minor) > 0,
    markPaid: manage && row.status === 'approved',
    cancel: manage && (row.status === 'draft' || row.status === 'approved'),
    isPreparer: row.created_by === me,
  };
}

// ---------- Choosing what a batch pays ----------

/**
 * Approved commissions not yet in a batch, earned up to the end of the period (older ones that
 * were waiting are included), of partners whose partnership is active, plus outstanding deductions.
 * With partners.holdDuringClawback, commissions still inside their clawback window wait.
 */
async function selectPayable(trx, company, { currency, periodEnd, forUpdate = false }) {
  const hold = await crmSetting(company, holdDuringClawbackSetting, trx);
  const endExclusive = new Date(new Date(`${periodEnd}T00:00:00.000Z`).getTime() + DAY_MS);
  const commissionsQuery = trx('partner_commissions as c')
    .join('partner_companies as pc', function joinLink() {
      this.on('pc.partner_id', '=', 'c.partner_id').andOn('pc.company_id', '=', 'c.company_id');
    })
    .where({ 'c.company_id': company.id, 'c.currency': currency, 'c.status': 'approved', 'pc.status': 'active' })
    .whereNull('c.payout_id')
    .where('c.earned_at', '<', endExclusive)
    .select('c.id', 'c.partner_id', 'c.amount_minor', 'c.clawed_back_minor', 'c.clawback_until');
  if (hold) commissionsQuery.where('c.clawback_until', '<=', trx.fn.now());
  if (forUpdate) commissionsQuery.forUpdate('c');
  const commissions = await commissionsQuery;
  const deductionsQuery = trx('partner_commission_clawbacks')
    .where({ company_id: company.id, currency, recovery: 'deduct' })
    .whereNull('recovered_at')
    .whereNull('payout_id')
    .select('id', 'partner_id', 'amount_minor');
  if (forUpdate) deductionsQuery.forUpdate();
  const deductions = await deductionsQuery;
  const { lines, skipped } = buildPayoutLines(commissions, deductions);
  const partners = lines.length
    ? await trx('partners')
        .whereIn(
          'id',
          lines.map((l) => l.partnerId),
        )
        .select('id', 'payout_hint')
    : [];
  const hints = new Map(partners.map((p) => [p.id, p.payout_hint ?? {}]));
  const ready = [];
  for (const line of lines) {
    const hint = hints.get(line.partnerId) ?? {};
    if (!hint.method) skipped.push({ partnerId: line.partnerId, netMinor: line.netMinor, reason: 'no_payout_details' });
    else ready.push({ ...line, payoutHint: hint });
  }
  return { lines: ready, skipped, hold };
}

const totalsOf = (lines) => ({
  commission: lines.reduce((sum, l) => sum + l.commissionMinor, 0),
  deduction: lines.reduce((sum, l) => sum + l.deductionMinor, 0),
  total: lines.reduce((sum, l) => sum + l.netMinor, 0),
});

/** POST /partner-payouts/preview: what a batch for this period would hold, without making it. */
export async function previewPayout(req, { companyId, periodEnd, currency }) {
  const company = await requireCompany(req, companyId, PERMISSIONS.managePayouts, { write: true, path: 'body.companyId' });
  const { lines, skipped, hold } = await selectPayable(db, company, { currency, periodEnd });
  const refs = await loadRefs({ partnerIds: [...lines, ...skipped].map((l) => l.partnerId) });
  const partner = (id) => {
    const p = refs.partners.get(id);
    return p ? { id: p.id, name: p.name, kind: p.kind } : { id, name: 'Partner', kind: 'person' };
  };
  const money = (valueMinor) => ({ valueMinor, currency });
  const totals = totalsOf(lines);
  return {
    currency,
    holdDuringClawback: hold,
    lines: lines.map((l) => ({
      partner: partner(l.partnerId),
      commission: money(l.commissionMinor),
      deductions: money(l.deductionMinor),
      net: money(l.netMinor),
      commissionCount: l.commissionIds.length,
    })),
    skipped: skipped.map((s) => ({ partner: partner(s.partnerId), net: money(s.netMinor), reason: s.reason })),
    commission: money(totals.commission),
    deductions: money(totals.deduction),
    total: money(totals.total),
  };
}

/** POST /partner-payouts: make a draft batch (partners.manage_payouts at the company). */
export async function createPayout(req, { companyId, periodStart, periodEnd, currency, notes }) {
  const company = await requireCompany(req, companyId, PERMISSIONS.managePayouts, { write: true, path: 'body.companyId' });
  const id = await db.transaction(async (trx) => {
    await lockKey(trx, `partners:payout:${company.id}:${currency}`);
    const { lines, skipped } = await selectPayable(trx, company, { currency, periodEnd, forUpdate: true });
    if (lines.length === 0) {
      throw errors.conflict('Nothing to pay for this period: no approved commissions are ready, or partners have no payout details yet.', {
        skipped: skipped.map((s) => ({ partnerId: s.partnerId, reason: s.reason })),
      });
    }
    const number = await nextSequence(trx, company.id, 'partner_payout');
    const prefix = await companyPrefix(company, trx);
    const totals = totalsOf(lines);
    const [payout] = await trx('partner_payouts')
      .insert({
        group_id: company.root_id,
        company_id: company.id,
        number,
        ref: `${prefix}-PO-${number}`,
        period_start: periodStart,
        period_end: periodEnd,
        currency,
        status: 'draft',
        commission_minor: totals.commission,
        deduction_minor: totals.deduction,
        total_minor: totals.total,
        line_count: lines.length,
        notes: notes ?? null,
        created_by: req.auth.user.id,
      })
      .returning('*');
    await insertLines(trx, payout.id, lines);
    await writeAudit(trx, req, {
      action: 'partner.payout_created',
      entityType: 'partner_payout',
      entityId: payout.id,
      unit: company,
      after: { ref: payout.ref, periodStart, periodEnd, currency, totalMinor: totals.total, lineCount: lines.length },
    });
    await emitEvent(trx, {
      type: 'partner.payout_created',
      groupId: company.root_id,
      unitId: company.id,
      aggregateType: 'partner_payout',
      aggregateId: payout.id,
      actorUserId: req.auth.user.id,
      payload: { payoutId: payout.id, companyId: company.id, ref: payout.ref, currency, totalMinor: totals.total, lineCount: lines.length },
    });
    return payout.id;
  });
  return getPayout(req, id);
}

async function insertLines(trx, payoutId, lines) {
  if (lines.length === 0) return;
  await trx('partner_payout_lines').insert(
    lines.map((line) => ({
      payout_id: payoutId,
      partner_id: line.partnerId,
      commission_minor: line.commissionMinor,
      deduction_minor: line.deductionMinor,
      net_minor: line.netMinor,
      commission_count: line.commissionIds.length,
      payout_hint: json(line.payoutHint ?? {}),
    })),
  );
  const commissionIds = lines.flatMap((l) => l.commissionIds);
  const deductionIds = lines.flatMap((l) => l.deductionIds);
  if (commissionIds.length) await trx('partner_commissions').whereIn('id', commissionIds).update({ payout_id: payoutId, updated_at: trx.fn.now() });
  if (deductionIds.length) await trx('partner_commission_clawbacks').whereIn('id', deductionIds).update({ payout_id: payoutId });
}

/**
 * Recount a draft batch after a clawback made one of its commissions smaller (or took it out).
 * Partners whose net drops to zero or below leave the batch with their deductions.
 */
export async function recomputeDraftPayout(trx, payoutId) {
  const payout = await trx('partner_payouts').where({ id: payoutId }).forUpdate().first();
  if (!payout || payout.status !== 'draft') return;
  const commissions = await trx('partner_commissions')
    .where({ payout_id: payoutId })
    .select('id', 'partner_id', 'amount_minor', 'clawed_back_minor');
  const deductions = await trx('partner_commission_clawbacks').where({ payout_id: payoutId }).select('id', 'partner_id', 'amount_minor');
  const { lines } = buildPayoutLines(commissions, deductions);
  const oldLines = await trx('partner_payout_lines').where({ payout_id: payoutId }).select('partner_id', 'payout_hint');
  const hints = new Map(oldLines.map((l) => [l.partner_id, l.payout_hint]));
  const keptCommissions = new Set(lines.flatMap((l) => l.commissionIds));
  const keptDeductions = new Set(lines.flatMap((l) => l.deductionIds));
  const releasedCommissions = commissions.filter((c) => !keptCommissions.has(c.id)).map((c) => c.id);
  const releasedDeductions = deductions.filter((d) => !keptDeductions.has(d.id)).map((d) => d.id);
  if (releasedCommissions.length) await trx('partner_commissions').whereIn('id', releasedCommissions).update({ payout_id: null, updated_at: trx.fn.now() });
  if (releasedDeductions.length) await trx('partner_commission_clawbacks').whereIn('id', releasedDeductions).update({ payout_id: null });
  await trx('partner_payout_lines').where({ payout_id: payoutId }).del();
  await insertLines(
    trx,
    payoutId,
    lines.map((l) => ({ ...l, payoutHint: hints.get(l.partnerId) ?? {} })),
  );
  const totals = totalsOf(lines);
  await trx('partner_payouts').where({ id: payoutId }).update({
    commission_minor: totals.commission,
    deduction_minor: totals.deduction,
    total_minor: totals.total,
    line_count: lines.length,
    updated_at: trx.fn.now(),
  });
}

// ---------- Reading ----------

/** The companies whose batches the user sees in the working scope. 404 invisible unit, 403 none. */
async function payoutCompanies(req, unitId, trx = db) {
  const index = await unitsIndex(req, trx);
  const unit = index.get(unitId);
  if (!unit || !req.access.canSee(unit.path)) throw errors.notFound('Unit');
  const own = companyOf(unit, index);
  const candidates = own ? [own] : [...index.values()].filter((u) => u.type === 'company' && isWithin(u.path, unit.path));
  const companies = candidates.filter((company) => canViewPayoutsAt(req.access, company));
  if (companies.length === 0) throw errors.forbidden();
  return { companies, index };
}

/** GET /partner-payouts: newest first. */
export async function listPayouts(req, { unitId, status, cursor, limit }) {
  const { companies, index } = await payoutCompanies(req, unitId);
  const query = db('partner_payouts as po')
    .whereIn(
      'po.company_id',
      companies.map((c) => c.id),
    )
    .select('po.*', cursorAt('po.created_at'));
  if (status) query.where('po.status', status);
  newestFirst(query, { cursor, limit, createdColumn: 'po.created_at', idColumn: 'po.id' });
  const { page, nextCursor } = newestPage(await query, limit);
  const refs = await loadRefs({ userIds: page.flatMap((r) => [r.created_by, r.approved_by, r.paid_by, r.cancelled_by]) });
  return {
    data: page.map((row) => presentPayout(row, { unitsById: index, refs, can: payoutCan(req, row, index.get(row.company_id)) })),
    nextCursor,
  };
}

async function loadScopedPayout(req, id, trx = db, { forUpdate = false } = {}) {
  const query = trx('partner_payouts').where({ id }).first();
  if (forUpdate) query.forUpdate();
  const row = await query;
  if (!row) throw errors.notFound('Payout');
  const index = await unitsIndex(req, trx);
  const company = index.get(row.company_id);
  if (!company || !req.access.canSee(company.path) || !canViewPayoutsAt(req.access, company)) throw errors.notFound('Payout');
  return { row, company, index };
}

/** GET /partner-payouts/:id with one line per partner. */
export async function getPayout(req, id) {
  const { row, company, index } = await loadScopedPayout(req, id);
  const lines = await db('partner_payout_lines').where({ payout_id: id }).orderBy('net_minor', 'desc');
  const refs = await loadRefs({
    userIds: [row.created_by, row.approved_by, row.paid_by, row.cancelled_by],
    partnerIds: lines.map((l) => l.partner_id),
  });
  return {
    ...presentPayout(row, { unitsById: index, refs, can: payoutCan(req, row, company) }),
    lines: lines.map((line) => presentPayoutLine(line, { refs, currency: row.currency })),
  };
}

// ---------- Approve, pay, cancel ----------

async function transition(req, id, change) {
  await db.transaction(async (trx) => {
    const { row, company } = await loadScopedPayout(req, id, trx, { forUpdate: true });
    const { action, patch, after, payload } = await change(trx, row, company);
    await trx('partner_payouts')
      .where({ id })
      .update({ ...patch, updated_at: trx.fn.now() });
    await writeAudit(trx, req, {
      action,
      entityType: 'partner_payout',
      entityId: id,
      unit: company,
      before: { status: row.status },
      after: { status: patch.status, ...after },
      meta: { ref: row.ref },
    });
    await emitEvent(trx, {
      type: action,
      groupId: row.group_id,
      unitId: row.company_id,
      aggregateType: 'partner_payout',
      aggregateId: id,
      actorUserId: req.auth.user.id,
      payload: { payoutId: id, companyId: row.company_id, ref: row.ref, currency: row.currency, totalMinor: Number(row.total_minor), ...payload },
    });
  });
  return getPayout(req, id);
}

/** POST /partner-payouts/:id/approve: someone other than the preparer, with partners.approve_payouts. */
export function approvePayout(req, id) {
  return transition(req, id, async (_trx, row, company) => {
    if (!canAt(req.access, PERMISSIONS.approvePayouts, company)) throw errors.forbidden('Only finance approvers can approve payouts');
    if (row.status !== 'draft') throw errors.conflict(`This payout is ${row.status}; only drafts can be approved`);
    if (row.created_by === req.auth.user.id) throw errors.forbidden('Someone other than the person who prepared this payout must approve it');
    if (!(Number(row.total_minor) > 0)) throw errors.conflict('This payout has nothing to pay any more; cancel it');
    return {
      action: 'partner.payout_approved',
      patch: { status: 'approved', approved_by: req.auth.user.id, approved_at: new Date() },
      after: {},
      payload: {},
    };
  });
}

/** POST /partner-payouts/:id/mark-paid: the bank batch went out; commissions become paid. */
export function markPayoutPaid(req, id, { reference, paidAt, lines = [] }) {
  return transition(req, id, async (trx, row, company) => {
    if (!canAt(req.access, PERMISSIONS.managePayouts, company)) throw errors.forbidden();
    if (row.status !== 'approved') throw errors.conflict(`This payout is ${row.status}; approve it before marking it paid`);
    const when = paidAt ? new Date(paidAt) : new Date();
    const partnerIds = new Set((await trx('partner_payout_lines').where({ payout_id: id }).select('partner_id')).map((l) => l.partner_id));
    const issues = [];
    lines.forEach((line, i) => {
      if (!partnerIds.has(line.partnerId)) issues.push({ path: `body.lines.${i}.partnerId`, message: 'This partner isn’t in the payout' });
    });
    if (issues.length) throw errors.validation(issues);
    for (const line of lines) {
      await trx('partner_payout_lines').where({ payout_id: id, partner_id: line.partnerId }).update({ reference: line.reference, updated_at: trx.fn.now() });
    }
    await trx('partner_commissions').where({ payout_id: id, status: 'approved' }).update({ status: 'paid', paid_at: when, updated_at: trx.fn.now() });
    await trx('partner_commissions').where({ payout_id: id }).whereNot('status', 'paid').update({ paid_at: when, updated_at: trx.fn.now() });
    await trx('partner_commission_clawbacks').where({ payout_id: id }).whereNull('recovered_at').update({ recovered_at: when });
    return {
      action: 'partner.payout_paid',
      patch: { status: 'paid', reference, paid_by: req.auth.user.id, paid_at: when },
      after: { reference },
      payload: { partnerIds: [...partnerIds], paidAt: when.toISOString() },
    };
  });
}

/** POST /partner-payouts/:id/cancel: a draft or approved batch; its commissions wait for the next one. */
export function cancelPayout(req, id, { reason }) {
  return transition(req, id, async (trx, row, company) => {
    if (!canAt(req.access, PERMISSIONS.managePayouts, company)) throw errors.forbidden();
    if (row.status !== 'draft' && row.status !== 'approved') throw errors.conflict(`A ${row.status} payout can’t be cancelled`);
    const commissionIds = (await trx('partner_commissions').where({ payout_id: id }).select('id')).map((c) => c.id);
    await trx('partner_commissions').where({ payout_id: id }).update({ payout_id: null, updated_at: trx.fn.now() });
    await trx('partner_commission_clawbacks').where({ payout_id: id }).whereNull('recovered_at').update({ payout_id: null });
    // Refunds that arrived while this batch was approved were booked as deductions from a later
    // payout. The commissions are unpaid again, so those clawbacks just make them smaller instead.
    if (commissionIds.length) {
      const pending = await trx('partner_commission_clawbacks')
        .whereIn('commission_id', commissionIds)
        .where({ recovery: 'deduct' })
        .whereNull('recovered_at')
        .select('id', 'payout_id');
      if (pending.length) {
        await trx('partner_commission_clawbacks')
          .whereIn(
            'id',
            pending.map((c) => c.id),
          )
          .update({ recovery: 'netted', payout_id: null });
        for (const payoutId of new Set(pending.map((c) => c.payout_id).filter(Boolean))) await recomputeDraftPayout(trx, payoutId);
      }
    }
    return {
      action: 'partner.payout_cancelled',
      patch: { status: 'cancelled', cancelled_by: req.auth.user.id, cancelled_at: new Date(), cancel_reason: reason },
      after: { reason },
      payload: { reason },
    };
  });
}
