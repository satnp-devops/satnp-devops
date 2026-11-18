/**
 * CSV imports: parse (RFC 4180, no dependencies), suggest how columns map to enquiry fields,
 * then validate and normalise each row into an enquiry with a per-row error report.
 *
 * Parsing follows RFC 4180 (https://www.rfc-editor.org/rfc/rfc4180) and is lenient where
 * spreadsheet exports are: LF or CR line endings as well as CRLF, a UTF-8 byte order mark,
 * `;`, tab or `|` delimiters (detected), spaces before an opening quote, and a stray quote inside
 * an unquoted field (kept literally, with a warning). An unterminated quote is an error.
 *
 * Writing (toCsv) guards against formula injection: cells starting with = + - @ tab or CR are
 * prefixed with an apostrophe so a spreadsheet shows them as text (OWASP "CSV Injection").
 */

import { toEnquiry } from './enquiry.js';
import { similarity } from './trigram.js';
import { isTimeZone, zonedTimeToUtc } from './time.js';

/** @typedef {{ line: number, code: string, message: string }} ParseIssue */

export const DELIMITERS = Object.freeze([',', ';', '\t', '|']);

/**
 * Guess the delimiter from the first lines: the candidate that splits the header into more than
 * one column and splits the most following lines into the same number of columns.
 * Quoted text is ignored. Falls back to a comma.
 * @param {string} text
 * @param {{ sampleLines?: number }} [options]
 */
export function detectDelimiter(text, { sampleLines = 20 } = {}) {
  const sample = String(text ?? '').replace(/^﻿/, '').slice(0, 64 * 1024);
  /** @type {Record<string, number>[]} */
  const lines = [];
  let counts = Object.fromEntries(DELIMITERS.map((d) => [d, 0]));
  let inQuotes = false;
  let blank = true;
  for (let i = 0; i < sample.length && lines.length < sampleLines; i += 1) {
    const ch = sample[i];
    if (ch === '"') {
      inQuotes = inQuotes && sample[i + 1] === '"' ? (i++, true) : !inQuotes;
      blank = false;
    } else if (!inQuotes && (ch === '\n' || ch === '\r')) {
      if (!blank) lines.push(counts);
      counts = Object.fromEntries(DELIMITERS.map((d) => [d, 0]));
      blank = true;
      if (ch === '\r' && sample[i + 1] === '\n') i += 1;
    } else {
      if (!inQuotes && ch in counts) counts[ch] += 1;
      if (ch.trim()) blank = false;
    }
  }
  if (!blank && lines.length < sampleLines) lines.push(counts);
  if (!lines.length) return ',';
  let best = ',';
  let bestScore = 0;
  for (const delimiter of DELIMITERS) {
    const columns = lines[0][delimiter];
    if (columns === 0) continue;
    const consistent = lines.filter((c) => c[delimiter] === columns).length;
    const score = consistent * 1000 + columns;
    if (score > bestScore) {
      best = delimiter;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Parse CSV text into rows of strings.
 * @param {string} input
 * @param {{ delimiter?: string, skipEmptyLines?: boolean, maxRows?: number }} [options]
 * @returns {{ rows: string[][], lines: number[], delimiter: string, errors: ParseIssue[], warnings: ParseIssue[], truncated: boolean }}
 *   `lines[i]` is the physical line where row i starts (1-based).
 */
export function parseCsv(input, { delimiter, skipEmptyLines = true, maxRows = Infinity } = {}) {
  let text = String(input ?? '');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const sep = delimiter ?? detectDelimiter(text);
  if (sep.length !== 1 || sep === '"' || sep === '\n' || sep === '\r') throw new Error('The delimiter must be one character other than a quote or a line break');

  /** @type {string[][]} */
  const rows = [];
  const lines = [];
  /** @type {ParseIssue[]} */
  const errors = [];
  /** @type {ParseIssue[]} */
  const warnings = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let quoted = false; // the current field was quoted
  let closed = false; // the current field's closing quote has been seen
  let rowQuoted = false; // some field in the current row was quoted
  let line = 1;
  let rowLine = 1;
  let quoteLine = 1;
  let truncated = false;

  const warnOnce = (code, message) => {
    if (!warnings.some((w) => w.line === rowLine && w.code === code)) warnings.push({ line: rowLine, code, message });
  };
  const endField = () => {
    row.push(field);
    field = '';
    quoted = false;
    closed = false;
  };
  const endRow = () => {
    const empty = row.length === 1 && row[0] === '' && !rowQuoted;
    if (!(skipEmptyLines && empty)) {
      if (rows.length >= maxRows) truncated = true;
      else {
        rows.push(row);
        lines.push(rowLine);
      }
    }
    row = [];
    rowQuoted = false;
  };

  for (let i = 0; i < text.length && !truncated; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
          closed = true;
        }
      } else {
        if (ch === '\n' || (ch === '\r' && text[i + 1] !== '\n')) line += 1;
        field += ch;
      }
      continue;
    }
    if (ch === sep) {
      endField();
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      endField();
      endRow();
      line += 1;
      rowLine = line;
      continue;
    }
    if (ch === '"' && !closed && field.trim() === '') {
      // Opening quote (spaces before it, as some tools write, are dropped).
      field = '';
      inQuotes = true;
      quoted = true;
      rowQuoted = true;
      quoteLine = line;
      continue;
    }
    if (closed) {
      if (ch.trim() === '') continue; // spaces after a closing quote
      warnOnce('text_after_quote', 'Text after a closing quote was kept as part of the field');
      field += ch;
      continue;
    }
    if (ch === '"') warnOnce('stray_quote', 'A quote inside an unquoted field was kept as text');
    field += ch;
  }
  if (inQuotes) errors.push({ line: quoteLine, code: 'unterminated_quote', message: 'A quoted field is never closed; the rest of the file was read into it' });
  if (!truncated && (field !== '' || row.length > 0 || quoted)) {
    endField();
    endRow();
  }
  return { rows, lines, delimiter: sep, errors, warnings, truncated };
}

