import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPayoutLines,
  choosePlan,
  clawbackFor,
  clawbackUntil,
  computeCommission,
  generateReferralCode,
  maskName,
  normalizeReferralCode,
  partnerLeadStatus,
  payableMinor,
  shareUrl,
  shouldAccrue,
} from '../../src/modules/partners/rules.js';
import { refFromLandingUrl, touchReferences } from '../../src/modules/partners/referrals.js';

const plan = (overrides = {}) => ({
  id: overrides.id ?? 'p1',
  active: true,
  basis: 'percent',
  rate_bps: 1000,
  fixed_minor: null,
  currency: null,
  trigger: 'first_payment',
  clawback_days: 30,
  cap_minor: null,
  product_line_id: null,
  position: 0,
  created_at: '2026-01-01T00:00:00Z',
  ...overrides,
});

test('choosePlan: partnership override, then product line, then company-wide', () => {
  const general = plan({ id: 'general' });
  const sat = plan({ id: 'sat', product_line_id: 'line-sat' });
  const special = plan({ id: 'special', position: 5 });
  const plans = [general, sat, special];
  assert.equal(choosePlan(plans, { productLineId: 'line-sat', currency: 'INR' }).id, 'sat');
  assert.equal(choosePlan(plans, { productLineId: 'other', currency: 'INR' }).id, 'general');
  assert.equal(choosePlan(plans, { overridePlanId: 'special', productLineId: 'line-sat', currency: 'INR' }).id, 'special');
  // An inactive override falls back to matching.
  assert.equal(choosePlan([general, { ...special, active: false }], { overridePlanId: 'special', currency: 'INR' }).id, 'general');
  assert.equal(choosePlan([{ ...general, active: false }], { currency: 'INR' }), null);
});

test('choosePlan: percent plans with a currency only apply to payments in it; ties go to position', () => {
  const inr = plan({ id: 'inr', currency: 'INR', position: 1 });
  const any = plan({ id: 'any', position: 2 });
  assert.equal(choosePlan([inr, any], { currency: 'INR' }).id, 'inr');
  assert.equal(choosePlan([inr, any], { currency: 'USD' }).id, 'any');
  const fixed = plan({ id: 'fixed', basis: 'fixed', fixed_minor: 100000, currency: 'INR', rate_bps: null });
  assert.equal(choosePlan([fixed], { currency: 'USD' }).id, 'fixed', 'fixed plans pay in their own currency');
});

test('shouldAccrue: first payment once, full payment when fully paid', () => {
  const first = plan();
  assert.deepEqual(shouldAccrue(first, { isFirstPayment: true }, { alreadyEarned: false }), { accrue: true });
  assert.deepEqual(shouldAccrue(first, {}, { alreadyEarned: false }), { accrue: true }, 'unknown = first when nothing was earned');
  assert.equal(shouldAccrue(first, { isFirstPayment: false }, { alreadyEarned: false }).reason, 'not_first_payment');
  assert.equal(shouldAccrue(first, { isFirstPayment: true }, { alreadyEarned: true }).reason, 'already_earned');
  const full = plan({ trigger: 'full_payment' });
  assert.equal(shouldAccrue(full, { fullyPaid: false }, { alreadyEarned: false }).reason, 'not_fully_paid');
  assert.deepEqual(shouldAccrue(full, { fullyPaid: true }, { alreadyEarned: false }), { accrue: true });
});

