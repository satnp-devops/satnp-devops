/**
 * Stripe amount rules (docs.stripe.com/currencies, checked 2026-11-05).
 *
 * The client's amounts are integers in Stripe's smallest unit for the currency:
 *   - two-decimal currencies (USD, EUR, INR, ...): cents/paise, 10.99 USD -> 1099
 *   - zero-decimal currencies (JPY, KRW, ...): whole units, 500 JPY -> 500
 *   - ISK and UGX: Stripe wants a two-decimal value whose decimals are always 00
 *     (5 ISK -> 500) even though ISO 4217 gives both 0 decimals. isoMinorToStripe() converts.
 */

export const ZERO_DECIMAL_CURRENCIES = new Set([
  'bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'vnd', 'vuv', 'xaf', 'xof', 'xpf',
]);

/**
 * Represented with two decimals that must be 00. Stripe lists UGX both as zero-decimal and
 * here; the special-case rule is the more specific one, so UGX lives here.
 */
export const WHOLE_UNITS_IN_HUNDREDTHS = new Set(['isk', 'ugx']);

/**
 * Three-decimal currencies. Not listed on the current currencies page (and not presentable
 * from Indian accounts); kept so amounts aren't silently mis-scaled. Unconfirmed: see docs.
 */
export const THREE_DECIMAL_CURRENCIES = new Set(['bhd', 'jod', 'kwd', 'omr', 'tnd']);

/** Digits Stripe allows in `amount` for non-card methods (cards allow up to 12). */
export const MAX_AMOUNT_DIGITS = Object.freeze({ idr: 12, cop: 10, inr: 9, default: 8 });

/**
 * Normalises an ISO 4217 code to Stripe's lowercase form.
 * @param {string} currency
 * @returns {string}
 */
export function normalizeCurrency(currency) {
  const code = String(currency ?? '').trim().toLowerCase();
  if (!/^[a-z]{3}$/.test(code)) throw new RangeError(`Invalid currency code: ${String(currency).slice(0, 10)}`);
  return code;
}

/**
 * Decimal places Stripe uses in `amount` for this currency.
 * @param {string} currency
 * @returns {0|2|3}
 */
export function stripeDecimals(currency) {
  const code = normalizeCurrency(currency);
  if (ZERO_DECIMAL_CURRENCIES.has(code)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(code)) return 3;
  return 2;
}

/** @param {string} currency */
export function isZeroDecimal(currency) {
  return stripeDecimals(currency) === 0;
}

/**
 * Throws RangeError unless `amount` is a valid Stripe amount for `currency`.
 * @param {number} amount
 * @param {string} currency
 * @param {{ allowZero?: boolean }} [options]
 */
export function assertStripeAmount(amount, currency, { allowZero = true } = {}) {
  const code = normalizeCurrency(currency);
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new RangeError('Amount must be a non-negative integer in the currency’s smallest unit');
  }
  if (!allowZero && amount === 0) throw new RangeError('Amount must be greater than zero');
  if (WHOLE_UNITS_IN_HUNDREDTHS.has(code) && amount % 100 !== 0) {
    throw new RangeError(`${code.toUpperCase()} amounts must be whole units (a multiple of 100 in Stripe’s representation)`);
  }
}

/**
 * Converts an ISO 4217 minor-unit amount to Stripe's representation (only ISK and UGX change).
 * @param {number} amount
 * @param {string} currency
 */
export function isoMinorToStripe(amount, currency) {
  return WHOLE_UNITS_IN_HUNDREDTHS.has(normalizeCurrency(currency)) ? amount * 100 : amount;
}

/**
 * Converts a Stripe amount to ISO 4217 minor units (only ISK and UGX change).
 * @param {number} amount
 * @param {string} currency
 */
export function stripeToIsoMinor(amount, currency) {
  return WHOLE_UNITS_IN_HUNDREDTHS.has(normalizeCurrency(currency)) ? Math.round(amount / 100) : amount;
}

/**
 * "10.99" + USD -> 1099; "500" + JPY -> 500; "5" + ISK -> 500. Exact decimal parsing, no floats.
 * @param {string|number} major
 * @param {string} currency
 * @returns {number}
 */
export function majorToStripeAmount(major, currency) {
  const code = normalizeCurrency(currency);
  const text = typeof major === 'number' ? major.toFixed(stripeDecimals(code)) : String(major).trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new RangeError('Amount must be a non-negative decimal number');
  const decimals = stripeDecimals(code);
  const fraction = match[2] ?? '';
  if (fraction.replace(/0+$/, '').length > decimals) {
    throw new RangeError(`${code.toUpperCase()} allows at most ${decimals} decimal places`);
  }
  const amount = Number(match[1] + fraction.padEnd(decimals, '0').slice(0, decimals));
  assertStripeAmount(amount, code);
  return amount;
}

/**
 * 1099 + USD -> "10.99"; 500 + JPY -> "500".
 * @param {number} amount
 * @param {string} currency
 * @returns {string}
 */
export function stripeAmountToMajor(amount, currency) {
  const decimals = stripeDecimals(currency);
  if (!Number.isSafeInteger(amount)) throw new RangeError('Amount must be an integer');
  const sign = amount < 0 ? '-' : '';
  const digits = String(Math.abs(amount)).padStart(decimals + 1, '0');
  return decimals === 0 ? `${sign}${digits}` : `${sign}${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
}
