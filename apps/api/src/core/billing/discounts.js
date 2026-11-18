/**
 * Discount approval policy, driven by configuration (a company-level setting in practice).
 *
 * A policy is a list of tiers in increasing order. A discount falls in the first tier whose
 * limits it fits (percentage of the list price and/or an absolute amount). A tier with no
 * approver roles needs no approval; otherwise someone holding one of its roles must approve,
 * and senior tiers' approvers may approve junior tiers too. A discount above the last tier is
 * not allowed at all. Percentages are compared exactly (discount × 10000 ≤ limit × list price),
 * so rounding can never let a discount slip into a cheaper tier.
 *
 * Role keys are the platform's role keys (systemRoles.js or custom roles); callers pass the
 * roles the person holds at the unit that owns the deal or invoice.
 */
import { z } from 'zod';
import { errors } from '../../lib/errors.js';
import { parseOrThrow } from '../../lib/validate.js';
import { BP, mulDivRound } from './money.js';

const tierSchema = z
  .object({
    label: z.string().max(80).optional(),
    maxPercentBp: z.number().int().min(0).max(BP).optional(),
    maxAmountMinor: z.number().int().nonnegative().optional(),
    approverRoles: z.array(z.string().min(1)).default([]),
  })
  .refine((t) => t.maxPercentBp !== undefined || t.maxAmountMinor !== undefined, {
    message: 'A tier needs a percentage or an amount limit',
  });

export const discountPolicySchema = z
  .object({
    tiers: z.array(tierSchema).min(1).max(20),
    /** Senior tiers' approvers can approve junior tiers. */
    inheritApprovers: z.boolean().default(true),
    /** Someone holding an approver role may approve their own discount. */
    allowSelfApproval: z.boolean().default(true),
  })
  .superRefine((policy, ctx) => {
    policy.tiers.forEach((tier, i) => {
      if (i === 0) return;
      const prev = policy.tiers[i - 1];
      const looser = (a, b) => a === undefined || b === undefined || a >= b;
      if (!looser(tier.maxPercentBp, prev.maxPercentBp) || !looser(tier.maxAmountMinor, prev.maxAmountMinor)) {
        ctx.addIssue({ code: 'custom', path: ['tiers', i], message: 'Tiers must be in increasing order of limits' });
      }
    });
  });

/** @typedef {z.output<typeof discountPolicySchema>} DiscountPolicy */

/**
 * A sensible default using the built-in roles: up to 5% (and ₹5,000) anyone may give; up to 15%
 * a manager approves; up to 30% a company admin; more is not allowed.
 * @type {z.input<typeof discountPolicySchema>}
 */
export const DEFAULT_DISCOUNT_POLICY = Object.freeze({
  tiers: [
    { label: 'Small', maxPercentBp: 500, maxAmountMinor: 500_000, approverRoles: [] },
    { label: 'Manager', maxPercentBp: 1500, approverRoles: ['manager'] },
    { label: 'Company', maxPercentBp: 3000, approverRoles: ['company_admin'] },
  ],
});

/** @param {unknown} policy @returns {DiscountPolicy} */
export const parseDiscountPolicy = (policy) => parseOrThrow(discountPolicySchema, policy, 'policy');

/**
 * @typedef {object} DiscountDecision
 * @property {'allowed' | 'needs_approval' | 'not_allowed'} decision
 * @property {number} percentBp the discount as a share of the list price, rounded for display
 * @property {number | null} tierIndex
 * @property {string | null} tierLabel
 * @property {string[]} approverRoles roles that can approve (empty when none is needed)
 * @property {boolean} selfApproved the requester's own role covered it
 * @property {string} reason
 */

/**
 * Evaluate a discount request.
 * @param {{ policy: unknown, listAmountMinor: number, discountMinor: number, requesterRoles?: string[] }} input
 * @returns {DiscountDecision}
 */
export function evaluateDiscount({ policy, listAmountMinor, discountMinor, requesterRoles = [] }) {
  const parsed = parseDiscountPolicy(policy);
  for (const [path, value] of [['listAmountMinor', listAmountMinor], ['discountMinor', discountMinor]]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw errors.validation([{ path, message: 'Must be a whole, non-negative number of minor units' }]);
    }
  }
  if (discountMinor > listAmountMinor) {
    throw errors.validation([{ path: 'discountMinor', message: 'Discount is more than the price' }]);
  }
  const percentBp = listAmountMinor === 0 ? 0 : mulDivRound(discountMinor, BP, listAmountMinor);
  if (discountMinor === 0) {
    return { decision: 'allowed', percentBp: 0, tierIndex: null, tierLabel: null, approverRoles: [], selfApproved: false, reason: 'No discount' };
  }
  const fits = (tier) =>
    (tier.maxAmountMinor === undefined || discountMinor <= tier.maxAmountMinor) &&
    (tier.maxPercentBp === undefined || BigInt(discountMinor) * BigInt(BP) <= BigInt(tier.maxPercentBp) * BigInt(listAmountMinor));
  const tierIndex = parsed.tiers.findIndex(fits);
  if (tierIndex === -1) {
    return {
      decision: 'not_allowed',
      percentBp,
      tierIndex: null,
      tierLabel: null,
      approverRoles: [],
      selfApproved: false,
      reason: 'The discount is above the largest discount the policy allows',
    };
  }
  const tier = parsed.tiers[tierIndex];
  const tierLabel = tier.label ?? null;
  if (tier.approverRoles.length === 0) {
    return { decision: 'allowed', percentBp, tierIndex, tierLabel, approverRoles: [], selfApproved: false, reason: 'Within the limit anyone may give' };
  }
  const approverRoles = approversFor(parsed, tierIndex);
  const selfApproved = parsed.allowSelfApproval && requesterRoles.some((role) => approverRoles.includes(role));
  return selfApproved
    ? { decision: 'allowed', percentBp, tierIndex, tierLabel, approverRoles, selfApproved: true, reason: 'Within the requester\'s own approval limit' }
    : { decision: 'needs_approval', percentBp, tierIndex, tierLabel, approverRoles, selfApproved: false, reason: `Needs approval by ${approverRoles.join(' or ')}` };
}

/** @param {DiscountPolicy} policy @param {number} tierIndex */
function approversFor(policy, tierIndex) {
  const tiers = policy.inheritApprovers ? policy.tiers.slice(tierIndex) : [policy.tiers[tierIndex]];
  return [...new Set(tiers.flatMap((t) => t.approverRoles))];
}

/**
 * Can this person approve a pending discount? They need one of the approver roles, and they may
 * not approve their own request unless the policy allows self-approval.
 * @param {{ decision: DiscountDecision, approverRoles: string[], approverUserId?: string, requesterUserId?: string, policy: unknown }} input
 */
export function canApproveDiscount({ decision, approverRoles, approverUserId, requesterUserId, policy }) {
  const parsed = parseDiscountPolicy(policy);
  if (decision.decision !== 'needs_approval') return false;
  if (!parsed.allowSelfApproval && approverUserId !== undefined && approverUserId === requesterUserId) return false;
  return approverRoles.some((role) => decision.approverRoles.includes(role));
}
