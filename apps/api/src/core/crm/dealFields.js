import { customFieldRef } from './customFields.js';

// Deal fields a pipeline stage can require (pipeline_stages.required_fields). A deal must have
// every listed field filled to ENTER the stage. Custom deal fields are referenced as
// "custom.<key>". The config slice validates stage settings against this list; the deals slice's
// stage-rule evaluator (modules/deals/stageRules.js) reads values as described in `reads`.

export const DEAL_REQUIRED_FIELDS = [
  { key: 'productLineId', label: 'Product line', reads: 'deals.product_line_id is set' },
  { key: 'productId', label: 'Product', reads: 'deals.product_id is set' },
  { key: 'ownerUserId', label: 'Owner', reads: 'deals.owner_user_id is set' },
  { key: 'valueMinor', label: 'Value', reads: 'deals.value_minor > 0' },
  { key: 'expectedCloseOn', label: 'Expected close date', reads: 'deals.expected_close_on is set' },
  { key: 'primaryContactId', label: 'Main contact', reads: 'deals.primary_contact_id is set' },
  { key: 'householdId', label: 'Family', reads: 'deals.household_id is set' },
  { key: 'accountId', label: 'Institute', reads: 'deals.account_id is set' },
  { key: 'students', label: 'Student', reads: 'at least one deal_contacts row with role student' },
  { key: 'contactPhone', label: 'Phone number of the main contact', reads: 'the main contact has a phone or WhatsApp number' },
  { key: 'contactEmail', label: 'Email of the main contact', reads: 'the main contact has an email address' },
];

const BUILT_IN_KEYS = new Set(DEAL_REQUIRED_FIELDS.map((field) => field.key));

/**
 * The choices for a stage's required fields in a company: built-in fields plus its active custom deal fields.
 * @param {Array<{ key: string, label: string, entity: string, active: boolean }>} customDefinitions
 */
export function requiredFieldOptions(customDefinitions = []) {
  return [
    ...DEAL_REQUIRED_FIELDS.map(({ key, label }) => ({ key, label, source: 'deal' })),
    ...customDefinitions
      .filter((d) => d.entity === 'deal' && d.active !== false)
      .map((d) => ({ key: customFieldRef(d.key), label: d.label, source: 'custom' })),
  ];
}

/** Keys in `keys` that are neither built-in deal fields nor the company's custom deal fields. */
export function unknownRequiredFields(keys, customDefinitions = []) {
  const custom = new Set(customDefinitions.filter((d) => d.entity === 'deal').map((d) => customFieldRef(d.key)));
  return keys.filter((key) => !BUILT_IN_KEYS.has(key) && !custom.has(key));
}
