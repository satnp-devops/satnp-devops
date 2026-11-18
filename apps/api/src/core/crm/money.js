// Money is stored as an integer count of the currency's minor unit (paise for INR, cents for USD)
// plus an ISO 4217 code. Never store or add amounts as floating-point rupees.

/** Currencies whose minor unit is not 1/100 (ISO 4217). Everything else uses 2 decimals. */
const EXPONENTS = {
  BHD: 3,
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  IQD: 3,
  ISK: 0,
  JOD: 3,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  PYG: 0,
  RWF: 0,
  TND: 3,
  UGX: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
};

/** Upper bound for stored amounts: comfortably inside JavaScript's safe integers and Postgres bigint. */
export const MAX_VALUE_MINOR = 100_000_000_000_000;

const CODE = /^[A-Z]{3}$/;

export const isCurrencyCode = (code) => typeof code === 'string' && CODE.test(code);

/** Number of decimals in a currency's minor unit: INR 2, JPY 0, KWD 3. */
export function currencyExponent(currency) {
  if (!isCurrencyCode(currency)) throw new TypeError(`"${currency}" is not an ISO 4217 currency code`);
  return EXPONENTS[currency] ?? 2;
}

/**
 * Convert a decimal amount to minor units without floating-point drift:
 * toMinor('1250.5', 'INR') → 125050; toMinor(19.999, 'USD') → 2000 (rounded half away from zero).
 */
export function toMinor(amount, currency) {
  const exponent = currencyExponent(currency);
  const text = typeof amount === 'number' ? amountToString(amount) : String(amount ?? '').trim().replace(/,/g, '');
  const match = /^([+-])?(\d*)(?:\.(\d*))?$/.exec(text);
  if (!match || (match[2] === '' && (match[3] ?? '') === '')) throw new TypeError(`"${amount}" is not an amount`);
  const [, sign, whole, fraction = ''] = match;
  const padded = fraction.padEnd(exponent + 1, '0');
  let minor = BigInt(whole || '0') * 10n ** BigInt(exponent) + BigInt(padded.slice(0, exponent) || '0');
  if (Number(padded[exponent]) >= 5) minor += 1n;
  if (sign === '-') minor = -minor;
  const result = Number(minor);
  if (!Number.isSafeInteger(result)) throw new RangeError('Amount is too large');
  return result;
}

function amountToString(value) {
  if (!Number.isFinite(value)) throw new TypeError(`${value} is not an amount`);
  // toFixed(10) avoids exponent notation and rounds away binary noise like 19.999999999.
  return value.toFixed(10);
}

/** Minor units back to a decimal string: fromMinor(125050, 'INR') → "1250.50". */
export function fromMinor(minor, currency) {
  const exponent = currencyExponent(currency);
  const value = BigInt(Math.trunc(Number(minor)));
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(exponent + 1, '0');
  const whole = digits.slice(0, digits.length - exponent) || '0';
  const fraction = exponent > 0 ? `.${digits.slice(-exponent)}` : '';
  return `${negative ? '-' : ''}${whole}${fraction}`;
}

/**
 * Format for people: formatMoney(1250000, 'INR') → "₹12,500"; formatMoney(125050, 'INR') → "₹1,250.50".
 * Whole amounts drop the decimals.
 */
export function formatMoney(minor, currency, locale = 'en-IN') {
  const exponent = currencyExponent(currency);
  const value = Number(minor);
  const whole = value % 10 ** exponent === 0;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: whole ? 0 : exponent,
    maximumFractionDigits: exponent,
  }).format(value / 10 ** exponent);
}

/** Totals per currency, sorted by currency code: [{ currency: 'INR', valueMinor: 250000 }]. */
export function sumByCurrency(items) {
  const totals = new Map();
  for (const item of items) {
    const currency = item.currency;
    totals.set(currency, (totals.get(currency) ?? 0) + Number(item.valueMinor ?? item.value_minor ?? 0));
  }
  return [...totals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, valueMinor]) => ({ currency, valueMinor }));
}

/** bigint columns arrive from pg as strings; present them as numbers (always safe below MAX_VALUE_MINOR). */
export const minorFromDb = (value) => (value === null || value === undefined ? 0 : Number(value));
