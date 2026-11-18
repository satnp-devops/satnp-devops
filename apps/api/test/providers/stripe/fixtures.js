/**
 * Realistic Stripe webhook payloads (shapes from docs.stripe.com API reference, API version
 * 2026-10-28.endive, plus pre-2025-03-31.basil invoice fields). Ids and values are made up.
 */

export const CREATED = 1762300800; // 2025-11-05T00:00:00Z

/**
 * @param {string} type
 * @param {object} object
 * @param {object} [overrides]
 */
export function snapshotEvent(type, object, overrides = {}) {
  return {
    id: `evt_1SPhx${type.replace(/[^a-z]/g, '').slice(0, 10)}A1b2C3`,
    object: 'event',
    api_version: '2026-10-28.endive',
    created: CREATED,
    data: { object },
    livemode: false,
    pending_webhooks: 1,
    request: { id: 'req_8Hd2kLmQx9', idempotency_key: '0c9a3f1e-5b7d-4e2a-9c1f-2d3e4f5a6b7c' },
    type,
    ...overrides,
  };
}

export const checkoutSessionPaid = {
  id: 'cs_test_a1B2c3D4e5F6g7H8i9J0',
  object: 'checkout.session',
  amount_subtotal: 250000,
  amount_total: 250000,
  billing_address_collection: 'required',
  cancel_url: 'https://crm.phoenix.test/pay/cancel',
  client_reference_id: 'lead_01JBX7',
  created: CREATED - 120,
  currency: 'usd',
  customer: 'cus_RkT9aBcDeF',
  customer_creation: 'if_required',
  customer_details: {
    address: { city: 'Dubai', country: 'AE', line1: 'Al Wasl Rd', line2: null, postal_code: null, state: null },
    email: 'parent@example.com',
    name: 'Aisha Khan',
    phone: null,
    tax_exempt: 'none',
    tax_ids: [],
  },
  customer_email: null,
  expires_at: CREATED + 86280,
  invoice: null,
  livemode: false,
  locale: null,
  metadata: { phoenix_payment_id: 'pay_01JBX8', company: 'phoenix-academy' },
  mode: 'payment',
  payment_intent: 'pi_3SPhxQ2eZvKYlo2C1aBcDeFg',
  payment_link: null,
  payment_method_types: ['card'],
  payment_status: 'paid',
  status: 'complete',
  subscription: null,
  success_url: 'https://crm.phoenix.test/pay/success',
  total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: 0 },
  ui_mode: 'hosted_page',
  url: null,
};

export const checkoutSessionUnpaidJpy = {
  ...checkoutSessionPaid,
  id: 'cs_test_jpy000000000000001',
  amount_subtotal: 5000,
  amount_total: 5000,
  currency: 'jpy',
  payment_status: 'unpaid',
  payment_link: 'plink_1SPhxQ2eZvKYlo2C',
  customer: null,
  customer_details: { email: 'buyer@example.jp', name: 'Sato Ken', address: null },
};

export const paymentIntentSucceeded = {
  id: 'pi_3SPhxQ2eZvKYlo2C1aBcDeFg',
  object: 'payment_intent',
  amount: 250000,
  amount_capturable: 0,
  amount_received: 250000,
  currency: 'usd',
  customer: 'cus_RkT9aBcDeF',
  description: 'Admission fee - Grade 6 - Phoenix Academy',
  last_payment_error: null,
  latest_charge: 'ch_3SPhxQ2eZvKYlo2C1xYz',
  livemode: false,
  metadata: { phoenix_payment_id: 'pay_01JBX8' },
  payment_method: 'pm_1SPhxQ2eZvKYlo2CaBc',
  status: 'succeeded',
};

export const paymentIntentFailed = {
  ...paymentIntentSucceeded,
  id: 'pi_3SPhxFAIL2eZvKYlo2C',
  amount_received: 0,
  latest_charge: { id: 'ch_3SPhxFAILcharge', object: 'charge' },
  status: 'requires_payment_method',
  last_payment_error: {
    code: 'card_declined',
    decline_code: 'insufficient_funds',
    doc_url: 'https://docs.stripe.com/error-codes/card-declined',
    message: 'Your card has insufficient funds.',
    type: 'card_error',
  },
};

