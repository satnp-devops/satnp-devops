import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_DISCOUNT_POLICY, canApproveDiscount, evaluateDiscount, parseDiscountPolicy } from '../../src/core/billing/discounts.js';
import { assertValidation } from './helpers.js';

const TEN_THOUSAND_RUPEES = 1_000_000;
const evaluate = (discountMinor, requesterRoles = ['counsellor'], listAmountMinor = TEN_THOUSAND_RUPEES, policy = DEFAULT_DISCOUNT_POLICY) =>
  evaluateDiscount({ policy, listAmountMinor, discountMinor, requesterRoles });

test('small discounts need no approval', () => {
  const result = evaluate(30_000);
  assert.equal(result.decision, 'allowed');
  assert.equal(result.percentBp, 300);
  assert.equal(result.tierIndex, 0);
  assert.equal(result.tierLabel, 'Small');
  assert.deepEqual(result.approverRoles, []);
  assert.equal(evaluate(50_000).decision, 'allowed', 'exactly 5% is inside the tier');
  assert.equal(evaluate(0).decision, 'allowed');
  assert.equal(evaluate(0).reason, 'No discount');
});

test('the amount cap applies as well as the percentage', () => {
  // 5% of ₹2,00,000 is ₹10,000, above the ₹5,000 cap of the first tier.
  const result = evaluate(1_000_000, ['counsellor'], 20_000_000);
  assert.equal(result.decision, 'needs_approval');
  assert.equal(result.tierIndex, 1);
});

test('bigger discounts need a manager, and senior approvers can approve too', () => {
  const result = evaluate(100_000);
  assert.equal(result.decision, 'needs_approval');
  assert.equal(result.percentBp, 1000);
  assert.deepEqual(result.approverRoles, ['manager', 'company_admin']);
  assert.match(result.reason, /manager or company_admin/);
  const manager = evaluate(100_000, ['manager']);
  assert.equal(manager.decision, 'allowed');
  assert.equal(manager.selfApproved, true);
  assert.equal(evaluate(100_000, ['company_admin']).decision, 'allowed');
});

test('the top tier needs a company admin; beyond it nothing is allowed', () => {
  const big = evaluate(200_000, ['manager']);
  assert.equal(big.decision, 'needs_approval');
  assert.deepEqual(big.approverRoles, ['company_admin']);
  assert.equal(evaluate(300_000, ['company_admin']).decision, 'allowed');
  const tooBig = evaluate(300_001, ['company_admin', 'group_owner']);
  assert.equal(tooBig.decision, 'not_allowed');
  assert.equal(tooBig.tierIndex, null);
});

test('percentages compare exactly, so rounding cannot slip a discount into a lower tier', () => {
  // 100 on 1999 is 5.0025%: displayed as 500 bp but above a 5% limit.
  const result = evaluate(100, ['counsellor'], 1999);
  assert.equal(result.percentBp, 500);
  assert.equal(result.tierIndex, 1);
  assert.equal(result.decision, 'needs_approval');
  assert.equal(evaluate(100, ['counsellor'], 2000).tierIndex, 0);
});

test('without inherited approvers only the tier\'s own roles approve', () => {
  const policy = { ...DEFAULT_DISCOUNT_POLICY, inheritApprovers: false };
  const result = evaluate(100_000, ['company_admin'], TEN_THOUSAND_RUPEES, policy);
  assert.equal(result.decision, 'needs_approval');
  assert.deepEqual(result.approverRoles, ['manager']);
});

test('without self-approval even an approver must ask someone else', () => {
  const policy = { ...DEFAULT_DISCOUNT_POLICY, allowSelfApproval: false };
  const result = evaluate(100_000, ['manager'], TEN_THOUSAND_RUPEES, policy);
  assert.equal(result.decision, 'needs_approval');
  assert.equal(canApproveDiscount({ policy, decision: result, approverRoles: ['manager'], approverUserId: 'u1', requesterUserId: 'u1' }), false);
  assert.equal(canApproveDiscount({ policy, decision: result, approverRoles: ['manager'], approverUserId: 'u2', requesterUserId: 'u1' }), true);
  assert.equal(canApproveDiscount({ policy, decision: result, approverRoles: ['counsellor'], approverUserId: 'u2', requesterUserId: 'u1' }), false);
  assert.equal(canApproveDiscount({ policy, decision: evaluate(1000), approverRoles: ['manager'] }), false, 'nothing to approve');
});

test('amount-only tiers and a free-of-charge tier', () => {
  const policy = {
    tiers: [
      { maxAmountMinor: 100_000, approverRoles: [] },
      { maxAmountMinor: 1_000_000, approverRoles: ['finance'] },
      { maxPercentBp: 10_000, approverRoles: ['group_admin'] },
    ],
  };
  assert.equal(evaluateDiscount({ policy, listAmountMinor: 50_000_000, discountMinor: 100_000 }).decision, 'allowed');
  assert.deepEqual(evaluateDiscount({ policy, listAmountMinor: 50_000_000, discountMinor: 500_000 }).approverRoles, ['finance', 'group_admin']);
  const free = evaluateDiscount({ policy, listAmountMinor: 50_000_000, discountMinor: 50_000_000, requesterRoles: ['group_admin'] });
  assert.equal(free.decision, 'allowed');
  assert.equal(free.percentBp, 10_000);
  assert.equal(evaluateDiscount({ policy, listAmountMinor: 0, discountMinor: 0 }).percentBp, 0);
});

test('policies are validated', () => {
  assert.equal(parseDiscountPolicy(DEFAULT_DISCOUNT_POLICY).allowSelfApproval, true);
  assertValidation(() => parseDiscountPolicy({ tiers: [] }), 'policy.tiers');
  assertValidation(() => parseDiscountPolicy({ tiers: [{ approverRoles: [] }] }), 'policy.tiers.0');
  assertValidation(
    () => parseDiscountPolicy({ tiers: [{ maxPercentBp: 1000 }, { maxPercentBp: 500, approverRoles: ['manager'] }] }),
    'policy.tiers.1',
  );
  assertValidation(() => parseDiscountPolicy({ tiers: [{ maxPercentBp: 10_001 }] }), 'policy.tiers.0.maxPercentBp');
  assertValidation(() => evaluate(-1), 'discountMinor');
  assertValidation(() => evaluate(1.5), 'discountMinor');
  assertValidation(() => evaluate(2_000_000), 'discountMinor');
  assertValidation(() => evaluateDiscount({ policy: DEFAULT_DISCOUNT_POLICY, listAmountMinor: -5, discountMinor: 0 }), 'listAmountMinor');
});
