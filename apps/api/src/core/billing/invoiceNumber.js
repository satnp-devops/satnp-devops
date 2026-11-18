/**
 * Invoice and note numbering.
 *
 * CGST Rules 46(b), 49(b) and 53(1A)(c): a consecutive serial number of at most 16 characters, in
 * one or more series, using letters, digits, "-" and "/", unique for a financial year. The
 * e-invoice system also rejects numbers that start with "0", "/" or "-".
 *
 * A series belongs to one GSTIN and one document type (invoices, credit notes, debit notes, bills
 * of supply each have their own) and restarts every financial year (April to March). Numbers are
 * rendered from a template such as "{prefix}/{fy}/{seq}" → "PVI/2627/00042".
 *
 * This module only formats, parses and validates. Allocating the next sequence without gaps is a
 * database job; the contract is in docs/platform/BILLING_CORE.md ("Allocating numbers").
 */
import { z } from 'zod';
import { errors } from '../../lib/errors.js';
import { parseOrThrow } from '../../lib/validate.js';
import { DEFAULT_TIME_ZONE, formatDate, toCalendarDate } from './dates.js';
import { normaliseGstin } from './gstin.js';

export const MAX_DOCUMENT_NUMBER_LENGTH = 16;
export const DOCUMENT_TYPES = /** @type {const} */ (['invoice', 'credit_note', 'debit_note', 'bill_of_supply']);

/** Ways to write the financial year 2026-27 inside a number. */
export const FY_STYLES = Object.freeze({
  long: { example: '2026-27', pattern: '\\d{4}-\\d{2}' },
  short: { example: '26-27', pattern: '\\d{2}-\\d{2}' },
  compact: { example: '2627', pattern: '\\d{4}' },
  startYear: { example: '2026', pattern: '\\d{4}' },
});

/** Default templates: credit and debit notes get their own visible marker as well as their own counter. */
export const DEFAULT_FORMATS = Object.freeze({
  invoice: '{prefix}/{fy}/{seq}',
  credit_note: '{prefix}/CN{fy}/{seq}',
  debit_note: '{prefix}/DN{fy}/{seq}',
  bill_of_supply: '{prefix}/BS{fy}/{seq}',
});

const ALLOWED = /^[A-Za-z0-9/-]*$/;
const FIRST_CHARACTER = /^[A-Za-z1-9]/;

export const numberSeriesSchema = z.object({
  documentType: z.enum(DOCUMENT_TYPES).default('invoice'),
  prefix: z.string().regex(ALLOWED, 'Use letters, digits, "/" and "-" only').max(14).default(''),
  format: z.string().min(1).max(40).optional(),
  fyStyle: z.enum(/** @type {[keyof typeof FY_STYLES, ...Array<keyof typeof FY_STYLES>]} */ (Object.keys(FY_STYLES))).default('compact'),
  padding: z.number().int().min(1).max(12).default(5),
  gstin: z.string().optional(),
});

/** @typedef {z.input<typeof numberSeriesSchema>} NumberSeriesInput */
/** @typedef {z.output<typeof numberSeriesSchema> & { format: string }} NumberSeries */

/**
 * @typedef {object} FinancialYear
 * @property {number} startYear 2026 for April 2026 - March 2027
 * @property {number} endYear
 * @property {string} label "2026-27"
 * @property {string} start "2026-04-01"
 * @property {string} end "2027-03-31"
 */

/** @param {number} startYear @returns {FinancialYear} */
export function financialYearStartingIn(startYear) {
  if (!Number.isInteger(startYear) || startYear < 2000 || startYear > 9998) throw new RangeError('Unsupported year');
  return {
    startYear,
    endYear: startYear + 1,
    label: fyLabel(startYear, 'long'),
    start: formatDate(startYear, 4, 1),
    end: formatDate(startYear + 1, 3, 31),
  };
}

/**
 * The Indian financial year (1 April - 31 March) a date falls in. Instants are read in the
 * company's zone first, so 31 March 2027 23:30 IST is still FY 2026-27.
 * @param {string | number | Date} value calendar date or instant
 * @param {string} [timeZone]
 * @returns {FinancialYear}
 */
export function financialYear(value, timeZone = DEFAULT_TIME_ZONE) {
  const date = toCalendarDate(value, timeZone);
  const [year, month] = date.split('-').map(Number);
  return financialYearStartingIn(month >= 4 ? year : year - 1);
}

const two = (n) => String(n % 100).padStart(2, '0');

/** @param {number} startYear @param {keyof typeof FY_STYLES} style */
export function fyLabel(startYear, style) {
  switch (style) {
    case 'long':
      return `${startYear}-${two(startYear + 1)}`;
    case 'short':
      return `${two(startYear)}-${two(startYear + 1)}`;
    case 'compact':
      return `${two(startYear)}${two(startYear + 1)}`;
    case 'startYear':
      return String(startYear);
    default:
      throw new RangeError(`Unknown financial-year style ${style}`);
  }
}

