import { db } from '../../lib/db.js';
import { maskEmail, maskPhone } from '../../core/crm/pii.js';
import { minorFromDb } from '../../core/crm/money.js';
import { presentPayoutHint } from './payoutDetails.js';
import { maskName, partnerLeadStatus, payableMinor, shareUrl } from './rules.js';

// Row → API shapes (apps/web/src/lib/partners/types.ts). Related rows are loaded once per page
// with loadRefs (one whereIn query per relation), never per row.

const iso = (value) => (value instanceof Date ? value.toISOString() : (value ?? null));
const money = (minor, currency) => ({ valueMinor: minorFromDb(minor), currency });
const uniq = (values) => [...new Set(values.filter(Boolean))];

export const unitRef = (unit) => (unit ? { id: unit.id, name: unit.name, type: unit.type } : null);
export const companyRef = (unit) => (unit ? { id: unit.id, name: unit.name, code: unit.code } : null);

/**
 * Load the rows a page refers to, one query per kind.
 * @returns {Promise<{ users: Map, productLines: Map, plans: Map, deals: Map, partners: Map, payouts: Map, contacts: Map }>}
 */
export async function loadRefs({ userIds = [], productLineIds = [], planIds = [], dealIds = [], partnerIds = [], payoutIds = [], contactIds = [] }, trx = db) {
  const fetch = (ids, query) => (ids.length ? query(ids) : Promise.resolve([]));
  const [users, productLines, plans, deals, partners, payouts, contacts] = await Promise.all([
    fetch(uniq(userIds), (ids) => trx('users').whereIn('id', ids).select('id', 'name', 'email', 'status')),
    fetch(uniq(productLineIds), (ids) => trx('product_lines').whereIn('id', ids).select('id', 'name', 'key')),
    fetch(uniq(planIds), (ids) => trx('commission_plans').whereIn('id', ids).select('id', 'name', 'basis', 'rate_bps', 'fixed_minor', 'currency', 'trigger')),
    fetch(uniq(dealIds), (ids) =>
      trx('deals').whereIn('id', ids).select('id', 'ref', 'title', 'status', 'unit_id', 'owner_user_id', 'company_id', 'primary_contact_id', 'product_line_id'),
    ),
    fetch(uniq(partnerIds), (ids) => trx('partners').whereIn('id', ids).select('id', 'name', 'kind')),
    fetch(uniq(payoutIds), (ids) => trx('partner_payouts').whereIn('id', ids).select('id', 'ref', 'status')),
    fetch(uniq(contactIds), (ids) => trx('contacts').whereIn('id', ids).select('id', 'display_name', 'primary_phone', 'erased_at')),
  ]);
  const byId = (rows) => new Map(rows.map((row) => [row.id, row]));
  return {
    users: byId(users),
    productLines: byId(productLines),
    plans: byId(plans),
    deals: byId(deals),
    partners: byId(partners),
    payouts: byId(payouts),
    contacts: byId(contacts),
  };
}

const userRef = (refs, id) => {
  const user = id ? refs.users.get(id) : null;
  return user ? { id: user.id, name: user.name } : null;
};
const productLineRef = (refs, id) => {
  const line = id ? refs.productLines.get(id) : null;
  return line ? { id: line.id, name: line.name } : null;
};
const partnerRef = (refs, id) => {
  const partner = refs.partners.get(id);
  return partner ? { id: partner.id, name: partner.name, kind: partner.kind } : { id, name: 'Partner', kind: 'person' };
};

// ---------- Partners ----------

export function presentPartnerLink(link, { unitsById, refs }) {
  const plan = link.commission_plan_id ? refs.plans.get(link.commission_plan_id) : null;
  return {
    id: link.id,
    company: companyRef(unitsById.get(link.company_id)),
    unit: unitRef(unitsById.get(link.unit_id)),
    owner: userRef(refs, link.owner_user_id),
    status: link.status,
    commissionPlan: plan ? { id: plan.id, name: plan.name } : null,
    joinedAt: iso(link.joined_at),
    endedAt: iso(link.ended_at),
  };
}

/**
 * PartnerSummary. `links` are the company links the viewer can see; `hasPortalAccess` says whether
 * the partner's portal sign-in covers any of them (service.js works it out from the role units).
 */
