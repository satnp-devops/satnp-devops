import { db, json } from '../../lib/db.js';
import { AppError, errors } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { env } from '../../config/env.js';
import { writeAudit } from '../../core/audit.js';
import { emitEvent } from '../../core/events.js';
import { unitsIndex } from '../../core/crm/scope.js';
import { OPEN_PAYMENT_STATUSES } from './constants.js';
import { applyBillingScope, billingLevel, billingListScope, canOnDeal, loadBillingRecord, loadDealForBilling } from './access.js';
import { addDays, zonedDateTimeToInstant } from '../../core/billing/index.js';
import { issueInvoiceForPayment } from './invoicing.js';
import { listRecords } from './lists.js';
import { notifySafely, ports } from './ports.js';
import { presentPayment, usersById } from './present.js';
import { subscriptionInvoiceSource, onSubscriptionPaid } from './subscriptions.js';
import { auditUnit, companyContext, dealTimeline, minor, money } from './util.js';

// Payment links (Razorpay for INR, Stripe for other currencies), offline payments recorded by
// finance, and what happens when a payment succeeds or fails. A link is created in two steps so
// no provider call runs inside a database transaction: the payment row is written first
// ('creating'), the provider is called, then the row is updated. Webhooks (webhooks.js) and
// offline payments both end in applyPaymentSuccess / applyPaymentFailure.

const notSetUp = (message) => new AppError(409, 'billing_not_set_up', message);

/**
 * The payment account that takes a currency for a company. INR goes to Razorpay. Other currencies
 * go to Stripe when the company has an international Stripe account (an Indian Stripe account must
 * have exports enabled: docs/providers/stripe.md), else to Razorpay when its account is enabled
 * for international payments (the docs' fallback, since Stripe India is invite-only).
 */
export async function choosePaymentAccount(trx, companyId, currency) {
  const accounts = await trx('billing_payment_accounts').where({ company_id: companyId, active: true });
  const covers = (a, scope) => a.scope === 'both' || a.scope === scope;
  if (currency === 'INR') {
    const account = accounts.find((a) => a.provider === 'razorpay' && covers(a, 'domestic'));
    if (!account) throw notSetUp('Add a Razorpay account for INR payments in Settings > Billing');
    return account;
  }
  const stripe = accounts.find((a) => a.provider === 'stripe' && covers(a, 'international') && (a.entity_country !== 'IN' || a.india_exports));
  if (stripe) return stripe;
  const razorpay = accounts.find((a) => a.provider === 'razorpay' && covers(a, 'international'));
  if (razorpay) return razorpay;
  throw notSetUp(
    `Payments in ${currency} need an international payment account: Stripe (invite-only for Indian businesses; needs exports enabled) or Razorpay with international payments. Add one in Settings > Billing.`,
  );
}

const quoteSource = (quote, { label = null } = {}) => ({
  lines: quote.lines,
  pricesIncludeTax: quote.prices_include_tax,
  recipient: quote.recipient ?? {},
  label,
  pricedTotals: (quote.lines ?? []).map((line) => quote.tax_summary?.lines?.find((l) => l.id === line.id)?.totalMinor ?? 0),
  totalMinor: minor(quote.total_minor),
});

/**
 * What a new link pays for: amount, currency, description and the invoice source.
 * Throws 422/409 for links that make no sense (nothing left to pay, wrong deal...).
 */
