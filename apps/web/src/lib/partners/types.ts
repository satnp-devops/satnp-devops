// Request and response types of the partners API (apps/api/src/modules/partners/present.js).
// Times are ISO 8601 UTC strings, dates YYYY-MM-DD, money { valueMinor, currency }.

export interface MoneyValue {
  valueMinor: number;
  currency: string;
}

export interface CompanyRef {
  id: string;
  name: string;
  code: string;
}

export interface UnitRef {
  id: string;
  name: string;
  type: string;
}

export interface UserRef {
  id: string;
  name: string;
}

export type PartnerKind = 'person' | 'organisation';
export type PartnershipStatus = 'pending' | 'active' | 'suspended' | 'terminated';
export type PayoutMethod = 'bank_transfer' | 'upi';

export interface PartnerRef {
  id: string;
  name: string;
  kind: PartnerKind;
}

/** The masked summary of where a partner's money goes. Never the full number. */
export interface PayoutHint {
  method: PayoutMethod;
  accountName: string | null;
  accountLast4: string | null;
  ifsc: string | null;
  bankName: string | null;
  upi: string | null;
  panOnFile: boolean;
  gstin: string | null;
  summary: string | null;
}

export interface Partnership {
  id: string;
  company: CompanyRef | null;
  unit: UnitRef | null;
  owner: UserRef | null;
  status: PartnershipStatus;
  commissionPlan: { id: string; name: string } | null;
  joinedAt: string;
  endedAt: string | null;
}

export interface PartnerSummary {
  id: string;
  kind: PartnerKind;
  name: string;
  code: string | null;
  legalName: string | null;
  city: string | null;
  email: string | null;
  phone: string | null;
  piiMasked: boolean;
  /** The partnerships the viewer can see. */
  companies: Partnership[];
  /** Whether the partner's portal sign-in covers a partnership the viewer can see. */
  hasPortalAccess: boolean;
  payout: PayoutHint | null;
  createdAt: string;
  updatedAt: string;
}

export interface PartnerDetail extends PartnerSummary {
  notes: string | null;
  contactId: string | null;
  accountId: string | null;
  portalUser: { id: string; email: string | null; status: 'invited' | 'active' | 'disabled' } | null;
  stats: {
    activeLinks: number;
    referredLeads: number;
    /** Payable totals per commission status, one entry per currency. */
    commissions: Partial<Record<CommissionStatus, MoneyValue[]>>;
  };
  /**
   * payoutDetails: read the bank details (audited). changePayoutDetails: change them, which needs
   * the permission at every company the partner works with (they are shared).
   */
  can: { manage: boolean; payoutDetails: boolean; changePayoutDetails: boolean; approveCommissions: boolean };
}

export interface PartnerInput {
  unitId: string;
  kind: PartnerKind;
  name: string;
  code?: string | null;
  legalName?: string | null;
  email?: string | null;
  phone?: string | null;
  city?: string | null;
  notes?: string | null;
  ownerUserId?: string | null;
  status?: 'pending' | 'active';
  commissionPlanId?: string | null;
}

export interface PartnershipPatch {
  unitId?: string;
  ownerUserId?: string | null;
  status?: PartnershipStatus;
  commissionPlanId?: string | null;
}

export type PayoutDetailsInput =
  | { method: 'bank_transfer'; accountName: string; accountNumber: string; ifsc: string; bankName?: string; pan?: string; gstin?: string }
  | { method: 'upi'; accountName?: string; upiId: string; pan?: string; gstin?: string };

export interface PayoutDetailsRead {
  details: PayoutDetailsInput | null;
  updatedAt: string | null;
}

export interface PortalAccessResult {
  partner: PartnerDetail;
  /** Development only: the invitation link, so nobody waits for email. */
  inviteUrl: string | null;
}

// ---------- Referral links ----------

export interface Utm {
  source?: string;
  medium?: string;
  campaign?: string;
  term?: string;
  content?: string;
}

export interface ReferralLink {
  id: string;
  code: string;
  label: string | null;
  partner: PartnerRef;
  company: CompanyRef | null;
  productLine: { id: string; name: string } | null;
  landingUrl: string | null;
  /** The landing page (the link's own, else the company's default) with ref and UTM tags. */
  shareUrl: string | null;
  utm: Utm;
  active: boolean;
  createdByPartner: boolean;
  leadCount: number;
  createdAt: string;
  deactivatedAt: string | null;
}

export interface ReferralLinkInput {
  partnerId: string;
  companyId: string;
  code?: string;
  label?: string | null;
  productLineId?: string | null;
  landingUrl?: string | null;
  utm?: Utm;
}

// ---------- Attributions ----------

export interface DealRef {
  id: string;
  ref: string;
  /** Null when the viewer can't see the deal itself. */
  title: string | null;
  status: 'open' | 'won' | 'lost';
  visible: boolean;
}

export type Touch = 'first' | 'last';
export type AttributionSource = 'referral_link' | 'partner_code' | 'manual';

export interface Attribution {
  id: string;
  touch: Touch;
  /** With onePerLead: this first-touch row also stands for the partner's last touch. */
  bothTouches: boolean;
  source: AttributionSource;
  code: string | null;
  partner: PartnerRef;
  company: CompanyRef | null;
  deal: DealRef;
  contact: { id: string; displayName: string; primaryPhone: string | null; piiMasked: boolean } | null;
  referralLinkId: string | null;
  touchedAt: string;
  createdAt: string;
}

// ---------- Commission plans ----------

export type PlanBasis = 'percent' | 'fixed';
export type PlanTrigger = 'first_payment' | 'full_payment';