/**
 * Write rows as CSV (RFC 4180, CRLF line endings).
 * @param {unknown[][]} rows
 * @param {{ delimiter?: string, guardFormulas?: boolean }} [options]
 */
export function toCsv(rows, { delimiter = ',', guardFormulas = true } = {}) {
  const cell = (value) => {
    let text = value === null || value === undefined ? '' : String(value);
    if (guardFormulas && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /["\r\n]/.test(text) || text.includes(delimiter) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return rows.map((row) => row.map(cell).join(delimiter)).join('\r\n');
}

// ---------------------------------------------------------------------------------------------
// Column mapping

/**
 * Enquiry fields a CSV column can fill, with the headers people actually use for them.
 * `kind` drives conversion: text, date (receivedAt), day (date of birth), boolean, number,
 * language, country, relation.
 */
export const ENQUIRY_FIELDS = Object.freeze([
  { field: 'contact.name', label: 'Name', synonyms: ['name', 'full name', 'contact name', 'lead name', 'customer name', 'enquirer name', 'parent name', 'guardian name', 'father name', 'mother name', 'applicant name'] },
  { field: 'contact.firstName', label: 'First name', synonyms: ['first name', 'firstname', 'fname', 'given name'] },
  { field: 'contact.lastName', label: 'Last name', synonyms: ['last name', 'lastname', 'lname', 'surname', 'family name'] },
  { field: 'contact.phone', label: 'Phone', synonyms: ['phone', 'mobile', 'mobile number', 'mobile no', 'phone number', 'phone no', 'contact number', 'contact no', 'cell', 'whatsapp', 'whatsapp number', 'mob', 'ph', 'parent mobile', 'telephone'] },
  { field: 'contact.altPhone', label: 'Other phone', synonyms: ['alternate phone', 'alternate mobile', 'alternate number', 'alt phone', 'alt mobile', 'other phone', 'secondary phone', 'landline', 'phone 2', 'mobile 2'] },
  { field: 'contact.email', label: 'Email', synonyms: ['email', 'email id', 'email address', 'mail', 'mail id', 'parent email'] },
  { field: 'contact.relation', label: 'Relation to student', synonyms: ['relation', 'relationship', 'relation with student', 'enquirer type'], kind: 'relation' },
  { field: 'contact.language', label: 'Language', synonyms: ['language', 'preferred language', 'mother tongue'], kind: 'language' },
  { field: 'contact.timeZone', label: 'Time zone', synonyms: ['time zone', 'timezone', 'tz'] },
  { field: 'contact.city', label: 'City', synonyms: ['city', 'town', 'location', 'district'] },
  { field: 'contact.state', label: 'State', synonyms: ['state', 'province', 'region'] },
  { field: 'contact.country', label: 'Country', synonyms: ['country', 'nationality'], kind: 'country' },
  { field: 'contact.pincode', label: 'PIN code', synonyms: ['pincode', 'pin code', 'pin', 'postal code', 'zip', 'zip code'] },
  { field: 'student.name', label: 'Student name', synonyms: ['student name', 'student', 'child name', 'ward name', 'candidate name', 'learner name', 'student full name'] },
  { field: 'student.grade', label: 'Grade or class', synonyms: ['grade', 'class', 'standard', 'std', 'current class', 'studying in'] },
  { field: 'student.board', label: 'Board', synonyms: ['board', 'school board', 'curriculum'] },
  { field: 'student.school', label: 'School', synonyms: ['school', 'school name', 'college', 'college name'] },
  { field: 'student.targetExam', label: 'Target exam', synonyms: ['exam', 'target exam', 'exam preparing for', 'preparing for'] },
  { field: 'student.dateOfBirth', label: 'Date of birth', synonyms: ['date of birth', 'dob', 'birth date', 'birthday'], kind: 'day' },
  { field: 'parent.name', label: 'Parent name (when the student enquires)', synonyms: ['parent', 'parents name', 'guardian'] },
  { field: 'parent.phone', label: 'Parent phone', synonyms: ['parent phone', 'father mobile', 'mother mobile', 'guardian phone', 'parent contact'] },
  { field: 'institute.name', label: 'Institute', synonyms: ['institute', 'institute name', 'organisation', 'organization', 'company', 'company name', 'coaching name', 'school or institute'] },
  { field: 'institute.type', label: 'Institute type', synonyms: ['institute type', 'organisation type', 'type of institute'] },
  { field: 'institute.studentCount', label: 'Number of students', synonyms: ['number of students', 'student count', 'students', 'no of students', 'strength'], kind: 'number' },
  { field: 'interest.course', label: 'Course', synonyms: ['course', 'program', 'programme', 'interested in', 'course interested', 'interest'] },
  { field: 'interest.product', label: 'Product', synonyms: ['product', 'product name', 'plan', 'service'] },
  { field: 'interest.message', label: 'Message', synonyms: ['message', 'comments', 'comment', 'remarks', 'query', 'notes', 'description', 'requirement'] },
  { field: 'interest.preferredTime', label: 'Preferred time', synonyms: ['preferred time', 'best time to call', 'call time'] },
  { field: 'source.campaign', label: 'Campaign', synonyms: ['campaign', 'campaign name'] },
  { field: 'source.utm.source', label: 'UTM source', synonyms: ['utm source', 'source', 'lead source'] },
  { field: 'source.utm.medium', label: 'UTM medium', synonyms: ['utm medium', 'medium'] },
  { field: 'source.utm.campaign', label: 'UTM campaign', synonyms: ['utm campaign'] },
  { field: 'source.utm.term', label: 'UTM term', synonyms: ['utm term', 'keyword'] },
  { field: 'source.utm.content', label: 'UTM content', synonyms: ['utm content', 'ad content'] },
  { field: 'source.referrer', label: 'Referrer', synonyms: ['referrer', 'referred by', 'reference', 'referral'] },
  { field: 'source.partnerId', label: 'Partner', synonyms: ['partner', 'partner id', 'partner code', 'agent code', 'broker code'] },
  { field: 'source.landingUrl', label: 'Landing page', synonyms: ['landing page', 'landing url', 'page url', 'url', 'form url'] },
  { field: 'source.formId', label: 'Form', synonyms: ['form', 'form id', 'form name'] },
  { field: 'source.adId', label: 'Ad', synonyms: ['ad id', 'ad name', 'ad'] },
  { field: 'receivedAt', label: 'Enquiry date', synonyms: ['date', 'enquiry date', 'inquiry date', 'created', 'created at', 'created on', 'created time', 'submitted at', 'submitted on', 'timestamp', 'lead date'], kind: 'date' },
  { field: 'externalId', label: 'Reference id', synonyms: ['id', 'lead id', 'enquiry id', 'inquiry id', 'reference id', 'ref no', 'external id'] },
  { field: 'consent.marketing', label: 'Marketing consent', synonyms: ['consent', 'marketing consent', 'opt in', 'subscribed', 'agree to contact'], kind: 'boolean' },
  { field: 'consent.whatsapp', label: 'WhatsApp consent', synonyms: ['whatsapp consent', 'whatsapp opt in'], kind: 'boolean' },
]);

const FIELD_INDEX = new Map(ENQUIRY_FIELDS.map((f) => [f.field, f]));

/** Lower-case a header and reduce it to words: "Father's Mobile No." → "father mobile no". */
export function normalizeHeader(header) {
  return String(header ?? '')
    .replace(/^﻿/, '')
    .toLowerCase()
    .replace(/['’]s\b/g, '')
    .replace(/\be[\s-]?mail\b/g, 'email')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Suggest which enquiry field each column fills. Exact synonyms score 1, a header that contains
 * every word of a synonym scores 0.85, otherwise the best trigram similarity (kept from 0.5).
 * Each field is given to one column at most, best scores first.
 * @param {string[]} headers
 * @param {{ minConfidence?: number }} [options]
 * @returns {{ mapping: Record<number, string>, suggestions: { index: number, header: string, field: string | null, confidence: number, alternatives: { field: string, confidence: number }[] }[] }}
 */
export function suggestMapping(headers, { minConfidence = 0.5 } = {}) {
  const scored = headers.map((header, index) => {
    const norm = normalizeHeader(header);
    const words = new Set(norm.split(' ').filter(Boolean));
    const options = ENQUIRY_FIELDS.map(({ field, synonyms }) => {
      let confidence = 0;
      for (const synonym of synonyms) {
        const synonymWords = synonym.split(' ');
        if (norm === synonym) confidence = 1;
        else if (synonymWords.length > 1 && synonymWords.every((w) => words.has(w))) confidence = Math.max(confidence, 0.85);
        // A header missing the synonym's qualifier ("Mobile" vs "father mobile") is not that field.
        else if (words.size > 0 && [...words].every((w) => synonymWords.includes(w))) continue;
        else confidence = Math.max(confidence, similarity(norm, synonym));
      }
      return { field, confidence: Math.round(confidence * 1000) / 1000 };
    })
      .filter((o) => o.confidence >= minConfidence)
      .sort((a, b) => b.confidence - a.confidence);
    return { index, header, options };
  });

  const pairs = scored
    .flatMap(({ index, options }) => options.map((o) => ({ index, ...o })))
    .sort((a, b) => b.confidence - a.confidence || a.index - b.index);
  /** @type {Record<number, string>} */
  const mapping = {};
  const taken = new Set();
  for (const pair of pairs) {
    if (pair.index in mapping || taken.has(pair.field)) continue;
    mapping[pair.index] = pair.field;
    taken.add(pair.field);
  }
  const suggestions = scored.map(({ index, header, options }) => {
    const field = mapping[index] ?? null;
    const chosen = options.find((o) => o.field === field);
    return {
      index,
      header,
      field,
      confidence: chosen?.confidence ?? 0,
      alternatives: options.filter((o) => o.field !== field).slice(0, 3),
    };
  });
  return { mapping, suggestions };
}

// ---------------------------------------------------------------------------------------------
// Value conversion

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

const LANGUAGES = {
  english: 'en', hindi: 'hi', tamil: 'ta', telugu: 'te', kannada: 'kn', malayalam: 'ml', marathi: 'mr', gujarati: 'gu',
  bengali: 'bn', bangla: 'bn', punjabi: 'pa', odia: 'or', oriya: 'or', urdu: 'ur', assamese: 'as', arabic: 'ar', nepali: 'ne',
};
const COUNTRIES = {
  india: 'IN', 'united arab emirates': 'AE', uae: 'AE', 'saudi arabia': 'SA', ksa: 'SA', qatar: 'QA', kuwait: 'KW', oman: 'OM',
  bahrain: 'BH', nepal: 'NP', bangladesh: 'BD', 'sri lanka': 'LK', singapore: 'SG', malaysia: 'MY', 'united kingdom': 'GB',
  uk: 'GB', 'united states': 'US', usa: 'US', us: 'US', canada: 'CA', australia: 'AU', 'new zealand': 'NZ',
};
const RELATION_WORDS = {
  self: 'self', student: 'self', candidate: 'self', parent: 'parent', father: 'parent', mother: 'parent', dad: 'parent', mom: 'parent',
  guardian: 'guardian', sibling: 'sibling', brother: 'sibling', sister: 'sibling', teacher: 'staff', staff: 'staff', other: 'other',
};

/**
 * Read a date (and optional time) as written in Indian spreadsheets and exports.
 * Accepts ISO 8601 (with or without an offset), D/M/Y or M/D/Y with / - or . separators,
 * "5 Nov 2026", "Nov 5, 2026", "05-Nov-2026", optional "10:30", "10:30:15" or "10:30 PM",
 * and Excel serial numbers. Times without an offset are read in `timeZone`.
 * @param {string} value
 * @param {{ dateOrder?: 'DMY' | 'MDY', timeZone?: string, dateOnly?: boolean }} [options]
 * @returns {string | null} an ISO instant, or "YYYY-MM-DD" with dateOnly
 */
export function parseDateValue(value, { dateOrder = 'DMY', timeZone = 'Asia/Kolkata', dateOnly = false } = {}) {
  const text = String(value ?? '').trim();
  if (!text || text.length > 64) return null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    const ms = Date.parse(text);
    if (Number.isNaN(ms)) return null;
    return dateOnly ? text.slice(0, 10) : new Date(ms).toISOString();
  }
  let year;
  let month;
  let day;
  let rest = '';
  let match;
  if ((match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s]+(.*))?$/.exec(text))) {
    [, year, month, day, rest = ''] = match;
  } else if ((match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})(?:[\s,T]+(.*))?$/.exec(text))) {
    const [, a, b, y, r = ''] = match;
    [day, month] = dateOrder === 'MDY' ? [b, a] : [a, b];
    year = y.length === 2 ? `20${y}` : y;
    rest = r;
  } else if ((match = /^(\d{1,2})[\s-]+([a-z]{3,9})\.?[\s,-]+(\d{4})(?:[\s,T]+(.*))?$/i.exec(text))) {
    [, day, month, year, rest = ''] = match;
    month = MONTHS[month.toLowerCase().slice(0, month.toLowerCase().startsWith('sept') ? 4 : 3)];
  } else if ((match = /^([a-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})(?:[\s,T]+(.*))?$/i.exec(text))) {
    [, month, day, year, rest = ''] = match;
    month = MONTHS[month.toLowerCase().slice(0, 3)];
  } else if (/^\d{5}(\.\d+)?$/.test(text)) {
    // Excel serial: days since 1899-12-30, with the fraction as the time of day.
    const serial = Number(text);
    if (serial < 20000 || serial > 80000) return null;
    const wall = new Date(Date.UTC(1899, 11, 30) + Math.round(serial * 86400) * 1000);
    year = wall.getUTCFullYear();
    month = wall.getUTCMonth() + 1;
    day = wall.getUTCDate();
    const pad = (n) => String(n).padStart(2, '0');
    rest = serial % 1 ? `${pad(wall.getUTCHours())}:${pad(wall.getUTCMinutes())}:${pad(wall.getUTCSeconds())}` : '';
  } else return null;

  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!m || m > 12 || !d || d > 31 || y < 1900 || y > 2200) return null;
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCMonth() !== m - 1) return null; // 31 Feb
  if (dateOnly) return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

  let hour = 0;
  let minute = 0;
  let second = 0;
  const time = rest.trim();
  if (time) {
    const t = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*([ap]\.?m\.?)?$/i.exec(time);
    if (!t) return null;
    hour = Number(t[1]);
    minute = Number(t[2]);
    second = Number(t[3] ?? 0);
    const meridiem = t[4]?.toLowerCase().replace(/\./g, '');
    if (meridiem) {
      if (hour < 1 || hour > 12) return null;
      hour = (hour % 12) + (meridiem === 'pm' ? 12 : 0);
    }
    if (hour > 23 || minute > 59 || second > 59) return null;
  }
  const zone = isTimeZone(timeZone) ? timeZone : 'UTC';
  return new Date(zonedTimeToUtc({ year: y, month: m, day: d, hour, minute, second }, zone)).toISOString();
}