export async function resolvePaymentTarget(trx, req, { deal, body }) {
  const field = (name, message) => errors.validation([{ path: `body.${name}`, message }]);
  const belongs = (row) => row && row.deal_id === deal.id;
  if (body.purpose === 'instalment') {
    if (!body.instalmentId) throw field('instalmentId', 'Pick the instalment');
    const instalment = await trx('instalments').where({ id: body.instalmentId }).forUpdate().first();
    if (!belongs(instalment)) throw field('instalmentId', 'Instalment not found on this deal');
    if (instalment.status !== 'pending') throw errors.conflict(`This instalment is ${instalment.status}`);
    const plan = await trx('instalment_plans').where({ id: instalment.plan_id }).first();
    if (plan.status !== 'active') throw errors.conflict('This instalment plan is no longer active');
    const quote = plan.quote_id ? await trx('quotes').where({ id: plan.quote_id }).first() : null;
    if (!quote) throw errors.conflict('This instalment plan has no quote to invoice from');
    const label = `Instalment ${instalment.number} of ${plan.count}`;
    return {
      amountMinor: minor(instalment.amount_minor) - minor(instalment.paid_minor),
      currency: instalment.currency,
      description: body.description || `${quote.title} – ${label}`,
      quoteId: quote.id,
      instalmentId: instalment.id,
      subscriptionId: null,
      source: quoteSource(quote, { label }),
    };
  }
  if (body.purpose === 'subscription') {
    if (!body.subscriptionId) throw field('subscriptionId', 'Pick the subscription');
    const subscription = await trx('subscriptions').where({ id: body.subscriptionId }).first();
    if (!belongs(subscription)) throw field('subscriptionId', 'Subscription not found on this deal');
    if (subscription.status === 'cancelled') throw errors.conflict('This subscription is cancelled');
    const { source, totalMinor, description } = await subscriptionInvoiceSource(trx, subscription);
    return { amountMinor: totalMinor, currency: subscription.currency, description: body.description || description, quoteId: null, instalmentId: null, subscriptionId: subscription.id, source };
  }
  if (body.purpose === 'adjustment') {
    if (!(await canOnDeal(req, 'billing.finance', deal, trx))) throw errors.forbidden('Only finance can ask for an amount not tied to a quote');
    if (!body.amountMinor) throw field('amountMinor', 'Enter the amount');
    if (!body.description) throw field('description', 'Describe what the payment is for');
    const currency = body.currency ?? deal.currency ?? 'INR';
    const line = { id: 'adjustment', planId: null, description: body.description, sac: null, quantity: 1, unitPriceMinor: body.amountMinor, discountMinor: 0, taxRateBp: 1800, taxability: 'taxable' };
    return {
      amountMinor: body.amountMinor,
      currency,
      description: body.description,
      quoteId: null,
      instalmentId: null,
      subscriptionId: null,
      source: { lines: [line], pricesIncludeTax: true, recipient: {}, label: null, pricedTotals: [body.amountMinor], totalMinor: body.amountMinor },
    };
  }
  // full / emi: the quote total, less what has already been paid against it.
  if (!body.quoteId) throw field('quoteId', 'Pick the quote or fee proposal');
  const quote = await trx('quotes').where({ id: body.quoteId }).forUpdate().first();
  if (!belongs(quote)) throw field('quoteId', 'Quote not found on this deal');
  if (!['sent', 'accepted'].includes(quote.status)) throw errors.conflict(quote.status === 'pending_approval' ? 'The discount is waiting for approval' : 'Send the quote before asking for payment');
  const plan = await trx('instalment_plans').where({ quote_id: quote.id, status: 'active' }).first('id');
  if (plan) throw errors.conflict('This fee is paid in instalments: send a link for the next instalment');
  const paid = await trx('payments').where({ quote_id: quote.id, status: 'succeeded' }).sum({ total: 'amount_minor' }).first();
  const outstanding = minor(quote.total_minor) - minor(paid?.total);
  if (outstanding <= 0) throw errors.conflict('This quote is fully paid');
  return {
    amountMinor: outstanding,
    currency: quote.currency,
    description: body.description || quote.title,
    quoteId: quote.id,
    instalmentId: null,
    subscriptionId: null,
    source: quoteSource(quote, { label: outstanding < minor(quote.total_minor) ? 'Balance' : null }),
  };
}

const loadPayment = (req, id, opts = {}) =>
  loadBillingRecord(req, 'payments', id, { notFound: 'Payment', ...opts });

async function paymentCan(req, row) {
  const [manage, finance] = await Promise.all([billingLevel(req, 'billing.manage', row), billingLevel(req, 'billing.finance', row)]);
  const open = ['link_sent', 'failed', 'pending', 'error'].includes(row.status);
  return {
    cancel: Boolean(manage) && open && row.provider !== 'manual',
    resend: Boolean(manage) && (row.status === 'link_sent' || row.status === 'failed'),
    refund: Boolean(manage) && row.status === 'succeeded' && minor(row.amount_refunded_minor) < minor(row.amount_minor),
    simulate: !env.isProd && Boolean(manage) && ['link_sent', 'failed', 'pending'].includes(row.status) && row.provider !== 'manual',
    finance: Boolean(finance),
  };
}

async function presentOne(req, id) {
  const row = await loadPayment(req, id);
  const invoice = row.invoice_id ? await db('invoices').where({ id: row.invoice_id }).first('number') : null;
  const users = await usersById(db, [row.created_by]);
  return presentPayment({ ...row, invoice_number: invoice?.number ?? null }, { users, can: await paymentCan(req, row) });
}

