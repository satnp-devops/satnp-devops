/**
 * Integer money helpers for the billing engine.
 *
 * Money is always an integer number of minor units (paise for INR). No floating-point value ever
 * holds money: products and ratios go through BigInt and are rounded once, half away from zero
 * (so 0.5 paise becomes 1 paisa), which is the commercial rounding Indian invoices use.
 */
import { errors } from '../../lib/errors.js';

/** Basis points in one whole: 10000 bp = 100%. */
export const BP = 10000;

/**
 * Throw a 422 unless `value` is a safe integer amount of minor units.
 * @param {unknown} value
 * @param {string} [path] field path for the error
 * @param {{ allowNegative?: boolean }} [options]
 * @returns {number}
 */
export function assertMinor(value, path = 'amountMinor', { allowNegative = false } = {}) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || (!allowNegative && value < 0)) {
    throw errors.validation([
      {
        path,
        message: allowNegative
          ? 'Must be a whole number of minor units'
          : 'Must be a whole, non-negative number of minor units',
      },
    ]);
  }
  return value;
}

/** @param {bigint} value */
function toSafeNumber(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new RangeError('Amount is too large to represent exactly');
  return n;
}

/**
 * round(a × b ÷ c), half away from zero, exact for any safe integers.
 * @param {number} a
 * @param {number} b
 * @param {number} c
 * @returns {number}
 */
export function mulDivRound(a, b, c) {
  if (c === 0) throw new RangeError('Division by zero');
  const n = BigInt(a) * BigInt(b);
  const d = BigInt(c);
  const negative = n < 0n !== d < 0n && n !== 0n;
  const an = n < 0n ? -n : n;
  const ad = d < 0n ? -d : d;
  const q = an / ad;
  const rounded = (an % ad) * 2n >= ad ? q + 1n : q;
  return toSafeNumber(negative ? -rounded : rounded);
}

/**
 * floor(a × b ÷ c) for non-negative safe integers.
 * @param {number} a
 * @param {number} b
 * @param {number} c
 * @returns {number}
 */
export function mulDivFloor(a, b, c) {
  if (c === 0) throw new RangeError('Division by zero');
  if (a < 0 || b < 0 || c < 0) throw new RangeError('mulDivFloor takes non-negative numbers');
  return toSafeNumber((BigInt(a) * BigInt(b)) / BigInt(c));
}

/**
 * Round an amount to a multiple of `unit` (for example 100 paise = one rupee), half away from zero.
 * @param {number} amountMinor
 * @param {number} unit
 */
export function roundToUnit(amountMinor, unit) {
  return mulDivRound(amountMinor, 1, unit) * unit;
}

/** @param {number[]} values */
export const sumMinor = (values) => values.reduce((total, value) => total + value, 0);

/**
 * Split `totalMinor` in proportion to `weights` with the largest-remainder method, so the parts
 * always add up to the total exactly. Ties go to the earliest index; zero weights get nothing.
 * When every weight is zero the total is split as evenly as possible.
 * @param {number} totalMinor non-negative
 * @param {number[]} weights non-negative integers
 * @returns {number[]}
 */
export function allocateProportionally(totalMinor, weights) {
  if (weights.length === 0) throw new RangeError('Nothing to allocate across');
  if (totalMinor < 0 || weights.some((w) => !Number.isSafeInteger(w) || w < 0)) {
    throw new RangeError('allocateProportionally takes a non-negative total and weights');
  }
  const effective = weights.every((w) => w === 0) ? weights.map(() => 1) : weights;
  const weightTotal = BigInt(sumMinor(effective));
  const total = BigInt(totalMinor);
  const parts = effective.map((w) => (total * BigInt(w)) / weightTotal);
  const remainders = effective.map((w, index) => ({ index, rest: (total * BigInt(w)) % weightTotal }));
  let left = total - parts.reduce((a, b) => a + b, 0n);
  remainders.sort((x, y) => (y.rest > x.rest ? 1 : y.rest < x.rest ? -1 : x.index - y.index));
  for (const { index } of remainders) {
    if (left === 0n) break;
    if (effective[index] === 0) continue;
    parts[index] += 1n;
    left -= 1n;
  }
  return parts.map(toSafeNumber);
}

/**
 * Quantities may carry up to three decimals (as on GST e-invoices). They are held as integer
 * thousandths so amounts stay exact.
 * @param {number} quantity
 * @returns {number} quantity × 1000
 */
export function quantityToMilli(quantity) {
  const milli = Math.round(quantity * 1000);
  if (Math.abs(milli - quantity * 1000) > 1e-6) throw new RangeError('Quantity has more than three decimals');
  return milli;
}
