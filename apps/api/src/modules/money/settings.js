import { z } from 'zod';
import { db } from '../../lib/db.js';
import { getEffectiveSettings } from '../../core/settings.js';
import { discountPolicySchema } from '../../core/billing/index.js';

// Settings of the money module: business rules live here, set on the group and overridden per
// company, never in per-company code. They show on Settings > General ("Fees and billing") and on
// Settings > Billing. The discount policy is built from the four discount settings (discounts.js
// tiers: free up to X% and ₹Y, manager up to Z%, company admin up to W%, larger not allowed).

const CATEGORY = 'Fees and billing';
const GROUP_COMPANY = ['group', 'company'];

const percent = (max = 100) => z.number().min(0).max(max);

export const discountFreePercentSetting = {
  key: 'billing.discountFreePercent',
  category: CATEGORY,
  label: 'Discount anyone may give (%)',
  description: 'Discounts up to this share of the list price need no approval.',
  input: 'number',
  schema: percent(),
  default: 5,
  levels: GROUP_COMPANY,
};

export const discountFreeAmountSetting = {
  key: 'billing.discountFreeAmount',
  category: CATEGORY,
  label: 'Discount anyone may give, at most (in the quote currency)',
  description: 'The free tier also stops at this amount, e.g. 5000 means ₹5,000.',
  input: 'number',
  schema: z.number().int().min(0).max(10_000_000),
  default: 5000,
  levels: GROUP_COMPANY,
};

export const discountManagerPercentSetting = {
  key: 'billing.discountManagerPercent',
  category: CATEGORY,
  label: 'Discount a manager may approve (%)',
  input: 'number',
  schema: percent(),
  default: 15,
  levels: GROUP_COMPANY,
};

export const discountCompanyPercentSetting = {
  key: 'billing.discountCompanyPercent',
  category: CATEGORY,
  label: 'Discount a company admin may approve (%)',
  description: 'Anything above this is not allowed.',
  input: 'number',
  schema: percent(),
  default: 30,
  levels: GROUP_COMPANY,
};

export const discountSelfApprovalSetting = {
  key: 'billing.discountSelfApproval',
  category: CATEGORY,
  label: 'Approvers may approve their own discounts',
  input: 'boolean',
  schema: z.boolean(),
  default: true,
  levels: GROUP_COMPANY,
};

export const quoteValidityDaysSetting = {
  key: 'billing.quoteValidityDays',
  category: CATEGORY,
  label: 'Quotes and fee proposals are valid for (days)',
  input: 'number',
  schema: z.number().int().min(1).max(180),
  default: 14,
  levels: GROUP_COMPANY,
};

export const paymentLinkExpiryDaysSetting = {
  key: 'billing.paymentLinkExpiryDays',
  category: CATEGORY,
  label: 'Payment links expire after (days)',
  description: 'Razorpay allows at most 180 days.',
  input: 'number',
  schema: z.number().int().min(1).max(180),
  default: 15,
  levels: GROUP_COMPANY,
};

const REMINDER_OPTIONS = [
  { value: 7, label: '7 days before' },
  { value: 3, label: '3 days before' },
  { value: 1, label: '1 day before' },
  { value: 0, label: 'On the due date' },
];

export const reminderDaysBeforeSetting = {
  key: 'billing.reminderDaysBefore',
  category: CATEGORY,
  label: 'Instalment reminders',
  input: 'multiselect',
  options: REMINDER_OPTIONS,
  schema: z.array(z.number().int().min(0).max(30)).max(10),
  default: [3, 0],
  levels: GROUP_COMPANY,
};

export const overdueReminderDaysSetting = {
  key: 'billing.overdueReminderDays',
  category: CATEGORY,
  label: 'Overdue reminders',
  input: 'multiselect',
  options: [
    { value: 1, label: '1 day after' },
    { value: 3, label: '3 days after' },
    { value: 7, label: '7 days after' },
    { value: 14, label: '14 days after' },
  ],
  schema: z.array(z.number().int().min(1).max(60)).max(10),
  default: [1, 7],
  levels: GROUP_COMPANY,
};

export const paymentRetryHoursSetting = {
  key: 'billing.paymentRetryHours',
  category: CATEGORY,
  label: 'After a failed payment, send a new link after',
  input: 'multiselect',
  options: [
    { value: 1, label: '1 hour' },
    { value: 24, label: '1 day' },
    { value: 72, label: '3 days' },
    { value: 168, label: '7 days' },
  ],
  schema: z.array(z.number().int().min(1).max(720)).max(10),
  default: [24, 72],
  levels: GROUP_COMPANY,
};

export const renewalReminderDaysSetting = {
  key: 'billing.renewalReminderDays',
  category: CATEGORY,
  label: 'Remind about subscription renewals (days before)',
  input: 'number',
  schema: z.number().int().min(0).max(90),
  default: 14,
  levels: GROUP_COMPANY,
};

export const moneySettings = [
  discountFreePercentSetting,
  discountFreeAmountSetting,
  discountManagerPercentSetting,
  discountCompanyPercentSetting,
  discountSelfApprovalSetting,
  quoteValidityDaysSetting,
  paymentLinkExpiryDaysSetting,
  reminderDaysBeforeSetting,
  overdueReminderDaysSetting,
  paymentRetryHoursSetting,
  renewalReminderDaysSetting,
];

/** Every money setting for a unit, as { key: value }. One query. */
export async function moneySettingsFor(unit, trx = db) {
  const resolved = await getEffectiveSettings(unit, moneySettings, trx);
  return Object.fromEntries(Object.entries(resolved).map(([key, entry]) => [key, entry.value]));
}

/**
 * The discounts.js policy from the settings. Percentages become basis points; the free amount is in
 * major units of the quote currency. Limits that are out of order are lifted so the tiers stay
 * increasing (a manager may always approve at least what anyone may give). Pure.
 */
export function discountPolicyFrom(values, { currencyExponent = 2 } = {}) {
  const bp = (value) => Math.round(Number(value) * 100);
  const free = bp(values[discountFreePercentSetting.key] ?? discountFreePercentSetting.default);
  const manager = Math.max(free, bp(values[discountManagerPercentSetting.key] ?? discountManagerPercentSetting.default));
  const company = Math.max(manager, bp(values[discountCompanyPercentSetting.key] ?? discountCompanyPercentSetting.default));
  const freeAmount = Number(values[discountFreeAmountSetting.key] ?? discountFreeAmountSetting.default) * 10 ** currencyExponent;
  return discountPolicySchema.parse({
    tiers: [
      { label: 'Anyone', maxPercentBp: free, maxAmountMinor: freeAmount, approverRoles: [] },
      { label: 'Manager', maxPercentBp: manager, approverRoles: ['manager'] },
      { label: 'Company admin', maxPercentBp: company, approverRoles: ['company_admin'] },
    ],
    inheritApprovers: true,
    allowSelfApproval: values[discountSelfApprovalSetting.key] ?? discountSelfApprovalSetting.default,
  });
}