export const getPayment = presentOne;

export async function listPayments(req, query) {
  const { page, nextCursor } = await listRecords(req, {
    table: 'payments',
    unitId: query.unitId,
    cursor: query.cursor,
    limit: query.limit,
    select: ['i.number as invoice_number'],
    filter: (q) => {
      q.leftJoin('invoices as i', 'i.id', 'r.invoice_id');
      if (query.status?.length) q.whereIn('r.status', query.status);
      if (query.provider) q.where('r.provider', query.provider);
      if (query.dealId) q.where('r.deal_id', query.dealId);
    },
  });
  const users = await usersById(db, page.map((r) => r.created_by));
  return { data: page.map((row) => presentPayment(row, { users })), nextCursor };
}

/**
 * Create a payment link (route and retry job). Step 1 writes the row, step 2 calls the provider,
 * step 3 records the link. Returns the payment id. `actor` is { req } or { actorUserId }.
 */
export async function createLink({ req = null, dealId, body, retryOf = null, actorUserId = null, target: presetTarget = null, trxHook = null }) {
  const actor = req?.auth?.user?.id ?? actorUserId;
  const prepared = await db.transaction(async (trx) => {
    let deal;
    let company;
    if (req) {
      ({ deal, company } = await loadDealForBilling(req, dealId, 'billing.manage', { trx, forUpdate: true }));
    } else {
      deal = await trx('deals').where({ id: dealId }).forUpdate().first();
      company = { id: deal.company_id, root_id: deal.group_id };
    }
    if (body.idempotencyKey) {
      const existing = await trx('payments').where({ company_id: company.id, idempotency_key: body.idempotencyKey }).first('id', 'deal_id');
      if (existing) {
        if (existing.deal_id !== deal.id) throw errors.conflict('This idempotency key was used for another deal');
        return { existingId: existing.id };
      }
    }
    const target = presetTarget ?? (await resolvePaymentTarget(trx, req, { deal, company, body }));
    // One open link per thing paid for: asking again returns the link already sent.
    const open = await trx('payments')
      .where({ deal_id: deal.id, purpose: body.purpose, quote_id: target.quoteId, instalment_id: target.instalmentId, subscription_id: target.subscriptionId })
      .whereIn('status', ['creating', 'link_sent', 'pending'])
      .where((q) => q.whereNull('expires_at').orWhere('expires_at', '>', trx.fn.now()))
      .modify((q) => {
        if (body.purpose === 'adjustment') q.whereRaw('false');
      })
      .first('id', 'amount_minor');
    if (open && minor(open.amount_minor) === target.amountMinor) return { existingId: open.id };
    if (open) throw errors.conflict('An earlier link for this is still open: cancel it before sending a new amount');
    const account = await choosePaymentAccount(trx, company.id, target.currency);
    const index = req ? await unitsIndex(req, trx) : null;
    const unit = index ? index.get(deal.unit_id) : await trx('org_units').where({ id: deal.unit_id }).first();
    const ctx = await companyContext(unit, trx);
    const expiresAt = new Date(Date.now() + (ctx.settings['billing.paymentLinkExpiryDays'] ?? 15) * 86_400_000);
    const [payment] = await trx('payments')
      .insert({
        group_id: deal.group_id,
        company_id: company.id,
        deal_id: deal.id,
        quote_id: target.quoteId,
        instalment_id: target.instalmentId,
        subscription_id: target.subscriptionId,
        purpose: body.purpose,
        provider: account.provider,
        account_id: account.id,
        status: 'creating',
        amount_minor: target.amountMinor,
        currency: target.currency,
        description: target.description.slice(0, 250),
        expires_at: expiresAt,
        idempotency_key: body.idempotencyKey ?? null,
        invoice_source: json(target.source),
        attempt: retryOf ? retryOf.attempt + 1 : 1,
        retry_of_id: retryOf?.id ?? null,
        created_by: actor,
      })
      .returning('*');
    await writeAudit(trx, req, {
      action: 'payment.link_requested',
      entityType: 'payment',
      entityId: payment.id,
      unit: auditUnit(deal),
      groupId: deal.group_id,
      actorUserId: actor,
      after: { amountMinor: payment.amount_minor, currency: payment.currency, purpose: payment.purpose, provider: payment.provider },
    });
    if (trxHook) await trxHook(trx, payment);
    return { payment, deal, account };
  });
  if (prepared.existingId) return prepared.existingId;

  const { payment, deal, account } = prepared;
  const customerName = await customerNameFor(deal);
  let link;
  try {
    const gateway = await ports.paymentGateway({ companyId: payment.company_id, provider: account.provider, account });
    link = await gateway.createPaymentLink({
      paymentId: payment.id,
      companyId: payment.company_id,
      amountMinor: minor(payment.amount_minor),
      currency: payment.currency,
      description: payment.description,
      purpose: payment.purpose,
      emi: payment.purpose === 'emi',
      customer: { name: customerName },
      expiresAt: Math.floor(new Date(payment.expires_at).getTime() / 1000),
      callbackUrl: `${env.APP_URL}/pay/done`,
    });
  } catch (err) {
    await db('payments')
      .where({ id: payment.id })
      .update({ status: 'error', failure: json({ code: err.code ?? 'provider_error', message: err.message?.slice(0, 300) ?? null }), updated_at: db.fn.now() });
    logger.warn({ paymentId: payment.id, provider: account.provider, code: err.code }, 'money: payment link not created');
    throw err;
  }

  await db.transaction(async (trx) => {
    const [saved] = await trx('payments')
      .where({ id: payment.id })
      .update({ status: 'link_sent', provider_link_id: link.linkId, provider_order_id: link.orderId ?? null, link_url: link.url, updated_at: trx.fn.now() })
      .returning('*');
    await emitEvent(trx, {
      type: 'payment.link_created',
      groupId: deal.group_id,
      unitId: deal.unit_id,
      aggregateType: 'payment',
      aggregateId: saved.id,
      actorUserId: actor,
      payload: paymentPayload(saved, deal),
    });
    await dealTimeline(trx, deal, {
      kind: 'payment',
      title: `Payment link sent: ${money(saved.amount_minor, saved.currency)}${saved.purpose === 'instalment' ? ' (instalment)' : ''}`,
      meta: { action: 'payment.link_created', paymentId: saved.id, provider: saved.provider },
      actorUserId: actor,
    });
  });
  if (body.notify !== false) {
    await notifySafely({
      template: retryOf ? 'billing.payment_retry' : 'billing.payment_link',
      companyId: payment.company_id,
      dealId: deal.id,
      contactId: deal.primary_contact_id,
      variables: { amount: money(payment.amount_minor, payment.currency), url: link.url, description: payment.description },
      idempotencyKey: `payment.link:${payment.id}`,
    });
  }
  return payment.id;
}

