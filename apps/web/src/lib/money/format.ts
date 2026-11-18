import type { PillTone } from '@/components/crm';
import { formatMoney, toMajorUnits, toMinorUnits } from '@/lib/crm/format';
import type { AgreementStatus, InstalmentState, Money, PaymentStatus, QuoteStatus, RefundStatus, SubscriptionStatus } from './types';

// Labels and pill tones for billing statuses, and small money helpers for forms.

type Labelled = { label: string; tone: PillTone };

export const QUOTE_STATUS: Record<QuoteStatus, Labelled> = {
  draft: { label: 'Draft', tone: 'neutral' },
  pending_approval: { label: 'Discount awaiting approval', tone: 'warning' },
  approved: { label: 'Discount approved', tone: 'accent' },
  sent: { label: 'Sent', tone: 'accent' },
  accepted: { label: 'Accepted', tone: 'success' },
  declined: { label: 'Declined', tone: 'danger' },
  expired: { label: 'Expired', tone: 'neutral' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

export const PAYMENT_STATUS: Record<PaymentStatus, Labelled> = {
  creating: { label: 'Creating link', tone: 'neutral' },
  link_sent: { label: 'Link sent', tone: 'accent' },
  pending: { label: 'Processing', tone: 'warning' },
  succeeded: { label: 'Paid', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  expired: { label: 'Expired', tone: 'neutral' },
  error: { label: 'Link not created', tone: 'danger' },
};

export const REFUND_STATUS: Record<RefundStatus, Labelled> = {
  requested: { label: 'Awaiting approval', tone: 'warning' },
  approved: { label: 'Approved', tone: 'accent' },
  rejected: { label: 'Rejected', tone: 'neutral' },
  processing: { label: 'Processing', tone: 'accent' },
  processed: { label: 'Refunded', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
};

export const AGREEMENT_STATUS: Record<AgreementStatus, Labelled> = {
  draft: { label: 'Draft', tone: 'neutral' },
  sent: { label: 'Awaiting signature', tone: 'warning' },
  partially_signed: { label: 'Partly signed', tone: 'accent' },
  signed: { label: 'Signed', tone: 'success' },
  failed: { label: 'Not signed', tone: 'danger' },
  expired: { label: 'Expired', tone: 'neutral' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

export const INSTALMENT_STATE: Record<InstalmentState, Labelled> = {
  upcoming: { label: 'Upcoming', tone: 'neutral' },
  due_today: { label: 'Due today', tone: 'warning' },
  overdue: { label: 'Overdue', tone: 'danger' },
  paid: { label: 'Paid', tone: 'success' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

export const SUBSCRIPTION_STATUS: Record<SubscriptionStatus, Labelled> = {
  pending: { label: 'Awaiting first payment', tone: 'warning' },
  active: { label: 'Active', tone: 'success' },
  past_due: { label: 'Past due', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

export const REFUND_REASONS = [
  { value: 'requested_by_customer', label: 'Customer asked' },
  { value: 'course_cancelled', label: 'Course or batch cancelled' },
  { value: 'service_issue', label: 'Service issue' },
  { value: 'fee_change', label: 'Fee changed' },
  { value: 'duplicate', label: 'Paid twice' },
  { value: 'other', label: 'Other' },
] as const;

export const SUPPLY_TYPES: Record<string, string> = {
  intra_state: 'Within the state (CGST + SGST)',
  inter_state: 'Another state (IGST)',
  export_with_igst: 'Export with IGST',
  export_under_lut: 'Export under LUT (no GST)',
  sez_with_igst: 'SEZ with IGST',
  sez_under_lut: 'SEZ under LUT (no GST)',
};

export const PROVIDER_LABEL: Record<string, string> = { razorpay: 'Razorpay', stripe: 'Stripe', manual: 'Offline', digio: 'Digio' };

export const percent = (bp: number) => `${(bp / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}%`;

export const money = (value: Money | null | undefined) => (value ? formatMoney(value.valueMinor, value.currency, { exact: true }) : '—');

/** "₹55,000 · $1,200": totals per currency, never summed across currencies. */
export const moneyList = (values: readonly Money[]) => (values.length ? values.map((v) => formatMoney(v.valueMinor, v.currency, { exact: true })).join(' · ') : '—');

/** Major units typed in a form ("5500.50") → minor units, or null when it isn't a number. */
export function parseMajor(text: string, currency: string): number | null {
  const clean = text.replace(/[,\s₹$]/g, '');
  if (!clean) return null;
  const value = Number(clean);
  if (!Number.isFinite(value) || value < 0) return null;
  return toMinorUnits(value, currency);
}

export const toMajorText = (minor: number, currency: string) => String(toMajorUnits(minor, currency));

export const humanStatus = (value: string) => value.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
