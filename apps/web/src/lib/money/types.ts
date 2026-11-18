// Response and request types of the money module (/api/v1/billing/*). The server's presenters
// (apps/api/src/modules/money/present.js) produce exactly these shapes.

import type { Money, UserRef } from '@/lib/crm/types';

export type { Money, UserRef };

export interface BillingDealRef {
  id: string;
  ref: string;
  title: string;
  status: 'open' | 'won' | 'lost';
  kind: 'b2c' | 'b2b' | null;
}

export interface PlaceOfSupply {
  code: string;
  name: string;
}

// ---------- Setup ----------

export type DocumentSeriesType = 'invoice' | 'credit_note' | 'debit_note' | 'bill_of_supply';
export type PlanKind = 'one_time' | 'recurring';
export type PlanUnit = 'flat' | 'seat' | 'student' | 'branch';
export type BillingInterval = 'month' | 'year';
export type Taxability = 'taxable' | 'nil_rated' | 'exempt' | 'non_gst';
export type Audience = 'b2c' | 'b2b';

export interface BillingCompany {
  id: string;
  name: string;
  code: string;
  missing: Array<'gstin' | 'invoice_series' | 'credit_note_series' | 'payment_account'>;
}

export interface BillingAddress {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  pincode?: string;
  country?: string;
}

export interface BillingProfile {
  companyId: string;
  legalName: string;
  tradeName: string | null;
  gstin: string | null;
  stateCode: string;
  stateName: string | null;
  pan: string | null;
  address: BillingAddress;
  email: string | null;
  phone: string | null;
  lutNumber: string | null;
  lutValidUntil: string | null;
  roundOff: boolean;
  invoiceNotes: string | null;
  bankDetails: { accountName?: string; accountNumber?: string; ifsc?: string; bank?: string };
  updatedAt: string | null;
}

export interface NumberSeries {
  id: string;
  companyId: string;
  gstin: string;
  documentType: DocumentSeriesType;
  prefix: string;
  format: string;
  fyStyle: 'long' | 'short' | 'compact' | 'startYear';
  padding: number;
  isDefault: boolean;
  active: boolean;
  example: string | null;
  last: { fyStartYear: number; sequence: number } | null;
}

export interface Plan {
  id: string;
  companyId: string;
  productId: string | null;
  code: string;
  name: string;
  description: string | null;
  kind: PlanKind;
  audience: Audience;
  unit: PlanUnit;
  interval: BillingInterval | null;
  sac: string | null;
  taxRateBp: number;
  taxability: Taxability;
  position: number;
  active: boolean;
}

export interface PriceList {
  id: string;
  companyId: string;
  name: string;
  currency: string;
  pricesIncludeTax: boolean;
  isDefault: boolean;
  active: boolean;
  prices: Array<{ planId: string; unitAmount: Money }>;
}

export interface PaymentAccount {
  id: string;
  companyId: string;
  provider: 'razorpay' | 'stripe';
  label: string;
  scope: 'domestic' | 'international' | 'both';
  mode: 'test' | 'live';
  accountRef: string | null;
  connected: boolean;
  entityCountry: string;
  indiaExports: boolean;
  purposeCode: string | null;
  active: boolean;
}

export interface AgreementTemplate {
  id: string;
  companyId: string;
  key: string;
  name: string;
  audience: Audience;
  body?: string;
  signType: SignType;
  expiresInDays: number;
  active: boolean;
}

export interface DiscountTier {
  label?: string;
  maxPercentBp?: number;
  maxAmountMinor?: number;
  approverRoles: string[];
}

export interface BillingSetup {
  company: { id: string; name: string; code: string };
  profile: BillingProfile | null;
  series: NumberSeries[];
  accounts: PaymentAccount[];
  templates: AgreementTemplate[];
  discountPolicy: { tiers: DiscountTier[]; inheritApprovers: boolean; allowSelfApproval: boolean };
  settings: Record<string, unknown>;
}

// ---------- Quotes ----------

