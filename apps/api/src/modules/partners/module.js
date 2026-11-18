import { PERMISSIONS as P, PARTNER_ROLE_KEY } from './constants.js';
import { partnerEventHandlers } from './handlers.js';
import { partnerRoutes } from './routes.js';
import { partnerSettings } from './settings.js';

// Phase 10: brokers and referral partners. Partners, their referral links, attribution of leads,
// commission plans, commissions accrued on payments and clawed back on refunds, payout batches
// with maker-checker approval, and the partner portal. docs/partners/PARTNERS.md.

export default {
  name: 'partners',
  label: 'Partners',
  permissions: [
    {
      key: P.view,
      label: 'See partners',
      description: 'See brokers and referral partners, their links, referred leads and commissions',
      supportsOwn: true,
    },
    {
      key: P.manage,
      label: 'Manage partners',
      description: 'Add partners, change partnerships, create referral links, credit leads and give portal access',
      supportsOwn: true,
    },
    { key: P.managePlans, label: 'Set up partner programmes', description: 'Create and change commission plans for a company' },
    { key: P.approveCommissions, label: 'Approve commissions', description: 'Approve or reject commissions before they are paid' },
    { key: P.managePayouts, label: 'Prepare partner payouts', description: 'Make payout batches, mark them paid or cancel them' },
    { key: P.approvePayouts, label: 'Approve partner payouts', description: 'Approve payout batches someone else prepared' },
    { key: P.payoutDetails, label: 'See partner bank details', description: 'Read and change partners’ bank and UPI details (every read is logged)' },
    { key: P.portal, label: 'Use the partner portal', description: 'For partners: see their own links, referred leads, commissions and payouts' },
  ],
  roleGrants: {
    group_admin: [P.view, P.manage, P.managePlans, P.approveCommissions, P.managePayouts, P.approvePayouts, P.payoutDetails],
    company_admin: [P.view, P.manage, P.managePlans, P.approveCommissions, P.managePayouts, P.approvePayouts, P.payoutDetails],
    manager: [P.view, P.manage],
    counsellor: [`${P.view}:own`],
    account_executive: [`${P.view}:own`],
    finance: [P.view, P.approveCommissions, P.managePayouts, P.approvePayouts, P.payoutDetails],
    marketing: [P.view, P.manage],
    analyst: [P.view],
    // The built-in role partners sign in with. core/systemRoles.js has no entry for it yet: the
    // partners service creates the role row when portal access is first given (ensurePartnerRole)
    // and the seed does the same; the integrator adds { key: 'partner', … } to SYSTEM_ROLES.
    [PARTNER_ROLE_KEY]: [P.portal],
  },
  settings: partnerSettings,
  eventHandlers: partnerEventHandlers,
  routes: (router) => partnerRoutes(router),
};
