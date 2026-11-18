import { db, json } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { writeAudit } from '../../core/audit.js';
import { emitEvent } from '../../core/events.js';
import { unitsIndex } from '../../core/crm/scope.js';
import { computeTax, prorateChange, termEndFor } from '../../core/billing/index.js';
import { billingLevel, loadBillingRecord, loadDealForBilling } from './access.js';
import { supplierFrom } from './invoicing.js';
import { listRecords } from './lists.js';
import { createLink } from './payments.js';
import { pickPriceList } from './quotes.js';
import { taxInputFor } from './pricing.js';
import { presentSubscription } from './present.js';
import { auditUnit, companyContext, dealTimeline, minor } from './util.js';

// B2B subscriptions: seats, students or branches on a recurring plan, monthly or annual, with
// add-ons and a renewal date (the exclusive end of the current term). The first payment activates
// a subscription; each renewal payment moves the term on by one interval. Seat changes are
// prorated by day (proration.js): upgrades are charged now, downgrades wait for renewal.

const UNIT_WORDS = { seat: ['seat', 'seats'], student: ['student', 'students'], branch: ['branch', 'branches'], flat: ['licence', 'licences'] };
const unitWord = (unit, quantity) => (UNIT_WORDS[unit] ?? UNIT_WORDS.flat)[quantity === 1 ? 0 : 1];

/** The lines one term of a subscription bills (plan line plus add-ons, at the plan's SAC and rate). */
export function subscriptionLines(subscription, plan) {
  const lines = [
    {
      id: 'plan',
      planId: plan.id,
      description: `${plan.name}: ${subscription.quantity} ${unitWord(subscription.unit, subscription.quantity)}`,
      sac: plan.sac,
      quantity: subscription.quantity,
      unitPriceMinor: minor(subscription.unit_price_minor),
      discountMinor: 0,
      taxRateBp: plan.tax_rate_bp,
      taxability: plan.taxability,
    },
  ];
  for (const [index, addon] of (subscription.addons ?? []).entries()) {
    lines.push({
      id: `addon-${index}`,
      planId: null,
      description: `${addon.name} (add-on)`,
      sac: plan.sac,
      quantity: addon.quantity,
      unitPriceMinor: addon.unitPriceMinor,
      discountMinor: 0,
      taxRateBp: plan.tax_rate_bp,
      taxability: plan.taxability,
    });
  }
  return lines;
}

async function recipientFor(trx, subscription) {
  if (!subscription.account_id) return {};
  const account = await trx('accounts').where({ id: subscription.account_id }).first('name', 'legal_name', 'country_code');
  return account ? { name: account.legal_name || account.name, outsideIndia: Boolean(account.country_code && account.country_code !== 'IN') } : {};
}

/** Invoice source and amount (incl. GST) for one term of a subscription. */
export async function subscriptionInvoiceSource(trx, subscription) {
  const [plan, profile] = await Promise.all([
    trx('billing_plans').where({ id: subscription.plan_id }).first(),
    trx('billing_profiles').where({ company_id: subscription.company_id }).first(),
  ]);
  if (!profile) throw errors.conflict('Set up billing for this company first');
  const lines = subscriptionLines(subscription, plan);
  const recipient = await recipientFor(trx, subscription);
  const today = new Date().toISOString().slice(0, 10);
  const result = computeTax(taxInputFor({ lines, pricesIncludeTax: subscription.prices_include_tax, supplier: supplierFrom(profile), recipient, currency: subscription.currency, onDate: today }));
  const period = `${subscription.current_period_start} to ${subscription.current_period_end}`;
  return {
    totalMinor: result.totals.grandTotalMinor,
    description: `${plan.name}, ${subscription.status === 'pending' ? 'first term' : 'renewal'} (${period})`,
    source: {
      lines,
      pricesIncludeTax: subscription.prices_include_tax,
      recipient,
      label: null,
      pricedTotals: result.lines.map((l) => l.totalMinor),
      totalMinor: result.totals.grandTotalMinor,
    },
  };
}