/** yes / no, y / n, true / false, 1 / 0, agreed, opted in … → boolean, or undefined. */
export function parseBoolean(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (['yes', 'y', 'true', 't', '1', 'agreed', 'agree', 'opted in', 'opt in', 'subscribed', 'haan', 'ha'].includes(text)) return true;
  if (['no', 'n', 'false', 'f', '0', 'declined', 'opted out', 'opt out', 'unsubscribed', 'nahi'].includes(text)) return false;
  return undefined;
}

/**
 * Convert one cell for a field. Returns the value, or an issue describing why it was dropped.
 * @returns {{ value?: unknown, issue?: { code: string, message: string } }}
 */
function convert(kind, raw, options) {
  const text = raw.trim();
  switch (kind) {
    case 'date': {
      const value = parseDateValue(text, options);
      return value ? { value } : { issue: { code: 'invalid_date', message: `"${text}" is not a date we can read` } };
    }
    case 'day': {
      const value = parseDateValue(text, { ...options, dateOnly: true });
      return value ? { value } : { issue: { code: 'invalid_date', message: `"${text}" is not a date we can read` } };
    }
    case 'boolean': {
      const value = parseBoolean(text);
      return value === undefined ? { issue: { code: 'invalid_boolean', message: `"${text}" is not yes or no` } } : { value };
    }
    case 'number': {
      const value = Number(text.replace(/[,\s]/g, ''));
      return Number.isFinite(value) ? { value } : { issue: { code: 'invalid_number', message: `"${text}" is not a number` } };
    }
    case 'language': {
      const lower = text.toLowerCase();
      const value = LANGUAGES[lower] ?? (/^[a-z]{2,3}$/.test(lower) ? lower : undefined);
      return value ? { value } : { issue: { code: 'invalid_language', message: `"${text}" is not a language we know` } };
    }
    case 'country': {
      const lower = text.toLowerCase();
      const value = COUNTRIES[lower] ?? (/^[a-z]{2}$/.test(lower) ? lower.toUpperCase() : undefined);
      return value ? { value } : { issue: { code: 'invalid_country', message: `"${text}" is not a country we know` } };
    }
    case 'relation': {
      const value = RELATION_WORDS[text.toLowerCase()];
      return value ? { value } : { issue: { code: 'invalid_relation', message: `"${text}" is not a relation we know` } };
    }
    default:
      return { value: text };
  }
}

