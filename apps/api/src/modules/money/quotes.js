import { randomUUID } from 'node:crypto';
import { db, json } from '../../lib/db.js';
import { AppError, errors } from '../../lib/errors.js';
import { writeAudit } from '../../core/audit.js';
import { emitEvent } from '../../core/events.js';
import { unitsIndex } from '../../core/crm/scope.js';
import { addDays, canApproveDiscount, evaluateDiscount, splitInstalments } from '../../core/billing/index.js';
import { currencyExponent } from '../../core/crm/money.js';
import { EDITABLE_QUOTE_STATUSES } from './constants.js';
import { loadBillingRecord, loadDealForBilling, roleKeysAt, billingLevel } from './access.js';
import { priceQuote, taxSummary } from './pricing.js';
import { supplierFrom } from './invoicing.js';
import { discountPolicyFrom } from './settings.js';
import { presentQuote, usersById } from './present.js';
import { listRecords, stateCodeForName } from './lists.js';
import { notifySafely } from './ports.js';
import { auditUnit, companyContext, dealTimeline, minor, money, nextCompanyNumber, refFor } from './util.js';

// Quotes (B2B) and fee proposals (B2C): lines from plans and price lists, GST preview, discount
// approval by the discount policy built from settings (discounts.js), validity, send, accept,
// decline. Accepting a fee proposal with an instalment option creates the instalment plan.

export const quoteNotSetUp = () => new AppError(409, 'billing_not_set_up', 'Set up billing for this company first (Settings > Billing: legal name and state)');

/**
 * The price list to price plans from when none is chosen: the company's default list in the
 * currency when it prices every plan, else the first active list in the currency that does.
 */
export async function pickPriceList(trx, companyId, currency, planIds) {
  const lists = await trx('billing_price_lists').where({ company_id: companyId, currency, active: true }).orderBy([{ column: 'is_default', order: 'desc' }, { column: 'name' }]);
  if (!lists.length) return null;
  if (!planIds.length) return lists[0];
  const prices = await trx('billing_prices').whereIn('price_list_id', lists.map((l) => l.id)).whereIn('plan_id', planIds).select('price_list_id', 'plan_id');
  return lists.find((l) => planIds.every((id) => prices.some((p) => p.price_list_id === l.id && p.plan_id === id))) ?? lists[0];
}

/** Recipient details for tax maths: the institute (B2B) or the family (B2C). No personal data is stored. */
async function defaultRecipient(trx, deal) {
  if (deal.account_id) {
    const account = await trx('accounts').where({ id: deal.account_id }).first('name', 'legal_name', 'state', 'country_code');
    if (account) {
      const outsideIndia = Boolean(account.country_code && account.country_code !== 'IN');
      return { name: account.legal_name || account.name, outsideIndia, ...(outsideIndia ? {} : { stateCode: stateCodeForName(account.state) }) };
    }
  }
  if (deal.primary_contact_id) {
    const contact = await trx('contacts').where({ id: deal.primary_contact_id }).first('display_name', 'country_code', 'address');
    if (contact) {
      const outsideIndia = Boolean(contact.country_code && contact.country_code !== 'IN');
      return { name: contact.display_name, outsideIndia, ...(outsideIndia ? {} : { stateCode: stateCodeForName(contact.address?.state) }) };
    }
  }
  return {};
}

/**
 * Turn a quote request into stored columns: resolve plans and prices, price with computeTax,
 * evaluate the discount and validate the instalment option. Pure apart from the reads.
 */