const subEvent = (trx, sub, deal, type, actorUserId, extra = {}) =>
  emitEvent(trx, {
    type,
    groupId: deal.group_id,
    unitId: deal.unit_id,
    aggregateType: 'subscription',
    aggregateId: sub.id,
    actorUserId,
    payload: {
      subscriptionId: sub.id,
      dealId: deal.id,
      companyId: sub.company_id,
      accountId: sub.account_id ?? null,
      planId: sub.plan_id,
      status: sub.status,
      quantity: sub.quantity,
      unit: sub.unit,
      interval: sub.interval,
      renewsOn: sub.current_period_end,
      ...extra,
    },
  });

/** Called by applyPaymentSuccess for a payment that carries subscription_id. */
export async function onSubscriptionPaid(trx, { payment, deal, actorUserId }) {
  if (payment.purpose !== 'subscription') return;
  const sub = await trx('subscriptions').where({ id: payment.subscription_id }).forUpdate().first();
  if (!sub || sub.status === 'cancelled') return;
  if (sub.status === 'pending') {
    const [saved] = await trx('subscriptions').where({ id: sub.id }).update({ status: 'active', updated_at: trx.fn.now() }).returning('*');
    await subEvent(trx, saved, deal, 'subscription.activated', actorUserId, { paymentId: payment.id });
    return;
  }
  // A renewal: the next term starts where this one ends, whenever the money arrives. A downgrade
  // that waited for renewal applies now.
  const change = sub.pending_change ?? null;
  const start = sub.current_period_end;
  const [saved] = await trx('subscriptions')
    .where({ id: sub.id })
    .update({
      status: 'active',
      current_period_start: start,
      current_period_end: termEndFor(start, sub.interval, 1),
      renewal_count: sub.renewal_count + 1,
      renewal_reminded_at: null,
      ...(change ? { quantity: change.quantity ?? sub.quantity, addons: json(change.addons ?? sub.addons), pending_change: null } : {}),
      updated_at: trx.fn.now(),
    })
    .returning('*');
  await subEvent(trx, saved, deal, 'subscription.renewed', actorUserId, { paymentId: payment.id, renewalCount: saved.renewal_count, periodStart: saved.current_period_start });
  await dealTimeline(trx, deal, {
    kind: 'payment',
    title: `Subscription renewed until ${saved.current_period_end}`,
    meta: { action: 'subscription.renewed', subscriptionId: saved.id },
    actorUserId,
  });
}

const loadSub = (req, id, opts = {}) =>
  loadBillingRecord(req, 'subscriptions', id, { notFound: 'Subscription', ...opts });

async function subCan(req, row) {
  const manage = await billingLevel(req, 'billing.manage', row);
  return {
    change: Boolean(manage) && ['active', 'past_due'].includes(row.status),
    cancel: Boolean(manage) && row.status !== 'cancelled',
    renew: Boolean(manage) && ['active', 'past_due'].includes(row.status),
  };
}

async function presentOne(req, id) {
  const row = await db('subscriptions as r')
    .join('deals as d', 'd.id', 'r.deal_id')
    .join('billing_plans as p', 'p.id', 'r.plan_id')
    .leftJoin('accounts as a', 'a.id', 'r.account_id')
    .where('r.id', id)
    .first(['r.*', 'p.name as plan_name', 'a.name as account_name', 'd.ref as deal_ref', 'd.title as deal_title', 'd.status as deal_status', 'd.kind as deal_kind', 'd.unit_id as deal_unit_id', 'd.owner_user_id as deal_owner_user_id']);
  const payments = await db('payments').where({ subscription_id: id }).orderBy('created_at', 'desc').limit(20).select('id', 'status', 'amount_minor', 'currency', 'purpose', 'paid_at', 'created_at');
  return {
    ...presentSubscription(row, { can: await subCan(req, row) }),
    pendingChange: row.pending_change ?? null,
    payments: payments.map((p) => ({ id: p.id, status: p.status, purpose: p.purpose, amount: { valueMinor: minor(p.amount_minor), currency: p.currency }, paidAt: p.paid_at ? new Date(p.paid_at).toISOString() : null, createdAt: new Date(p.created_at).toISOString() })),
  };
}

