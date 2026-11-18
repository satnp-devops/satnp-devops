import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_FORMATS,
  MAX_DOCUMENT_NUMBER_LENGTH,
  checkDocumentNumber,
  counterKey,
  describeSeries,
  financialYear,
  financialYearStartingIn,
  findSeriesConflicts,
  formatDocumentNumber,
  fyLabel,
  isValidDocumentNumber,
  maxSequence,
  nextDocumentNumber,
  parseDocumentNumber,
  resolveSeries,
} from '../../src/core/billing/invoiceNumber.js';
import { assertValidation } from './helpers.js';

test('the financial year runs April to March', () => {
  assert.deepEqual(financialYear('2026-04-01'), { startYear: 2026, endYear: 2027, label: '2026-27', start: '2026-04-01', end: '2027-03-31' });
  assert.equal(financialYear('2027-03-31').startYear, 2026);
  assert.equal(financialYear('2026-03-31').startYear, 2025);
  assert.equal(financialYear('2026-12-31').label, '2026-27');
  assert.equal(financialYear('2027-01-01').label, '2026-27');
  assert.equal(financialYearStartingIn(2099).label, '2099-00');
  assert.throws(() => financialYearStartingIn(1999), RangeError);
});

test('instants are read in Indian time at the year boundary', () => {
  assert.equal(financialYear('2027-03-31T18:29:59Z').startYear, 2026, '23:59:59 IST on 31 March');
  assert.equal(financialYear('2027-03-31T18:30:00Z').startYear, 2027, '00:00 IST on 1 April');
  assert.equal(financialYear(Date.UTC(2027, 2, 31, 18, 30)).startYear, 2027);
  assert.equal(financialYear('2027-03-31T20:00:00Z', 'Europe/London').startYear, 2026, 'another zone, another date');
});

test('financial-year styles', () => {
  assert.equal(fyLabel(2026, 'long'), '2026-27');
  assert.equal(fyLabel(2026, 'short'), '26-27');
  assert.equal(fyLabel(2026, 'compact'), '2627');
  assert.equal(fyLabel(2026, 'startYear'), '2026');
  assert.equal(fyLabel(2099, 'compact'), '9900');
  assert.equal(fyLabel(2009, 'short'), '09-10');
  assert.throws(() => fyLabel(2026, 'roman'), RangeError);
});

test('numbers are prefix + financial year + zero-padded sequence', () => {
  assert.equal(formatDocumentNumber({ prefix: 'PVI' }, { sequence: 42, fyStartYear: 2026 }), 'PVI/2627/00042');
  assert.equal(formatDocumentNumber({ prefix: 'SP', fyStyle: 'short', padding: 6 }, { sequence: 1, fyStartYear: 2026 }), 'SP/26-27/000001');
  assert.equal(formatDocumentNumber({ prefix: 'EX', format: '{prefix}-{fy}-{seq}', fyStyle: 'long', padding: 4 }, { sequence: 7, fyStartYear: 2026 }), 'EX-2026-27-0007');
  assert.equal(formatDocumentNumber({ prefix: 'PVI' }, { sequence: 1, date: '2027-04-01' }), 'PVI/2728/00001');
});

test('credit notes have their own series and visibly different numbers', () => {
  const invoice = formatDocumentNumber({ prefix: 'PVI', documentType: 'invoice' }, { sequence: 1, fyStartYear: 2026 });
  const credit = formatDocumentNumber({ prefix: 'PVI', documentType: 'credit_note' }, { sequence: 1, fyStartYear: 2026 });
  const debit = formatDocumentNumber({ prefix: 'PVI', documentType: 'debit_note' }, { sequence: 1, fyStartYear: 2026 });
  assert.equal(invoice, 'PVI/2627/00001');
  assert.equal(credit, 'PVI/CN2627/00001');
  assert.equal(debit, 'PVI/DN2627/00001');
  assert.deepEqual(findSeriesConflicts([{ prefix: 'PVI' }, { prefix: 'PVI', documentType: 'credit_note' }, { prefix: 'PVI', documentType: 'debit_note' }]), []);
  assert.equal(resolveSeries({ documentType: 'bill_of_supply', prefix: 'X' }).format, DEFAULT_FORMATS.bill_of_supply);
});