export async function buildQuote(trx, req, { deal, unit, company, input, existing = null }) {
  const ctx = await companyContext(unit, trx);
  const profile = await trx('billing_profiles').where({ company_id: company.id }).first();
  if (!profile) throw quoteNotSetUp();
  const priceListId = input.priceListId !== undefined ? input.priceListId : (existing?.price_list_id ?? null);
  let priceList = null;
  if (priceListId) {
    priceList = await trx('billing_price_lists').where({ id: priceListId }).first();
    if (!priceList || priceList.company_id !== company.id || !priceList.active) throw errors.validation([{ path: 'body.priceListId', message: 'Price list not found in this company' }]);
  }
  const currency = input.currency ?? priceList?.currency ?? existing?.currency ?? deal.currency ?? 'INR';
  const linesInput = input.lines ?? existing?.lines?.map((l) => ({ ...l, planId: l.planId ?? null })) ?? [];
  const planIds = [...new Set(linesInput.map((l) => l.planId).filter(Boolean))];
  if (!priceList) priceList = await pickPriceList(trx, company.id, currency, planIds);
  if (priceList && priceList.currency !== currency) throw errors.validation([{ path: 'body.currency', message: `The price list is in ${priceList.currency}` }]);
  const pricesIncludeTax = priceList ? priceList.prices_include_tax : true;

  const [plans, prices] = await Promise.all([
    planIds.length ? trx('billing_plans').whereIn('id', planIds) : [],
    planIds.length && priceList ? trx('billing_prices').where({ price_list_id: priceList.id }).whereIn('plan_id', planIds) : [],
  ]);
  const lines = linesInput.map((line, index) => {
    const path = `body.lines.${index}`;
    const plan = line.planId ? plans.find((p) => p.id === line.planId) : null;
    if (line.planId && (!plan || plan.company_id !== company.id)) throw errors.validation([{ path: `${path}.planId`, message: 'Plan not found in this company' }]);
    if (plan && !plan.active && !existing) throw errors.validation([{ path: `${path}.planId`, message: 'This plan is no longer sold' }]);
    const listPrice = plan ? prices.find((p) => p.plan_id === plan.id) : null;
    const unitPriceMinor = line.unitPriceMinor ?? (listPrice ? minor(listPrice.unit_amount_minor) : null);
    if (unitPriceMinor === null) throw errors.validation([{ path: `${path}.unitPriceMinor`, message: 'Enter a price: this plan has none in the price list' }]);
    const description = line.description || plan?.name;
    if (!description) throw errors.validation([{ path: `${path}.description`, message: 'Describe the line' }]);
    const quantity = line.quantity ?? 1;
    const gross = Math.round(unitPriceMinor * quantity);
    const discountMinor = line.discountMinor ?? 0;
    if (discountMinor > gross) throw errors.validation([{ path: `${path}.discountMinor`, message: 'The discount is more than the line' }]);
    return {
      id: line.id ?? randomUUID(),
      planId: plan?.id ?? null,
      description,
      sac: plan ? plan.sac : (line.sac ?? null),
      quantity,
      unitPriceMinor,
      discountMinor,
      taxRateBp: plan ? plan.tax_rate_bp : (line.taxRateBp ?? 1800),
      taxability: plan ? plan.taxability : (line.taxability ?? 'taxable'),
    };
  });

  const recipient = { ...(existing?.recipient ?? (await defaultRecipient(trx, deal))), ...(input.recipient ?? {}) };
  if (recipient.gstin && !recipient.stateCode) recipient.stateCode = recipient.gstin.slice(0, 2);
  const today = ctx.today();
  const priced = priceQuote({ lines, pricesIncludeTax, supplier: supplierFrom(profile), recipient, currency, onDate: today });

  // Discount approval (discounts.js): the policy comes from settings at the deal's unit.
  const policy = discountPolicyFrom(ctx.settings, { currencyExponent: currencyExponent(currency) });
  let decision = null;
  let discountStatus = 'none';
  if (priced.discountMinor > 0) {
    decision = evaluateDiscount({ policy, listAmountMinor: priced.subtotalMinor, discountMinor: priced.discountMinor, requesterRoles: roleKeysAt(req.access, unit.path) });
    if (decision.decision === 'not_allowed') {
      throw errors.validation([{ path: 'body.lines', message: `A ${(decision.percentBp / 100).toFixed(2)}% discount is more than the policy allows` }]);
    }
    discountStatus = decision.decision === 'allowed' ? 'allowed' : 'needs_approval';
  }

  const instalmentOption = input.instalmentOption !== undefined ? input.instalmentOption : (existing?.instalment_option ?? null);
  const instalmentPreview = instalmentOption ? previewInstalments(instalmentOption, priced.totalMinor) : null;
  const validUntil = input.validUntil ?? existing?.valid_until ?? addDays(today, ctx.settings['billing.quoteValidityDays'] ?? 14);
  if (validUntil < today) throw errors.validation([{ path: 'body.validUntil', message: 'Pick a date from today' }]);

  return {
    ctx,
    instalmentPreview,
    values: {
      price_list_id: priceList?.id ?? null,
      currency,
      prices_include_tax: pricesIncludeTax,
      lines: json(lines),
      recipient: json(recipient),
      place_of_supply_state_code: priced.result.placeOfSupplyStateCode,
      subtotal_minor: priced.subtotalMinor,
      discount_minor: priced.discountMinor,
      taxable_minor: priced.taxableMinor,
      tax_minor: priced.taxMinor,
      total_minor: priced.totalMinor,
      tax_summary: json(taxSummary(priced.result)),
      discount_status: discountStatus,
      discount_decision: decision ? json(decision) : null,
      instalment_option: instalmentOption ? json(instalmentOption) : null,
      valid_until: validUntil,
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      ...(input.terms !== undefined ? { terms: input.terms } : {}),
      ...(input.discountNote !== undefined ? { discount_note: input.discountNote } : {}),
    },
  };
}