export async function getSubscription(req, id) {
  await loadSub(req, id);
  return presentOne(req, id);
}

export async function listSubscriptions(req, query) {
  const today = new Date().toISOString().slice(0, 10);
  const renewing = query.renewingWithinDays !== undefined;
  const { page, nextCursor } = await listRecords(req, {
    table: 'subscriptions',
    unitId: query.unitId,
    cursor: query.cursor,
    limit: query.limit,
    ...(renewing ? { sortColumn: 'current_period_end', sortOrder: 'asc' } : {}),
    select: ['p.name as plan_name', 'a.name as account_name'],
    filter: (q) => {
      q.join('billing_plans as p', 'p.id', 'r.plan_id').leftJoin('accounts as a', 'a.id', 'r.account_id');
      if (query.status?.length) q.whereIn('r.status', query.status);
      if (renewing) {
        const until = new Date(Date.now() + query.renewingWithinDays * 86_400_000).toISOString().slice(0, 10);
        q.whereIn('r.status', ['active', 'past_due']).where('r.cancel_at_period_end', false).where('r.current_period_end', '<=', until);
      }
    },
  });
  return { data: page.map((row) => presentSubscription(row, { today })), nextCursor };
}

export async function createSubscription(req, body) {
  let created;
  const id = await db.transaction(async (trx) => {
    const { deal, unit, company } = await loadDealForBilling(req, body.dealId, 'billing.manage', { trx, forUpdate: true });
    const plan = await trx('billing_plans').where({ id: body.planId }).first();
    if (!plan || plan.company_id !== company.id || !plan.active) throw errors.validation([{ path: 'body.planId', message: 'Plan not found in this company' }]);
    if (plan.kind !== 'recurring') throw errors.validation([{ path: 'body.planId', message: 'Pick a recurring plan' }]);
    let priceList = null;
    if (body.priceListId) {
      priceList = await trx('billing_price_lists').where({ id: body.priceListId }).first();
      if (!priceList || priceList.company_id !== company.id) throw errors.validation([{ path: 'body.priceListId', message: 'Price list not found in this company' }]);
    } else {
      priceList = await pickPriceList(trx, company.id, deal.currency ?? 'INR', [plan.id]);
    }
    const price = priceList ? await trx('billing_prices').where({ price_list_id: priceList.id, plan_id: plan.id }).first() : null;
    const unitPrice = body.unitPriceMinor ?? (price ? minor(price.unit_amount_minor) : null);
    if (unitPrice === null) throw errors.validation([{ path: 'body.unitPriceMinor', message: 'Enter a price: this plan has none in the price list' }]);
    const ctx = await companyContext(unit, trx);
    const start = body.startDate ?? ctx.today();
    const [sub] = await trx('subscriptions')
      .insert({
        group_id: deal.group_id,
        company_id: company.id,
        deal_id: deal.id,
        account_id: deal.account_id ?? null,
        plan_id: plan.id,
        status: 'pending',
        quantity: body.quantity,
        unit: plan.unit,
        interval: plan.interval,
        unit_price_minor: unitPrice,
        currency: priceList?.currency ?? deal.currency ?? 'INR',
        prices_include_tax: priceList ? priceList.prices_include_tax : false,
        addons: json(body.addons),
        start_date: start,
        current_period_start: start,
        current_period_end: termEndFor(start, plan.interval, 1),
        created_by: req.auth.user.id,
      })
      .returning('*');
    await writeAudit(trx, req, { action: 'subscription.created', entityType: 'subscription', entityId: sub.id, unit: auditUnit(deal), after: { planId: plan.id, quantity: sub.quantity, interval: sub.interval, unitPriceMinor: sub.unit_price_minor } });
    await subEvent(trx, sub, deal, 'subscription.created', req.auth.user.id, { unitPriceMinor: minor(sub.unit_price_minor), currency: sub.currency });
    await dealTimeline(trx, deal, {
      kind: 'document',
      title: `Subscription started: ${plan.name}, ${sub.quantity} ${unitWord(sub.unit, sub.quantity)} (${sub.interval === 'year' ? 'yearly' : 'monthly'})`,
      meta: { action: 'subscription.created', subscriptionId: sub.id },
      actorUserId: req.auth.user.id,
    });
    created = sub;
    return sub.id;
  });
  if (body.sendLink) {
    await createLink({ req, dealId: created.deal_id, body: { purpose: 'subscription', subscriptionId: id, notify: true } });
  }
  return presentOne(req, id);
}

