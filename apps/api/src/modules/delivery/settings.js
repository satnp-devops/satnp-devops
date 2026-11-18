import { createHash } from 'node:crypto';
import { z } from 'zod';
import { db } from '../../lib/db.js';
import { getEffectiveSettings } from '../../core/settings.js';
import { REMINDER_DAY_OPTIONS } from './constants.js';

// Business rules of the delivery module are settings, inherited down the org tree, so a branch in
// a state with different coaching rules can override them (docs/delivery/DELIVERY.md §6).

const LEVELS = ['group', 'company', 'region', 'branch'];

export const DEFAULT_REFUND_POLICY = [
  'Fees and refunds. The fee shown is the full course fee, inclusive of taxes. Study material is included.',
  'If you leave a course midway, we refund the fee for the remaining period of the course on a pro-rata basis within 10 days of your request. Hostel and mess fees, if any, are refunded the same way.',
  'You can ask to withdraw at any time by email, WhatsApp, phone or at the centre; you do not have to give a reason.',
  'Admission to a coaching programme is no guarantee of success in any examination.',
].join('\n\n');

export const refundSlaDaysSetting = {
  key: 'enrollments.refundSlaDays',
  category: 'Enrollments',
  label: 'Refund deadline (days)',
  description:
    'Refunds for students who leave mid-course are due within this many calendar days of their request. The Ministry of Education coaching guidelines (2024, cl. 8(iv)) say 10; change it only where a state rule says otherwise.',
  input: 'number',
  schema: z.coerce.number().int().min(1).max(90),
  default: 10,
  levels: LEVELS,
};

export const coolingOffDaysSetting = {
  key: 'enrollments.coolingOffDays',
  category: 'Enrollments',
  label: 'Full refund window (days)',
  description:
    'Students who withdraw within this many days of enrolling get the whole fee back (Jammu and Kashmir rules: 10). 0 means no such window.',
  input: 'number',
  schema: z.coerce.number().int().min(0).max(60),
  default: 0,
  levels: LEVELS,
};

export const waitlistAutoPromoteSetting = {
  key: 'enrollments.waitlistAutoPromote',
  category: 'Enrollments',
  label: 'Fill free seats from the waitlist',
  description: 'When a seat frees up, give it to the next person on the waitlist straight away (first come, first served).',
  input: 'boolean',
  schema: z.boolean(),
  default: true,
  levels: LEVELS,
};

export const checkoutEnabledSetting = {
  key: 'enrollments.checkoutEnabled',
  category: 'Enrollments',
  label: 'Website checkout',
  description: 'Let families pick a batch and pay on the public checkout page (/checkout/<company code>). Only batches marked for checkout are listed.',
  input: 'boolean',
  schema: z.boolean(),
  default: false,
  levels: ['group', 'company'],
};

export const refundPolicySetting = {
  key: 'enrollments.refundPolicyText',
  category: 'Enrollments',
  label: 'Fee, exit and refund policy',
  description: 'Shown at checkout; families must accept it before paying. Each enrollment records the version they saw.',
  input: 'textarea',
  schema: z.string().trim().min(40, 'Write the full policy').max(4000),
  default: DEFAULT_REFUND_POLICY,
  levels: LEVELS,
};

export const autoAssignBatchSetting = {
  key: 'enrollments.autoAssignBatch',
  category: 'Enrollments',
  label: 'Seat paid students automatically',
  description:
    'When a family pays for a programme from a deal, put the student in the earliest open batch of that programme with a free seat (or on its waitlist). Off: the enrollment waits for someone to pick a batch.',
  input: 'boolean',
  schema: z.boolean(),
  default: true,
  levels: LEVELS,
};

export const enrollmentSettings = [
  refundSlaDaysSetting,
  coolingOffDaysSetting,
  waitlistAutoPromoteSetting,
  autoAssignBatchSetting,
  checkoutEnabledSetting,
  refundPolicySetting,
];

export const renewalReminderDaysSetting = {
  key: 'onboarding.renewalReminderDays',
  category: 'Renewals',
  label: 'Renewal reminders',
  description: 'Days before a subscription renews when its owner (and automations) get a reminder.',
  input: 'multiselect',
  options: REMINDER_DAY_OPTIONS.map((days) => ({ value: days, label: `${days} days before` })),
  schema: z.array(z.coerce.number().int().refine((d) => REMINDER_DAY_OPTIONS.includes(d), 'Pick from the list')).max(9),
  default: [90, 60, 30, 7],
  levels: ['group', 'company'],
};

export const churnInactiveDaysSetting = {
  key: 'onboarding.churnInactiveDays',
  category: 'Renewals',
  label: 'Quiet account after (days)',
  description: 'An institute with no calls, messages, meetings or notes for this long counts towards churn risk.',
  input: 'number',
  schema: z.coerce.number().int().min(7).max(365),
  default: 30,
  levels: ['group', 'company'],
};

export const churnMediumScoreSetting = {
  key: 'onboarding.churnMediumScore',
  category: 'Renewals',
  label: 'Churn risk: medium from score',
  description: 'Risk scores run from 0 to 100. At or above this score a renewal shows as medium risk.',
  input: 'number',
  schema: z.coerce.number().int().min(1).max(100),
  default: 30,
  levels: ['group', 'company'],
};

export const churnHighScoreSetting = {
  key: 'onboarding.churnHighScore',
  category: 'Renewals',
  label: 'Churn risk: high from score',
  description: 'At or above this score a renewal shows as high risk.',
  input: 'number',
  schema: z.coerce.number().int().min(1).max(100),
  default: 60,
  levels: ['group', 'company'],
};

export const PROJECT_TRIGGERS = ['deal_won', 'contract_signed', 'subscription_started'];

export const projectTriggersSetting = {
  key: 'onboarding.projectTriggers',
  category: 'Onboarding',
  label: 'Start implementation projects when',
  description: 'B2B only. A project is created once per institute deal or subscription, whichever of these happens first; later ones attach to it.',
  input: 'multiselect',
  options: [
    { value: 'deal_won', label: 'An institute deal is won' },
    { value: 'contract_signed', label: 'A contract is signed' },
    { value: 'subscription_started', label: 'A subscription starts' },
  ],
  schema: z.array(z.enum(PROJECT_TRIGGERS)).max(3),
  default: ['deal_won', 'contract_signed', 'subscription_started'],
  levels: ['group', 'company'],
};

export const onboardingSettings = [projectTriggersSetting, renewalReminderDaysSetting, churnInactiveDaysSetting, churnMediumScoreSetting, churnHighScoreSetting];

/** Effective delivery settings at a unit, in one query. */
export async function deliverySettings(unit, definitions, trx = db) {
  const resolved = await getEffectiveSettings(unit, definitions, trx);
  return Object.fromEntries(definitions.map((d) => [d.key, resolved[d.key].value]));
}

/** A short, stable version id for a policy text (stored with each acknowledgement). */
export const policyVersion = (text) => createHash('sha256').update(String(text)).digest('hex').slice(0, 12);
