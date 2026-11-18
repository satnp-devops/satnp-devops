/**
 * GSTIN (Goods and Services Tax Identification Number) checks and the GST state/UT code table.
 *
 * A regular GSTIN has 15 characters:
 *   27 AAPFU0939F 1 Z V
 *   │  │          │ │ └ check character (base-36 checksum over the first 14)
 *   │  │          │ └ "Z" by default
 *   │  │          └ entity number for the same PAN in that state (1-9, then A-Z)
 *   │  └ PAN of the holder (5 letters, 4 digits, 1 letter)
 *   └ state or UT code
 *
 * Special registrations (UIN for embassies and UN bodies, TDS/TCS deductors, non-resident and
 * OIDAR suppliers) use other layouts in the middle but the same state prefix and checksum; pass
 * `{ allowSpecial: true }` to accept them.
 */

const BASE36 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * @typedef {object} StateCode
 * @property {string} code two digits
 * @property {string} name
 * @property {'state' | 'ut' | 'other'} kind
 * @property {'SGST' | 'UTGST' | null} localTax the tax charged with CGST on an intra-state supply
 * @property {boolean} active false for codes kept only for old registrations
 */

/** @type {ReadonlyArray<StateCode>} */
export const STATE_CODES = Object.freeze(
  [
    ['01', 'Jammu and Kashmir', 'ut', 'SGST'],
    ['02', 'Himachal Pradesh', 'state', 'SGST'],
    ['03', 'Punjab', 'state', 'SGST'],
    ['04', 'Chandigarh', 'ut', 'UTGST'],
    ['05', 'Uttarakhand', 'state', 'SGST'],
    ['06', 'Haryana', 'state', 'SGST'],
    ['07', 'Delhi', 'ut', 'SGST'],
    ['08', 'Rajasthan', 'state', 'SGST'],
    ['09', 'Uttar Pradesh', 'state', 'SGST'],
    ['10', 'Bihar', 'state', 'SGST'],
    ['11', 'Sikkim', 'state', 'SGST'],
    ['12', 'Arunachal Pradesh', 'state', 'SGST'],
    ['13', 'Nagaland', 'state', 'SGST'],
    ['14', 'Manipur', 'state', 'SGST'],
    ['15', 'Mizoram', 'state', 'SGST'],
    ['16', 'Tripura', 'state', 'SGST'],
    ['17', 'Meghalaya', 'state', 'SGST'],
    ['18', 'Assam', 'state', 'SGST'],
    ['19', 'West Bengal', 'state', 'SGST'],
    ['20', 'Jharkhand', 'state', 'SGST'],
    ['21', 'Odisha', 'state', 'SGST'],
    ['22', 'Chhattisgarh', 'state', 'SGST'],
    ['23', 'Madhya Pradesh', 'state', 'SGST'],
    ['24', 'Gujarat', 'state', 'SGST'],
    ['25', 'Daman and Diu (merged into 26 in 2020)', 'ut', 'UTGST', false],
    ['26', 'Dadra and Nagar Haveli and Daman and Diu', 'ut', 'UTGST'],
    ['27', 'Maharashtra', 'state', 'SGST'],
    ['28', 'Andhra Pradesh (before 2014)', 'state', 'SGST', false],
    ['29', 'Karnataka', 'state', 'SGST'],
    ['30', 'Goa', 'state', 'SGST'],
    ['31', 'Lakshadweep', 'ut', 'UTGST'],
    ['32', 'Kerala', 'state', 'SGST'],
    ['33', 'Tamil Nadu', 'state', 'SGST'],
    ['34', 'Puducherry', 'ut', 'SGST'],
    ['35', 'Andaman and Nicobar Islands', 'ut', 'UTGST'],
    ['36', 'Telangana', 'state', 'SGST'],
    ['37', 'Andhra Pradesh', 'state', 'SGST'],
    ['38', 'Ladakh', 'ut', 'UTGST'],
    ['97', 'Other Territory', 'other', 'UTGST'],
    ['99', 'Centre Jurisdiction', 'other', null],
  ].map(([code, name, kind, localTax, active = true]) => Object.freeze({ code, name, kind, localTax, active })),
);

/** Place-of-supply code for supplies outside India (e-invoice schema, "Pos": 96). */
export const OUTSIDE_INDIA_CODE = '96';

const byCode = new Map(STATE_CODES.map((s) => [s.code, s]));

/**
 * @param {string | number} code "7", "07" or 7
 * @returns {string | null} the two-digit code, or null when it isn't a number
 */
export function normaliseStateCode(code) {
  const text = String(code ?? '').trim();
  if (!/^\d{1,2}$/.test(text)) return null;
  return text.padStart(2, '0');
}

/** @param {string | number} code @returns {StateCode | null} */
export function stateByCode(code) {
  const normalised = normaliseStateCode(code);
  return normalised ? (byCode.get(normalised) ?? null) : null;
}

