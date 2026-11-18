import { db } from '../../lib/db.js';
import { canViewPiiAt, levelForRecord, unitsIndex } from '../../core/crm/scope.js';
import { loadDealVisible } from './access.js';
import { companyContext, minor } from './util.js';
import {
  presentAgreement,
  presentInvoiceSummary,
  presentPayment,
  presentQuote,
  presentRefund,
  presentSubscription,
  presentInstalment,
  presentTemplate,
  usersById,
} from './present.js';

// Everything billing knows about one deal, for the deal profile's FeesPanel and AgreementPanel:
// one query per kind of record (all by deal_id, index-backed), presented with the viewer's rights.

const byCurrency = (rows, pick) => {
  const totals = new Map();
  for (const row of rows) totals.set(row.currency, (totals.get(row.currency) ?? 0) + pick(row));
  return [...totals.entries()].map(([currency, valueMinor]) => ({ valueMinor, currency }));
};

export async function dealBilling(req, dealId) {
  const { deal, unit } = await loadDealVisible(req, dealId);
  const index = await unitsIndex(req);
  const opts = { userId: req.auth.user.id, unitColumn: 'unit_id', ownerColumns: ['owner_user_id'] };
  const can = (permission) => Boolean(levelForRecord(req.access, index, permission, deal, opts));
  const dealCols = { deal_id: deal.id, deal_ref: deal.ref, deal_title: deal.title, deal_status: deal.status, deal_kind: deal.kind, deal_unit_id: deal.unit_id, deal_owner_user_id: deal.owner_user_id };
  const [quotes, payments, plans, instalments, invoices, refunds, agreements, subscriptions, templates, profile, accounts, ctx] = await Promise.all([
    db('quotes').where({ deal_id: deal.id }).orderBy('created_at', 'desc').limit(50),
    db('payments as p').leftJoin('invoices as i', 'i.id', 'p.invoice_id').where('p.deal_id', deal.id).orderBy('p.created_at', 'desc').limit(100).select('p.*', 'i.number as invoice_number'),
    db('instalment_plans').where({ deal_id: deal.id }).orderBy('created_at', 'desc').limit(20),
    db('instalments').where({ deal_id: deal.id }).orderBy([{ column: 'plan_id' }, { column: 'number' }]).limit(500),
    db('invoices').where({ deal_id: deal.id }).orderBy('created_at', 'desc').limit(100),
    db('refunds').where({ deal_id: deal.id }).orderBy('created_at', 'desc').limit(50),
    db('agreements').where({ deal_id: deal.id }).orderBy('created_at', 'desc').limit(20),
    db('subscriptions as s').join('billing_plans as bp', 'bp.id', 's.plan_id').where('s.deal_id', deal.id).orderBy('s.created_at', 'desc').limit(20).select('s.*', 'bp.name as plan_name'),
    db('agreement_templates').where({ company_id: deal.company_id, active: true }).orderBy('name').limit(100),
    db('billing_profiles').where({ company_id: deal.company_id }).first('company_id', 'gstin', 'state_code'),
    db('billing_payment_accounts').where({ company_id: deal.company_id, active: true }).select('provider', 'scope'),
    companyContext(unit),
  ]);
  const users = await usersById(db, [...quotes.flatMap((q) => [q.created_by, q.discount_requested_by, q.discount_reviewed_by]), ...payments.map((p) => p.created_by), ...refunds.flatMap((r) => [r.requested_by, r.reviewed_by]), ...agreements.map((a) => a.created_by)]);
  const today = ctx.today();
  const canViewPii = canViewPiiAt(req.access, index, [deal.unit_id]);
  const succeeded = payments.filter((p) => p.status === 'succeeded');
  const liveQuotes = quotes.filter((q) => ['sent', 'accepted'].includes(q.status));
  const missing = [];
  if (!profile) missing.push('profile');
  else if (!profile.gstin) missing.push('gstin');
  if (!accounts.some((a) => a.provider === 'razorpay')) missing.push('payment_account');
  return {
    deal: { id: deal.id, ref: deal.ref, title: deal.title, kind: deal.kind, status: deal.status, currency: deal.currency, companyId: deal.company_id, value: { valueMinor: minor(deal.value_minor), currency: deal.currency } },
    can: {
      manage: can('billing.manage'),
      finance: can('billing.finance'),
      approveDiscounts: can('billing.approve_discounts'),
      approveRefunds: can('billing.approve_refunds'),
      viewPii: canViewPii,
    },
    setup: { ready: missing.length === 0, missing },
    totals: {
      quoted: byCurrency(liveQuotes, (q) => minor(q.total_minor)),
      paid: byCurrency(succeeded, (p) => minor(p.amount_minor)),
      refunded: byCurrency(succeeded, (p) => minor(p.amount_refunded_minor)),
      due: byCurrency(instalments.filter((i) => i.status === 'pending'), (i) => minor(i.amount_minor) - minor(i.paid_minor)),
    },
    quotes: quotes.map((q) => presentQuote({ ...q, ...dealCols }, { users })),
    payments: payments.map((p) => presentPayment({ ...p, ...dealCols }, { users })),
    instalmentPlans: plans.map((plan) => ({
      id: plan.id,
      quoteId: plan.quote_id ?? null,
      status: plan.status,
      total: { valueMinor: minor(plan.total_minor), currency: plan.currency },
      count: plan.count,
      instalments: instalments.filter((i) => i.plan_id === plan.id).map((i) => presentInstalment({ ...i, ...dealCols, plan_count: plan.count }, today)),
    })),
    invoices: invoices.map((i) => presentInvoiceSummary({ ...i, ...dealCols })),
    refunds: refunds.map((r) => presentRefund({ ...r, ...dealCols }, { users })),
    agreements: agreements.map((a) => presentAgreement({ ...a, ...dealCols }, { canViewPii, users })),
    subscriptions: subscriptions.map((s) => presentSubscription({ ...s, ...dealCols })),
    templates: templates.map(presentTemplate).map(({ body: _body, ...t }) => t),
    today,
  };
}
