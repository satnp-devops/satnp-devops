import { z } from 'zod';
import { webUrlSchema } from '../../lib/schemas.js';

// Partner programme rules that differ between companies live in settings, not code.

export const attributionModelSetting = {
  key: 'partners.attributionModel',
  category: 'Partner programmes',
  label: 'Which partner earns the commission',
  description:
    'When a lead came through more than one partner, the partner of its first touch or of its last touch earns the commission.',
  input: 'select',
  options: [
    { value: 'first_touch', label: 'First touch' },
    { value: 'last_touch', label: 'Last touch' },
  ],
  schema: z.enum(['first_touch', 'last_touch']),
  default: 'first_touch',
  levels: ['group', 'company'],
};

export const holdDuringClawbackSetting = {
  key: 'partners.holdDuringClawback',
  category: 'Partner programmes',
  label: 'Hold commissions until the clawback window ends',
  description: 'Payout batches only include commissions whose clawback window is over, so refunds rarely need recovering.',
  input: 'boolean',
  schema: z.boolean(),
  default: true,
  levels: ['group', 'company'],
};

export const maxLinksPerPartnerSetting = {
  key: 'partners.maxLinksPerPartner',
  category: 'Partner programmes',
  label: 'Referral links per partner',
  description: 'How many active referral links one partner may have with a company.',
  input: 'number',
  schema: z.coerce.number().int().min(1).max(500),
  default: 25,
  levels: ['group', 'company'],
};

export const defaultLandingUrlSetting = {
  key: 'partners.defaultLandingUrl',
  category: 'Partner programmes',
  label: 'Default referral landing page',
  description: 'Referral links without their own landing page send people here, with the referral code and UTM tags added.',
  input: 'url',
  schema: webUrlSchema.nullable(),
  default: null,
  levels: ['company'],
};

export const partnerSettings = [attributionModelSetting, holdDuringClawbackSetting, maxLinksPerPartnerSetting, defaultLandingUrlSetting];