/** The instalment schedule an option gives for a total (422 with the engine's message when it can't). */
export function previewInstalments(option, totalMinor) {
  const schedule =
    option.frequency === 'custom'
      ? { frequency: 'custom', dates: option.dates }
      : { frequency: 'monthly', startDate: option.startDate, ...(option.dayOfMonth ? { dayOfMonth: option.dayOfMonth } : {}), ...(option.intervalMonths ? { intervalMonths: option.intervalMonths } : {}) };
  try {
    return splitInstalments({ totalMinor, count: option.count, schedule, ...(option.firstAmountMinor ? { firstAmountMinor: option.firstAmountMinor } : {}) }).instalments;
  } catch (err) {
    if (err?.status === 422) {
      throw errors.validation((err.details ?? []).map((d) => ({ path: `body.instalmentOption.${String(d.path ?? '').replace(/^.*\./, '')}`, message: d.message })), err.message);
    }
    throw err;
  }
}

async function quoteCan(req, row, trx = db) {
  const [manage, approve] = await Promise.all([billingLevel(req, 'billing.manage', row, trx), billingLevel(req, 'billing.approve_discounts', row, trx)]);
  const index = await unitsIndex(req, trx);
  const unit = index.get(row.deal_unit_id);
  let canApprove = false;
  if (approve && row.status === 'pending_approval' && row.discount_decision && unit) {
    const ctx = await companyContext(unit, trx);
    canApprove = canApproveDiscount({
      policy: discountPolicyFrom(ctx.settings, { currencyExponent: currencyExponent(row.currency) }),
      decision: row.discount_decision,
      approverRoles: roleKeysAt(req.access, unit.path),
      approverUserId: req.auth.user.id,
      requesterUserId: row.discount_requested_by,
    });
  }
  const editable = EDITABLE_QUOTE_STATUSES.includes(row.status);
  return {
    edit: Boolean(manage) && editable,
    send: Boolean(manage) && (row.status === 'approved' || (row.status === 'draft' && ['none', 'allowed'].includes(row.discount_status))),
    accept: Boolean(manage) && row.status === 'sent',
    cancel: Boolean(manage) && !['accepted', 'cancelled', 'declined', 'expired'].includes(row.status),
    approveDiscount: canApprove,
  };
}