/** API 2025-03-31.basil and later: subscription under parent.subscription_details. */
export const invoicePaid = {
  id: 'in_1SPhxQ2eZvKYlo2CinV1',
  object: 'invoice',
  amount_due: 9900,
  amount_paid: 9900,
  amount_remaining: 0,
  attempt_count: 1,
  billing_reason: 'subscription_cycle',
  currency: 'usd',
  customer: 'cus_InstituteA1',
  customer_email: 'accounts@institute.example',
  hosted_invoice_url: 'https://invoice.stripe.com/i/acct_test/test_inv1',
  metadata: {},
  next_payment_attempt: null,
  number: 'PHX-0042',
  parent: {
    quote_details: null,
    subscription_details: { metadata: {}, subscription: 'sub_1SPhxQ2eZvKYlo2CsUb1' },
    type: 'subscription_details',
  },
  payments: {
    object: 'list',
    data: [{ id: 'inpay_1', object: 'invoice_payment', payment: { type: 'payment_intent', payment_intent: 'pi_3SPhxINV2eZvKYlo2C' } }],
  },
  status: 'paid',
};

/** Older API versions: top-level subscription and payment_intent. */
export const invoicePaymentFailedLegacy = {
  id: 'in_1OLDxQ2eZvKYlo2CinV2',
  object: 'invoice',
  amount_due: 9900,
  amount_paid: 0,
  attempt_count: 2,
  billing_reason: 'subscription_cycle',
  charge: 'ch_3OLDxQ2eZvKYlo2C',
  currency: 'usd',
  customer: 'cus_InstituteA1',
  customer_email: 'accounts@institute.example',
  hosted_invoice_url: 'https://invoice.stripe.com/i/acct_test/test_inv2',
  metadata: { plan: 'crm-pro' },
  next_payment_attempt: CREATED + 259200,
  number: 'PHX-0043',
  paid: false,
  payment_intent: 'pi_3OLDxQ2eZvKYlo2C',
  status: 'open',
  subscription: 'sub_1SPhxQ2eZvKYlo2CsUb1',
};

export const chargePartiallyRefunded = {
  id: 'ch_3SPhxQ2eZvKYlo2C1xYz',
  object: 'charge',
  amount: 250000,
  amount_captured: 250000,
  amount_refunded: 50000,
  billing_details: { email: 'parent@example.com', name: 'Aisha Khan' },
  captured: true,
  currency: 'usd',
  customer: 'cus_RkT9aBcDeF',
  failure_code: null,
  failure_message: null,
  metadata: { phoenix_payment_id: 'pay_01JBX8' },
  paid: true,
  payment_intent: 'pi_3SPhxQ2eZvKYlo2C1aBcDeFg',
  receipt_email: null,
  refunded: false,
  status: 'succeeded',
};

export const chargeFullyRefunded = { ...chargePartiallyRefunded, amount_refunded: 250000, refunded: true };

export const subscriptionDeleted = {
  id: 'sub_1SPhxQ2eZvKYlo2CsUb1',
  object: 'subscription',
  cancel_at_period_end: false,
  canceled_at: CREATED - 60,
  currency: 'usd',
  customer: 'cus_InstituteA1',
  items: {
    object: 'list',
    data: [
      {
        id: 'si_1',
        object: 'subscription_item',
        current_period_end: CREATED + 2592000,
        price: { id: 'price_1Pro', object: 'price', currency: 'usd', unit_amount: 9900, recurring: { interval: 'month', interval_count: 1 } },
        quantity: 1,
      },
    ],
  },
  latest_invoice: 'in_1SPhxQ2eZvKYlo2CinV1',
  metadata: { institute: 'inst_77' },
  status: 'canceled',
};

/** Thin event (docs.stripe.com/events/how-events-work), as delivered to a thin destination. */
export const thinEvent = {
  id: 'evt_test_65UIRNU7G1XbhCfOim416TgmEI4ASQ3jHxXt8RFwXoeVwO',
  object: 'v2.core.event',
  type: 'v2.core.account.updated',
  livemode: false,
  created: '2026-03-09T13:00:28.435Z',
  context: null,
  reason: { type: 'request', request: { id: 'req_v2y9y15XqG3Futmjg', idempotency_key: 'ik_TgmEI3jHxXt8RFw4jS7ve2QcAReDQWBjPAkAEUm' } },
  related_object: { id: 'acct_1T93Q4Pmpb34Vto6', type: 'v2.core.account', url: '/v2/core/accounts/acct_1T93Q4Pmpb34Vto6' },
};
