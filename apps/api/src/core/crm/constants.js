// Fixed vocabularies of the core CRM (phase 2). docs/crm/PHASE2_CONTRACT.md is the source of truth.
//
// Small, stable lists are also enforced by check constraints in the migration
// (20261106000100_crm_core.js). Lists that grow with configuration (enquiry channels, product
// kinds, timeline kinds, account kinds) are validated in code only, so adding one needs no migration.

export const CONTACT_KINDS = ['parent', 'student', 'staff', 'other'];
export const CONTACT_METHOD_KINDS = ['phone', 'email', 'whatsapp'];
/** A company's relationship with a person or institute (contact_companies / account_companies). */
export const LINK_STATUSES = ['lead', 'customer', 'former'];
export const HOUSEHOLD_ROLES = ['parent', 'guardian', 'student', 'other'];

/** Kinds of B2B organisation. Validated in code; add a kind here, no migration needed. */
export const ACCOUNT_KINDS = [
  { key: 'coaching_institute', label: 'Coaching institute' },
  { key: 'school', label: 'School' },
  { key: 'college', label: 'College' },
  { key: 'independent_mentor', label: 'Independent mentor' },
  { key: 'other', label: 'Other organisation' },
];
export const ACCOUNT_CONTACT_ROLES = ['decision_maker', 'influencer', 'champion', 'user', 'billing', 'other'];

export const DEAL_KINDS = ['b2c', 'b2b'];
export const DEAL_STATUSES = ['open', 'won', 'lost'];
export const STAGE_CATEGORIES = ['open', 'won', 'lost'];
export const DEAL_CONTACT_ROLES = ['parent', 'student', 'guardian', 'decision_maker', 'influencer', 'other'];

/** Keyset sorts for GET /deals. The id tie-breaker always runs in the same direction. */
export const DEAL_SORTS = [
  '-updatedAt',
  'updatedAt',
  '-createdAt',
  'createdAt',
  '-lastActivityAt',
  'lastActivityAt',
  '-value',
  'value',
  'expectedCloseOn',
  '-expectedCloseOn',
  'slaDueAt',
  '-slaDueAt',
  'stageEnteredAt',
  '-stageEnteredAt',
];

/** Columns a saved view may show on the Leads list; custom deal fields are "custom.<key>". */
export const DEAL_COLUMNS = [
  'ref',
  'title',
  'contact',
  'account',
  'stage',
  'status',
  'owner',
  'unit',
  'channel',
  'productLine',
  'product',
  'value',
  'tags',
  'expectedCloseOn',
  'slaDueAt',
  'firstReplyDueAt',
  'lastActivityAt',
  'createdAt',
  'updatedAt',
];

/** Timeline entry kinds. Later phases add kinds (booking, payment, ...) here; the column is not constrained. */
export const TIMELINE_KINDS = [
  { key: 'note', label: 'Note' },
  { key: 'message', label: 'Message' },
  { key: 'call', label: 'Call' },
  { key: 'email', label: 'Email' },
  { key: 'meeting', label: 'Meeting' },
  { key: 'system', label: 'Update' },
  { key: 'stage_change', label: 'Stage change' },
  { key: 'task', label: 'Task' },
  { key: 'ai', label: 'AI action' },
];
/** Entry kinds people can add by hand through POST /timeline. */
export const MANUAL_TIMELINE_KINDS = ['note', 'call', 'email', 'meeting', 'message'];
/** Outbound entries of these kinds count as the first reply to an enquiry. */
export const REPLY_KINDS = ['message', 'call', 'email', 'meeting'];
export const TIMELINE_DIRECTIONS = ['inbound', 'outbound', 'internal'];
export const ACTOR_TYPES = ['user', 'system', 'ai', 'contact'];

export const TASK_STATUSES = ['open', 'done', 'cancelled'];
export const TASK_PRIORITIES = ['low', 'normal', 'high'];
export const TASK_KINDS = ['call', 'message', 'email', 'meeting', 'follow_up', 'other'];

export const SAVED_VIEW_ENTITIES = ['deals'];
export const SAVED_VIEW_VISIBILITIES = ['personal', 'shared'];

export const SEARCH_ENTITY_TYPES = ['deal', 'contact', 'account'];

// Consent and opt-out records (India's Digital Personal Data Protection Act, 2023).
export const CONSENT_CHANNELS = ['whatsapp', 'sms', 'email', 'voice', 'all'];
export const CONSENT_PURPOSES = ['marketing', 'transactional', 'service'];
export const CONSENT_STATUSES = ['granted', 'withdrawn'];
export const CONSENT_SOURCES = [
  'web_form',
  'checkout',
  'whatsapp',
  'call',
  'email',
  'sms',
  'unsubscribe_link',
  'import',
  'manual',
];

export const CUSTOM_FIELD_ENTITIES = ['deal', 'contact', 'account'];
export const CUSTOM_FIELD_TYPES = [
  'text',
  'textarea',
  'number',
  'date',
  'select',
  'multiselect',
  'boolean',
  'phone',
  'email',
  'url',
];

/** Kinds of product line. `audience` says which deal kind sells it. Add a kind here, no migration needed. */
export const PRODUCT_KINDS = [
  { key: 'group_batch', label: 'Group batch', audience: 'b2c' },
  { key: 'mentorship_1to1', label: '1:1 mentorship', audience: 'b2c' },
  { key: 'crash_course', label: 'Crash course', audience: 'b2c' },
  { key: 'test_series', label: 'Test series', audience: 'b2c' },
  { key: 'program', label: 'Program', audience: 'b2c' },
  { key: 'software_test_platform', label: 'Online test platform', audience: 'b2b' },
  { key: 'software_erp', label: 'ERP', audience: 'b2b' },
  { key: 'software_other', label: 'Other software', audience: 'b2b' },
];

export const productKind = (key) => PRODUCT_KINDS.find((kind) => kind.key === key) ?? null;
export const accountKind = (key) => ACCOUNT_KINDS.find((kind) => kind.key === key) ?? null;
