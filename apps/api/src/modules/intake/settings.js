import { z } from 'zod';
import * as crmNormalize from '../../core/crm/normalize.js';

// Intake settings (shown on Settings > General and edited on Settings > Routing). Business rules
// live here as configuration; nothing in the intake code is specific to one company.

export const routingThresholdSetting = {
  key: 'intake.routingThreshold',
  category: 'Capture and intake',
  label: 'Routing confidence threshold',
  description:
    'On shared channels (the group number, a group inbox) the classifier must be at least this sure (0.3 to 0.99) that an enquiry belongs to the company; below it the enquiry waits in the review queue.',
  input: 'number',
  schema: z.coerce.number().min(0.3).max(0.99),
  default: 0.75,
  levels: ['group', 'company'],
};

export const reopenWindowSetting = {
  key: 'intake.reopenWindowDays',
  category: 'Capture and intake',
  label: 'Reopen lost leads within (days)',
  description: 'A family that enquires again within this many days of their lead being lost gets that lead reopened instead of a new one. 0 never reopens.',
  input: 'number',
  schema: z.coerce.number().int().min(0).max(730),
  default: 180,
  levels: ['group', 'company'],
};

export const attachToOpenDealSetting = {
  key: 'intake.attachToOpenDeal',
  category: 'Capture and intake',
  label: 'Add repeat enquiries to the open lead',
  description: 'When the person already has an open lead with the company, a new enquiry is added to that lead (its owner keeps it) instead of creating another.',
  input: 'boolean',
  schema: z.boolean(),
  default: true,
  levels: ['group', 'company'],
};

export const returningOwnerSetting = {
  key: 'intake.returningOwnerDays',
  category: 'Capture and intake',
  label: 'Returning families keep their counsellor for (days)',
  description: 'A returning family goes to the person who worked with them last, when that was within this many days and they can still take leads.',
  input: 'number',
  schema: z.coerce.number().int().min(0).max(1825),
  default: 365,
  levels: ['group', 'company'],
};

export const dedupMergeSetting = {
  key: 'intake.dedupMergeScore',
  category: 'Capture and intake',
  label: 'Same-person score',
  description: 'Enquiries scoring at least this (0.8 to 1) against one existing person are added to that person automatically.',
  input: 'number',
  schema: z.coerce.number().min(0.8).max(1),
  default: 0.9,
  levels: ['group'],
};

export const dedupSuggestSetting = {
  key: 'intake.dedupSuggestScore',
  category: 'Capture and intake',
  label: 'Possible-duplicate score',
  description: 'Scores from this (0.4 to 0.89) up to the same-person score create a new person and put a possible duplicate in the review queue.',
  input: 'number',
  schema: z.coerce.number().min(0.4).max(0.89),
  default: 0.6,
  levels: ['group'],
};

export const intakeSettings = [
  routingThresholdSetting,
  reopenWindowSetting,
  attachToOpenDealSetting,
  returningOwnerSetting,
  dedupMergeSetting,
  dedupSuggestSetting,
];

/**
 * The phase 2 normalisers in the shape the intake engine expects, so that what intake matches on
 * is exactly what contact_methods stores. Names keep the engine's display form (the CRM's
 * normalizeName folds to lower case for matching, which is not a display name).
 */
export const crmNormalizers = Object.freeze({
  phone: (raw, { defaultCountry } = {}) => crmNormalize.normalizePhone(raw, defaultCountry ?? 'IN')?.e164 ?? null,
  email: (raw) => crmNormalize.normalizeEmail(raw),
});