test('computeCommission: percent of the fee, rounded half up, capped; fixed amounts', () => {
  const p = plan({ rate_bps: 750 });
  // 7.5% of ₹36,000 (fee given by the payment) = ₹2,700.
  assert.deepEqual(computeCommission(p, { amountMinor: 1_000_000, currency: 'INR', totalMinor: 3_600_000 }), {
    baseMinor: 3_600_000,
    baseCurrency: 'INR',
    amountMinor: 270_000,
    currency: 'INR',
    rateBps: 750,
  });
  // No fee on the payment: the deal value, when in the same currency.
  assert.equal(computeCommission(p, { amountMinor: 1_000, currency: 'INR' }, { value_minor: '2000000', currency: 'INR' }).amountMinor, 150_000);
  // Deal in another currency: the payment itself.
  assert.equal(computeCommission(p, { amountMinor: 1_000, currency: 'USD' }, { value_minor: '2000000', currency: 'INR' }).amountMinor, 75);
  // Half up: 1001 * 7.5% = 75.075 → 75; 1010 * 7.5% = 75.75 → 76.
  assert.equal(computeCommission(p, { amountMinor: 1010, currency: 'INR' }).amountMinor, 76);
  const capped = plan({ rate_bps: 1000, cap_minor: 2_500_000, currency: 'INR' });
  assert.equal(computeCommission(capped, { amountMinor: 35_000_000, currency: 'INR' }).amountMinor, 2_500_000);
  const fixed = plan({ basis: 'fixed', fixed_minor: '200000', currency: 'INR', rate_bps: null });
  assert.deepEqual(computeCommission(fixed, { amountMinor: 50_000, currency: 'INR' }), {
    baseMinor: 50_000,
    baseCurrency: 'INR',
    amountMinor: 200_000,
    currency: 'INR',
    rateBps: null,
  });
  assert.equal(computeCommission(p, { amountMinor: 0, currency: 'INR' }), null, 'nothing earned on nothing');
  // Big fees don't lose precision.
  assert.equal(computeCommission(plan({ rate_bps: 1 }), { amountMinor: 99_999_999_999_999, currency: 'INR' }).amountMinor, 10_000_000_000);
});

test('full-payment plans take the percent of the fee paid in total', () => {
  const p = plan({ trigger: 'full_payment', rate_bps: 500 });
  assert.equal(computeCommission(p, { amountMinor: 100_000, paidTotalMinor: 4_000_000, totalMinor: 5_000_000, currency: 'INR' }).amountMinor, 200_000);
});

test('clawbackFor: inside the window, proportional to the refund, never more than is left', () => {
  const earnedAt = '2026-10-01T10:00:00Z';
  const commission = {
    status: 'approved',
    amount_minor: '270000',
    clawed_back_minor: '0',
    base_minor: '3600000',
    base_currency: 'INR',
    clawback_until: clawbackUntil(earnedAt, 30).toISOString(),
  };
  assert.equal(commission.clawback_until, '2026-10-31T10:00:00.000Z');
  // Half the fee refunded → half the commission.
  assert.deepEqual(clawbackFor(commission, { amountMinor: 1_800_000, currency: 'INR', refundedAt: '2026-10-20T00:00:00Z' }), { amountMinor: 135_000 });
  // Full refund → everything left.
  assert.deepEqual(clawbackFor({ ...commission, clawed_back_minor: '135000' }, { full: true, refundedAt: '2026-10-20T00:00:00Z' }), { amountMinor: 135_000 });
  // A refund bigger than the base can't take more than is left.
  assert.deepEqual(clawbackFor({ ...commission, clawed_back_minor: '200000' }, { amountMinor: 9_000_000, currency: 'INR', refundedAt: '2026-10-20T00:00:00Z' }), {
    amountMinor: 70_000,
  });
  assert.equal(clawbackFor(commission, { amountMinor: 100, currency: 'INR', refundedAt: '2026-11-01T00:00:00Z' }).reason, 'outside_window');
  assert.equal(clawbackFor(commission, { amountMinor: 100, currency: 'USD', refundedAt: '2026-10-02T00:00:00Z' }).reason, 'currency_mismatch');
  assert.equal(clawbackFor({ ...commission, status: 'rejected' }, { full: true, refundedAt: '2026-10-02T00:00:00Z' }).reason, 'nothing_left');
  assert.equal(clawbackFor({ ...commission, clawed_back_minor: '270000' }, { full: true, refundedAt: '2026-10-02T00:00:00Z' }).reason, 'nothing_left');
  assert.equal(clawbackFor(commission, { refundedAt: '2026-10-02T00:00:00Z' }).reason, 'no_amount');
  assert.equal(payableMinor({ amount_minor: '270000', clawed_back_minor: '135000' }), 135_000);
});

