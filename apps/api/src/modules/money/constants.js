// Vocabularies of the money module (phase 7). The migration builds its check constraints from
// these lists, so code and database agree.

export const PLAN_KINDS = Object.freeze(['one_time', 'recurring']);
export const PLAN_UNITS = Object.freeze(['flat', 'seat', 'student', 'branch']);
export const BILLING_INTERVALS = Object.freeze(['month', 'year']);
export const TAXABILITIES = Object.freeze(['taxable', 'nil_rated', 'exempt', 'non_gst']);
export const AUDIENCES = Object.freeze(['b2c', 'b2b']);

export const QUOTE_KINDS = Object.freeze(['quote', 'fee_proposal']);
export const QUOTE_STATUSES = Object.freeze([
  'draft',
  'pending_approval',
  'approved',
  'sent',
  'accepted',
  'declined',
  'expired',
  'cancelled',
]);
/** Statuses in which a quote's lines and discount can still change. */
export const EDITABLE_QUOTE_STATUSES = Object.freeze(['draft', 'pending_approval', 'approved']);
export const DISCOUNT_STATUSES = Object.freeze(['none', 'allowed', 'needs_approval', 'approved', 'rejected', 'not_allowed']);

export const PAYMENT_PROVIDERS = Object.freeze(['razorpay', 'stripe', 'manual']);
export const GATEWAY_PROVIDERS = Object.freeze(['razorpay', 'stripe']);
export const PAYMENT_PURPOSES = Object.freeze(['full', 'instalment', 'emi', 'subscription', 'adjustment']);
export const PAYMENT_STATUSES = Object.freeze([
  'creating', // row written, provider call in flight
  'link_sent', // link created, waiting for the payer
  'pending', // payer started, provider still deciding
  'succeeded',
  'failed', // last attempt failed; a retry may follow
  'cancelled',
  'expired',
  'error', // the provider refused to create the link
]);
/** Payments whose link can still be paid. */
export const OPEN_PAYMENT_STATUSES = Object.freeze(['creating', 'link_sent', 'pending', 'failed']);
export const PAYMENT_METHODS = Object.freeze(['upi', 'card', 'netbanking', 'wallet', 'emi', 'bank_transfer', 'cash', 'cheque', 'paylater', 'other']);

export const INVOICE_STATUSES = Object.freeze(['issued', 'cancelled']);
export const SERIES_DOCUMENT_TYPES = Object.freeze(['invoice', 'credit_note', 'debit_note', 'bill_of_supply']);
export const FY_STYLE_KEYS = Object.freeze(['long', 'short', 'compact', 'startYear']);

export const INSTALMENT_PLAN_STATUSES = Object.freeze(['active', 'completed', 'cancelled', 'rescheduled']);
export const INSTALMENT_STATUSES = Object.freeze(['pending', 'paid', 'cancelled']);

export const SUBSCRIPTION_STATUSES = Object.freeze(['pending', 'active', 'past_due', 'cancelled']);

export const REFUND_STATUSES = Object.freeze(['requested', 'approved', 'rejected', 'processing', 'processed', 'failed']);
export const REFUND_REASONS = Object.freeze(['requested_by_customer', 'duplicate', 'course_cancelled', 'service_issue', 'fee_change', 'other']);

export const AGREEMENT_STATUSES = Object.freeze(['draft', 'sent', 'partially_signed', 'signed', 'failed', 'expired', 'cancelled']);
export const SIGNER_STATUSES = Object.freeze(['pending', 'waiting', 'signed', 'failed', 'rejected', 'expired', 'cancelled']);
export const SIGN_TYPES = Object.freeze(['aadhaar', 'electronic', 'dsc']);
export const SIGNER_ROLES = Object.freeze(['parent', 'guardian', 'student', 'signatory', 'witness', 'company']);

export const ACCOUNT_SCOPES = Object.freeze(['domestic', 'international', 'both']);

export const ESIGN_PROVIDERS = Object.freeze(['digio']);

/**
 * Built-in roles that stand in for more junior ones when approving discounts: a company admin may
 * approve what a manager may. Custom roles approve only the tiers that name them.
 */
export const SENIOR_ROLES = Object.freeze({
  group_owner: ['group_admin', 'company_admin', 'manager', 'finance'],
  group_admin: ['company_admin', 'manager'],
  company_admin: ['manager'],
});

/** Sequence names in crm_sequences (per company) for human references. */
export const SEQUENCES = Object.freeze({ quote: 'quote', agreement: 'agreement', refund: 'refund' });