async function presentOne(req, row, trx = db) {
  const users = await usersById(trx, [row.created_by, row.discount_requested_by, row.discount_reviewed_by]);
  const option = row.instalment_option;
  return presentQuote(row, { users, can: await quoteCan(req, row, trx), instalmentPreview: option ? safePreview(option, minor(row.total_minor)) : null });
}

function safePreview(option, total) {
  try {
    return previewInstalments(option, total).map((i) => ({ number: i.number, dueDate: i.dueDate, amountMinor: i.amountMinor }));
  } catch {
    return null;
  }
}

const loadQuote = (req, id, opts = {}) => loadBillingRecord(req, 'quotes', id, { notFound: 'Quote', ...opts });

export async function getQuote(req, id) {
  return presentOne(req, await loadQuote(req, id));
}

export async function listQuotes(req, query) {
  const { page, nextCursor } = await listRecords(req, {
    table: 'quotes',
    unitId: query.unitId,
    cursor: query.cursor,
    limit: query.limit,
    filter: (q) => {
      if (query.status?.length) q.whereIn('r.status', query.status);
      if (query.kind) q.where('r.kind', query.kind);
      if (query.awaitingApproval === 'true') q.where('r.status', 'pending_approval');
    },
  });
  const users = await usersById(db, page.flatMap((r) => [r.created_by, r.discount_requested_by, r.discount_reviewed_by]));
  return { data: page.map((row) => presentQuote(row, { users })), nextCursor };
}

/** Price a quote without saving it (the form's live totals). */
export async function previewQuote(req, body) {
  const { deal, unit, company } = await loadDealForBilling(req, body.dealId, 'billing.manage');
  const built = await buildQuote(db, req, { deal, unit, company, input: body });
  const v = built.values;
  const row = {
    ...v,
    id: null,
    ref: null,
    kind: body.kind ?? (deal.kind === 'b2c' ? 'fee_proposal' : 'quote'),
    status: 'draft',
    title: body.title ?? '',
    company_id: company.id,
    lines: JSON.parse(v.lines),
    recipient: JSON.parse(v.recipient),
    tax_summary: JSON.parse(v.tax_summary),
    discount_decision: v.discount_decision ? JSON.parse(v.discount_decision) : null,
    instalment_option: v.instalment_option ? JSON.parse(v.instalment_option) : null,
  };
  return presentQuote(row, { instalmentPreview: built.instalmentPreview });
}

async function quoteEvent(trx, req, row, deal, type, extra = {}) {
  await emitEvent(trx, {
    type,
    groupId: deal.group_id,
    unitId: deal.unit_id,
    aggregateType: 'quote',
    aggregateId: row.id,
    actorUserId: req?.auth?.user?.id ?? null,
    payload: {
      quoteId: row.id,
      ref: row.ref,
      kind: row.kind,
      dealId: deal.id,
      companyId: row.company_id,
      status: row.status,
      totalMinor: minor(row.total_minor),
      discountMinor: minor(row.discount_minor),
      currency: row.currency,
      ...extra,
    },
  });
}

