import { randomInt } from 'node:crypto';

// The pure rules of the partner programme: which plan applies, what a payment earns, how much a
// refund claws back, how a payout batch adds up, how referral links are built and how a referred
// lead is shown to a partner. No database or clock access; unit tests in test/partners/.

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------- Plans ----------

/**
 * The plan for a commission. In order: the plan set on the partner's company link (when active),
 * then the active plan for the deal's product line, then the active company-wide plan (no product
 * line). Ties go to the lowest position, then the oldest. A plan with a currency only applies to
 * payments in that currency.
 * @param {object[]} plans commission_plans rows of the company
 * @param {{ overridePlanId?: string | null, productLineId?: string | null, currency: string }} input
 */
export function choosePlan(plans, { overridePlanId = null, productLineId = null, currency }) {
  const usable = (plan) => plan.active && (plan.basis === 'fixed' || !plan.currency || plan.currency === currency);
  const order = (a, b) => a.position - b.position || new Date(a.created_at) - new Date(b.created_at) || String(a.id).localeCompare(String(b.id));
  if (overridePlanId) {
    const override = plans.find((plan) => plan.id === overridePlanId);
    if (override && usable(override)) return override;
  }
  const byLine = productLineId ? plans.filter((plan) => usable(plan) && plan.product_line_id === productLineId).sort(order) : [];
  if (byLine.length) return byLine[0];
  const general = plans.filter((plan) => usable(plan) && !plan.product_line_id).sort(order);
  return general[0] ?? null;
}

// ---------- Accrual ----------

/**
 * Does this payment earn the plan's commission?
 *   first_payment: the first successful payment of the deal (payment.isFirstPayment, or no
 *                  earlier commission when the payment doesn't say)
 *   full_payment:  the payment that completes the deal's fee (payment.fullyPaid)
 * A deal earns one commission; `alreadyEarned` is true when it has one that wasn't rejected.
 */
export function shouldAccrue(plan, payment, { alreadyEarned }) {
  if (alreadyEarned) return { accrue: false, reason: 'already_earned' };
  if (plan.trigger === 'full_payment') {
    return payment.fullyPaid === true ? { accrue: true } : { accrue: false, reason: 'not_fully_paid' };
  }
  return payment.isFirstPayment === false ? { accrue: false, reason: 'not_first_payment' } : { accrue: true };
}

/** What a percent is taken of: the fee the payment is for (order total, else the deal value, else the payment). */
export function commissionBase(plan, payment, deal = {}) {
  const dealValue = Number(deal.value_minor ?? 0);
  const dealValueFits = dealValue > 0 && deal.currency === payment.currency;
  if (plan.trigger === 'full_payment') {
    return payment.paidTotalMinor ?? payment.totalMinor ?? (dealValueFits ? dealValue : payment.amountMinor);
  }
  return payment.totalMinor ?? (dealValueFits ? dealValue : payment.amountMinor);
}

const roundDiv = (numerator, denominator) => (numerator * 2n + denominator) / (denominator * 2n);

/**
 * The commission a qualifying payment earns, in minor units.
 * @returns {{ baseMinor: number, baseCurrency: string, amountMinor: number, currency: string, rateBps: number | null } | null}
 */
export function computeCommission(plan, payment, deal = {}) {
  const baseMinor = Math.max(0, Math.trunc(Number(commissionBase(plan, payment, deal))));
  let amountMinor;
  let currency;
  if (plan.basis === 'fixed') {
    amountMinor = Number(plan.fixed_minor);
    currency = plan.currency;
  } else {
    amountMinor = Number(roundDiv(BigInt(baseMinor) * BigInt(plan.rate_bps), 10_000n));
    currency = payment.currency;
  }
  if (plan.cap_minor != null && plan.currency === currency) amountMinor = Math.min(amountMinor, Number(plan.cap_minor));
  if (!(amountMinor > 0)) return null;
  return { baseMinor, baseCurrency: payment.currency, amountMinor, currency, rateBps: plan.basis === 'percent' ? plan.rate_bps : null };
}

/** End of the clawback window for a commission earned at `earnedAt`. */
export const clawbackUntil = (earnedAt, days) => new Date(new Date(earnedAt).getTime() + days * DAY_MS);

// ---------- Clawback ----------

/**
 * How much of a commission a refund claws back. Inside the window only. A full refund takes back
 * what is left; a partial refund takes back the same share of the commission as the refund is of
 * the commission's base (a 50% refund of the fee claws back 50% of the commission).
 * @param {{ amount_minor, clawed_back_minor, base_minor, base_currency, clawback_until, status }} commission
 * @param {{ amountMinor?: number, currency?: string, full?: boolean, refundedAt: string | Date }} refund
 * @returns {{ amountMinor: number, reason?: string }}
 */
