import type { PillTone } from '@/components/crm';
import { formatMoney } from '@/lib/crm/format';
import type {
  AttributionSource,
  CommissionPlan,
  CommissionStatus,
  MoneyValue,
  PartnershipStatus,
  PayoutStatus,
  PlanTrigger,
  PortalLeadStatus,
} from './types';

// Words and tones for the partners area. Statuses are always shown in words; colour only helps.

export const PARTNERSHIP_STATUS: Record<PartnershipStatus, { label: string; tone: PillTone }> = {
  pending: { label: 'Pending', tone: 'warning' },
  active: { label: 'Active', tone: 'success' },
  suspended: { label: 'Suspended', tone: 'danger' },
  terminated: { label: 'Ended', tone: 'neutral' },
};

export const COMMISSION_STATUS: Record<CommissionStatus, { label: string; tone: PillTone }> = {
  pending: { label: 'Pending approval', tone: 'warning' },
  approved: { label: 'Approved', tone: 'accent' },
  rejected: { label: 'Rejected', tone: 'neutral' },
  paid: { label: 'Paid', tone: 'success' },
  clawed_back: { label: 'Clawed back', tone: 'danger' },
};

export const PAYOUT_STATUS: Record<PayoutStatus, { label: string; tone: PillTone }> = {
  draft: { label: 'Awaiting approval', tone: 'warning' },
  approved: { label: 'Approved, not paid', tone: 'accent' },
  paid: { label: 'Paid', tone: 'success' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

export const PORTAL_LEAD_STATUS: Record<PortalLeadStatus, { label: string; tone: PillTone }> = {
  in_progress: { label: 'In progress', tone: 'accent' },
  enrolled: { label: 'Enrolled', tone: 'success' },
  closed: { label: 'Closed', tone: 'neutral' },
};

export const SOURCE_LABEL: Record<AttributionSource, string> = {
  referral_link: 'Referral link',
  partner_code: 'Partner code',
  manual: 'Set by hand',
};

export const TRIGGER_LABEL: Record<PlanTrigger, string> = {
  first_payment: 'On the first payment',
  full_payment: 'When the fee is fully paid',
};

export const SKIP_REASON: Record<string, string> = {
  no_payout_details: 'No bank or UPI details yet',
  deductions_exceed_commissions: 'Refund deductions are more than the commissions',
};

/** "10%" or "7.5%" from basis points. */
export function formatRate(bps: number | null | undefined): string {
  if (bps === null || bps === undefined) return '';
  const percent = bps / 100;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(2).replace(/0+$/, '')}%`;
}

export const money = (value: MoneyValue | null | undefined): string => (value ? formatMoney(value.valueMinor, value.currency) : '');

/** "₹1,800 + $40" for totals in several currencies; "₹0" when empty. */
export function moneyList(values: readonly MoneyValue[] | undefined, fallbackCurrency = 'INR'): string {
  if (!values || values.length === 0) return formatMoney(0, fallbackCurrency);
  return values.map((value) => formatMoney(value.valueMinor, value.currency)).join(' + ');
}

/** One line describing what a plan pays: "10% on the first payment, up to ₹25,000 · 30-day clawback". */
export function planSummary(plan: Pick<CommissionPlan, 'basis' | 'rateBps' | 'fixed' | 'trigger' | 'cap' | 'clawbackDays'>): string {
  const amount = plan.basis === 'percent' ? `${formatRate(plan.rateBps)} of the fee` : money(plan.fixed);
  const when = plan.trigger === 'first_payment' ? 'on the first payment' : 'when fully paid';
  const cap = plan.cap ? `, up to ${money(plan.cap)}` : '';
  const clawback = plan.clawbackDays > 0 ? `${plan.clawbackDays}-day clawback` : 'no clawback';
  return `${amount} ${when}${cap} · ${clawback}`;
}

export const kindLabel = (kind: 'person' | 'organisation') => (kind === 'person' ? 'Person' : 'Organisation');