export type QuoteKind = 'quote' | 'fee_proposal';
export type QuoteStatus = 'draft' | 'pending_approval' | 'approved' | 'sent' | 'accepted' | 'declined' | 'expired' | 'cancelled';
export type DiscountStatus = 'none' | 'allowed' | 'needs_approval' | 'approved' | 'rejected' | 'not_allowed';

export interface QuoteLine {
  id: string;
  planId: string | null;
  description: string;
  sac: string | null;
  quantity: number;
  unitPrice: Money;
  discount: Money;
  taxRateBp: number;
  taxability: Taxability;
  taxable: Money;
  tax: Money;
  total: Money;
}

export interface InstalmentOption {
  count: number;
  frequency: 'monthly' | 'custom';
  startDate?: string;
  dayOfMonth?: number;
  intervalMonths?: number;
  dates?: string[];
  firstAmountMinor?: number;
}

export interface Quote {
  id: string | null;
  ref: string | null;
  kind: QuoteKind;
  status: QuoteStatus;
  title: string;
  companyId: string;
  deal: BillingDealRef | null;
  currency: string;
  pricesIncludeTax: boolean;
  priceListId: string | null;
  lines: QuoteLine[];
  recipient: { name?: string; gstin?: string | null; stateCode?: string | null; outsideIndia?: boolean };
  placeOfSupply: PlaceOfSupply | null;
  supplyType: string | null;
  taxKind: 'cgst_sgst' | 'igst' | 'none' | null;
  amounts: { subtotal: Money; discount: Money; taxable: Money; tax: Money; total: Money };
  discount: {
    status: DiscountStatus;
    percentBp: number;
    tierLabel: string | null;
    approverRoles: string[];
    reason: string | null;
    requestedBy: UserRef | null;
    reviewedBy: UserRef | null;
    reviewedAt: string | null;
    note: string | null;
  };
  instalmentOption: InstalmentOption | null;
  instalmentPreview: Array<{ number: number; dueDate: string; amountMinor: number }> | null;
  validUntil: string | null;
  notes: string | null;
  terms: string | null;
  sentAt: string | null;
  acceptedAt: string | null;
  declinedAt: string | null;
  declineReason: string | null;
  createdBy: UserRef | null;
  createdAt: string | null;
  updatedAt: string | null;
  can?: { edit: boolean; send: boolean; accept: boolean; cancel: boolean; approveDiscount: boolean };
}

export interface QuoteLineInput {
  planId?: string | null;
  description?: string;
  quantity?: number;
  unitPriceMinor?: number;
  discountMinor?: number;
  sac?: string | null;
  taxRateBp?: number;
  taxability?: Taxability;
}

export interface QuoteInput {
  dealId: string;
  kind?: QuoteKind;
  title?: string;
  priceListId?: string | null;
  currency?: string;
  lines: QuoteLineInput[];
  recipient?: { name?: string; gstin?: string | null; stateCode?: string | null; outsideIndia?: boolean };
  instalmentOption?: InstalmentOption | null;
  validUntil?: string;
  notes?: string | null;
  discountNote?: string | null;
}

// ---------- Payments, invoices, refunds ----------

export type PaymentStatus = 'creating' | 'link_sent' | 'pending' | 'succeeded' | 'failed' | 'cancelled' | 'expired' | 'error';
export type PaymentPurpose = 'full' | 'instalment' | 'emi' | 'subscription' | 'adjustment';

export interface Payment {
  id: string;
  companyId: string;
  deal: BillingDealRef | null;
  quoteId: string | null;
  instalmentId: string | null;
  subscriptionId: string | null;
  invoiceId: string | null;
  invoiceNumber: string | null;
  purpose: PaymentPurpose;
  provider: 'razorpay' | 'stripe' | 'manual';
  status: PaymentStatus;
  amount: Money;
  refunded: Money;
  method: string | null;
  description: string;
  linkUrl: string | null;
  providerPaymentId: string | null;
  expiresAt: string | null;
  paidAt: string | null;
  failedAt: string | null;
  failure: { code?: string | null; message?: string | null; count?: number } | null;
  attempt: number;
  nextRetryAt: string | null;
  invoiceError: string | null;
  createdBy: UserRef | null;
  createdAt: string;
  can?: { cancel: boolean; resend: boolean; refund: boolean; simulate: boolean; finance: boolean };
}

