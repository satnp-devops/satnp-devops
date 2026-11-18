// Vocabularies of the partners module (docs/partners/PARTNERS.md). The migration's check
// constraints use the same lists.

export const PARTNER_KINDS = ['person', 'organisation'];
export const PARTNER_LINK_STATUSES = ['pending', 'active', 'suspended', 'terminated'];
export const PAYOUT_METHODS = ['bank_transfer', 'upi'];
export const PLAN_BASES = ['percent', 'fixed'];
export const PLAN_TRIGGERS = ['first_payment', 'full_payment'];
export const TOUCHES = ['first', 'last'];
export const ATTRIBUTION_SOURCES = ['referral_link', 'partner_code', 'manual'];
export const COMMISSION_STATUSES = ['pending', 'approved', 'rejected', 'paid', 'clawed_back'];
export const PAYOUT_STATUSES = ['draft', 'approved', 'paid', 'cancelled'];

/** The built-in role external partners sign in with (core/systemRoles.js needs the matching entry). */
export const PARTNER_ROLE_KEY = 'partner';
export const PARTNER_ROLE = {
  key: PARTNER_ROLE_KEY,
  name: 'Partner',
  description: 'Broker or referral partner: sees only their own referral links, referred leads, commissions and payouts.',
};

export const PERMISSIONS = Object.freeze({
  view: 'partners.view',
  manage: 'partners.manage',
  managePlans: 'partners.manage_plans',
  approveCommissions: 'partners.approve_commissions',
  managePayouts: 'partners.manage_payouts',
  approvePayouts: 'partners.approve_payouts',
  payoutDetails: 'partners.payout_details',
  portal: 'partners.portal',
});

/** Most commissions one approve call handles. */
export const MAX_BULK = 100;