const TOKEN = /\{(\w+)\}/g;

/**
 * Apply defaults and check the template's tokens. Throws 422 for a malformed series.
 * @param {NumberSeriesInput} input
 * @returns {NumberSeries}
 */
export function resolveSeries(input) {
  const series = parseOrThrow(numberSeriesSchema, input, 'series');
  const format = series.format ?? DEFAULT_FORMATS[series.documentType];
  const tokens = [...format.matchAll(TOKEN)].map((m) => m[1]);
  const fail = (message) => errors.validation([{ path: 'series.format', message }]);
  for (const token of tokens) if (!['prefix', 'fy', 'seq'].includes(token)) throw fail(`Unknown placeholder {${token}}`);
  if (tokens.filter((t) => t === 'seq').length !== 1) throw fail('The format needs {seq} exactly once');
  if (tokens.filter((t) => t === 'fy').length > 1 || tokens.filter((t) => t === 'prefix').length > 1) {
    throw fail('Use {prefix} and {fy} at most once');
  }
  if (!ALLOWED.test(format.replace(TOKEN, ''))) throw fail('Use letters, digits, "/" and "-" only');
  return { ...series, format, ...(series.gstin !== undefined && { gstin: normaliseGstin(series.gstin) }) };
}

/** @param {NumberSeries} series @param {number} startYear @param {string} seqText */
const render = (series, startYear, seqText) =>
  series.format.replace(TOKEN, (_, token) =>
    token === 'prefix' ? series.prefix : token === 'fy' ? fyLabel(startYear, series.fyStyle) : seqText,
  );

/** The largest sequence the series can carry (all nines in its padding). @param {NumberSeries} series */
export const maxSequence = (series) => 10 ** series.padding - 1;

/**
 * Check a series against the rules before it is saved.
 * @param {NumberSeriesInput} input
 * @returns {{ ok: boolean, issues: Array<{ code: string, message: string }>, warnings: Array<{ code: string, message: string }>,
 *   maxLength: number, maxSequence: number, example: string, series: NumberSeries | null }}
 */
export function describeSeries(input) {
  let series;
  try {
    series = resolveSeries(input);
  } catch (error) {
    const details = /** @type {any} */ (error).details ?? [];
    return {
      ok: false,
      issues: details.map((d) => ({ code: 'invalid', message: `${d.path}: ${d.message}` })),
      warnings: [],
      maxLength: 0,
      maxSequence: 0,
      example: '',
      series: null,
    };
  }
  const example = render(series, 2026, '1'.padStart(series.padding, '0'));
  const longest = render(series, 2026, '9'.repeat(series.padding));
  const issues = [];
  const warnings = [];
  if (longest.length > MAX_DOCUMENT_NUMBER_LENGTH) {
    issues.push({
      code: 'too_long',
      message: `Numbers reach ${longest.length} characters; the limit is ${MAX_DOCUMENT_NUMBER_LENGTH}. Shorten the prefix, the year style or the padding.`,
    });
  }
  if (!FIRST_CHARACTER.test(example)) {
    issues.push({ code: 'bad_first_character', message: 'Numbers must start with a letter or a digit other than 0' });
  }
  if (!series.format.includes('{fy}')) {
    warnings.push({
      code: 'no_financial_year',
      message: 'Numbers restart each financial year, so without {fy} the same number recurs every year',
    });
  }
  return { ok: issues.length === 0, issues, warnings, maxLength: longest.length, maxSequence: maxSequence(series), example, series };
}

/**
 * Does a string meet the document-number rules on its own?
 * @param {unknown} number
 * @returns {{ valid: boolean, error: null | 'empty' | 'too_long' | 'characters' | 'first_character' }}
 */
export function checkDocumentNumber(number) {
  const text = String(number ?? '');
  if (text.length === 0) return { valid: false, error: 'empty' };
  if (text.length > MAX_DOCUMENT_NUMBER_LENGTH) return { valid: false, error: 'too_long' };
  if (!ALLOWED.test(text)) return { valid: false, error: 'characters' };
  if (!FIRST_CHARACTER.test(text)) return { valid: false, error: 'first_character' };
  return { valid: true, error: null };
}

/** @param {unknown} number */
export const isValidDocumentNumber = (number) => checkDocumentNumber(number).valid;

/**
 * Render one number of a series.
 * @param {NumberSeriesInput} input
 * @param {{ sequence: number, fyStartYear?: number, date?: string | number | Date, timeZone?: string }} at
 * @returns {string}
 */