test('buildPayoutLines: one line per partner, deductions netted, negatives wait', () => {
  const commissions = [
    { id: 'c1', partner_id: 'a', amount_minor: '100000', clawed_back_minor: '0' },
    { id: 'c2', partner_id: 'a', amount_minor: '50000', clawed_back_minor: '10000' },
    { id: 'c3', partner_id: 'b', amount_minor: '20000', clawed_back_minor: '0' },
    { id: 'c4', partner_id: 'c', amount_minor: '5000', clawed_back_minor: '5000' }, // fully netted: nothing to pay
  ];
  const deductions = [
    { id: 'd1', partner_id: 'a', amount_minor: '30000' },
    { id: 'd2', partner_id: 'b', amount_minor: '25000' }, // more than b earns in this batch
    { id: 'd3', partner_id: 'z', amount_minor: '1000' }, // nothing to deduct it from
  ];
  const { lines, skipped } = buildPayoutLines(commissions, deductions);
  assert.deepEqual(lines, [{ partnerId: 'a', commissionMinor: 140_000, deductionMinor: 30_000, netMinor: 110_000, commissionIds: ['c1', 'c2'], deductionIds: ['d1'] }]);
  assert.deepEqual(skipped, [{ partnerId: 'b', netMinor: -5000, reason: 'deductions_exceed_commissions' }]);
});

test('referral codes: generated, normalised, turned into share links', () => {
  const code = generateReferralCode('SP');
  assert.match(code, /^SP-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{6}$/);
  assert.notEqual(generateReferralCode('SP'), generateReferralCode('SP'));
  assert.equal(normalizeReferralCode('  sp-edupath '), 'sp-edupath');
  assert.equal(normalizeReferralCode('a'), null);
  assert.equal(normalizeReferralCode('has space'), null);
  assert.equal(normalizeReferralCode("x'; drop"), null);
  assert.equal(
    shareUrl({ landingUrl: 'https://satnpaper.example/enquire?lang=en', code: 'SP-7KQ2MX', utm: { source: 'partner', medium: 'referral', campaign: '' } }),
    'https://satnpaper.example/enquire?lang=en&ref=SP-7KQ2MX&utm_source=partner&utm_medium=referral',
  );
  assert.equal(shareUrl({ landingUrl: null, code: 'X' }), null);
  assert.equal(shareUrl({ landingUrl: 'not a url', code: 'X' }), null);
});

test('touch references: partner id or code first, then ?ref= on the landing page', () => {
  assert.equal(refFromLandingUrl('https://satnpaper.example/sat?ref=SP-EDUPATH&utm_source=x'), 'SP-EDUPATH');
  assert.equal(refFromLandingUrl('https://satnpaper.example/sat?partner=edupath-advisors'), 'edupath-advisors');
  assert.equal(refFromLandingUrl('nonsense'), null);
  assert.deepEqual(touchReferences({ partnerId: ' edupath-advisors ', landingUrl: 'https://x.example/?ref=SP-EDUPATH' }), ['edupath-advisors', 'SP-EDUPATH']);
  assert.deepEqual(touchReferences({ landingUrl: 'https://x.example/?ref=SP-EDUPATH' }), ['SP-EDUPATH']);
  assert.deepEqual(touchReferences(null), []);
});

test('what a partner sees of a lead: masked name, plain status', () => {
  assert.equal(maskName('Priya Sharma'), 'Priya S.');
  assert.equal(maskName('Rohan Kumar Mehta'), 'Rohan M.');
  assert.equal(maskName('Aarav'), 'Aarav');
  assert.equal(maskName('  '), 'Unnamed');
  assert.equal(partnerLeadStatus('won'), 'enrolled');
  assert.equal(partnerLeadStatus('lost'), 'closed');
  assert.equal(partnerLeadStatus('open'), 'in_progress');
});
