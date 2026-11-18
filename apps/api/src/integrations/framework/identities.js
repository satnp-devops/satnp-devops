import { db } from '../../lib/db.js';
import { CHANNEL_TYPES } from '../../core/intake/enquiry.js';
import { normalizeIdentity } from '../../core/intake/routing.js';

/**
 * Channel identities: the numbers, inboxes, forms, pages and links enquiries arrive on, each
 * owned by one company or shared by several. Next wave's intake routes with them:
 *
 *   const identities = await loadChannelIdentities(groupId);
 *   const result = await route({ channel: enquiry.source.channel, identities, enquiry, classify, thresholds });
 *
 * Types are the intake channel types (core/intake/enquiry.js). An identity may belong to a
 * connection (the WhatsApp number of a WhatsApp connection); web forms, lead-ad pages and
 * partner links usually have none.
 */

export const IDENTITY_TYPES = CHANNEL_TYPES;

/** Which identity types a connection of each kind can carry. Other kinds carry none. */
export const KIND_IDENTITY_TYPES = Object.freeze({
  'messaging.whatsapp': ['whatsapp'],
  'messaging.email': ['email'],
  'messaging.sms': ['sms'],
  calling: ['phone_call', 'missed_call'],
});

/** What each type's identity looks like, for the form. */
export const IDENTITY_HINTS = Object.freeze({
  website_form: 'Form id, or the site host (satnpaper.com)',
  landing_page: 'Page URL or host',
  chat_widget: 'Widget id or site host',
  whatsapp: 'Business number, e.g. +919876543210',
  phone_call: 'Number dialled, e.g. +918045671234',
  missed_call: 'Missed-call number',
  sms: 'Number or sender id',
  email: 'Receiving inbox, e.g. admissions@satnpaper.in',
  facebook_lead_ad: 'Facebook page id or lead form id',
  instagram: 'Instagram account id',
  google_lead_form: 'Google lead form id',
  walk_in: 'Branch unit id',
  event: 'Event id (fair, seminar, school visit)',
  partner_referral: 'Partner link prefix or partner id',
  csv_import: 'Import batch id',
  api: 'API client id',
  other: 'Any identifier',
});

export function normalizeChannelIdentity(type, identity) {
  return normalizeIdentity(type, identity);
}

const E164 = /^\+[1-9]\d{6,14}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Why a normalised identity can't be registered, or null. Numbers that customers dial or message
 * must normalise to E.164 (intake matches on that); inboxes must be email addresses.
 */
export function identityProblem(type, normalized) {
  if (!normalized) return 'Enter the number, inbox, form or link';
  if (['whatsapp', 'phone_call', 'missed_call'].includes(type) && !E164.test(normalized)) return 'Enter the full number with its country code, e.g. +919876543210';
  if (type === 'email' && !EMAIL.test(normalized)) return 'Enter an email address, e.g. admissions@satnpaper.in';
  return null;
}

/** The group's identity registry in the shape core/intake/routing.js expects. */
export async function loadChannelIdentities(groupId, trx = db) {
  const rows = await trx('channel_identities').where({ group_id: groupId }).whereNull('archived_at').orderBy('created_at');
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    identity: row.identity_normalized,
    companyId: row.company_id ?? undefined,
    productLineId: row.product_line_id ?? undefined,
    shared: row.shared,
    companyIds: row.shared ? row.company_ids : undefined,
    connectionId: row.connection_id ?? undefined,
  }));
}
