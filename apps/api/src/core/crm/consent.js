import { db } from '../../lib/db.js';
import { CONSENT_CHANNELS, CONSENT_PURPOSES } from './constants.js';

// Consent and opt-out (India's DPDP Act, 2023). `consents` is an append-only history: each row
// records that a person granted or withdrew consent for a purpose on a channel, for one company
// or (company_id null) for the whole group. The effective state is the latest applicable record
// (docs/crm/PHASE2_CONTRACT.md §5.12). The contacts module writes records; messaging (phase 5)
// and automations (phase 9) read the state through these helpers before sending anything.
//
// Separately, contact_methods.opted_out_at blocks a single number or address for everything.

const SPECIFIC_CHANNELS = CONSENT_CHANNELS.filter((channel) => channel !== 'all');

const time = (value) => new Date(value).getTime();

/**
 * The effective consent for one company, channel and purpose. Pure.
 * A record applies when it is for that company or for the whole group, and for that channel or
 * for "all". The latest captured_at wins (then the latest created row), whoever recorded it.
 * @param {Array<{ id: string, company_id: string | null, channel: string, purpose: string, status: 'granted' | 'withdrawn', captured_at: Date | string, created_at?: Date | string }>} records
 * @param {{ companyId: string | null, channel: string, purpose: string }} target
 * @returns {{ status: 'granted' | 'withdrawn' | 'unknown', record: object | null }}
 */
export function effectiveConsent(records, { companyId, channel, purpose }) {
  let best = null;
  for (const record of records) {
    if (record.purpose !== purpose) continue;
    if (record.channel !== channel && record.channel !== 'all') continue;
    if (record.company_id !== null && record.company_id !== companyId) continue;
    if (
      !best ||
      time(record.captured_at) > time(best.captured_at) ||
      (time(record.captured_at) === time(best.captured_at) && time(record.created_at ?? 0) > time(best.created_at ?? 0))
    ) {
      best = record;
    }
  }
  return { status: best ? best.status : 'unknown', record: best };
}

/**
 * May a company message a person for a purpose on a channel?
 *   marketing                 only with consent granted
 *   transactional, service    unless consent was withdrawn
 * @param {'granted' | 'withdrawn' | 'unknown'} status
 */
export function consentAllows(status, purpose) {
  return purpose === 'marketing' ? status === 'granted' : status !== 'withdrawn';
}

/**
 * The effective state for every specific channel and purpose, for the API's consent panel. Pure.
 * @returns {Array<{ companyId: string | null, channel: string, purpose: string, status: string, recordId: string | null, capturedAt: Date | string | null }>}
 */
export function consentMatrix(records, companyId) {
  const out = [];
  for (const channel of SPECIFIC_CHANNELS) {
    for (const purpose of CONSENT_PURPOSES) {
      const { status, record } = effectiveConsent(records, { companyId, channel, purpose });
      out.push({ companyId, channel, purpose, status, recordId: record?.id ?? null, capturedAt: record?.captured_at ?? null });
    }
  }
  return out;
}

/** Every consent record of a person that can apply to a company (its own and group-wide ones), oldest first. */
export function loadConsentRecords(contactId, companyId, trx = db) {
  return trx('consents')
    .where({ contact_id: contactId })
    .where((where) => {
      where.whereNull('company_id');
      if (companyId) where.orWhere('company_id', companyId);
    })
    .orderBy([{ column: 'captured_at' }, { column: 'created_at' }]);
}

/**
 * Can a company contact a person for a purpose on a channel right now? Checks the consent records
 * and, when a normalised number or address is given, its opt-out flag.
 * @returns {Promise<{ allowed: boolean, status: 'granted' | 'withdrawn' | 'unknown', optedOut: boolean }>}
 */
export async function canContact({ contactId, companyId, channel, purpose, normalized = null }, trx = db) {
  const [records, method] = await Promise.all([
    loadConsentRecords(contactId, companyId, trx),
    normalized
      ? trx('contact_methods').where({ contact_id: contactId, normalized }).whereNotNull('opted_out_at').first('id')
      : null,
  ]);
  const { status } = effectiveConsent(records, { companyId, channel, purpose });
  const optedOut = Boolean(method);
  return { allowed: !optedOut && consentAllows(status, purpose), status, optedOut };
}