async function customerNameFor(deal) {
  if (deal.account_id) return (await db('accounts').where({ id: deal.account_id }).first('name'))?.name ?? null;
  if (deal.primary_contact_id) return (await db('contacts').where({ id: deal.primary_contact_id }).first('display_name'))?.display_name ?? null;
  return null;
}

export const paymentPayload = (payment, deal, extra = {}) => ({
  paymentId: payment.id,
  dealId: deal.id,
  companyId: payment.company_id,
  quoteId: payment.quote_id ?? null,
  instalmentId: payment.instalment_id ?? null,
  subscriptionId: payment.subscription_id ?? null,
  purpose: payment.purpose,
  provider: payment.provider,
  amountMinor: minor(payment.amount_minor),
  currency: payment.currency,
  ...extra,
});

export async function createPaymentLink(req, body) {
  const id = await createLink({ req, dealId: body.dealId, body });
  return presentOne(req, id);
}

export async function cancelPayment(req, id) {
  const payment = await loadPayment(req, id, { permission: 'billing.manage' });
  if (!['link_sent', 'failed', 'pending', 'error', 'creating'].includes(payment.status)) throw errors.conflict(`A ${payment.status} payment can't be cancelled`);
  if (payment.provider === 'manual') throw errors.conflict('Offline payments are not links');
  if (payment.provider_link_id) {
    const account = payment.account_id ? await db('billing_payment_accounts').where({ id: payment.account_id }).first() : null;
    const gateway = await ports.paymentGateway({ companyId: payment.company_id, provider: payment.provider, account });
    await gateway.cancelPaymentLink(payment.provider_link_id);
  }
  await db.transaction(async (trx) => {
    const row = await trx('payments').where({ id }).forUpdate().first();
    if (row.status === 'succeeded') throw errors.conflict('This payment went through while cancelling: refund it instead');
    const deal = await trx('deals').where({ id: row.deal_id }).first();
    const [saved] = await trx('payments').where({ id }).update({ status: 'cancelled', next_retry_at: null, updated_at: trx.fn.now() }).returning('*');
    await writeAudit(trx, req, { action: 'payment.cancelled', entityType: 'payment', entityId: id, unit: auditUnit(deal), before: { status: row.status }, after: { status: 'cancelled' } });
    await emitEvent(trx, { type: 'payment.cancelled', groupId: deal.group_id, unitId: deal.unit_id, aggregateType: 'payment', aggregateId: id, actorUserId: req.auth.user.id, payload: paymentPayload(saved, deal) });
  });
  return presentOne(req, id);
}