export function presentPartner(partner, { links, unitsById, refs, canViewPii, hasPortalAccess = false }) {
  return {
    id: partner.id,
    kind: partner.kind,
    name: partner.name,
    code: partner.code ?? null,
    legalName: partner.legal_name ?? null,
    city: partner.city ?? null,
    email: canViewPii ? (partner.email ?? null) : maskEmail(partner.email),
    phone: canViewPii ? (partner.phone ?? null) : maskPhone(partner.phone),
    piiMasked: !canViewPii,
    companies: links.map((link) => presentPartnerLink(link, { unitsById, refs })),
    hasPortalAccess: Boolean(partner.user_id) && hasPortalAccess,
    payout: presentPayoutHint(partner.payout_hint),
    createdAt: iso(partner.created_at),
    updatedAt: iso(partner.updated_at),
  };
}

// ---------- Plans ----------

export function presentPlan(plan, { unitsById, refs }) {
  return {
    id: plan.id,
    companyId: plan.company_id,
    company: companyRef(unitsById.get(plan.company_id)),
    productLine: productLineRef(refs, plan.product_line_id),
    name: plan.name,
    description: plan.description ?? null,
    basis: plan.basis,
    rateBps: plan.rate_bps ?? null,
    fixed: plan.basis === 'fixed' ? money(plan.fixed_minor, plan.currency) : null,
    currency: plan.currency ?? null,
    trigger: plan.trigger,
    clawbackDays: plan.clawback_days,
    cap: plan.cap_minor != null ? money(plan.cap_minor, plan.currency) : null,
    active: plan.active,
    position: plan.position,
    createdAt: iso(plan.created_at),
    updatedAt: iso(plan.updated_at),
  };
}

// ---------- Referral links ----------

export function presentReferralLink(link, { unitsById, refs, defaultLandingUrls = new Map(), leadCounts = new Map() }) {
  const landingUrl = link.landing_url ?? defaultLandingUrls.get(link.company_id) ?? null;
  return {
    id: link.id,
    code: link.code,
    label: link.label ?? null,
    partner: partnerRef(refs, link.partner_id),
    company: companyRef(unitsById.get(link.company_id)),
    productLine: productLineRef(refs, link.product_line_id),
    landingUrl: link.landing_url ?? null,
    shareUrl: shareUrl({ landingUrl, code: link.code, utm: link.utm }),
    utm: link.utm ?? {},
    active: link.active,
    createdByPartner: link.created_by_partner === true,
    leadCount: leadCounts.get(link.id) ?? 0,
    createdAt: iso(link.created_at),
    deactivatedAt: iso(link.deactivated_at),
  };
}

// ---------- Deals as staff see them from partner records ----------

/**
 * DealRef for a deal seen from a partner record. The title names the family, so it is only shown
 * when the viewer can see the deal itself; otherwise just the reference and status.
 */
function dealRef(refs, dealId, visibleDealIds) {
  const deal = refs.deals.get(dealId);
  if (!deal) return { id: dealId, ref: '', title: null, status: 'open', visible: false };
  const visible = visibleDealIds.has(deal.id);
  return { id: deal.id, ref: deal.ref, title: visible ? deal.title : null, status: deal.status, visible };
}

export function presentAttribution(row, { unitsById, refs, visibleDealIds, piiUnitIds }) {
  const contact = row.contact_id ? refs.contacts.get(row.contact_id) : null;
  const deal = refs.deals.get(row.deal_id);
  const canViewPii = deal ? piiUnitIds.has(deal.unit_id) : false;
  const visible = visibleDealIds.has(row.deal_id);
  return {
    id: row.id,
    touch: row.touch,
    bothTouches: row.both_touches === true,
    source: row.source,
    code: row.code ?? null,
    partner: partnerRef(refs, row.partner_id),
    company: companyRef(unitsById.get(row.company_id)),
    deal: dealRef(refs, row.deal_id, visibleDealIds),
    contact:
      contact && visible
        ? {
            id: contact.id,
            displayName: contact.display_name,
            primaryPhone: canViewPii ? (contact.primary_phone ?? null) : maskPhone(contact.primary_phone),
            piiMasked: !canViewPii,
          }
        : null,
    referralLinkId: row.referral_link_id ?? null,
    touchedAt: iso(row.touched_at),
    createdAt: iso(row.created_at),
  };
}

// ---------- Commissions ----------

