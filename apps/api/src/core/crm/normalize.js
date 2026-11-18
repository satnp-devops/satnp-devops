// Normalisation used for de-duplication and exact lookups. Pure functions, no dependencies.
//
//   phones  → E.164 ("+919812345678"), using the company's default country for national numbers
//   emails  → trimmed and lower-cased
//   names   → lower-case, no accents, punctuation or honorifics, single spaces ("priya sharma")
//   domains → bare host without www ("satnpaper.example")

/**
 * Countries we can read national numbers for. `lengths` are national significant number lengths
 * (without the trunk prefix). Numbers written with +CC work for every country.
 */
export const PHONE_COUNTRIES = {
  IN: { name: 'India', callingCode: '91', lengths: [10], trunk: '0', firstDigit: /^[2-9]/ },
  AE: { name: 'United Arab Emirates', callingCode: '971', lengths: [8, 9], trunk: '0' },
  SA: { name: 'Saudi Arabia', callingCode: '966', lengths: [8, 9], trunk: '0' },
  QA: { name: 'Qatar', callingCode: '974', lengths: [8], trunk: null },
  KW: { name: 'Kuwait', callingCode: '965', lengths: [8], trunk: null },
  OM: { name: 'Oman', callingCode: '968', lengths: [8], trunk: null },
  BH: { name: 'Bahrain', callingCode: '973', lengths: [8], trunk: null },
  SG: { name: 'Singapore', callingCode: '65', lengths: [8], trunk: null },
  MY: { name: 'Malaysia', callingCode: '60', lengths: [9, 10], trunk: '0' },
  NP: { name: 'Nepal', callingCode: '977', lengths: [8, 9, 10], trunk: '0' },
  BD: { name: 'Bangladesh', callingCode: '880', lengths: [10], trunk: '0' },
  LK: { name: 'Sri Lanka', callingCode: '94', lengths: [9], trunk: '0' },
  GB: { name: 'United Kingdom', callingCode: '44', lengths: [9, 10], trunk: '0' },
  US: { name: 'United States', callingCode: '1', lengths: [10], trunk: '1', firstDigit: /^[2-9]/ },
  CA: { name: 'Canada', callingCode: '1', lengths: [10], trunk: '1', firstDigit: /^[2-9]/ },
  AU: { name: 'Australia', callingCode: '61', lengths: [9], trunk: '0' },
};

export const DEFAULT_PHONE_COUNTRY = 'IN';

const MIN_E164_DIGITS = 8;
const MAX_E164_DIGITS = 15;

/** Countries for a calling code, longest code first, so "+971..." is not read as "+97...". */
function countryForInternational(digits) {
  let best = null;
  for (const [code, country] of Object.entries(PHONE_COUNTRIES)) {
    if (!digits.startsWith(country.callingCode)) continue;
    if (!best || country.callingCode.length > PHONE_COUNTRIES[best].callingCode.length) best = code;
  }
  // +1 is shared by the US and Canada; we can't tell them apart without area codes.
  if (best === 'CA') best = 'US';
  return best;
}

function fitsNational(country, national) {
  return country.lengths.includes(national.length) && (!country.firstDigit || country.firstDigit.test(national));
}

/**
 * Normalise a phone number to E.164.
 * Handles spaces, dashes, dots and brackets, "tel:" links, a leading + or 00, national numbers
 * with or without the trunk prefix (098123 45678), and +CC numbers that repeat the trunk
 * prefix (+91 098123 45678).
 * @param {unknown} input
 * @param {string} [defaultCountry] ISO 3166 alpha-2 code used for numbers without a country code
 * @returns {{ e164: string, country: string | null, national: string } | null} null when it isn't a phone number
 */