export interface CommissionPlan {
  id: string;
  companyId: string;
  company: CompanyRef | null;
  productLine: { id: string; name: string } | null;
  name: string;
  description: string | null;
  basis: PlanBasis;
  rateBps: number | null;
  fixed: MoneyValue | null;
  currency: string | null;
  trigger: PlanTrigger;
  clawbackDays: number;
  cap: MoneyValue | null;
  active: boolean;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface CommissionPlanInput {
  companyId?: string;
  name?: string;
  description?: string | null;
  productLineId?: string | null;
  basis?: PlanBasis;
  rateBps?: number | null;
  fixedMinor?: number | null;
  currency?: string | null;
  trigger?: PlanTrigger;
  clawbackDays?: number;
  capMinor?: number | null;
  active?: boolean;
  position?: number;
}

// ---------- Commissions ----------

export type CommissionStatus = 'pending' | 'approved' | 'rejected' | 'paid' | 'clawed_back';

export interface Commission {
  id: string;
  status: CommissionStatus;
  partner: PartnerRef;
  company: CompanyRef | null;
  deal: DealRef;
  plan: { id: string; name: string };
  trigger: PlanTrigger;
  basis: PlanBasis;
  rateBps: number | null;
  base: MoneyValue;
  amount: MoneyValue;
  clawedBack: MoneyValue;
  payable: MoneyValue;
  paymentId: string;
  earnedAt: string;
  clawbackUntil: string;
  approvedAt: string | null;
  approvedBy: UserRef | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  payout: { id: string; ref: string; status: PayoutStatus } | null;
  paidAt: string | null;
  clawedBackAt: string | null;
  createdAt: string;
  can: { approve: boolean };
}

export interface Clawback {
  id: string;
  refundId: string;
  amount: MoneyValue;
  recovery: 'netted' | 'deduct';
  payoutId: string | null;
  recoveredAt: string | null;
  refundedAt: string;
  createdAt: string;
}

export interface CommissionDetail extends Commission {
  clawbacks: Clawback[];
  planTerms: Record<string, unknown>;
}

export interface CommissionTotal {
  status: CommissionStatus;
  count: number;
  total: MoneyValue;
}

export interface CommissionSummary {
  statuses: CommissionTotal[];
  /** Clawed back so far, per currency (from commissions of any status). */
  clawedBack: MoneyValue[];
}

export interface BulkApproveResult {
  approved: string[];
  skipped: Array<{ id: string; code: string; message: string }>;
}

// ---------- Payouts ----------

export type PayoutStatus = 'draft' | 'approved' | 'paid' | 'cancelled';

export interface Payout {
  id: string;
  ref: string;
  company: CompanyRef | null;
  periodStart: string;
  periodEnd: string;
  currency: string;
  status: PayoutStatus;
  commission: MoneyValue;
  deductions: MoneyValue;
  total: MoneyValue;
  lineCount: number;
  reference: string | null;
  notes: string | null;
  createdBy: UserRef | null;
  createdAt: string;
  approvedBy: UserRef | null;
  approvedAt: string | null;
  paidBy: UserRef | null;
  paidAt: string | null;
  cancelledBy: UserRef | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  can: { approve: boolean; markPaid: boolean; cancel: boolean; isPreparer: boolean };
}

export interface PayoutLine {
  id: string;
  partner: PartnerRef;
  commission: MoneyValue;
  deductions: MoneyValue;
  net: MoneyValue;
  commissionCount: number;
  payout: PayoutHint | null;
  reference: string | null;
}

export interface PayoutDetail extends Payout {
  lines: PayoutLine[];
}

export interface PayoutInput {
  companyId: string;
  periodStart: string;
  periodEnd: string;
  currency: string;
  notes?: string;
}

export interface PayoutPreview {
  currency: string;
  holdDuringClawback: boolean;
  lines: Array<{ partner: PartnerRef; commission: MoneyValue; deductions: MoneyValue; net: MoneyValue; commissionCount: number }>;
  skipped: Array<{ partner: PartnerRef; net: MoneyValue; reason: 'deductions_exceed_commissions' | 'no_payout_details' }>;
  commission: MoneyValue;
  deductions: MoneyValue;
  total: MoneyValue;
}

// ---------- Partner portal ----------

export interface PortalMe {
  id: string;
  kind: PartnerKind;
  name: string;
  code: string | null;
  email: string | null;
  phone: string | null;
  city: string | null;
  payout: PayoutHint | null;
  companies: Array<{ company: CompanyRef | null; status: PartnershipStatus; contactName: string | null; joinedAt: string; canCreateLinks: boolean }>;
  stats: {
    activeLinks: number;
    referredLeads: number;
    enrolled: number;
    commissions: Partial<Record<CommissionStatus, MoneyValue[]>>;
  };
}

export type PortalLeadStatus = 'in_progress' | 'enrolled' | 'closed';

export interface PortalLead {
  id: string;
  ref: string;
  company: CompanyRef | null;
  /** "Priya S.": first name and initial only. */
  name: string;
  /** Masked: "+91 ••••• •3210". */
  phone: string | null;
  productLine: { id: string; name: string } | null;
  status: PortalLeadStatus;
  touch: Touch;
  referredAt: string;
}

export interface PortalCommission {
  id: string;
  ref: string;
  company: CompanyRef | null;
  status: CommissionStatus;
  amount: MoneyValue;
  clawedBack: MoneyValue;
  payable: MoneyValue;
  earnedAt: string;
  clawbackUntil: string;
  paidAt: string | null;
}

export interface PortalPayout {
  id: string;
  payoutRef: string;
  company: CompanyRef | null;
  periodStart: string;
  periodEnd: string;
  status: PayoutStatus;
  net: MoneyValue;
  deductions: MoneyValue;
  commissionCount: number;
  paidAt: string | null;
  reference: string | null;
}