function setPath(target, path, value) {
  const keys = path.split('.');
  let node = target;
  for (const key of keys.slice(0, -1)) {
    if (!node[key] || typeof node[key] !== 'object') node[key] = {};
    node = node[key];
  }
  node[keys[keys.length - 1]] = value;
}

function getPath(target, path) {
  return path.split('.').reduce((node, key) => (node && typeof node === 'object' ? node[key] : undefined), target);
}

function deepMerge(base, extra) {
  const out = structuredClone(base ?? {});
  for (const [key, value] of Object.entries(extra ?? {})) {
    out[key] = value && typeof value === 'object' && !Array.isArray(value) ? deepMerge(out[key], value) : value;
  }
  return out;
}

/**
 * @typedef {object} RowIssue
 * @property {number} row  spreadsheet row number (the header is row 1)
 * @property {number} line  physical line in the file where the row starts
 * @property {string} [column]  the header of the column, when one column is at fault
 * @property {string} field  enquiry field path
 * @property {string} code
 * @property {string} message
 * @property {string} [value]
 */

/**
 * Turn a CSV file into enquiries with a per-row report.
 *
 * @param {string} text
 * @param {object} [options]
 * @param {Record<string | number, string>} [options.mapping]  column (header text or index) → field
 *   path from ENQUIRY_FIELDS; defaults to suggestMapping(); map a column to '' or null to skip it
 * @param {object} [options.defaults]  merged under every row, e.g.
 *   `{ companyId, source: { channel: { type: 'csv_import', identity: batchId } } }`
 * @param {Partial<import('./normalize.js').Normalizers>} [options.normalizers]
 * @param {string} [options.defaultCountry]
 * @param {'DMY' | 'MDY'} [options.dateOrder]
 * @param {string} [options.timeZone]  for dates written without an offset
 * @param {number | string | Date} [options.now]  receivedAt for rows without a date
 * @param {number} [options.maxRows]  data rows (default 50 000); more is an error
 * @param {string} [options.delimiter]
 */