export async function createQuote(req, body) {
  const row = await db.transaction(async (trx) => {
    const { deal, unit, company } = await loadDealForBilling(req, body.dealId, 'billing.manage', { trx, forUpdate: true });
    const kind = body.kind ?? (deal.kind === 'b2c' ? 'fee_proposal' : 'quote');
    const built = await buildQuote(trx, req, { deal, unit, company, input: body });
    const number = await nextCompanyNumber(trx, company.id, 'quote');
    const pending = built.values.discount_status === 'needs_approval';
    const [saved] = await trx('quotes')
      .insert({
        group_id: deal.group_id,
        company_id: company.id,
        deal_id: deal.id,
        number,
        ref: refFor(built.ctx.prefix, kind === 'fee_proposal' ? 'FP' : 'Q', number),
        kind,
        status: pending ? 'pending_approval' : 'draft',
        title: body.title || `${kind === 'fee_proposal' ? 'Fee proposal' : 'Quote'} for ${deal.title}`.slice(0, 200),
        ...built.values,
        discount_requested_by: built.values.discount_status === 'none' ? null : req.auth.user.id,
        created_by: req.auth.user.id,
      })
      .returning('*');
    await writeAudit(trx, req, {
      action: 'quote.created',
      entityType: 'quote',
      entityId: saved.id,
      unit: auditUnit(deal),
      after: { ref: saved.ref, kind, totalMinor: saved.total_minor, discountMinor: saved.discount_minor, discountStatus: saved.discount_status },
    });
    await quoteEvent(trx, req, saved, deal, 'quote.created');
    if (pending) await quoteEvent(trx, req, saved, deal, 'quote.discount_requested', { approverRoles: built.values.discount_decision ? JSON.parse(built.values.discount_decision).approverRoles : [] });
    return saved;
  });
  return presentOne(req, await loadQuote(req, row.id));
}

export async function updateQuote(req, id, body) {
  await db.transaction(async (trx) => {
    const existing = await loadQuote(req, id, { permission: 'billing.manage', trx, forUpdate: true });
    if (!EDITABLE_QUOTE_STATUSES.includes(existing.status)) throw errors.conflict(`A ${existing.status} quote can't be changed: make a new one`);
    const deal = await trx('deals').where({ id: existing.deal_id }).first();
    const index = await unitsIndex(req, trx);
    const built = await buildQuote(trx, req, { deal, unit: index.get(deal.unit_id), company: index.get(existing.company_id), input: body, existing });
    const discountChanged = built.values.discount_minor !== minor(existing.discount_minor) || built.values.subtotal_minor !== minor(existing.subtotal_minor);
    const pending = built.values.discount_status === 'needs_approval';
    // A changed discount needs a new decision; an unchanged approved one stays approved.
    const keepApproval = existing.status === 'approved' && !discountChanged;
    const changes = {
      ...built.values,
      ...(body.title ? { title: body.title } : {}),
      status: keepApproval ? 'approved' : pending ? 'pending_approval' : 'draft',
      discount_status: keepApproval ? 'approved' : built.values.discount_status,
      ...(keepApproval ? {} : { discount_reviewed_by: null, discount_reviewed_at: null }),
      discount_requested_by: built.values.discount_status === 'none' ? null : discountChanged ? req.auth.user.id : existing.discount_requested_by,
      updated_at: trx.fn.now(),
    };
    const [saved] = await trx('quotes').where({ id }).update(changes).returning('*');
    await writeAudit(trx, req, {
      action: 'quote.updated',
      entityType: 'quote',
      entityId: id,
      unit: auditUnit(deal),
      before: { totalMinor: existing.total_minor, discountMinor: existing.discount_minor, status: existing.status },
      after: { totalMinor: saved.total_minor, discountMinor: saved.discount_minor, status: saved.status },
    });
    await quoteEvent(trx, req, saved, deal, 'quote.updated');
    if (pending && discountChanged) await quoteEvent(trx, req, saved, deal, 'quote.discount_requested');
  });
  return getQuote(req, id);
}