test('the 16-character limit is checked against the longest number a series can produce', () => {
  assert.equal(MAX_DOCUMENT_NUMBER_LENGTH, 16);
  const exact = describeSeries({ prefix: 'PVI', documentType: 'credit_note' });
  assert.equal(exact.ok, true);
  assert.equal(exact.maxLength, 16);
  assert.equal(exact.example, 'PVI/CN2627/00001');
  const over = describeSeries({ prefix: 'PVIX', documentType: 'credit_note' });
  assert.equal(over.ok, false);
  assert.equal(over.maxLength, 17);
  assert.equal(over.issues[0].code, 'too_long');
  assert.equal(describeSeries({ prefix: 'PHOENIXX', fyStyle: 'long' }).issues[0].code, 'too_long');
  assertValidation(() => formatDocumentNumber({ prefix: 'PVIX', documentType: 'credit_note' }, { sequence: 1, fyStartYear: 2026 }), 'series');
});

test('the sequence must fit the padding', () => {
  const series = { prefix: 'PVI' };
  assert.equal(maxSequence(resolveSeries(series)), 99_999);
  assert.equal(nextDocumentNumber(series, { lastSequence: 99_998, fyStartYear: 2026 }).number, 'PVI/2627/99999');
  assertValidation(() => nextDocumentNumber(series, { lastSequence: 99_999, fyStartYear: 2026 }), 'sequence');
  assertValidation(() => formatDocumentNumber(series, { sequence: 0, fyStartYear: 2026 }), 'sequence');
  assertValidation(() => formatDocumentNumber(series, { sequence: 1.5, fyStartYear: 2026 }), 'sequence');
});

test('next number restarts at 1 in a new financial year', () => {
  const series = { prefix: 'PVI' };
  const march = nextDocumentNumber(series, { lastSequence: 1234, date: '2027-03-31' });
  assert.deepEqual(march, { fyStartYear: 2026, fyLabel: '2026-27', sequence: 1235, number: 'PVI/2627/01235' });
  const april = nextDocumentNumber(series, { date: '2027-04-01' });
  assert.deepEqual(april, { fyStartYear: 2027, fyLabel: '2027-28', sequence: 1, number: 'PVI/2728/00001' });
});

test('only letters, digits, "/" and "-" are allowed', () => {
  assertValidation(() => resolveSeries({ prefix: 'PV I' }), 'series.prefix');
  assertValidation(() => resolveSeries({ prefix: 'PV_I' }), 'series.prefix');
  assertValidation(() => resolveSeries({ prefix: 'PV', format: '{prefix}#{seq}' }), 'series.format');
  assertValidation(() => resolveSeries({ prefix: 'PV', format: '{prefix}/{year}/{seq}' }), 'series.format');
  assertValidation(() => resolveSeries({ prefix: 'PV', format: '{prefix}/{fy}' }), 'series.format');
  assertValidation(() => resolveSeries({ prefix: 'PV', format: '{seq}/{seq}' }), 'series.format');
  assertValidation(() => resolveSeries({ prefix: 'PV', format: '{fy}{fy}{seq}' }), 'series.format');
  assertValidation(() => resolveSeries({ prefix: 'PV', padding: 0 }), 'series.padding');
});

test('numbers may not start with 0, "/" or "-" (e-invoice rule)', () => {
  assert.equal(describeSeries({ prefix: 'PV', format: '{seq}/{fy}' }).issues[0].code, 'bad_first_character');
  assert.equal(describeSeries({ prefix: '-PV' }).issues[0].code, 'bad_first_character');
  assert.equal(describeSeries({ prefix: '0PV' }).issues[0].code, 'bad_first_character');
  assert.equal(describeSeries({ prefix: '' }).issues[0].code, 'bad_first_character', 'the default format then starts with "/"');
  assert.equal(describeSeries({ prefix: '', format: '{fy}/{seq}' }).ok, true, 'years start with 2');
});

test('describeSeries reports malformed series instead of throwing', () => {
  const bad = describeSeries({ prefix: 'P V' });
  assert.equal(bad.ok, false);
  assert.equal(bad.series, null);
  assert.equal(bad.issues[0].code, 'invalid');
});