/**
 * Is this a code a place of supply or a supplier can carry? Retired codes (25, 28) are refused
 * unless `allowRetired` is set; 99 (Centre Jurisdiction) is not a place of supply.
 * @param {string | number} code
 * @param {{ allowRetired?: boolean, allowCentre?: boolean }} [options]
 */
export function isValidStateCode(code, { allowRetired = false, allowCentre = false } = {}) {
  const state = stateByCode(code);
  if (!state) return false;
  if (state.code === '99') return allowCentre;
  return state.active || allowRetired;
}

/** @param {string} char */
const valueOf = (char) => BASE36.indexOf(char);

/**
 * The check character for the first 14 characters of a GSTIN: each character's base-36 value is
 * multiplied by 1 and 2 alternately, the product's base-36 digits are added up, and the check
 * character is whatever brings the total to a multiple of 36.
 * @param {string} first14
 * @returns {string}
 */
export function gstinCheckCharacter(first14) {
  const text = String(first14).toUpperCase();
  if (!/^[0-9A-Z]{14}$/.test(text)) throw new RangeError('A GSTIN check character needs 14 letters or digits');
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const product = valueOf(text[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return BASE36[(36 - (sum % 36)) % 36];
}

const REGULAR = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const PAN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

/** Fourth PAN character → holder type (Income Tax Department PAN structure). */
export const PAN_HOLDER_TYPES = Object.freeze({
  P: 'individual',
  C: 'company',
  H: 'hindu_undivided_family',
  F: 'firm',
  A: 'association_of_persons',
  T: 'trust',
  B: 'body_of_individuals',
  L: 'local_authority',
  J: 'artificial_juridical_person',
  G: 'government',
});

/** @param {unknown} value */
export const normaliseGstin = (value) => String(value ?? '').replace(/\s+/g, '').toUpperCase();

/**
 * @typedef {object} GstinCheck
 * @property {boolean} valid
 * @property {string} gstin normalised (trimmed, upper case)
 * @property {string | null} error code: length | characters | state_code | format | checksum
 * @property {string} [message]
 * @property {'regular' | 'special'} [kind]
 * @property {string} [stateCode]
 * @property {string} [stateName]
 * @property {string | null} [pan] null for special registrations
 * @property {string | null} [panHolderType]
 * @property {string} [entityNumber]
 * @property {string} [checkCharacter]
 */

/**
 * Validate a GSTIN and take it apart.
 * @param {unknown} value
 * @param {{ allowSpecial?: boolean }} [options]
 * @returns {GstinCheck}
 */
export function validateGstin(value, { allowSpecial = false } = {}) {
  const gstin = normaliseGstin(value);
  const fail = (error, message) => ({ valid: false, gstin, error, message });
  if (gstin.length !== 15) return fail('length', 'A GSTIN has 15 characters');
  if (!/^[0-9A-Z]{15}$/.test(gstin)) return fail('characters', 'A GSTIN has only letters and digits');
  const stateCode = gstin.slice(0, 2);
  const state = stateByCode(stateCode);
  if (!state || (state.code === '99' && !allowSpecial)) return fail('state_code', `${stateCode} is not a GST state code`);
  const regular = REGULAR.test(gstin);
  if (!regular && !allowSpecial) {
    return fail('format', 'Expected 2-digit state code, 10-character PAN, entity number, Z and a check character');
  }
  const expected = gstinCheckCharacter(gstin.slice(0, 14));
  if (gstin[14] !== expected) return fail('checksum', 'The last character does not match; check for a typo');
  const pan = regular ? gstin.slice(2, 12) : null;
  return {
    valid: true,
    gstin,
    error: null,
    kind: regular ? 'regular' : 'special',
    stateCode,
    stateName: state.name,
    pan,
    panHolderType: pan ? (PAN_HOLDER_TYPES[pan[3]] ?? null) : null,
    entityNumber: gstin[12],
    checkCharacter: expected,
  };
}

/** @param {unknown} value @param {{ allowSpecial?: boolean }} [options] */
export const isValidGstin = (value, options) => validateGstin(value, options).valid;

/** State code of a valid GSTIN, else null. @param {unknown} value */
export const stateCodeFromGstin = (value) => validateGstin(value, { allowSpecial: true }).stateCode ?? null;

/** PAN inside a valid regular GSTIN, else null. @param {unknown} value */
export const panFromGstin = (value) => validateGstin(value).pan ?? null;

/** @param {unknown} value */
export const isValidPan = (value) => PAN.test(String(value ?? '').toUpperCase());

/**
 * A zod-friendly refinement: `z.string().refine(gstinRefinement, 'Enter a valid GSTIN')`.
 * @param {string} value
 */
export const gstinRefinement = (value) => isValidGstin(value);