export interface PaymentLinkInput {
  dealId: string;
  purpose: PaymentPurpose;
  quoteId?: string;
  instalmentId?: string;
  subscriptionId?: string;
  amountMinor?: number;
  currency?: string;
  description?: string;
  idempotencyKey?: string;
  notify?: boolean;
}

export interface InvoiceSummary {
  id: string;
  number: string;
  companyId: string;
  deal: BillingDealRef | null;
  paymentId: string | null;
  documentType: 'tax_invoice' | 'bill_of_supply';
  status: 'issued' | 'cancelled';
  issueDate: string;
  recipientName: string | null;
  supplyType: string;
  taxable: Money;
  tax: Money;
  total: Money;
  credited: Money;
  createdAt: string;
}

export interface TaxComponent {
  rateBp: number;
  amount: Money;
}

export interface CreditNote {
  id: string;
  number: string;
  companyId: string;
  deal: BillingDealRef | null;
  invoiceId: string;
  invoiceNumber: string | null;
  refundId: string | null;
  issueDate: string;
  reason: string;
  mode: 'full' | 'partial';
  status: 'issued' | 'cancelled';
  taxable: Money;
  tax: Money;
  total: Money;
  amountInWords: string;
  createdAt: string;
}

export interface Invoice extends InvoiceSummary {
  supplier: {
    legalName?: string;
    tradeName?: string | null;
    gstin?: string | null;
    stateCode?: string;
    stateName?: string | null;
    pan?: string | null;
    address?: BillingAddress;
    email?: string | null;
    phone?: string | null;
  };
  recipient: { name?: string; gstin?: string | null; stateCode?: string | null; outsideIndia?: boolean };
  placeOfSupply: PlaceOfSupply | null;
  taxKind: 'cgst_sgst' | 'igst' | 'none';
  stateTaxLabel: 'SGST' | 'UTGST' | null;
  currency: string;
  lines: Array<{
    description: string;
    sac: string | null;
    quantity: number;
    gross: Money;
    discount: Money;
    taxable: Money;
    taxRateBp: number;
    taxability: Taxability;
    cgst: TaxComponent;
    sgst: TaxComponent;
    igst: TaxComponent;
    total: Money;
  }>;
  sacSummary: Array<{ sac: string | null; taxRateBp: number | null; taxable: Money; tax: Money }>;
  totals: { gross: Money; discount: Money; taxable: Money; cgst: Money; sgst: Money; igst: Money; tax: Money; roundOff: Money; total: Money };
  amountInWords: string;
  endorsement: string | null;
  notes: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  creditNotes: CreditNote[];
  creditNoteDeadline: string | null;
  can: { cancel: boolean; creditNote: boolean };
}

export type RefundStatus = 'requested' | 'approved' | 'rejected' | 'processing' | 'processed' | 'failed';
export type RefundReason = 'requested_by_customer' | 'duplicate' | 'course_cancelled' | 'service_issue' | 'fee_change' | 'other';

export interface Refund {
  id: string;
  ref: string;
  companyId: string;
  deal: BillingDealRef | null;
  paymentId: string;
  invoiceId: string | null;
  creditNoteId: string | null;
  amount: Money;
  reason: RefundReason;
  note: string | null;
  status: RefundStatus;
  provider: string;
  requestedBy: UserRef | null;
  requestedAt: string;
  reviewedBy: UserRef | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  processedAt: string | null;
  failure: { code?: string | null; message?: string | null } | null;
  createdAt: string;
  can?: { approve: boolean; reject: boolean; retry: boolean };
}

// ---------- Instalments and subscriptions ----------

export type InstalmentState = 'upcoming' | 'due_today' | 'overdue' | 'paid' | 'cancelled';

export interface Instalment {
  id: string;
  planId: string;
  companyId: string;
  deal: BillingDealRef | null;
  number: number;
  count: number | null;
  dueDate: string;
  amount: Money;
  paid: Money;
  outstanding: Money;
  status: 'pending' | 'paid' | 'cancelled';
  state: InstalmentState;
  paidAt: string | null;
  lastReminderAt: string | null;
}

