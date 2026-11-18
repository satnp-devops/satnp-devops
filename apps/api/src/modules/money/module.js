import { moneySettings } from './settings.js';
import { moneyRoutes } from './routes.js';
import { moneyEventHandlers } from './handlers.js';

// Phase 7, money: plans and price lists, quotes and fee proposals with discount approval,
// agreements and e-sign, payment links (Razorpay for INR, Stripe for international), instalment
// plans, B2B subscriptions, GST invoices, credit notes and refunds with finance approval.
// README.md in this folder explains the flows, the ports the integrator connects and the jobs.

export default {
  name: 'money',
  label: 'Fees and billing',
  permissions: [
    {
      key: 'billing.view',
      label: 'See fees and billing',
      description: 'See quotes, fee proposals, payments, instalments, invoices, agreements and subscriptions of deals',
      supportsOwn: true,
    },
    {
      key: 'billing.manage',
      label: 'Work fees and billing',
      description: 'Make quotes and fee proposals, send payment links and agreements, request refunds',
      supportsOwn: true,
    },
    {
      key: 'billing.approve_discounts',
      label: 'Approve discounts',
      description: 'Approve discounts within the tiers of the discount policy that name your role',
    },
    {
      key: 'billing.finance',
      label: 'Finance operations',
      description: 'Record offline payments, issue credit notes and cancel invoices',
    },
    { key: 'billing.approve_refunds', label: 'Approve refunds', description: 'Approve or reject refunds others have requested' },
    {
      key: 'billing.configure',
      label: 'Set up billing',
      description: 'GSTIN and invoice series, plans and price lists, payment accounts and agreement templates',
    },
  ],
  roleGrants: {
    group_admin: ['billing.view', 'billing.manage', 'billing.approve_discounts', 'billing.finance', 'billing.approve_refunds', 'billing.configure'],
    company_admin: ['billing.view', 'billing.manage', 'billing.approve_discounts', 'billing.finance', 'billing.configure'],
    manager: ['billing.view', 'billing.manage', 'billing.approve_discounts'],
    counsellor: ['billing.view:own', 'billing.manage:own'],
    account_executive: ['billing.view:own', 'billing.manage:own'],
    finance: ['billing.view', 'billing.finance', 'billing.approve_refunds'],
    support: ['billing.view'],
    analyst: ['billing.view'],
  },
  settings: moneySettings,
  eventHandlers: moneyEventHandlers,
  routes: (router) => moneyRoutes(router),
};
