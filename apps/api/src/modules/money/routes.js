import { validate } from '../../lib/validate.js';
import { requireAuth } from '../../core/guards.js';
import { describe } from '../../core/openapi/describe.js';
import * as s from './schemas.js';
import * as config from './config.js';
import * as quotes from './quotes.js';
import * as payments from './payments.js';
import * as documents from './documents.js';
import * as refunds from './refunds.js';
import * as instalments from './instalments.js';
import * as subscriptions from './subscriptions.js';
import * as agreements from './agreements.js';
import { dealBilling } from './dealBilling.js';
import { simulatePayment } from './webhooks.js';

// Endpoints of the money module, all under /api/v1/billing. Literal paths come before /:id ones.
// Webhooks are not routes here: the webhook receiver calls handlePaymentWebhook and
// handleEsignWebhook with the raw body (README.md, "Wiring").

export function moneyRoutes(router) {
  const route = (method, path, meta, schemas, handler) =>
    router[method](path, describe(meta), requireAuth(), validate(schemas), handler);
  const data = (fn) => async (req, res) => res.json({ data: await fn(req) });
  const created = (fn) => async (req, res) => res.status(201).json({ data: await fn(req) });
  const page = (fn) => async (req, res) => {
    const { data: rows, nextCursor } = await fn(req);
    res.json({ data: rows, nextCursor });
  };
  const id = (req) => req.valid.params.id;
  const body = (req) => req.valid.body;
  const query = (req) => req.valid.query;

  // ---------- Setup (Settings > Billing) ----------
  route('get', '/billing/companies', { summary: 'List companies with their billing setup state', permission: 'billing.configure' }, { query: s.overviewQuery }, data((req) => config.listBillingCompanies(req, query(req).unitId)));
  route('get', '/billing/setup', { summary: 'Get a company billing setup', permission: 'billing.configure' }, { query: s.companyQuery }, data((req) => config.getSetup(req, query(req).companyId)));
  route('put', '/billing/profile', { summary: 'Save the company billing profile (GSTIN)', permission: 'billing.configure' }, { body: s.profileBody }, data((req) => config.putProfile(req, body(req))));
  route('post', '/billing/series', { summary: 'Add an invoice number series', permission: 'billing.configure', status: 201 }, { body: s.seriesBody }, created((req) => config.createSeries(req, body(req))));
  route('patch', '/billing/series/:id', { summary: 'Update an invoice number series', permission: 'billing.configure' }, { params: s.idParams, body: s.seriesPatchBody }, data((req) => config.updateSeries(req, id(req), body(req))));
  route('get', '/billing/plans', { summary: 'List plans', permission: ['billing.view', 'billing.configure'] }, { query: s.unitOrCompanyQuery }, data((req) => config.listPlans(req, query(req))));
  route('post', '/billing/plans', { summary: 'Add a plan', permission: 'billing.configure', status: 201 }, { body: s.planBody }, created((req) => config.createPlan(req, body(req))));
  route('patch', '/billing/plans/:id', { summary: 'Update a plan', permission: 'billing.configure' }, { params: s.idParams, body: s.planPatchBody }, data((req) => config.updatePlan(req, id(req), body(req))));
  route('get', '/billing/price-lists', { summary: 'List price lists with their prices', permission: ['billing.view', 'billing.configure'] }, { query: s.unitOrCompanyQuery }, data((req) => config.listPriceLists(req, query(req))));
  route('post', '/billing/price-lists', { summary: 'Add a price list', permission: 'billing.configure', status: 201 }, { body: s.priceListBody }, created((req) => config.createPriceList(req, body(req))));
  route('patch', '/billing/price-lists/:id', { summary: 'Update a price list and its prices', permission: 'billing.configure' }, { params: s.idParams, body: s.priceListPatchBody }, data((req) => config.updatePriceList(req, id(req), body(req))));
  route('post', '/billing/payment-accounts', { summary: 'Add a payment account', permission: 'billing.configure', status: 201 }, { body: s.paymentAccountBody }, created((req) => config.createAccount(req, body(req))));
  route('patch', '/billing/payment-accounts/:id', { summary: 'Update a payment account', permission: 'billing.configure' }, { params: s.idParams, body: s.paymentAccountPatchBody }, data((req) => config.updateAccount(req, id(req), body(req))));
  route('get', '/billing/agreement-templates', { summary: 'List agreement templates', permission: ['billing.view', 'billing.configure'] }, { query: s.unitOrCompanyQuery }, data((req) => config.listTemplates(req, query(req))));
  route('post', '/billing/agreement-templates', { summary: 'Add an agreement template', permission: 'billing.configure', status: 201 }, { body: s.templateBody }, created((req) => config.createTemplate(req, body(req))));
  route('patch', '/billing/agreement-templates/:id', { summary: 'Update an agreement template', permission: 'billing.configure' }, { params: s.idParams, body: s.templatePatchBody }, data((req) => config.updateTemplate(req, id(req), body(req))));

  // ---------- Overview and the deal profile ----------
  route('get', '/billing/overview', { summary: 'Fees and billing figures for a working unit', permission: 'billing.view' }, { query: s.overviewQuery }, data((req) => payments.billingOverview(req, query(req).unitId)));
  route('get', '/billing/deals/:dealId', { summary: 'Everything billing holds for a deal', permission: 'billing.view' }, { params: s.dealParams }, data((req) => dealBilling(req, req.valid.params.dealId)));

  // ---------- Quotes and fee proposals ----------
  route('get', '/billing/quotes', { summary: 'List quotes and fee proposals', permission: 'billing.view', list: true }, { query: s.quoteListQuery }, page((req) => quotes.listQuotes(req, query(req))));
  route('post', '/billing/quotes/preview', { summary: 'Price a quote without saving it', permission: 'billing.manage' }, { body: s.quotePreviewBody }, data((req) => quotes.previewQuote(req, body(req))));
  route('post', '/billing/quotes', { summary: 'Create a quote or fee proposal', permission: 'billing.manage', status: 201, description: 'Emits quote.created, and quote.discount_requested when the discount needs approval.' }, { body: s.quoteBody }, created((req) => quotes.createQuote(req, body(req))));
  route('get', '/billing/quotes/:id', { summary: 'Get a quote', permission: 'billing.view' }, { params: s.idParams }, data((req) => quotes.getQuote(req, id(req))));
  route('patch', '/billing/quotes/:id', { summary: 'Edit a quote', permission: 'billing.manage' }, { params: s.idParams, body: s.quotePatchBody }, data((req) => quotes.updateQuote(req, id(req), body(req))));
  route('post', '/billing/quotes/:id/approve-discount', { summary: 'Approve a discount', permission: 'billing.approve_discounts' }, { params: s.idParams, body: s.reviewBody }, data((req) => quotes.reviewDiscount(req, id(req), { approve: true, note: body(req).note })));
  route('post', '/billing/quotes/:id/reject-discount', { summary: 'Reject a discount', permission: 'billing.approve_discounts' }, { params: s.idParams, body: s.reviewBody }, data((req) => quotes.reviewDiscount(req, id(req), { approve: false, note: body(req).note })));
  route('post', '/billing/quotes/:id/send', { summary: 'Send a quote to the customer', permission: 'billing.manage', description: 'Emits quote.sent.' }, { params: s.idParams }, data((req) => quotes.sendQuote(req, id(req))));
  route('post', '/billing/quotes/:id/accept', { summary: 'Record that the customer accepted a quote', permission: 'billing.manage', description: 'Emits quote.accepted; a fee proposal with an instalment option gets its plan.' }, { params: s.idParams }, data((req) => quotes.acceptQuote(req, id(req))));
  route('post', '/billing/quotes/:id/decline', { summary: 'Record that the customer declined a quote', permission: 'billing.manage' }, { params: s.idParams, body: s.declineBody }, data((req) => quotes.declineQuote(req, id(req), body(req))));
  route('post', '/billing/quotes/:id/cancel', { summary: 'Cancel a quote', permission: 'billing.manage' }, { params: s.idParams }, data((req) => quotes.cancelQuote(req, id(req))));

  // ---------- Payments ----------
  route('get', '/billing/payments', { summary: 'List payments', permission: 'billing.view', list: true }, { query: s.paymentListQuery }, page((req) => payments.listPayments(req, query(req))));
  route('post', '/billing/payments/links', { summary: 'Create a payment link', permission: 'billing.manage', status: 201, description: 'Razorpay for INR, Stripe (or Razorpay international) for other currencies. Emits payment.link_created.', errors: [409, 502, 503] }, { body: s.paymentLinkBody }, created((req) => payments.createPaymentLink(req, body(req))));
  route('post', '/billing/payments/manual', { summary: 'Record an offline payment', permission: 'billing.finance', status: 201, description: 'Emits payment.succeeded and issues the GST invoice.' }, { body: s.manualPaymentBody }, created((req) => payments.recordManualPayment(req, body(req))));
  route('get', '/billing/payments/:id', { summary: 'Get a payment', permission: 'billing.view' }, { params: s.idParams }, data((req) => payments.getPayment(req, id(req))));
  route('post', '/billing/payments/:id/cancel', { summary: 'Cancel a payment link', permission: 'billing.manage' }, { params: s.idParams }, data((req) => payments.cancelPayment(req, id(req))));
  route('post', '/billing/payments/:id/resend', { summary: 'Send a payment link again', permission: 'billing.manage' }, { params: s.idParams }, data((req) => payments.resendPayment(req, id(req))));
  route('post', '/billing/payments/:id/invoice', { summary: 'Issue the invoice of a payment received before billing was set up', permission: 'billing.finance', status: 201 }, { params: s.idParams }, created((req) => documents.issueMissingInvoice(req, id(req))));
  route(
    'post',
    '/billing/payments/:id/simulate',
    { summary: 'Simulate the provider completing or failing a payment (development only)', permission: 'billing.manage', description: 'Refused in production and for accounts with a real provider connection.' },
    { params: s.idParams, body: s.simulateBody },
    data(async (req) => {
      await simulatePayment(req, id(req), body(req));
      return payments.getPayment(req, id(req));
    }),
  );

  // ---------- Invoices and credit notes ----------
  route('get', '/billing/invoices', { summary: 'List GST invoices', permission: 'billing.view', list: true }, { query: s.invoiceListQuery }, page((req) => documents.listInvoices(req, query(req))));
  route('get', '/billing/invoices/:id', { summary: 'Get an invoice, ready to print', permission: 'billing.view' }, { params: s.idParams }, data((req) => documents.getInvoice(req, id(req))));
  route('post', '/billing/invoices/:id/cancel', { summary: 'Cancel an invoice', permission: 'billing.finance' }, { params: s.idParams, body: s.cancelInvoiceBody }, data((req) => documents.cancelInvoice(req, id(req), body(req))));
  route('post', '/billing/invoices/:id/credit-notes', { summary: 'Issue a credit note against an invoice', permission: 'billing.finance', status: 201 }, { params: s.idParams, body: s.creditNoteBody }, created((req) => documents.createCreditNote(req, id(req), body(req))));
  route('get', '/billing/credit-notes', { summary: 'List credit notes', permission: 'billing.view', list: true }, { query: s.listQuery }, page((req) => documents.listCreditNotes(req, query(req))));

  // ---------- Instalments ----------
  route('get', '/billing/instalments', { summary: 'List instalments due, overdue, upcoming or paid', permission: 'billing.view', list: true }, { query: s.instalmentListQuery }, page((req) => instalments.listInstalments(req, query(req))));
  route('get', '/billing/instalment-plans/:id', { summary: 'Get an instalment plan', permission: 'billing.view' }, { params: s.idParams }, data((req) => instalments.planSummary(req, id(req))));
  route('post', '/billing/instalment-plans/:id/reschedule', { summary: 'Reschedule what is left of an instalment plan', permission: 'billing.manage' }, { params: s.idParams, body: s.rescheduleBody }, data((req) => instalments.reschedulePlan(req, id(req), body(req))));

  // ---------- Refunds ----------
  route('get', '/billing/refunds', { summary: 'List refunds', permission: 'billing.view', list: true }, { query: s.refundListQuery }, page((req) => refunds.listRefunds(req, query(req))));
  route('post', '/billing/refunds', { summary: 'Request a refund', permission: 'billing.manage', status: 201, description: 'Needs approval by someone else with billing.approve_refunds. Emits refund.requested.' }, { body: s.refundBody }, created((req) => refunds.requestRefund(req, body(req))));
  route('get', '/billing/refunds/:id', { summary: 'Get a refund', permission: 'billing.view' }, { params: s.idParams }, data((req) => refunds.getRefund(req, id(req))));
  route('post', '/billing/refunds/:id/approve', { summary: 'Approve a refund and send it to the provider', permission: 'billing.approve_refunds', description: 'Emits refund.approved, then refund.processed when the money goes back.' }, { params: s.idParams, body: s.reviewBody }, data((req) => refunds.reviewRefund(req, id(req), { approve: true, note: body(req).note })));
  route('post', '/billing/refunds/:id/reject', { summary: 'Reject a refund', permission: 'billing.approve_refunds' }, { params: s.idParams, body: s.reviewBody }, data((req) => refunds.reviewRefund(req, id(req), { approve: false, note: body(req).note })));
  route('post', '/billing/refunds/:id/retry', { summary: 'Retry a failed refund', permission: 'billing.approve_refunds' }, { params: s.idParams }, data((req) => refunds.retryRefund(req, id(req))));

  // ---------- Subscriptions ----------
  route('get', '/billing/subscriptions', { summary: 'List subscriptions', permission: 'billing.view', list: true }, { query: s.subscriptionListQuery }, page((req) => subscriptions.listSubscriptions(req, query(req))));
  route('post', '/billing/subscriptions', { summary: 'Start a subscription', permission: 'billing.manage', status: 201, description: 'Emits subscription.created; the first payment activates it.' }, { body: s.subscriptionBody }, created((req) => subscriptions.createSubscription(req, body(req))));
  route('get', '/billing/subscriptions/:id', { summary: 'Get a subscription', permission: 'billing.view' }, { params: s.idParams }, data((req) => subscriptions.getSubscription(req, id(req))));
  route('patch', '/billing/subscriptions/:id', { summary: 'Change seats or add-ons (prorated)', permission: 'billing.manage' }, { params: s.idParams, body: s.subscriptionPatchBody }, data((req) => subscriptions.changeSubscription(req, id(req), body(req))));
  route('post', '/billing/subscriptions/:id/cancel', { summary: 'Cancel a subscription', permission: 'billing.manage', description: 'Emits subscription.cancelled (or subscription.cancel_scheduled at period end).' }, { params: s.idParams, body: s.subscriptionCancelBody }, data((req) => subscriptions.cancelSubscription(req, id(req), body(req))));
  route('post', '/billing/subscriptions/:id/renew', { summary: 'Send the renewal payment link now', permission: 'billing.manage' }, { params: s.idParams }, data((req) => subscriptions.renewSubscription(req, id(req))));

  // ---------- Agreements and e-sign ----------
  route('get', '/billing/agreements', { summary: 'List agreements', permission: 'billing.view', list: true }, { query: s.agreementListQuery }, page((req) => agreements.listAgreements(req, query(req))));
  route('post', '/billing/agreements', { summary: 'Create an agreement from a template', permission: 'billing.manage', status: 201 }, { body: s.agreementBody }, created((req) => agreements.createAgreement(req, body(req))));
  route('get', '/billing/agreements/:id', { summary: 'Get an agreement', permission: 'billing.view' }, { params: s.idParams }, data((req) => agreements.getAgreement(req, id(req))));
  route('post', '/billing/agreements/:id/send', { summary: 'Send an agreement for e-sign', permission: 'billing.manage', errors: [502, 503] }, { params: s.idParams }, data((req) => agreements.sendAgreement(req, id(req))));
  route('post', '/billing/agreements/:id/cancel', { summary: 'Cancel an agreement', permission: 'billing.manage' }, { params: s.idParams, body: s.agreementCancelBody }, data((req) => agreements.cancelAgreement(req, id(req), body(req))));
  route('post', '/billing/agreements/:id/refresh', { summary: 'Fetch the e-sign status from the provider', permission: 'billing.manage' }, { params: s.idParams }, data((req) => agreements.refreshAgreement(req, id(req))));
  route('post', '/billing/agreements/:id/simulate', { summary: 'Simulate e-sign completing or failing (development only)', permission: 'billing.manage', description: 'Refused in production and for accounts with a real provider connection.' }, { params: s.idParams, body: s.agreementSimulateBody }, data((req) => agreements.simulateAgreement(req, id(req), body(req))));
}