export function normalizePhone(input, defaultCountry = DEFAULT_PHONE_COUNTRY) {
  if (typeof input !== 'string' && typeof input !== 'number') return null;
  const text = String(input).trim().replace(/^tel:/i, '');
  if (!text) return null;
  // Only digits and the usual separators are allowed; letters mean it isn't a number (or has an extension).
  if (!/^\(?\+?[\d\s().\-/]+$/.test(text)) return null;
  // "+91 ..." or "(+91) ..."
  const hasPlus = /^\(?\+/.test(text);
  let digits = text.replace(/\D/g, '');
  if (!digits) return null;

  let international = hasPlus;
  if (!hasPlus && digits.startsWith('00')) {
    international = true;
    digits = digits.slice(2);
  }

  if (international) {
    const code = countryForInternational(digits);
    if (code) {
      const country = PHONE_COUNTRIES[code];
      let national = digits.slice(country.callingCode.length);
      // "+91 0 98123 45678": drop a trunk prefix written after the country code.
      if (country.trunk && national.startsWith(country.trunk) && !fitsNational(country, national)) {
        const withoutTrunk = national.slice(country.trunk.length);
        if (fitsNational(country, withoutTrunk)) national = withoutTrunk;
      }
      if (!fitsNational(country, national)) return null;
      return { e164: `+${country.callingCode}${national}`, country: code, national };
    }
    if (digits.length < MIN_E164_DIGITS || digits.length > MAX_E164_DIGITS || digits.startsWith('0')) return null;
    return { e164: `+${digits}`, country: null, national: digits };
  }

  const code = PHONE_COUNTRIES[defaultCountry] ? defaultCountry : DEFAULT_PHONE_COUNTRY;
  const country = PHONE_COUNTRIES[code];
  if (fitsNational(country, digits)) return { e164: `+${country.callingCode}${digits}`, country: code, national: digits };
  if (country.trunk && digits.startsWith(country.trunk)) {
    const national = digits.slice(country.trunk.length);
    if (fitsNational(country, national)) return { e164: `+${country.callingCode}${national}`, country: code, national };
  }
  // The country code written without a plus: "919812345678".
  if (digits.startsWith(country.callingCode)) {
    const national = digits.slice(country.callingCode.length);
    if (fitsNational(country, national)) return { e164: `+${country.callingCode}${national}`, country: code, national };
  }
  return null;
}

/** Just the E.164 string, or null. */
export const toE164 = (input, defaultCountry) => normalizePhone(input, defaultCountry)?.e164 ?? null;

/** Split an E.164 number into its calling code and national number, when the country is known. */
export function splitE164(e164) {
  if (typeof e164 !== 'string' || !e164.startsWith('+')) return null;
  const digits = e164.slice(1);
  const code = countryForInternational(digits);
  if (!code) return { callingCode: null, national: digits, country: null };
  const { callingCode } = PHONE_COUNTRIES[code];
  return { callingCode, national: digits.slice(callingCode.length), country: code };
}

/** Variants of a number people type into search: +919812345678, 919812345678, 9812345678. */
export function phoneSearchTokens(e164) {
  const parts = splitE164(e164);
  if (!parts) return [];
  const tokens = [e164, e164.slice(1)];
  if (parts.callingCode) tokens.push(parts.national);
  return [...new Set(tokens)];
}

const EMAIL = /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[^\s@<>()[\],;:"]{2,}$/;

/** Lower-case an email address for matching. Returns null when it isn't one. */
export function normalizeEmail(input) {
  if (typeof input !== 'string') return null;
  const value = input.trim().replace(/^mailto:/i, '').toLowerCase();
  if (value.length > 254 || !EMAIL.test(value)) return null;
  return value;
}

/** The domain of an email address ("ravi@school.example" → "school.example"). */
export function emailDomain(email) {
  const normalized = normalizeEmail(email);
  return normalized ? normalized.slice(normalized.lastIndexOf('@') + 1) : null;
}

/** Free mailbox providers: their domains say nothing about which institute someone works at. */
export const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.co.in',
  'yahoo.in',
  'ymail.com',
  'outlook.com',
  'outlook.in',
  'hotmail.com',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'rediffmail.com',
  'zoho.com',
  'zohomail.in',
  'mail.com',
  'gmx.com',
]);

export const isFreeEmailDomain = (domain) => FREE_EMAIL_DOMAINS.has(String(domain ?? '').toLowerCase());

/** A website or email domain reduced to its host: "https://www.School.example/about" → "school.example". */
export function normalizeDomain(input) {
  if (typeof input !== 'string') return null;
  let value = input.trim().toLowerCase();
  if (!value) return null;
  if (value.includes('@') && !value.includes('/')) value = value.slice(value.lastIndexOf('@') + 1);
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  value = value.split(/[/?#]/)[0].replace(/:\d+$/, '').replace(/^www\d?\./, '').replace(/\.$/, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(value) || value.length > 253) return null;
  return value;
}

/** Titles people put in front of names. They don't help tell people apart. */
const HONORIFICS = new Set([
  'mr',
  'mrs',
  'ms',
  'miss',
  'mx',
  'dr',
  'prof',
  'sir',
  'madam',
  'shri',
  'sri',
  'shrimati',
  'smt',
  'kumari',
  'km',
  'master',
]);

/** Name tokens for matching: ["priya", "sharma"]. */
export function nameTokens(input) {
  if (typeof input !== 'string') return [];
  const tokens = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  const withoutTitles = tokens.filter((token) => !HONORIFICS.has(token));
  return withoutTitles.length > 0 ? withoutTitles : tokens;
}

/** "Mrs. Priya  D'Souza" → "priya dsouza". Stored in name_normalized for sorting and fuzzy matching. */
export const normalizeName = (input) => nameTokens(input).join(' ');

/** Trigrams the way pg_trgm builds them: each word padded with two spaces in front and one behind. */
function trigrams(text) {
  const set = new Set();
  for (const word of String(text).split(' ').filter(Boolean)) {
    const padded = `  ${word} `;
    for (let i = 0; i + 3 <= padded.length; i += 1) set.add(padded.slice(i, i + 3));
  }
  return set;
}

/** Trigram similarity between 0 and 1, close to pg_trgm's similarity(). */
export function nameSimilarity(a, b) {
  const x = trigrams(normalizeName(a));
  const y = trigrams(normalizeName(b));
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const gram of x) if (y.has(gram)) shared += 1;
  return shared / (x.size + y.size - shared);
}

/**
 * Could two names belong to the same person? Used together with a shared phone or email, never alone.
 *   true   same name, a shorter form of it ("Priya" / "Priya Sharma"), an initial ("P Sharma"), or similar spelling
 *   false  clearly different first names ("Priya Sharma" / "Aarav Sharma": a parent and child sharing a number)
 *   null   one of the names is missing, so we can't tell
 */
export function namesLikelySame(a, b, threshold = 0.5) {
  const x = nameTokens(a);
  const y = nameTokens(b);
  if (x.length === 0 || y.length === 0) return null;
  if (x.join(' ') === y.join(' ')) return true;

  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.every((token) => long.includes(token))) return true;

  const firstA = x[0];
  const firstB = y[0];
  const initial = (firstA.length === 1 && firstB.startsWith(firstA)) || (firstB.length === 1 && firstA.startsWith(firstB));
  if (initial) {
    const restA = x.slice(1).join(' ');
    const restB = y.slice(1).join(' ');
    return !restA || !restB || restA === restB || nameSimilarity(restA, restB) >= threshold;
  }
  if (nameSimilarity(firstA, firstB) < 0.5) return false;
  return nameSimilarity(x.join(' '), y.join(' ')) >= threshold;
}

/** "  Priya   Sharma " → "Priya Sharma". */
export function displayName(firstName, lastName) {
  return [firstName, lastName]
    .map((part) => (typeof part === 'string' ? part.trim().replace(/\s+/g, ' ') : ''))
    .filter(Boolean)
    .join(' ');
}

/** Split a full name into first and last name at the first space. */
export function splitFullName(fullName) {
  const clean = typeof fullName === 'string' ? fullName.trim().replace(/\s+/g, ' ') : '';
  if (!clean) return { firstName: '', lastName: null };
  const index = clean.indexOf(' ');
  if (index === -1) return { firstName: clean, lastName: null };
  return { firstName: clean.slice(0, index), lastName: clean.slice(index + 1) };
}