/** Send the open link again (the family lost the message). */
export async function resendPayment(req, id) {
  const payment = await loadPayment(req, id, { permission: 'billing.manage' });
  if (!['link_sent', 'failed'].includes(payment.status) || !payment.link_url) throw errors.conflict('This payment has no open link');
  if (payment.expires_at && new Date(payment.expires_at) < new Date()) throw errors.conflict('The link has expired: send a new one');
  const deal = await db('deals').where({ id: payment.deal_id }).first();
  await notifySafely({
    template: 'billing.payment_link',
    companyId: payment.company_id,
    dealId: deal.id,
    contactId: deal.primary_contact_id,
    variables: { amount: money(payment.amount_minor, payment.currency), url: payment.link_url, description: payment.description },
    idempotencyKey: `payment.resend:${payment.id}:${Date.now()}`,
  });
  await db.transaction(async (trx) => {
    await writeAudit(trx, req, { action: 'payment.link_resent', entityType: 'payment', entityId: id, unit: auditUnit(deal) });
  });
  return presentOne(req, id);
}

/** Finance records money received outside a gateway (bank transfer, cheque, cash). */
export async function recordManualPayment(req, body) {
  const paymentId = await db.transaction(async (trx) => {
    const { deal, company } = await loadDealForBilling(req, body.dealId, 'billing.finance', { trx, forUpdate: true });
    const purpose = body.instalmentId ? 'instalment' : body.subscriptionId ? 'subscription' : body.quoteId ? 'full' : 'adjustment';
    const target = await resolvePaymentTarget(trx, req, { deal, company, body: { ...body, purpose, description: body.description ?? (purpose === 'adjustment' ? `Payment ${body.reference}` : undefined) } });
    if (body.amountMinor > target.amountMinor && purpose !== 'adjustment') {
      throw errors.validation([{ path: 'body.amountMinor', message: `Only ${money(target.amountMinor, target.currency)} is due` }]);
    }
    if (body.currency && body.currency !== target.currency) throw errors.validation([{ path: 'body.currency', message: `This is billed in ${target.currency}` }]);
    const [payment] = await trx('payments')
      .insert({
        group_id: deal.group_id,
        company_id: company.id,
        deal_id: deal.id,
        quote_id: target.quoteId,
        instalment_id: target.instalmentId,
        subscription_id: target.subscriptionId,
        purpose,
        provider: 'manual',
        status: 'pending',
        amount_minor: body.amountMinor,
        currency: target.currency,
        description: target.description.slice(0, 250),
        provider_payment_id: body.reference,
        invoice_source: json(target.source),
        idempotency_key: `manual:${body.reference}`,
        created_by: req.auth.user.id,
      })
      .onConflict(db.raw('(company_id, idempotency_key) where idempotency_key is not null'))
      .ignore()
      .returning('*');
    if (!payment) throw errors.conflict('A payment with this reference is already recorded');
    await writeAudit(trx, req, {
      action: 'payment.recorded',
      entityType: 'payment',
      entityId: payment.id,
      unit: auditUnit(deal),
      after: { amountMinor: payment.amount_minor, currency: payment.currency, method: body.method, reference: body.reference },
    });
    await applyPaymentSuccess(trx, payment, { deal, method: body.method, providerPaymentId: body.reference, paidAt: body.paidAt ?? new Date().toISOString(), actorUserId: req.auth.user.id, req });
    return payment.id;
  });
  return presentOne(req, paymentId);
}

/**
 * A payment went through (webhook or offline). Inside the caller's transaction, with the payment
 * row locked: mark it paid, settle the instalment or subscription, accept a quote that was only
 * sent, issue the GST invoice (in a savepoint: billing not set up leaves invoice_error instead of
 * losing the payment), emit payment.succeeded and write the timeline entry.
 */