const perTerm = (quantity, unitPrice, addons) => quantity * unitPrice + (addons ?? []).reduce((s, a) => s + a.quantity * a.unitPriceMinor, 0);

/**
 * Change seats or add-ons. Upgrades take effect now and are charged pro rata for the rest of the
 * term (a payment link for the difference plus GST); downgrades wait for renewal. preview: true
 * returns the proration without changing anything.
 */
export async function changeSubscription(req, id, body) {
  const sub = await loadSub(req, id, { permission: 'billing.manage' });
  if (!['active', 'past_due'].includes(sub.status)) throw errors.conflict(`A ${sub.status} subscription can't be changed`);
  const index = await unitsIndex(req);
  const ctx = await companyContext(index.get(sub.deal_unit_id));
  const quantity = body.quantity ?? sub.quantity;
  const addons = body.addons ?? sub.addons ?? [];
  const changeAt = body.changeDate ?? ctx.today();
  if (changeAt < sub.current_period_start || changeAt >= sub.current_period_end) {
    throw errors.validation([{ path: 'body.changeDate', message: `Pick a date in the current term (${sub.current_period_start} to ${sub.current_period_end})` }]);
  }
  const proration = prorateChange({
    termStart: sub.current_period_start,
    termEnd: sub.current_period_end,
    changeAt,
    timeZone: ctx.timeZone,
    from: { amountMinor: perTerm(sub.quantity, minor(sub.unit_price_minor), sub.addons) },
    to: { amountMinor: perTerm(quantity, minor(sub.unit_price_minor), addons) },
  });
  if (body.preview) return { proration, subscription: await presentOne(req, id) };

  const plan = await db('billing_plans').where({ id: sub.plan_id }).first();
  const deal = await db('deals').where({ id: sub.deal_id }).first();
  if (proration.netMinor > 0) {
    const line = {
      id: 'proration',
      planId: plan.id,
      description: `${plan.name}: ${quantity} ${unitWord(sub.unit, quantity)} from ${changeAt}, replacing ${sub.quantity}`,
      sac: plan.sac,
      quantity: 1,
      unitPriceMinor: proration.netMinor,
      discountMinor: 0,
      taxRateBp: plan.tax_rate_bp,
      taxability: plan.taxability,
    };
    const profile = await db('billing_profiles').where({ company_id: sub.company_id }).first();
    const recipient = await recipientFor(db, sub);
    const taxed = computeTax(taxInputFor({ lines: [line], pricesIncludeTax: false, supplier: supplierFrom(profile), recipient, currency: sub.currency, onDate: ctx.today() }));
    const target = {
      amountMinor: taxed.totals.grandTotalMinor,
      currency: sub.currency,
      description: line.description,
      quoteId: null,
      instalmentId: null,
      subscriptionId: sub.id,
      source: { lines: [line], pricesIncludeTax: false, recipient, label: null, pricedTotals: [taxed.totals.grandTotalMinor], totalMinor: taxed.totals.grandTotalMinor },
    };
    await createLink({
      req,
      dealId: sub.deal_id,
      body: { purpose: 'adjustment', notify: true },
      target,
      trxHook: async (trx) => {
        await applyChange(trx, req, { sub, deal, quantity, addons, proration, now: true });
      },
    });
  } else {
    await db.transaction(async (trx) => {
      await applyChange(trx, req, { sub, deal, quantity, addons, proration, now: proration.direction === 'none' });
    });
  }
  return { proration, subscription: await presentOne(req, id) };
}

