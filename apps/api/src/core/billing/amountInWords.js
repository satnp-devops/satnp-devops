/**
 * Amounts in words for invoices, using the Indian numbering system (thousand, lakh, crore):
 * 12345678.90 → "Rupees One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy
 * Eight and Ninety Paise Only". Above 99 crore the crore count is itself read in Indian words
 * ("One Lakh Crore"). Also formats figures with Indian digit grouping (1,23,45,678.90).
 */

const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

/** Currency names for the words; amounts in these currencies have two decimal places. */
export const CURRENCY_WORDS = Object.freeze({
  INR: { major: 'Rupees', minor: 'Paise' },
  USD: { major: 'US Dollars', minor: 'Cents' },
  EUR: { major: 'Euros', minor: 'Cents' },
  GBP: { major: 'Pounds Sterling', minor: 'Pence' },
  AED: { major: 'UAE Dirhams', minor: 'Fils' },
  SGD: { major: 'Singapore Dollars', minor: 'Cents' },
  AUD: { major: 'Australian Dollars', minor: 'Cents' },
  CAD: { major: 'Canadian Dollars', minor: 'Cents' },
});

/** @param {number} n 0-99 @param {string} joiner */
function belowHundred(n, joiner) {
  if (n < 20) return ONES[n];
  const tens = TENS[Math.floor(n / 10)];
  return n % 10 === 0 ? tens : `${tens}${joiner}${ONES[n % 10]}`;
}

/** @param {number} n 0-999 @param {string} joiner */
function belowThousand(n, joiner) {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  return [hundreds ? `${ONES[hundreds]} Hundred` : '', rest ? belowHundred(rest, joiner) : ''].filter(Boolean).join(' ');
}

/**
 * A whole number in Indian words, e.g. 150000 → "One Lakh Fifty Thousand".
 * @param {number} n non-negative safe integer
 * @param {{ hyphenate?: boolean }} [options] "Twenty-Three" instead of "Twenty Three"
 * @returns {string}
 */
export function toIndianWords(n, { hyphenate = false } = {}) {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError('toIndianWords takes a non-negative whole number');
  if (n === 0) return 'Zero';
  const joiner = hyphenate ? '-' : ' ';
  const words = [];
  const crore = Math.floor(n / 10_000_000);
  let rest = n % 10_000_000;
  if (crore) words.push(`${toIndianWords(crore, { hyphenate })} Crore`);
  const lakh = Math.floor(rest / 100_000);
  rest %= 100_000;
  if (lakh) words.push(`${belowHundred(lakh, joiner)} Lakh`);
  const thousand = Math.floor(rest / 1000);
  rest %= 1000;
  if (thousand) words.push(`${belowHundred(thousand, joiner)} Thousand`);
  if (rest) words.push(belowThousand(rest, joiner));
  return words.join(' ');
}

/**
 * An amount of money in words for an invoice.
 * @param {number} amountMinor integer minor units (paise)
 * @param {{ currency?: string, hyphenate?: boolean, upperCase?: boolean }} [options]
 * @returns {string} e.g. "Rupees Eleven Thousand Eight Hundred and Fifty Paise Only"
 */
export function amountInWords(amountMinor, { currency = 'INR', hyphenate = false, upperCase = false } = {}) {
  if (!Number.isSafeInteger(amountMinor)) throw new RangeError('amountInWords takes whole minor units');
  const names = CURRENCY_WORDS[/** @type {keyof typeof CURRENCY_WORDS} */ (currency)];
  if (!names) throw new RangeError(`No words for currency ${currency}`);
  const negative = amountMinor < 0;
  const abs = Math.abs(amountMinor);
  const major = Math.floor(abs / 100);
  const minor = abs % 100;
  const parts = [`${names.major} ${toIndianWords(major, { hyphenate })}`];
  if (minor) parts.push(`and ${belowHundred(minor, hyphenate ? '-' : ' ')} ${names.minor}`);
  const text = `${negative ? 'Minus ' : ''}${parts.join(' ')} Only`;
  return upperCase ? text.toUpperCase() : text;
}

/**
 * Indian digit grouping with two decimals: 1234567.8 rupees → "12,34,567.80".
 * @param {number} amountMinor
 * @param {{ symbol?: boolean }} [options] prefix "₹"
 */
export function formatInr(amountMinor, { symbol = false } = {}) {
  if (!Number.isSafeInteger(amountMinor)) throw new RangeError('formatInr takes whole minor units');
  const negative = amountMinor < 0;
  const abs = Math.abs(amountMinor);
  const rupees = String(Math.floor(abs / 100));
  const paise = String(abs % 100).padStart(2, '0');
  const lastThree = rupees.slice(-3);
  const head = rupees.slice(0, -3);
  const grouped = head ? `${head.replace(/\B(?=(\d{2})+$)/g, ',')},${lastThree}` : lastThree;
  return `${negative ? '-' : ''}${symbol ? '₹' : ''}${grouped}.${paise}`;
}
