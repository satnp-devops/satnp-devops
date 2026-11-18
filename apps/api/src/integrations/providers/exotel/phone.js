import { ExotelValidationError } from './errors.js';

/**
 * Phone-number helpers for Exotel and Indian calling rules.
 *
 * Exotel wants `To` in E.164 and accepts E.164 or a SIP URI for `From`. CRM data is messy
 * ("98765 43210", "098765-43210", "919876543210"), so everything goes through toE164 first.
 */

const SIP_URI = /^sip:[^\s@]+@[^\s@]+$/i;

/** @param {unknown} value */
export function isSipUri(value) {
  return typeof value === 'string' && SIP_URI.test(value.trim());
}

/**
 * Normalises a phone number to E.164.
 * @param {string} input
 * @param {{ defaultCountryCode?: string }} [options]
 * @returns {string}
 * @throws {ExotelValidationError}
 */
export function toE164(input, { defaultCountryCode = '91' } = {}) {
  const result = toE164Safe(input, { defaultCountryCode });
  if (!result) throw new ExotelValidationError('Phone number is not a valid E.164 number', { code: 'invalid_phone' });
  return result;
}

/**
 * Like toE164 but returns null instead of throwing.
 * @param {unknown} input
 * @param {{ defaultCountryCode?: string }} [options]
 * @returns {string | null}
 */
export function toE164Safe(input, { defaultCountryCode = '91' } = {}) {
  if (typeof input !== 'string' && typeof input !== 'number') return null;
  const text = String(input).trim();
  if (!text || /[^\d\s()+.-]/.test(text)) return null;
  const hasPlus = text.startsWith('+');
  let digits = text.replace(/\D/g, '');
  let e164;
  if (hasPlus) e164 = `+${digits}`;
  else if (digits.startsWith('00')) e164 = `+${digits.slice(2)}`;
  else if (defaultCountryCode === '91') {
    if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
    if (digits.length === 12 && digits.startsWith('91')) e164 = `+${digits}`;
    else if (digits.length === 10 || isIndianSpecialLength(digits)) e164 = `+91${digits}`;
    else return null;
  } else {
    e164 = `+${defaultCountryCode}${digits.replace(/^0/, '')}`;
  }
  if (!/^\+[1-9]\d{6,14}$/.test(e164)) return null;
  if (e164.startsWith('+91') && !isValidIndianNsn(e164.slice(3))) return null;
  return e164;
}

/** Toll-free (1800/1860) numbers have an 11-digit national number. @param {string} nsn */
function isIndianSpecialLength(nsn) {
  return nsn.length === 11 && /^18[06]0/.test(nsn);
}

/** @param {string} nsn national significant number (without +91 or trunk 0) */
function isValidIndianNsn(nsn) {
  if (isIndianSpecialLength(nsn)) return true;
  return /^[1-9]\d{9}$/.test(nsn);
}

/**
 * @typedef {'promotional_140' | 'bfsi_govt_1600' | 'service_1601' | 'toll_free' | 'standard' | 'non_indian' | 'invalid'} NumberSeries
 */

/**
 * Classifies a number by the Indian series rules that matter for outbound calling.
 *  - 140xx: the only series allowed for promotional voice calls; operators scrub DND preferences.
 *  - 1600xx: service/transactional calls by RBI/SEBI/IRDAI/PFRDA entities and government only.
 *  - 1601xx: service/transactional calls by other sectors, rolled out in phases (Direction of
 *    10 Aug 2026 covers utilities, logistics and courier first). Education is not yet included.
 * @param {string} number
 * @returns {NumberSeries}
 */
export function classifyIndianNumber(number) {
  const e164 = toE164Safe(number);
  if (!e164) return 'invalid';
  if (!e164.startsWith('+91')) return 'non_indian';
  const nsn = e164.slice(3);
  if (nsn.startsWith('140')) return 'promotional_140';
  if (nsn.startsWith('1600')) return 'bfsi_govt_1600';
  if (nsn.startsWith('1601')) return 'service_1601';
  if (/^18[06]0/.test(nsn)) return 'toll_free';
  // Ordinary 10-digit mobile or fixed-line number (they cannot be told apart by prefix alone).
  return 'standard';
}

/**
 * @typedef {'service' | 'transactional' | 'promotional'} CallPurpose
 * @typedef {{ allowed: boolean, series: NumberSeries, reasons: string[], warnings: string[] }} ComplianceResult
 */

/**
 * Pre-dial check of the caller ID against the TRAI number-series rules (TCCCPR 2018 as amended).
 * This is a guard rail, not legal advice: it cannot see the customer's DND preference or consent.
 * @param {{ purpose?: CallPurpose, callerId: string }} input
 * @returns {ComplianceResult}
 */
export function checkCallCompliance({ purpose = 'service', callerId }) {
  const series = classifyIndianNumber(callerId);
  /** @type {string[]} */
  const reasons = [];
  /** @type {string[]} */
  const warnings = [];
  if (series === 'invalid') reasons.push('caller_id_invalid');
  if (purpose === 'promotional') {
    if (series !== 'promotional_140') reasons.push('promotional_calls_require_140_series_caller_id');
    warnings.push('promotional_calls_are_blocked_for_numbers_on_the_dnd_registry');
  } else {
    if (series === 'promotional_140') warnings.push('service_call_from_140_series_is_treated_as_promotional');
    if (series === 'bfsi_govt_1600') warnings.push('1600_series_is_reserved_for_bfsi_and_government');
    warnings.push('service_calls_need_an_existing_relationship_or_consent_record');
  }
  return { allowed: reasons.length === 0, series, reasons, warnings };
}