/** Approve or reject a discount waiting for approval. */
export async function reviewDiscount(req, id, { approve, note }) {
  await db.transaction(async (trx) => {
    const quote = await loadQuote(req, id, { permission: 'billing.approve_discounts', trx, forUpdate: true });
    if (quote.status !== 'pending_approval') throw errors.conflict('This quote is not waiting for a discount approval');
    const can = await quoteCan(req, quote, trx);
    if (!can.approveDiscount) throw errors.forbidden('Your role cannot approve a discount of this size');
    const deal = await trx('deals').where({ id: quote.deal_id }).first();
    const [saved] = await trx('quotes')
      .where({ id })
      .update({
        status: approve ? 'approved' : 'draft',
        discount_status: approve ? 'approved' : 'rejected',
        discount_reviewed_by: req.auth.user.id,
        discount_reviewed_at: trx.fn.now(),
        ...(note !== undefined ? { discount_note: note } : {}),
        updated_at: trx.fn.now(),
      })
      .returning('*');
    const action = approve ? 'quote.discount_approved' : 'quote.discount_rejected';
    await writeAudit(trx, req, { action, entityType: 'quote', entityId: id, unit: auditUnit(deal), after: { discountMinor: saved.discount_minor, percentBp: quote.discount_decision?.percentBp ?? null }, meta: note ? { note } : undefined });
    await quoteEvent(trx, req, saved, deal, action, { requestedBy: quote.discount_requested_by });
  });
  return getQuote(req, id);
}

export async function sendQuote(req, id) {
  const sent = await db.transaction(async (trx) => {
    const quote = await loadQuote(req, id, { permission: 'billing.manage', trx, forUpdate: true });
    const sendable = quote.status === 'approved' || (quote.status === 'draft' && ['none', 'allowed'].includes(quote.discount_status));
    if (quote.status === 'sent') return { quote, deal: null };
    if (!sendable) throw errors.conflict(quote.status === 'pending_approval' ? 'The discount is waiting for approval' : `A ${quote.status} quote can't be sent`);
    const deal = await trx('deals').where({ id: quote.deal_id }).first();
    const [saved] = await trx('quotes').where({ id }).update({ status: 'sent', sent_at: trx.fn.now(), updated_at: trx.fn.now() }).returning('*');
    await writeAudit(trx, req, { action: 'quote.sent', entityType: 'quote', entityId: id, unit: auditUnit(deal), after: { status: 'sent' } });
    await quoteEvent(trx, req, saved, deal, 'quote.sent', { validUntil: saved.valid_until });
    await dealTimeline(trx, deal, {
      kind: 'document',
      title: `${saved.kind === 'fee_proposal' ? 'Fee proposal' : 'Quote'} ${saved.ref} sent: ${money(saved.total_minor, saved.currency)}`,
      meta: { action: 'quote.sent', quoteId: id, ref: saved.ref },
      actorUserId: req.auth.user.id,
    });
    return { quote: saved, deal };
  });
  if (sent.deal) {
    await notifySafely({
      template: sent.quote.kind === 'fee_proposal' ? 'billing.fee_proposal_sent' : 'billing.quote_sent',
      companyId: sent.quote.company_id,
      dealId: sent.quote.deal_id,
      contactId: sent.deal.primary_contact_id,
      variables: { ref: sent.quote.ref, total: money(sent.quote.total_minor, sent.quote.currency), validUntil: sent.quote.valid_until },
      idempotencyKey: `quote.sent:${id}`,
    });
  }
  return getQuote(req, id);
}

/** Record the customer's acceptance. A fee proposal with an instalment option gets its plan now. */
export async function acceptQuote(req, id) {
  await db.transaction(async (trx) => {
    const quote = await loadQuote(req, id, { permission: 'billing.manage', trx, forUpdate: true });
    if (quote.status === 'accepted') return;
    if (quote.status !== 'sent') throw errors.conflict(`A ${quote.status} quote can't be accepted: send it first`);
    const deal = await trx('deals').where({ id: quote.deal_id }).first();
    const index = await unitsIndex(req, trx);
    const ctx = await companyContext(index.get(deal.unit_id), trx);
    if (quote.valid_until && quote.valid_until < ctx.today()) throw errors.conflict('This quote has expired: send a new one');
    const [saved] = await trx('quotes').where({ id }).update({ status: 'accepted', accepted_at: trx.fn.now(), updated_at: trx.fn.now() }).returning('*');
    let planId = null;
    if (saved.instalment_option) planId = await createInstalmentPlan(trx, { quote: saved, deal, actorUserId: req.auth.user.id });
    await writeAudit(trx, req, { action: 'quote.accepted', entityType: 'quote', entityId: id, unit: auditUnit(deal), after: { status: 'accepted', instalmentPlanId: planId } });
    await quoteEvent(trx, req, saved, deal, 'quote.accepted', { instalmentPlanId: planId, productIds: (saved.lines ?? []).map((l) => l.planId).filter(Boolean) });
    await dealTimeline(trx, deal, {
      kind: 'document',
      title: `${saved.kind === 'fee_proposal' ? 'Fee proposal' : 'Quote'} ${saved.ref} accepted`,
      meta: { action: 'quote.accepted', quoteId: id, ref: saved.ref, instalmentPlanId: planId },
      actorUserId: req.auth.user.id,
    });
  });
  return getQuote(req, id);
}

