import { z } from 'zod';
import { db } from '../../lib/db.js';
import { getSetting } from '../settings.js';
import { PHONE_COUNTRIES } from './normalize.js';

// Setting definitions of the CRM modules. They are declared here (not inside the modules) so the
// core CRM helpers can read them with getSetting(); each module lists its own in module.js
// `settings`, which is what puts them on the Settings screen.

const countryOptions = Object.entries(PHONE_COUNTRIES)
  .filter(([code]) => code !== 'CA')
  .map(([code, country]) => ({ value: code, label: `${country.name} (+${country.callingCode})` }));

export const defaultCountrySetting = {
  key: 'contacts.defaultCountry',
  category: 'Contacts',
  label: 'Default country for phone numbers',
  description: 'Numbers typed without a country code are read as numbers in this country.',
  input: 'select',
  options: countryOptions,
  schema: z.enum(Object.keys(PHONE_COUNTRIES)),
  default: 'IN',
  levels: ['group', 'company'],
};

export const fuzzyMatchThresholdSetting = {
  key: 'contacts.fuzzyMatchThreshold',
  category: 'Contacts',
  label: 'Name match strictness',
  description:
    'How alike two names must be (0.2 to 0.95) before a shared phone number or email is treated as the same person. Higher is stricter.',
  input: 'number',
  schema: z.coerce.number().min(0.2).max(0.95),
  default: 0.5,
  levels: ['group'],
};

export const firstReplySlaSetting = {
  key: 'deals.firstReplySlaMinutes',
  category: 'Leads and deals',
  label: 'First reply target (minutes)',
  description: 'New enquiries from WhatsApp, forms, calls, email, ads and partners should get a first reply within this time.',
  input: 'number',
  schema: z.coerce.number().int().min(1).max(10_080),
  default: 30,
  levels: ['group', 'company', 'region', 'branch', 'team'],
};

export const referencePrefixSetting = {
  key: 'deals.referencePrefix',
  category: 'Leads and deals',
  label: 'Lead reference prefix',
  description: 'New leads get references like SP-1042. Changing it only affects new leads.',
  input: 'text',
  schema: z.string().regex(/^[A-Z][A-Z0-9]{0,5}$/, 'Use 1 to 6 capital letters or digits, starting with a letter'),
  default: 'D',
  levels: ['company'],
};

export const nurtureOnLostSetting = {
  key: 'deals.nurtureOnLost',
  category: 'Leads and deals',
  label: 'Nurture lost leads',
  description: 'Mark leads for the nurture flow when they are lost, unless the person closing them says otherwise.',
  input: 'boolean',
  schema: z.boolean(),
  default: true,
  levels: ['group', 'company'],
};

export const contactSettings = [defaultCountrySetting, fuzzyMatchThresholdSetting];
export const dealSettings = [firstReplySlaSetting, referencePrefixSetting, nurtureOnLostSetting];

/** Effective value of a CRM setting for a unit (inherited down the tree). */
export const crmSetting = (unit, definition, trx = db) => getSetting(unit, definition, trx);