test('a series without the financial year warns that numbers recur', () => {
  const description = describeSeries({ prefix: 'R', format: '{prefix}{seq}' });
  assert.equal(description.ok, true);
  assert.equal(description.warnings[0].code, 'no_financial_year');
});

test('checkDocumentNumber applies the rule to any string', () => {
  assert.deepEqual(checkDocumentNumber('PVI/2627/00001'), { valid: true, error: null });
  assert.equal(checkDocumentNumber('inv-26-27/1').valid, true, 'lower case is allowed');
  assert.equal(checkDocumentNumber('').error, 'empty');
  assert.equal(checkDocumentNumber('A'.repeat(17)).error, 'too_long');
  assert.equal(checkDocumentNumber('A'.repeat(16)).valid, true);
  assert.equal(checkDocumentNumber('INV#1').error, 'characters');
  assert.equal(checkDocumentNumber('INV 1').error, 'characters');
  assert.equal(checkDocumentNumber('/INV1').error, 'first_character');
  assert.equal(checkDocumentNumber('-INV1').error, 'first_character');
  assert.equal(checkDocumentNumber('0001').error, 'first_character');
  assert.equal(isValidDocumentNumber('1001'), true);
  assert.equal(isValidDocumentNumber(undefined), false);
});

test('numbers parse back into year and sequence', () => {
  const series = { prefix: 'PVI' };
  assert.deepEqual(parseDocumentNumber(series, 'PVI/2627/00042'), { fy: '2627', fyStartYear: 2026, sequence: 42 });
  assert.equal(parseDocumentNumber(series, 'PVI/2627/0042'), null, 'wrong padding');
  assert.equal(parseDocumentNumber(series, 'PVX/2627/00042'), null, 'wrong prefix');
  assert.equal(parseDocumentNumber(series, 'PVI/2627/00000'), null, 'sequences start at 1');
  assert.equal(parseDocumentNumber(series, 'PVI/2699/00001')?.fyStartYear, null, 'not a real year pair');
  assert.deepEqual(parseDocumentNumber({ prefix: 'SP', fyStyle: 'long' }, 'SP/2026-27/00001'), { fy: '2026-27', fyStartYear: 2026, sequence: 1 });
  assert.deepEqual(parseDocumentNumber({ prefix: 'R', format: '{prefix}{seq}' }, 'R00009'), { fy: null, fyStartYear: null, sequence: 9 });
  for (const sequence of [1, 77, 99_999]) {
    const number = formatDocumentNumber(series, { sequence, fyStartYear: 2031 });
    assert.deepEqual(parseDocumentNumber(series, number), { fy: '3132', fyStartYear: 2031, sequence });
  }
});

test('series that could produce the same number are flagged', () => {
  const a = { prefix: 'INV', format: '{prefix}{seq}', padding: 5 };
  const b = { prefix: 'INV0', format: '{prefix}{seq}', padding: 4 };
  assert.deepEqual(findSeriesConflicts([a, b]), [[0, 1]]);
  assert.deepEqual(findSeriesConflicts([a, { ...a }]), [[0, 1]], 'a duplicate series');
  assert.deepEqual(findSeriesConflicts([{ ...a, gstin: '27AAPFU0939F1ZV' }, { ...b, gstin: '33GSPTN3382G1Z4' }]), [], 'different GSTINs never clash');
  assert.deepEqual(findSeriesConflicts([{ prefix: 'PVI' }, { prefix: 'SPI' }]), []);
});

test('counter keys identify one counter per GSTIN, type, prefix and year', () => {
  assert.equal(counterKey({ gstin: '27aapfu0939f1zv', documentType: 'invoice', prefix: 'PVI', fyStartYear: 2026 }), '27AAPFU0939F1ZV:invoice:PVI:2026');
  assert.notEqual(
    counterKey({ gstin: '27AAPFU0939F1ZV', documentType: 'invoice', prefix: 'PVI', fyStartYear: 2026 }),
    counterKey({ gstin: '27AAPFU0939F1ZV', documentType: 'credit_note', prefix: 'PVI', fyStartYear: 2026 }),
  );
});