/** Instalment plan and instalments from an accepted quote's option (inside the caller's transaction). */
export async function createInstalmentPlan(trx, { quote, deal, actorUserId }) {
  const schedule = previewInstalments(quote.instalment_option, minor(quote.total_minor));
  const [plan] = await trx('instalment_plans')
    .insert({
      group_id: quote.group_id,
      company_id: quote.company_id,
      deal_id: quote.deal_id,
      quote_id: quote.id,
      currency: quote.currency,
      total_minor: quote.total_minor,
      count: schedule.length,
      schedule: json(quote.instalment_option),
      created_by: actorUserId,
    })
    .returning('*');
  await trx('instalments').insert(
    schedule.map((i) => ({
      plan_id: plan.id,
      group_id: quote.group_id,
      company_id: quote.company_id,
      deal_id: quote.deal_id,
      number: i.number,
      due_date: i.dueDate,
      amount_minor: i.amountMinor,
      currency: quote.currency,
    })),
  );
  await emitEvent(trx, {
    type: 'instalment_plan.created',
    groupId: deal.group_id,
    unitId: deal.unit_id,
    aggregateType: 'instalment_plan',
    aggregateId: plan.id,
    actorUserId,
    payload: { planId: plan.id, quoteId: quote.id, dealId: deal.id, companyId: quote.company_id, count: schedule.length, totalMinor: minor(quote.total_minor), currency: quote.currency },
  });
  return plan.id;
}

export async function declineQuote(req, id, { reason }) {
  return closeQuote(req, id, { status: 'declined', action: 'quote.declined', allowed: ['sent', 'approved', 'draft'], extra: { declined_at: db.fn.now(), decline_reason: reason ?? null } });
}

export async function cancelQuote(req, id) {
  return closeQuote(req, id, { status: 'cancelled', action: 'quote.cancelled', allowed: ['draft', 'pending_approval', 'approved', 'sent'] });
}

async function closeQuote(req, id, { status, action, allowed, extra = {} }) {
  await db.transaction(async (trx) => {
    const quote = await loadQuote(req, id, { permission: 'billing.manage', trx, forUpdate: true });
    if (quote.status === status) return;
    if (!allowed.includes(quote.status)) throw errors.conflict(`A ${quote.status} quote can't be ${status}`);
    const paid = await trx('payments').where({ quote_id: id }).whereIn('status', ['succeeded', 'pending', 'link_sent', 'creating']).first('id');
    if (paid) throw errors.conflict('This quote has payment links or payments: cancel the links first');
    const deal = await trx('deals').where({ id: quote.deal_id }).first();
    const [saved] = await trx('quotes').where({ id }).update({ status, ...extra, updated_at: trx.fn.now() }).returning('*');
    await writeAudit(trx, req, { action, entityType: 'quote', entityId: id, unit: auditUnit(deal), before: { status: quote.status }, after: { status } });
    await quoteEvent(trx, req, saved, deal, action);
  });
  return getQuote(req, id);
}