export function importCsv(text, options = {}) {
  const {
    defaults = { source: { channel: { type: 'csv_import' } } },
    normalizers,
    defaultCountry = 'IN',
    dateOrder = 'DMY',
    timeZone = 'Asia/Kolkata',
    now,
    maxRows = 50_000,
    delimiter,
  } = options;
  const parsed = parseCsv(text, { delimiter, maxRows: maxRows + 1 });
  /** @type {RowIssue[]} */
  const errors = [];
  /** @type {RowIssue[]} */
  const warnings = [];
  const fileIssues = [...parsed.errors.map((e) => ({ ...e, level: 'error' })), ...parsed.warnings.map((w) => ({ ...w, level: 'warning' }))];
  if (parsed.truncated) {
    fileIssues.push({ line: parsed.lines[parsed.lines.length - 1] ?? 1, code: 'too_many_rows', message: `The file has more than ${maxRows} rows; split it into smaller files`, level: 'error' });
  }

  const [headerRow = [], ...dataRows] = parsed.rows;
  const headers = headerRow.map((h, i) => h.trim() || `Column ${i + 1}`);
  const seenHeaders = new Map();
  headers.forEach((h, i) => {
    const key = normalizeHeader(h);
    if (seenHeaders.has(key)) fileIssues.push({ line: 1, code: 'duplicate_header', message: `Columns ${seenHeaders.get(key) + 1} and ${i + 1} have the same header "${h}"`, level: 'warning' });
    else seenHeaders.set(key, i);
  });

  const suggestion = suggestMapping(headers);
  /** @type {Record<number, string>} */
  let mapping = suggestion.mapping;
  if (options.mapping) {
    mapping = {};
    for (const [column, field] of Object.entries(options.mapping)) {
      if (!field) continue;
      const index = /^\d+$/.test(column) ? Number(column) : headers.findIndex((h) => h === column || normalizeHeader(h) === normalizeHeader(column));
      if (index < 0 || index >= headers.length) {
        fileIssues.push({ line: 1, code: 'unknown_column', message: `The mapping names a column "${column}" that is not in the file`, level: 'error' });
        continue;
      }
      if (!FIELD_INDEX.has(field)) {
        fileIssues.push({ line: 1, code: 'unknown_field', message: `"${field}" is not an enquiry field`, level: 'error' });
        continue;
      }
      mapping[index] = field;
    }
  }
  const mapped = Object.values(mapping);
  if (!mapped.some((f) => ['contact.phone', 'contact.altPhone', 'contact.email'].includes(f))) {
    fileIssues.push({ line: 1, code: 'no_contact_column', message: 'No column is mapped to a phone or email, so no row can be imported', level: 'error' });
  }

  const enquiries = [];
  const firstSeen = new Map();
  let blank = 0;
  let duplicatesInFile = 0;
  const convertOptions = { dateOrder, timeZone };

  dataRows.forEach((cells, offset) => {
    const row = offset + 2;
    const line = parsed.lines[offset + 1];
    if (cells.every((c) => c.trim() === '')) {
      blank += 1;
      return;
    }
    const rowWarnings = [];
    if (cells.length !== headers.length) {
      rowWarnings.push({ row, line, field: '', code: 'column_count', message: `Row has ${cells.length} cells; the header has ${headers.length}` });
    }
    let input = deepMerge(defaults, {});
    const raw = {};
    headers.forEach((header, index) => {
      const value = cells[index] ?? '';
      if (value !== '') raw[header] = value;
    });
    for (const [indexText, field] of Object.entries(mapping)) {
      const index = Number(indexText);
      const value = cells[index];
      if (value === undefined || value.trim() === '') continue;
      const { value: converted, issue } = convert(FIELD_INDEX.get(field)?.kind, value, convertOptions);
      if (issue) rowWarnings.push({ row, line, column: headers[index], field, value, ...issue });
      else setPath(input, field, converted);
    }
    input = { ...input, raw };
    const result = toEnquiry(input, { normalizers, defaultCountry, now });
    const toRowIssue = (issue) => {
      const index = Object.entries(mapping).find(([, f]) => f === issue.path)?.[0];
      const column = index === undefined ? undefined : headers[Number(index)];
      const value = getPath(input, issue.path);
      return {
        row,
        line,
        ...(column ? { column } : {}),
        field: issue.path,
        code: issue.code,
        message: issue.message,
        ...(typeof value === 'string' ? { value } : {}),
      };
    };
    const allWarnings = [...rowWarnings, ...result.warnings.map(toRowIssue)];
    warnings.push(...allWarnings);
    if (!result.ok) {
      errors.push(...result.errors.map(toRowIssue));
      return;
    }
    const keys = [result.enquiry.contact.phone, result.enquiry.contact.email].filter(Boolean);
    const earlier = keys.map((k) => firstSeen.get(k)).find((r) => r !== undefined);
    if (earlier !== undefined) {
      duplicatesInFile += 1;
      const issue = { row, line, field: 'contact', code: 'duplicate_in_file', message: `Same phone or email as row ${earlier}` };
      warnings.push(issue);
      allWarnings.push(issue);
    }
    for (const key of keys) if (!firstSeen.has(key)) firstSeen.set(key, row);
    enquiries.push({ row, line, enquiry: result.enquiry, warnings: allWarnings });
  });

  const rejectedRows = new Set(errors.map((e) => e.row));
  const fatal = fileIssues.some((i) => i.level === 'error' && i.code !== 'unterminated_quote');
  return {
    ok: !fatal,
    delimiter: parsed.delimiter,
    headers,
    mapping,
    suggestions: suggestion.suggestions,
    enquiries: fatal ? [] : enquiries,
    errors,
    warnings,
    fileIssues,
    summary: {
      rows: dataRows.length,
      imported: fatal ? 0 : enquiries.length,
      rejected: rejectedRows.size,
      blank,
      withWarnings: enquiries.filter((e) => e.warnings.length).length,
      duplicatesInFile,
    },
  };
}

/**
 * The error report as CSV for download: one line per problem, rows in order, errors first.
 * @param {{ errors: RowIssue[], warnings: RowIssue[], fileIssues?: { line: number, code: string, message: string, level: string }[] }} report
 */
export function errorReportCsv(report) {
  const lines = [['Row', 'Level', 'Column', 'Field', 'Problem', 'Value']];
  for (const issue of report.fileIssues ?? []) lines.push(['', issue.level, '', '', `${issue.message} (line ${issue.line})`, '']);
  const all = [
    ...report.errors.map((e) => ({ ...e, level: 'error' })),
    ...report.warnings.map((w) => ({ ...w, level: 'warning' })),
  ].sort((a, b) => a.row - b.row || (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1));
  for (const issue of all) lines.push([issue.row, issue.level, issue.column ?? '', issue.field, issue.message, issue.value ?? '']);
  return toCsv(lines);
}