async function applyChange(trx, req, { sub, deal, quantity, addons, proration, now }) {
  const changes = now
    ? { quantity, addons: json(addons), pending_change: null }
    : { pending_change: json({ quantity, addons, requestedBy: req.auth.user.id, requestedAt: new Date().toISOString(), effectiveOn: sub.current_period_end }) };
  const [saved] = await trx('subscriptions').where({ id: sub.id }).update({ ...changes, updated_at: trx.fn.now() }).returning('*');
  await writeAudit(trx, req, {
    action: 'subscription.updated',
    entityType: 'subscription',
    entityId: sub.id,
    unit: auditUnit(deal),
    before: { quantity: sub.quantity, addons: (sub.addons ?? []).length },
    after: { quantity, addons: addons.length, effective: now ? 'now' : 'at_renewal', netMinor: proration.netMinor },
  });
  await subEvent(trx, saved, deal, 'subscription.updated', req.auth.user.id, { fromQuantity: sub.quantity, toQuantity: quantity, effective: now ? 'now' : 'at_renewal', netMinor: proration.netMinor });
}

export async function cancelSubscription(req, id, { atPeriodEnd, reason }) {
  await db.transaction(async (trx) => {
    const sub = await loadSub(req, id, { permission: 'billing.manage', trx, forUpdate: true });
    if (sub.status === 'cancelled') return;
    const deal = await trx('deals').where({ id: sub.deal_id }).first();
    const immediate = !atPeriodEnd || sub.status === 'pending';
    const [saved] = await trx('subscriptions')
      .where({ id })
      .update(immediate ? { status: 'cancelled', cancelled_at: trx.fn.now(), cancel_reason: reason, cancel_at_period_end: false, updated_at: trx.fn.now() } : { cancel_at_period_end: true, cancel_reason: reason, updated_at: trx.fn.now() })
      .returning('*');
    if (immediate) {
      await trx('payments').where({ subscription_id: id }).whereIn('status', ['link_sent', 'failed', 'creating']).update({ status: 'cancelled', next_retry_at: null, updated_at: trx.fn.now() });
    }
    await writeAudit(trx, req, { action: immediate ? 'subscription.cancelled' : 'subscription.cancel_scheduled', entityType: 'subscription', entityId: id, unit: auditUnit(deal), after: { atPeriodEnd: !immediate }, meta: { reason } });
    await subEvent(trx, saved, deal, immediate ? 'subscription.cancelled' : 'subscription.cancel_scheduled', req.auth.user.id, { reason, effectiveOn: immediate ? null : saved.current_period_end });
    await dealTimeline(trx, deal, {
      kind: 'document',
      title: immediate ? 'Subscription cancelled' : `Subscription ends on ${saved.current_period_end}`,
      meta: { action: immediate ? 'subscription.cancelled' : 'subscription.cancel_scheduled', subscriptionId: id },
      actorUserId: req.auth.user.id,
    });
  });
  return presentOne(req, id);
}

/** Send the renewal link now (the renewal job does this automatically before the renewal date). */
export async function renewSubscription(req, id) {
  const sub = await loadSub(req, id, { permission: 'billing.manage' });
  if (!['active', 'past_due'].includes(sub.status)) throw errors.conflict(`A ${sub.status} subscription can't be renewed`);
  if (sub.cancel_at_period_end) throw errors.conflict('This subscription is set to end at the renewal date');
  await createLink({ req, dealId: sub.deal_id, body: { purpose: 'subscription', subscriptionId: id, notify: true } });
  await db('subscriptions').where({ id }).update({ renewal_reminded_at: db.fn.now() });
  return presentOne(req, id);
}

