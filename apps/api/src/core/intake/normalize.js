/**
 * Reference normalisers for the intake engine.
 *
 * Every intake function takes a `normalizers` option so the phase 2 helper
 * (core/crm/normalize.js) can be plugged in without touching the engine. These reference
 * versions are deliberately small, dependency free and good enough for tests and imports:
 *
 * - phone: E.164 ("+919876543210") or null. Indian numbers are understood in every common
 *   written form; other countries need a leading "+" / "00" or a known default country.
 * - email: trimmed, lower-cased address or null when it is not an address.
 * - name: display-cleaned name ("RAHUL  SHARMA" → "Rahul Sharma"), '' when empty.
 */

/** @typedef {{ defaultCountry?: string }} PhoneOptions */

/**
 * @typedef {object} Normalizers
 * @property {(raw: unknown, options?: PhoneOptions) => string | null} phone  E.164 or null
 * @property {(raw: unknown) => string | null} email  lower-cased address or null
 * @property {(raw: unknown) => string} name  display-cleaned name, '' when empty
 */

/** Calling codes for the countries Phoenix families and institutes most often come from. */
export const CALLING_CODES = Object.freeze({
  IN: '91',
  AE: '971',
  SA: '966',
  QA: '974',
  KW: '965',
  OM: '968',
  BH: '973',
  NP: '977',
  BD: '880',
  LK: '94',
  SG: '65',
  MY: '60',
  GB: '44',
  US: '1',
  CA: '1',
  AU: '61',
  NZ: '64',
});

const EXTENSION = /\s*(?:ext\.?|extn\.?|extension|x|#)\s*\d{1,6}\s*$/i;

/**
 * Normalise a phone number to E.164.
 * @param {unknown} raw
 * @param {PhoneOptions} [options]
 * @returns {string | null}
 */
export function normalizePhone(raw, { defaultCountry = 'IN' } = {}) {
  if (raw === null || raw === undefined) return null;
  let text = String(raw).trim();
  // Real numbers are short; the cap also keeps the regexes below linear on hostile input.
  if (!text || text.length > 64) return null;
  text = text.replace(EXTENSION, '').replace(/^\(\s*(\+|00)/, '$1');
  // Only digits, spaces, separators and one leading plus are allowed: "call me" is not a number.
  if (!/^\+?[\d\s().\-/]+$/.test(text)) return null;
  let digits = text.replace(/\D/g, '');
  let international = text.startsWith('+');
  if (!international && digits.startsWith('00')) {
    international = true;
    digits = digits.slice(2);
  }

  if (international) {
    // Indian numbers are often written "+91 0 98765 43210": drop the trunk zero.
    if (digits.startsWith('910') && digits.length === 13) digits = `91${digits.slice(3)}`;
    if (digits.startsWith('91')) return indian(digits.slice(2));
    if (digits.length < 8 || digits.length > 15 || digits.startsWith('0')) return null;
    return `+${digits}`;
  }

  if (defaultCountry === 'IN') {
    if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
    else if (digits.length === 13 && digits.startsWith('910')) digits = digits.slice(3);
    else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
    return indian(digits);
  }

  const code = CALLING_CODES[defaultCountry];
  if (!code) return null;
  digits = digits.replace(/^0+/, '');
  if (digits.length < 6 || code.length + digits.length > 15) return null;
  return `+${code}${digits}`;
}

/** Ten-digit Indian national number (mobile or STD landline) to E.164. */
function indian(national) {
  if (!/^[1-9]\d{9}$/.test(national)) return null;
  if (/^(\d)\1{9}$/.test(national) || national === '1234567890') return null; // placeholder junk
  return `+91${national}`;
}

/**
 * Normalise an email address: trim, lower-case, strip "mailto:" and "Name <addr>" wrappers.
 * @param {unknown} raw
 * @returns {string | null}
 */
export function normalizeEmail(raw) {
  if (raw === null || raw === undefined) return null;
  let text = String(raw).trim();
  const bracketed = /<([^<>]+)>\s*$/.exec(text);
  if (bracketed) text = bracketed[1];
  text = text.trim().replace(/^mailto:/i, '').toLowerCase().replace(/\.+$/, '');
  if (text.length > 254) return null;
  if (!/^[^\s@<>(),;:"]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/.test(text)) {
    return null;
  }
  return text;
}

/**
 * The mailbox an address delivers to, for matching aliases of one person:
 * "+tags" are dropped everywhere, and Gmail ignores dots and treats googlemail.com as gmail.com.
 * @param {string} email  an already normalised address
 */
export function emailMailboxKey(email) {
  const at = email.lastIndexOf('@');
  if (at < 1) return email;
  let local = email.slice(0, at);
  let domain = email.slice(at + 1);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  local = local.split('+')[0];
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return `${local}@${domain}`;
}

/**
 * Clean a name for display: collapse whitespace, drop wrapping quotes and stray punctuation,
 * and title-case names typed entirely in upper or lower case.
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeName(raw) {
  if (raw === null || raw === undefined) return '';
  let text = String(raw).normalize('NFC').replace(/\s+/g, ' ').trim();
  text = text.replace(/^[\s"'`,.;:-]+|[\s"'`,;:-]+$/g, '').trim();
  if (!text) return '';
  const letters = text.replace(/[^A-Za-z]/g, '');
  if (letters && (letters === letters.toUpperCase() || letters === letters.toLowerCase())) {
    text = text.toLowerCase().replace(/(^|[\s.'-])([a-z])/g, (_m, sep, ch) => sep + ch.toUpperCase());
  }
  return text;
}

/** @type {Normalizers} */
export const referenceNormalizers = Object.freeze({
  phone: normalizePhone,
  email: normalizeEmail,
  name: normalizeName,
});

/**
 * Fill any missing normaliser with the reference one, so callers may override just one.
 * @param {Partial<Normalizers>} [overrides]
 * @returns {Normalizers}
 */
export function resolveNormalizers(overrides) {
  return { ...referenceNormalizers, ...(overrides ?? {}) };
}