export function presentCommission(row, { unitsById, refs, visibleDealIds, canApprove = false }) {
  const plan = refs.plans.get(row.plan_id);
  const payout = row.payout_id ? refs.payouts.get(row.payout_id) : null;
  return {
    id: row.id,
    status: row.status,
    partner: partnerRef(refs, row.partner_id),
    company: companyRef(unitsById.get(row.company_id)),
    deal: dealRef(refs, row.deal_id, visibleDealIds),
    plan: plan ? { id: plan.id, name: plan.name } : { id: row.plan_id, name: row.plan_snapshot?.name ?? 'Plan' },
    trigger: row.trigger,
    basis: row.basis,
    rateBps: row.rate_bps ?? null,
    base: money(row.base_minor, row.base_currency),
    amount: money(row.amount_minor, row.currency),
    clawedBack: money(row.clawed_back_minor, row.currency),
    payable: money(payableMinor(row), row.currency),
    paymentId: row.payment_id,
    earnedAt: iso(row.earned_at),
    clawbackUntil: iso(row.clawback_until),
    approvedAt: iso(row.approved_at),
    approvedBy: userRef(refs, row.approved_by),
    rejectedAt: iso(row.rejected_at),
    rejectionReason: row.rejection_reason ?? null,
    payout: payout ? { id: payout.id, ref: payout.ref, status: payout.status } : null,
    paidAt: iso(row.paid_at),
    clawedBackAt: iso(row.clawed_back_at),
    createdAt: iso(row.created_at),
    can: { approve: canApprove && row.status === 'pending' },
  };
}

export function presentClawback(row) {
  return {
    id: row.id,
    refundId: row.refund_id,
    amount: money(row.amount_minor, row.currency),
    recovery: row.recovery,
    payoutId: row.payout_id ?? null,
    recoveredAt: iso(row.recovered_at),
    refundedAt: iso(row.refunded_at),
    createdAt: iso(row.created_at),
  };
}

// ---------- Payouts ----------

export function presentPayout(row, { unitsById, refs, can = { approve: false, markPaid: false, cancel: false } }) {
  return {
    id: row.id,
    ref: row.ref,
    company: companyRef(unitsById.get(row.company_id)),
    periodStart: row.period_start,
    periodEnd: row.period_end,
    currency: row.currency,
    status: row.status,
    commission: money(row.commission_minor, row.currency),
    deductions: money(row.deduction_minor, row.currency),
    total: money(row.total_minor, row.currency),
    lineCount: row.line_count,
    reference: row.reference ?? null,
    notes: row.notes ?? null,
    createdBy: userRef(refs, row.created_by),
    createdAt: iso(row.created_at),
    approvedBy: userRef(refs, row.approved_by),
    approvedAt: iso(row.approved_at),
    paidBy: userRef(refs, row.paid_by),
    paidAt: iso(row.paid_at),
    cancelledBy: userRef(refs, row.cancelled_by),
    cancelledAt: iso(row.cancelled_at),
    cancelReason: row.cancel_reason ?? null,
    can,
  };
}

export function presentPayoutLine(line, { refs, currency }) {
  return {
    id: line.id,
    partner: partnerRef(refs, line.partner_id),
    commission: money(line.commission_minor, currency),
    deductions: money(line.deduction_minor, currency),
    net: money(line.net_minor, currency),
    commissionCount: line.commission_count,
    payout: presentPayoutHint(line.payout_hint),
    reference: line.reference ?? null,
  };
}

// ---------- The partner portal (the partner's own data, minimal and masked) ----------

/** A referred lead as the partner sees it: masked name and phone, the outcome, no stage or notes. */
export function presentPortalLead(row, { unitsById }) {
  return {
    id: row.id,
    ref: row.deal_ref,
    company: companyRef(unitsById.get(row.company_id)),
    name: row.erased_at ? 'Erased' : maskName(row.display_name),
    phone: row.erased_at ? null : maskPhone(row.primary_phone),
    productLine: row.product_line_name ? { id: row.product_line_id, name: row.product_line_name } : null,
    status: partnerLeadStatus(row.deal_status),
    touch: row.touch,
    referredAt: iso(row.touched_at),
  };
}

export function presentPortalCommission(row, { unitsById }) {
  return {
    id: row.id,
    ref: row.deal_ref,
    company: companyRef(unitsById.get(row.company_id)),
    status: row.status,
    amount: money(row.amount_minor, row.currency),
    clawedBack: money(row.clawed_back_minor, row.currency),
    payable: money(payableMinor(row), row.currency),
    earnedAt: iso(row.earned_at),
    clawbackUntil: iso(row.clawback_until),
    paidAt: iso(row.paid_at),
  };
}

export function presentPortalPayout(row, { unitsById }) {
  return {
    id: row.id,
    payoutRef: row.ref,
    company: companyRef(unitsById.get(row.company_id)),
    periodStart: row.period_start,
    periodEnd: row.period_end,
    status: row.status,
    net: money(row.net_minor, row.currency),
    deductions: money(row.deduction_minor, row.currency),
    commissionCount: row.commission_count,
    paidAt: iso(row.paid_at),
    reference: row.line_reference ?? row.reference ?? null,
  };
}