export interface InstalmentPlan {
  id: string;
  quoteId: string | null;
  status: 'active' | 'completed' | 'cancelled' | 'rescheduled';
  total: Money;
  count: number;
  instalments: Instalment[];
}

export type SubscriptionStatus = 'pending' | 'active' | 'past_due' | 'cancelled';

export interface Subscription {
  id: string;
  companyId: string;
  deal: BillingDealRef | null;
  accountId: string | null;
  accountName: string | null;
  planId: string;
  planName: string | null;
  status: SubscriptionStatus;
  quantity: number;
  unit: PlanUnit;
  interval: BillingInterval;
  unitPrice: Money;
  pricesIncludeTax: boolean;
  addons: Array<{ code: string; name: string; quantity: number; unitPrice: Money }>;
  perPeriod: Money;
  startDate: string;
  currentPeriodStart: string;
  renewsOn: string;
  cancelAtPeriodEnd: boolean;
  cancelledAt: string | null;
  cancelReason: string | null;
  renewalCount: number;
  createdAt: string;
  can?: { change: boolean; cancel: boolean; renew: boolean };
  pendingChange?: { quantity?: number; effectiveOn?: string } | null;
  payments?: Array<{ id: string; status: PaymentStatus; purpose: PaymentPurpose; amount: Money; paidAt: string | null; createdAt: string }>;
}

export interface Proration {
  termStart: string;
  termEnd: string;
  changeDate: string;
  termDays: number;
  remainingDays: number;
  direction: 'upgrade' | 'downgrade' | 'none';
  effective: 'now' | 'at_renewal';
  creditMinor: number;
  chargeMinor: number;
  netMinor: number;
}

// ---------- Agreements ----------

export type SignType = 'aadhaar' | 'electronic' | 'dsc';
export type AgreementStatus = 'draft' | 'sent' | 'partially_signed' | 'signed' | 'failed' | 'expired' | 'cancelled';

export interface Agreement {
  id: string;
  ref: string;
  title: string;
  companyId: string;
  deal: BillingDealRef | null;
  quoteId: string | null;
  templateId: string | null;
  status: AgreementStatus;
  signType: SignType;
  provider: string | null;
  signers: Array<{
    name: string;
    role: string;
    order: number;
    identifier: string;
    identifierMasked: boolean;
    status: string;
    signedAt: string | null;
    signUrl: string | null;
  }>;
  expiresAt: string | null;
  sentAt: string | null;
  signedAt: string | null;
  cancelledAt: string | null;
  failure: { code?: string | null; message?: string | null } | null;
  createdBy: UserRef | null;
  createdAt: string;
  body?: string;
  can?: { send: boolean; cancel: boolean; refresh: boolean; simulate: boolean };
}

export interface AgreementInput {
  dealId: string;
  templateId: string;
  quoteId?: string;
  title?: string;
  signers: Array<{ name: string; identifier: string; role: string; order?: number }>;
  send?: boolean;
}

// ---------- Overview and the deal ----------

export interface BillingOverview {
  collectedThisMonth: Array<Money & { count: number }>;
  instalmentsOverdue: number;
  instalmentsDueThisWeek: number;
  refundsAwaitingApproval: number;
  agreementsAwaitingSignature: number;
  discountsAwaitingApproval: number;
  failedPayments: number;
  canApproveRefunds: boolean;
}

export interface DealBilling {
  deal: { id: string; ref: string; title: string; kind: 'b2c' | 'b2b'; status: string; currency: string; companyId: string; value: Money };
  can: { manage: boolean; finance: boolean; approveDiscounts: boolean; approveRefunds: boolean; viewPii: boolean };
  setup: { ready: boolean; missing: string[] };
  totals: { quoted: Money[]; paid: Money[]; refunded: Money[]; due: Money[] };
  quotes: Quote[];
  payments: Payment[];
  instalmentPlans: InstalmentPlan[];
  invoices: InvoiceSummary[];
  refunds: Refund[];
  agreements: Agreement[];
  subscriptions: Subscription[];
  templates: AgreementTemplate[];
  today: string;
}