export async function applyPaymentSuccess(trx, payment, { deal, method = null, providerPaymentId = null, paidAt, feeMinor = null, taxMinor = null, sourceEventId = null, actorUserId = null, req = null }) {
  const [saved] = await trx('payments')
    .where({ id: payment.id })
    .update({
      status: 'succeeded',
      paid_at: paidAt,
      method,
      provider_payment_id: providerPaymentId ?? payment.provider_payment_id,
      fee_minor: feeMinor,
      provider_tax_minor: taxMinor,
      failure: null,
      next_retry_at: null,
      updated_at: trx.fn.now(),
    })
    .returning('*');
  const amount = minor(saved.amount_minor);
  let instalmentPlanCompleted = false;
  if (saved.instalment_id) {
    const [instalment] = await trx('instalments')
      .where({ id: saved.instalment_id })
      .update({
        paid_minor: trx.raw('least(amount_minor, paid_minor + ?)', [amount]),
        status: trx.raw("case when paid_minor + ? >= amount_minor then 'paid' else status end", [amount]),
        paid_at: trx.raw('case when paid_minor + ? >= amount_minor then ?::timestamptz else paid_at end', [amount, paidAt]),
        updated_at: trx.fn.now(),
      })
      .returning(['plan_id']);
    const left = await trx('instalments').where({ plan_id: instalment.plan_id, status: 'pending' }).first('id');
    if (!left) {
      await trx('instalment_plans').where({ id: instalment.plan_id, status: 'active' }).update({ status: 'completed', updated_at: trx.fn.now() });
      instalmentPlanCompleted = true;
    }
  }
  if (saved.quote_id) {
    const [accepted] = await trx('quotes').where({ id: saved.quote_id, status: 'sent' }).update({ status: 'accepted', accepted_at: trx.fn.now(), updated_at: trx.fn.now() }).returning('*');
    if (accepted) {
      await emitEvent(trx, {
        type: 'quote.accepted',
        groupId: deal.group_id,
        unitId: deal.unit_id,
        aggregateType: 'quote',
        aggregateId: accepted.id,
        actorUserId,
        payload: { quoteId: accepted.id, ref: accepted.ref, kind: accepted.kind, dealId: deal.id, companyId: accepted.company_id, status: 'accepted', totalMinor: minor(accepted.total_minor), currency: accepted.currency, byPayment: true },
      });
    }
  }
  if (saved.subscription_id) await onSubscriptionPaid(trx, { payment: saved, deal, actorUserId });

  let invoice = null;
  try {
    const unit = await trx('org_units').where({ id: deal.unit_id }).first();
    const ctx = await companyContext(unit, trx);
    invoice = await trx.transaction((sp) =>
      issueInvoiceForPayment(sp, { payment: saved, deal, source: saved.invoice_source, timeZone: ctx.timeZone, issueDate: ctx.today(), req, actorUserId }),
    );
  } catch (err) {
    if (err?.code !== 'billing_not_set_up' && err?.status !== 409) throw err;
    await trx('payments').where({ id: saved.id }).update({ invoice_error: err.message.slice(0, 300) });
    logger.warn({ paymentId: saved.id, reason: err.message }, 'money: payment recorded without an invoice');
  }

  const fullyPaid = await quoteFullyPaid(trx, saved);
  await emitEvent(trx, {
    type: 'payment.succeeded',
    groupId: deal.group_id,
    unitId: deal.unit_id,
    aggregateType: 'payment',
    aggregateId: saved.id,
    actorUserId,
    payload: paymentPayload(saved, deal, { method, invoiceId: invoice?.id ?? null, quoteFullyPaid: fullyPaid, instalmentPlanCompleted, paidAt: new Date(paidAt).toISOString() }),
  });
  await dealTimeline(trx, deal, {
    kind: 'payment',
    title: `Payment received: ${money(amount, saved.currency)}${method ? ` by ${method.replace('_', ' ')}` : ''}${invoice ? ` · invoice ${invoice.number}` : ''}`,
    meta: { action: 'payment.succeeded', paymentId: saved.id, invoiceId: invoice?.id ?? null, provider: saved.provider },
    actorUserId,
    actorType: actorUserId ? 'user' : 'system',
    sourceEventId,
  });
  return { payment: saved, invoice };
}