export function clawbackFor(commission, refund) {
  if (commission.status === 'rejected' || commission.status === 'clawed_back') return { amountMinor: 0, reason: 'nothing_left' };
  if (new Date(refund.refundedAt) > new Date(commission.clawback_until)) return { amountMinor: 0, reason: 'outside_window' };
  const amount = BigInt(commission.amount_minor);
  const remaining = amount - BigInt(commission.clawed_back_minor ?? 0);
  if (remaining <= 0n) return { amountMinor: 0, reason: 'nothing_left' };
  if (refund.full === true) return { amountMinor: Number(remaining) };
  if (!(refund.amountMinor > 0)) return { amountMinor: 0, reason: 'no_amount' };
  if (refund.currency !== commission.base_currency) return { amountMinor: 0, reason: 'currency_mismatch' };
  const base = BigInt(commission.base_minor);
  if (base <= 0n) return { amountMinor: Number(remaining) };
  let share = roundDiv(amount * BigInt(refund.amountMinor), base);
  if (share > remaining) share = remaining;
  return share > 0n ? { amountMinor: Number(share) } : { amountMinor: 0, reason: 'too_small' };
}

/** What is still payable on a commission (after clawbacks netted against it). */
export const payableMinor = (commission) => Number(commission.amount_minor) - Number(commission.clawed_back_minor ?? 0);

// ---------- Payout batches ----------

/**
 * Group approved commissions and outstanding deductions (clawbacks of commissions already paid)
 * into one line per partner. A partner is paid only when their net is above zero; otherwise
 * everything of theirs waits for a later batch.
 * @returns {{ lines: Array<{ partnerId, commissionMinor, deductionMinor, netMinor, commissionIds, deductionIds }>, skipped: Array<{ partnerId, netMinor, reason }> }}
 */
export function buildPayoutLines(commissions, deductions = []) {
  const byPartner = new Map();
  const entry = (partnerId) => {
    if (!byPartner.has(partnerId)) byPartner.set(partnerId, { partnerId, commissionMinor: 0, deductionMinor: 0, commissionIds: [], deductionIds: [] });
    return byPartner.get(partnerId);
  };
  for (const commission of commissions) {
    const amount = payableMinor(commission);
    if (amount <= 0) continue;
    const line = entry(commission.partner_id);
    line.commissionMinor += amount;
    line.commissionIds.push(commission.id);
  }
  for (const deduction of deductions) {
    if (!byPartner.has(deduction.partner_id)) continue; // nothing to deduct it from in this batch
    const line = entry(deduction.partner_id);
    line.deductionMinor += Number(deduction.amount_minor);
    line.deductionIds.push(deduction.id);
  }
  const lines = [];
  const skipped = [];
  for (const line of byPartner.values()) {
    const netMinor = line.commissionMinor - line.deductionMinor;
    if (netMinor > 0) lines.push({ ...line, netMinor });
    else skipped.push({ partnerId: line.partnerId, netMinor, reason: 'deductions_exceed_commissions' });
  }
  return { lines, skipped };
}

// ---------- Referral links ----------

// Crockford-style alphabet without 0/O, 1/I/L, U: easy to read out on a call.
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A random referral code like "SP-7KQ2MX" (the prefix is the company's lead prefix). */
export function generateReferralCode(prefix = '', length = 6) {
  let code = '';
  for (let i = 0; i < length; i += 1) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return prefix ? `${prefix}-${code}` : code;
}

/** Codes people type: letters, digits, dash and underscore, 3 to 40 characters. */
export const REFERRAL_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,39}$/;

export function normalizeReferralCode(value) {
  if (typeof value !== 'string') return null;
  const code = value.trim();
  return REFERRAL_CODE_PATTERN.test(code) ? code : null;
}

/** The link a partner shares: the landing page with `ref` and the UTM tags added. Null without a landing page. */
export function shareUrl({ landingUrl, code, utm = {} }) {
  if (!landingUrl) return null;
  let url;
  try {
    url = new URL(landingUrl);
  } catch {
    return null;
  }
  url.searchParams.set('ref', code);
  for (const [key, value] of Object.entries(utm ?? {})) if (value) url.searchParams.set(`utm_${key}`, String(value));
  return url.toString();
}

// ---------- What a partner sees of a referred lead ----------

/** "Priya Sharma" → "Priya S.": enough for a partner to recognise the family, nothing more. */
export function maskName(displayName) {
  const words = String(displayName ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 'Unnamed';
  const [first, ...rest] = words;
  const last = rest.at(-1);
  return last ? `${first} ${last[0].toUpperCase()}.` : first;
}

/** Deal statuses as a partner understands them. */
export function partnerLeadStatus(status) {
  if (status === 'won') return 'enrolled';
  if (status === 'lost') return 'closed';
  return 'in_progress';
}
