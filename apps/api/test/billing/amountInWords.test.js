import { test } from 'node:test';
import assert from 'node:assert/strict';
import { amountInWords, formatInr, toIndianWords } from '../../src/core/billing/amountInWords.js';
import { seededRandom } from './helpers.js';

test('whole numbers in Indian words', () => {
  const cases = [
    [0, 'Zero'],
    [1, 'One'],
    [15, 'Fifteen'],
    [21, 'Twenty One'],
    [90, 'Ninety'],
    [100, 'One Hundred'],
    [101, 'One Hundred One'],
    [115, 'One Hundred Fifteen'],
    [999, 'Nine Hundred Ninety Nine'],
    [1000, 'One Thousand'],
    [1001, 'One Thousand One'],
    [11_800, 'Eleven Thousand Eight Hundred'],
    [99_999, 'Ninety Nine Thousand Nine Hundred Ninety Nine'],
    [100_000, 'One Lakh'],
    [110_000, 'One Lakh Ten Thousand'],
    [1_234_567, 'Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven'],
    [10_000_000, 'One Crore'],
    [10_000_001, 'One Crore One'],
    [12_345_678, 'One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight'],
    [999_999_999, 'Ninety Nine Crore Ninety Nine Lakh Ninety Nine Thousand Nine Hundred Ninety Nine'],
    [1_000_000_000, 'One Hundred Crore'],
    [100_000_000_000, 'Ten Thousand Crore'],
    [1_000_000_000_000, 'One Lakh Crore'],
  ];
  for (const [n, words] of cases) assert.equal(toIndianWords(n), words, String(n));
  assert.equal(toIndianWords(21, { hyphenate: true }), 'Twenty-One');
  const max = toIndianWords(Number.MAX_SAFE_INTEGER);
  assert.ok(max.startsWith('Ninety Crore Seven Lakh Nineteen Thousand Nine Hundred Twenty Five Crore'), max);
  assert.ok(max.endsWith('Crore Forty Seven Lakh Forty Thousand Nine Hundred Ninety One'), max);
  assert.throws(() => toIndianWords(-1), RangeError);
  assert.throws(() => toIndianWords(1.5), RangeError);
});

test('invoice amounts in rupees and paise', () => {
  assert.equal(amountInWords(0), 'Rupees Zero Only');
  assert.equal(amountInWords(100), 'Rupees One Only');
  assert.equal(amountInWords(50), 'Rupees Zero and Fifty Paise Only');
  assert.equal(amountInWords(1), 'Rupees Zero and One Paise Only');
  assert.equal(amountInWords(1_180_000), 'Rupees Eleven Thousand Eight Hundred Only');
  assert.equal(amountInWords(1_180_050), 'Rupees Eleven Thousand Eight Hundred and Fifty Paise Only');
  assert.equal(amountInWords(10_000_000), 'Rupees One Lakh Only');
  assert.equal(amountInWords(1_000_000_000), 'Rupees One Crore Only');
  assert.equal(
    amountInWords(1_234_567_890),
    'Rupees One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight and Ninety Paise Only',
  );
});

test('options: hyphens, capitals, negatives and other currencies', () => {
  assert.equal(amountInWords(2_199, { hyphenate: true }), 'Rupees Twenty-One and Ninety-Nine Paise Only');
  assert.equal(amountInWords(100_000, { upperCase: true }), 'RUPEES ONE THOUSAND ONLY');
  assert.equal(amountInWords(-150), 'Minus Rupees One and Fifty Paise Only');
  assert.equal(amountInWords(100_050, { currency: 'USD' }), 'US Dollars One Thousand and Fifty Cents Only');
  assert.throws(() => amountInWords(100, { currency: 'JPY' }), RangeError);
  assert.throws(() => amountInWords(1.5), RangeError);
});

test('Indian digit grouping', () => {
  assert.equal(formatInr(0), '0.00');
  assert.equal(formatInr(5), '0.05');
  assert.equal(formatInr(99_999), '999.99');
  assert.equal(formatInr(100_000), '1,000.00');
  assert.equal(formatInr(10_000_000), '1,00,000.00');
  assert.equal(formatInr(12_345_678), '1,23,456.78');
  assert.equal(formatInr(1_234_567_890), '1,23,45,678.90');
  assert.equal(formatInr(-1_180_050, { symbol: true }), '-₹11,800.50');
  assert.throws(() => formatInr(0.5), RangeError);
});

test('grouping matches the platform locale formatter', () => {
  const format = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: true });
  const random = seededRandom(11);
  for (let run = 0; run < 300; run += 1) {
    const minor = random.int(0, 2 ** 40);
    assert.equal(formatInr(minor), format.format(minor / 100), String(minor));
  }
});