async function quoteFullyPaid(trx, payment) {
  if (!payment.quote_id) return null;
  const quote = await trx('quotes').where({ id: payment.quote_id }).first('total_minor');
  const paid = await trx('payments').where({ quote_id: payment.quote_id, status: 'succeeded' }).sum({ total: 'amount_minor' }).first();
  return minor(paid?.total) >= minor(quote.total_minor);
}

/** A payment attempt failed. The link usually stays open; the retry job reminds per settings. */
export async function applyPaymentFailure(trx, payment, { deal, failure, sourceEventId = null }) {
  const unit = await trx('org_units').where({ id: deal.unit_id }).first();
  const ctx = await companyContext(unit, trx);
  const schedule = ctx.settings['billing.paymentRetryHours'] ?? [];
  const failures = (payment.failure?.count ?? 0) + 1;
  const reminders = payment.failure?.reminders ?? 0;
  const hours = schedule[reminders];
  // The schedule counts from the failure; a second failure before the reminder keeps the first plan.
  const nextRetryAt = payment.next_retry_at ?? (hours ? new Date(Date.now() + hours * 3_600_000) : null);
  const [saved] = await trx('payments')
    .where({ id: payment.id })
    .update({ status: 'failed', failed_at: trx.fn.now(), failure: json({ ...(failure ?? {}), count: failures, reminders }), next_retry_at: nextRetryAt, updated_at: trx.fn.now() })
    .returning('*');
  await emitEvent(trx, {
    type: 'payment.failed',
    groupId: deal.group_id,
    unitId: deal.unit_id,
    aggregateType: 'payment',
    aggregateId: saved.id,
    actorUserId: null,
    payload: paymentPayload(saved, deal, { failureCode: failure?.code ?? null, retryAt: nextRetryAt?.toISOString() ?? null, failures }),
  });
  await dealTimeline(trx, deal, {
    kind: 'payment',
    title: `Payment failed: ${money(saved.amount_minor, saved.currency)}${failure?.message ? ` (${failure.message.slice(0, 120)})` : ''}`,
    meta: { action: 'payment.failed', paymentId: saved.id, code: failure?.code ?? null },
    sourceEventId,
  });
  return saved;
}

/** Overview counts for the Fees and billing page, one query per figure, all index-backed. */
export async function billingOverview(req, unitId) {
  const scope = await billingListScope(req, 'billing.view', unitId);
  const unit = scope.unit;
  const ctx = await companyContext(unit);
  const today = ctx.today();
  const monthStart = `${today.slice(0, 7)}-01`;
  const scoped = (table) => applyBillingScope(db(`${table} as r`).join('deals as d', 'd.id', 'r.deal_id'), scope, 'r');
  const [collected, overdue, dueSoon, refunds, agreements, approvals, failed] = await Promise.all([
    scoped('payments').where('r.status', 'succeeded').where('r.paid_at', '>=', zonedDateTimeToInstant(monthStart, ctx.timeZone, '00:00:00')).groupBy('r.currency').select('r.currency').sum({ total: 'r.amount_minor' }).count({ count: '*' }),
    scoped('instalments').where('r.status', 'pending').where('r.due_date', '<', today).count({ count: '*' }).first(),
    scoped('instalments').where('r.status', 'pending').whereBetween('r.due_date', [today, addDays(today, 7)]).count({ count: '*' }).first(),
    scoped('refunds').where('r.status', 'requested').count({ count: '*' }).first(),
    scoped('agreements').whereIn('r.status', ['sent', 'partially_signed']).count({ count: '*' }).first(),
    scoped('quotes').where('r.status', 'pending_approval').count({ count: '*' }).first(),
    scoped('payments').where('r.status', 'failed').count({ count: '*' }).first(),
  ]);
  return {
    collectedThisMonth: collected.map((c) => ({ valueMinor: minor(c.total), currency: c.currency, count: Number(c.count) })),
    instalmentsOverdue: Number(overdue.count),
    instalmentsDueThisWeek: Number(dueSoon.count),
    refundsAwaitingApproval: Number(refunds.count),
    agreementsAwaitingSignature: Number(agreements.count),
    discountsAwaitingApproval: Number(approvals.count),
    failedPayments: Number(failed.count),
    canApproveRefunds: req.access.canAnywhereWithin('billing.approve_refunds', unit.path),
  };
}


export { OPEN_PAYMENT_STATUSES };