export function formatDocumentNumber(input, { sequence, fyStartYear, date, timeZone }) {
  const description = describeSeries(input);
  if (!description.ok || !description.series) {
    throw errors.validation(description.issues.map((issue) => ({ path: 'series', message: issue.message })));
  }
  const series = description.series;
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > maxSequence(series)) {
    throw errors.validation([{ path: 'sequence', message: `Sequence must be between 1 and ${maxSequence(series)}` }]);
  }
  const startYear = fyStartYear ?? financialYear(date ?? Date.now(), timeZone).startYear;
  const number = render(series, startYear, String(sequence).padStart(series.padding, '0'));
  const check = checkDocumentNumber(number);
  if (!check.valid) throw errors.validation([{ path: 'series', message: `Number ${number} breaks the rules (${check.error})` }]);
  return number;
}

/**
 * The number after `lastSequence` in the financial year of `date` (or `fyStartYear`).
 * Pass the last sequence for that same financial year; a new year starts again at 1.
 * @param {NumberSeriesInput} input
 * @param {{ lastSequence?: number, fyStartYear?: number, date?: string | number | Date, timeZone?: string }} at
 */
export function nextDocumentNumber(input, { lastSequence = 0, fyStartYear, date, timeZone } = {}) {
  const fy = fyStartYear !== undefined ? financialYearStartingIn(fyStartYear) : financialYear(date ?? Date.now(), timeZone);
  const sequence = lastSequence + 1;
  return {
    fyStartYear: fy.startYear,
    fyLabel: fy.label,
    sequence,
    number: formatDocumentNumber(input, { sequence, fyStartYear: fy.startYear }),
  };
}

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');

/**
 * Read a number back into its parts, or null if it doesn't belong to the series.
 * @param {NumberSeriesInput} input
 * @param {string} number
 * @returns {{ fy: string | null, fyStartYear: number | null, sequence: number } | null}
 */
export function parseDocumentNumber(input, number) {
  const series = resolveSeries(input);
  let fyGroup = false;
  const source = series.format
    .split(TOKEN)
    .map((part, i) => {
      if (i % 2 === 0) return escapeRe(part);
      if (part === 'prefix') return escapeRe(series.prefix);
      if (part === 'fy') {
        fyGroup = true;
        return `(?<fy>${FY_STYLES[series.fyStyle].pattern})`;
      }
      return `(?<seq>\\d{${series.padding}})`;
    })
    .join('');
  const match = new RegExp(`^${source}$`).exec(String(number));
  if (!match?.groups) return null;
  const sequence = Number(match.groups.seq);
  if (sequence < 1) return null;
  const fy = fyGroup ? match.groups.fy : null;
  return { fy, fyStartYear: fy ? fyStartYearFromLabel(fy, series.fyStyle) : null, sequence };
}

/** @param {string} label @param {keyof typeof FY_STYLES} style */
function fyStartYearFromLabel(label, style) {
  const digits = label.replace('-', '');
  const startYear = style === 'long' || style === 'startYear' ? Number(digits.slice(0, 4)) : 2000 + Number(digits.slice(0, 2));
  if (style !== 'startYear' && fyLabel(startYear, style) !== label) return null;
  return startYear;
}

/**
 * Find series of the same GSTIN whose numbers could collide (for example prefix "INV" with 5
 * digits and prefix "INV0" with 4 digits both produce "INV00001"). Checks sample numbers of
 * each series against every other series of that GSTIN, in both directions.
 * @param {NumberSeriesInput[]} list
 * @param {number} [fyStartYear]
 * @returns {Array<[number, number]>} index pairs that conflict
 */
export function findSeriesConflicts(list, fyStartYear = 2026) {
  const resolved = list.map(resolveSeries);
  /** @type {Array<[number, number]>} */
  const conflicts = [];
  for (let i = 0; i < resolved.length; i += 1) {
    for (let j = i + 1; j < resolved.length; j += 1) {
      const [a, b] = [resolved[i], resolved[j]];
      if ((a.gstin ?? null) !== (b.gstin ?? null)) continue;
      const samplesOf = (s) =>
        [1, 9, 10, 99, 100, maxSequence(s)].filter((n) => n <= maxSequence(s)).map((n) => render(s, fyStartYear, String(n).padStart(s.padding, '0')));
      const clash =
        samplesOf(a).some((n) => parseDocumentNumber(b, n) !== null) || samplesOf(b).some((n) => parseDocumentNumber(a, n) !== null);
      if (clash) conflicts.push([i, j]);
    }
  }
  return conflicts;
}

/**
 * The key of the counter row a number is allocated from: one counter per GSTIN, document type,
 * series prefix and financial year.
 * @param {{ gstin: string, documentType: string, prefix?: string, fyStartYear: number }} key
 */
export const counterKey = ({ gstin, documentType, prefix = '', fyStartYear }) =>
  `${normaliseGstin(gstin)}:${documentType}:${prefix}:${fyStartYear}`;
