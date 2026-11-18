import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ENQUIRY_FIELDS,
  detectDelimiter,
  errorReportCsv,
  importCsv,
  normalizeHeader,
  parseBoolean,
  parseCsv,
  parseDateValue,
  suggestMapping,
  toCsv,
} from '../../src/core/intake/csv.js';

const NOW = '2026-11-05T00:00:00.000Z';

// --- RFC 4180 parsing ----------------------------------------------------------------------------

test('plain fields, CRLF records and a final line without a break', () => {
  const { rows, lines, errors } = parseCsv('a,b,c\r\n1,2,3\r\n4,5,6');
  assert.deepEqual(rows, [['a', 'b', 'c'], ['1', '2', '3'], ['4', '5', '6']]);
  assert.deepEqual(lines, [1, 2, 3]);
  assert.deepEqual(errors, []);
});

test('LF and lone CR line endings', () => {
  assert.deepEqual(parseCsv('a,b\n1,2\n').rows, [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsv('a,b\r1,2\r').rows, [['a', 'b'], ['1', '2']]);
});

test('quoted fields may contain delimiters, escaped quotes and line breaks', () => {
  const text = 'name,note\r\n"Sharma, Rahul","He said ""call after 6"""\r\n"Iyer","line one\r\nline two\nline three"\r\nlast,"x"\r\n';
  const { rows, lines } = parseCsv(text);
  assert.deepEqual(rows, [
    ['name', 'note'],
    ['Sharma, Rahul', 'He said "call after 6"'],
    ['Iyer', 'line one\r\nline two\nline three'],
    ['last', 'x'],
  ]);
  assert.deepEqual(lines, [1, 2, 3, 6], 'a record with line breaks inside still reports where it starts');
});

test('empty fields, empty quoted fields and trailing delimiters', () => {
  assert.deepEqual(parseCsv('a,,c\r\n,,\r\n"",x,""\r\n1,2,').rows, [['a', '', 'c'], ['', '', ''], ['', 'x', ''], ['1', '2', '']]);
});

test('a lone empty quoted field is a row, a blank line is not (unless asked)', () => {
  assert.deepEqual(parseCsv('a\r\n\r\n""\r\n').rows, [['a'], ['']]);
  assert.deepEqual(parseCsv('a\r\n\r\nb', { skipEmptyLines: false }).rows, [['a'], [''], ['b']]);
});

test('a UTF-8 byte order mark is dropped', () => {
  const { rows } = parseCsv('﻿Name,Phone\r\nराहुल,9876543210');
  assert.deepEqual(rows[0], ['Name', 'Phone']);
  assert.equal(rows[1][0], 'राहुल');
});

test('lenient with spreadsheet quirks: spaces around quotes, stray quotes', () => {
  const spaced = parseCsv('a, "b, c" ,d');
  assert.deepEqual(spaced.rows, [['a', 'b, c', 'd']]);
  const stray = parseCsv('name,size\r\nBig 5" screen,2\r\n');
  assert.deepEqual(stray.rows[1], ['Big 5" screen', '2']);
  assert.deepEqual(stray.warnings.map((w) => [w.line, w.code]), [[2, 'stray_quote']]);
  const after = parseCsv('"abc"def,1');
  assert.deepEqual(after.rows, [['abcdef', '1']]);
  assert.equal(after.warnings[0].code, 'text_after_quote');
});

test('an unterminated quote is an error and swallows the rest', () => {
  const { rows, errors } = parseCsv('a,b\r\n1,"open\r\n2,3\r\n');
  assert.deepEqual(errors.map((e) => [e.line, e.code]), [[2, 'unterminated_quote']]);
  assert.deepEqual(rows, [['a', 'b'], ['1', 'open\r\n2,3\r\n']]);
});

test('delimiters are detected: comma, semicolon, tab and pipe', () => {
  assert.equal(detectDelimiter('a,b,c\n1,2,3'), ',');
  assert.equal(detectDelimiter('Name;Phone;City\nRahul;98765;Delhi'), ';');
  assert.equal(detectDelimiter('Name\tPhone\nRahul\t98765'), '\t');
  assert.equal(detectDelimiter('Name|Phone\nRahul|98765'), '|');
  assert.equal(detectDelimiter('"Sharma, Rahul";"98765"\n"Iyer, Priya";"9000"'), ';', 'commas inside quotes do not count');
  assert.equal(detectDelimiter('single column\nvalue'), ',', 'falls back to a comma');
  assert.equal(detectDelimiter(''), ',');
  assert.equal(detectDelimiter('a;b,c;d\n1;2,3;4\n5;6;7;8'), ';', 'the delimiter that splits rows consistently wins');
  assert.deepEqual(parseCsv('a;b\n1;2').rows, [['a', 'b'], ['1', '2']]);
});

test('an explicit delimiter is used and validated', () => {
  assert.deepEqual(parseCsv('a,b;c', { delimiter: ';' }).rows, [['a,b', 'c']]);
  assert.throws(() => parseCsv('a', { delimiter: '"' }));
  assert.throws(() => parseCsv('a', { delimiter: ',,' }));
});

test('maxRows stops reading and says so', () => {
  const result = parseCsv('a\n1\n2\n3\n', { maxRows: 2 });
  assert.deepEqual(result.rows, [['a'], ['1']]);
  assert.equal(result.truncated, true);
  assert.equal(parseCsv('a\n1\n', { maxRows: 2 }).truncated, false);
});

test('empty input gives no rows', () => {
  assert.deepEqual(parseCsv('').rows, []);
  assert.deepEqual(parseCsv(null).rows, []);
});

test('toCsv escapes and round-trips, and guards against formula injection', () => {
  const rows = [['name', 'note'], ['Sharma, Rahul', 'He said "hi"\nbye'], ['=HYPERLINK("x")', '+91 98765'], ['-5', '@SUM(A1)'], [null, undefined]];
  const text = toCsv(rows);
  assert.equal(text.split('\r\n')[0], 'name,note');
  const back = parseCsv(text).rows;
  assert.deepEqual(back[1], ['Sharma, Rahul', 'He said "hi"\nbye']);
  assert.deepEqual(back[2], ["'=HYPERLINK(\"x\")", "'+91 98765"]);
  assert.deepEqual(back[3], ["'-5", "'@SUM(A1)"]);
  assert.deepEqual(back[4], ['', '']);
  assert.equal(toCsv([['=1']], { guardFormulas: false }), '=1');
  assert.equal(toCsv([['a;b', 'c']], { delimiter: ';' }), '"a;b";c');
});

// --- mapping -------------------------------------------------------------------------------------

test('headers are normalised for matching', () => {
  assert.equal(normalizeHeader("Father's Mobile No."), 'father mobile no');
  assert.equal(normalizeHeader('E-mail ID'), 'email id');
  assert.equal(normalizeHeader('﻿  Student  NAME '), 'student name');
});

test('common Indian export headers map to enquiry fields', () => {
  const headers = ['Name', 'Mobile No.', 'E-mail ID', 'Student Name', 'Class', 'City', 'Enquiry Date', 'Remarks', 'utm_source', 'Lead ID', 'Course Interested', 'Board'];
  const { mapping, suggestions } = suggestMapping(headers);
  assert.deepEqual(mapping, {
    0: 'contact.name',
    1: 'contact.phone',
    2: 'contact.email',
    3: 'student.name',
    4: 'student.grade',
    5: 'contact.city',
    6: 'receivedAt',
    7: 'interest.message',
    8: 'source.utm.source',
    9: 'externalId',
    10: 'interest.course',
    11: 'student.board',
  });
  assert.equal(suggestions[0].confidence, 1);
});

test('each field goes to one column, the best match first', () => {
  const { mapping, suggestions } = suggestMapping(['Phone', 'Mobile', 'Alternate Mobile']);
  assert.equal(mapping[0], 'contact.phone');
  assert.equal(mapping[1], undefined, 'phone is taken by the exact match in column 0');
  assert.equal(mapping[2], 'contact.altPhone');
  assert.equal(suggestions[1].field, null);
  assert.ok(suggestions[1].alternatives.some((a) => a.field === 'contact.phone'));
});

test('near-miss headers are suggested with lower confidence; nonsense is left unmapped', () => {
  const { suggestions } = suggestMapping(['Parent Mobile Number', 'Studnet Name', 'xyzzy']);
  assert.equal(suggestions[0].field, 'contact.phone');
  assert.ok(suggestions[0].confidence < 1 && suggestions[0].confidence >= 0.5);
  assert.equal(suggestions[1].field, 'student.name');
  assert.equal(suggestions[2].field, null);
  assert.equal(suggestions[2].confidence, 0);
});

test('every field definition is well formed', () => {
  const fields = new Set();
  for (const def of ENQUIRY_FIELDS) {
    assert.ok(!fields.has(def.field), `duplicate ${def.field}`);
    fields.add(def.field);
    assert.ok(def.synonyms.length > 0);
    for (const synonym of def.synonyms) assert.equal(normalizeHeader(synonym), synonym, `${def.field}: "${synonym}" must already be normalised`);
  }
});

// --- values --------------------------------------------------------------------------------------

test('dates as Indian spreadsheets write them', () => {
  const ist = (y, m, d, h = 0, min = 0) => new Date(Date.UTC(y, m - 1, d, h, min) - 330 * 60000).toISOString();
  assert.equal(parseDateValue('05/11/2026'), ist(2026, 11, 5));
  assert.equal(parseDateValue('5-11-2026 10:30'), ist(2026, 11, 5, 10, 30));
  assert.equal(parseDateValue('05.11.26 10:30 PM'), ist(2026, 11, 5, 22, 30));
  assert.equal(parseDateValue('05/11/2026 12:15 am'), ist(2026, 11, 5, 0, 15));
  assert.equal(parseDateValue('2026-11-05'), ist(2026, 11, 5));
  assert.equal(parseDateValue('2026-11-05 10:30:15'), new Date(Date.parse(ist(2026, 11, 5, 10, 30)) + 15000).toISOString());
  assert.equal(parseDateValue('5 Nov 2026'), ist(2026, 11, 5));
  assert.equal(parseDateValue('05-Sept-2026'), ist(2026, 9, 5));
  assert.equal(parseDateValue('Nov 5, 2026 9:00 am'), ist(2026, 11, 5, 9));
  assert.equal(parseDateValue('2026-11-05T10:30:00Z'), '2026-11-05T10:30:00.000Z');
  assert.equal(parseDateValue('2026-11-05T10:30:00+05:30'), '2026-11-05T05:00:00.000Z');
  assert.equal(parseDateValue('46331'), ist(2026, 11, 5), 'Excel serial');
  assert.equal(parseDateValue('46331.4375'), ist(2026, 11, 5, 10, 30), 'Excel serial with a time');
});

test('date order and zone options', () => {
  assert.equal(parseDateValue('11/05/2026', { dateOrder: 'MDY', timeZone: 'UTC' }), '2026-11-05T00:00:00.000Z');
  assert.equal(parseDateValue('05/11/2026 09:00', { timeZone: 'Asia/Dubai' }), '2026-11-05T05:00:00.000Z');
  assert.equal(parseDateValue('05/11/2026', { dateOnly: true }), '2026-11-05');
  assert.equal(parseDateValue('2026-11-05T23:30:00Z', { dateOnly: true }), '2026-11-05');
});

test('impossible or unreadable dates are rejected', () => {
  for (const bad of ['', '31/02/2026', '13/13/2026', '00/01/2026', 'yesterday', '05/11/2026 25:00', '05/11/2026 13:00 PM', '5 Smarch 2026', '123', '99999', '05/11/1850']) {
    assert.equal(parseDateValue(bad), null, bad);
  }
});

test('booleans', () => {
  for (const yes of ['Yes', 'y', 'TRUE', '1', 'Agreed', 'opted in', 'haan']) assert.equal(parseBoolean(yes), true, yes);
  for (const no of ['No', 'n', 'false', '0', 'opted out', 'nahi']) assert.equal(parseBoolean(no), false, no);
  assert.equal(parseBoolean('maybe'), undefined);
});

// --- import --------------------------------------------------------------------------------------

const SHEET = [
  'Name,Mobile No.,E-mail ID,Student Name,Class,City,Enquiry Date,Language,Consent,Relation',
  'RAHUL SHARMA,098765 43210,Rahul.Sharma@Gmail.com,aarav sharma,11,Delhi,05/11/2026 10:30,Hindi,Yes,Father',
  'Priya Iyer,,priya@example.in,,,Chennai,,ta,no,self',
  'Bad Row,12345,not-an-email,,,,,,,',
  ',,,,,,,,,',
  'Rahul S,+91 98765 43210,,,,,31/02/2026,Klingon,maybe,uncle',
  '"Mehta, Anil","+971 50 123 4567",,"Riya ""Bunty"" Mehta",9,"Dubai",2026-11-04,,,',
].join('\r\n');

test('a sheet becomes enquiries with a per-row report', () => {
  const report = importCsv(SHEET, { now: NOW, defaults: { companyId: 'pi-vector', source: { channel: { type: 'csv_import', identity: 'batch-1' } } } });
  assert.equal(report.ok, true);
  assert.equal(report.delimiter, ',');
  assert.deepEqual(report.summary, { rows: 6, imported: 4, rejected: 1, blank: 1, withWarnings: 1, duplicatesInFile: 1 });

  const [first, second, fifth, sixth] = report.enquiries;
  assert.equal(first.row, 2);
  assert.deepEqual(first.enquiry.contact, {
    name: 'Rahul Sharma',
    phone: '+919876543210',
    email: 'rahul.sharma@gmail.com',
    relation: 'parent',
    language: 'hi',
    city: 'Delhi',
  });
  assert.deepEqual(first.enquiry.student, { name: 'Aarav Sharma', grade: '11' });
  assert.equal(first.enquiry.receivedAt, '2026-11-05T05:00:00.000Z');
  assert.equal(first.enquiry.consent.marketing, true);
  assert.equal(first.enquiry.companyId, 'pi-vector');
  assert.deepEqual(first.enquiry.source.channel, { type: 'csv_import', identity: 'batch-1' });
  assert.equal(first.enquiry.raw['Mobile No.'], '098765 43210', 'the original cells are kept for history');

  assert.equal(second.enquiry.contact.language, 'ta');
  assert.equal(second.enquiry.consent.marketing, false);
  assert.equal(second.enquiry.receivedAt, NOW, 'rows without a date get now');

  assert.equal(fifth.row, 6);
  assert.deepEqual(
    fifth.warnings.map((w) => w.code).sort(),
    ['duplicate_in_file', 'invalid_boolean', 'invalid_date', 'invalid_language', 'invalid_relation'],
  );
  assert.equal(sixth.enquiry.contact.name, 'Mehta, Anil');
  assert.equal(sixth.enquiry.contact.phone, '+971501234567');
  assert.equal(sixth.enquiry.student.name, 'Riya "Bunty" Mehta');
});

test('rejected rows explain themselves with row, column and value', () => {
  const report = importCsv(SHEET, { now: NOW });
  const row4 = report.errors.filter((e) => e.row === 4);
  assert.deepEqual(row4.map((e) => e.code), ['invalid_phone', 'invalid_email', 'contact_point_required']);
  assert.deepEqual(row4[0], { row: 4, line: 4, column: 'Mobile No.', field: 'contact.phone', code: 'invalid_phone', message: '"12345" is not a phone number we recognise', value: '12345' });
  const dup = report.warnings.find((w) => w.code === 'duplicate_in_file');
  assert.match(dup.message, /row 2/);
  const date = report.warnings.find((w) => w.code === 'invalid_date');
  assert.deepEqual([date.row, date.column, date.value], [6, 'Enquiry Date', '31/02/2026']);
});

test('the error report downloads as CSV', () => {
  const csv = errorReportCsv(importCsv(SHEET, { now: NOW }));
  const rows = parseCsv(csv).rows;
  assert.deepEqual(rows[0], ['Row', 'Level', 'Column', 'Field', 'Problem', 'Value']);
  assert.deepEqual(rows[1].slice(0, 4), ['4', 'error', 'Mobile No.', 'contact.phone']);
  assert.ok(rows.some((r) => r[1] === 'warning' && r[0] === '6'));
  const rowsInOrder = rows.slice(1).map((r) => Number(r[0]));
  assert.deepEqual(rowsInOrder, [...rowsInOrder].sort((a, b) => a - b));
});

test('formula-looking values in the error report are neutralised', () => {
  const report = importCsv('Name,Phone\r\nX,=cmd|calc', { now: NOW });
  const csv = errorReportCsv(report);
  assert.ok(csv.includes("'=cmd|calc"));
});

test('an explicit mapping by header or index overrides suggestions', () => {
  const text = 'Col A,Col B,Col C\r\nPriya,9876543210,Pune\r\n';
  const byHeader = importCsv(text, { now: NOW, mapping: { 'Col A': 'student.name', 'col b': 'contact.phone', 'Col C': '' } });
  assert.equal(byHeader.ok, true);
  assert.deepEqual(byHeader.enquiries[0].enquiry.student, { name: 'Priya' });
  assert.equal(byHeader.enquiries[0].enquiry.contact.city, undefined, 'a column mapped to nothing is skipped');
  const byIndex = importCsv(text, { now: NOW, mapping: { 0: 'contact.name', 1: 'contact.phone', 2: 'contact.city' } });
  assert.equal(byIndex.enquiries[0].enquiry.contact.city, 'Pune');
});

test('mapping mistakes and missing contact columns stop the import', () => {
  const unknownColumn = importCsv('Name,Phone\r\nA,9876543210', { now: NOW, mapping: { Nope: 'contact.name', Phone: 'contact.phone' } });
  assert.equal(unknownColumn.ok, false);
  assert.equal(unknownColumn.fileIssues[0].code, 'unknown_column');
  assert.deepEqual(unknownColumn.enquiries, []);
  const unknownField = importCsv('Name,Phone\r\nA,9876543210', { now: NOW, mapping: { Name: 'contact.nickname', Phone: 'contact.phone' } });
  assert.equal(unknownField.fileIssues[0].code, 'unknown_field');
  const noContact = importCsv('Name,City\r\nA,Delhi', { now: NOW });
  assert.equal(noContact.ok, false);
  assert.equal(noContact.fileIssues[0].code, 'no_contact_column');
  assert.equal(noContact.summary.imported, 0);
});

test('too many rows rejects the file', () => {
  const text = ['Phone', ...Array.from({ length: 5 }, (_, i) => `98765432${10 + i}`)].join('\n');
  const report = importCsv(text, { now: NOW, maxRows: 3 });
  assert.equal(report.ok, false);
  assert.ok(report.fileIssues.some((i) => i.code === 'too_many_rows'));
  assert.equal(importCsv(text, { now: NOW, maxRows: 5 }).summary.imported, 5);
});

test('short and long rows, duplicate and blank headers are reported', () => {
  const report = importCsv('Phone,Phone,\r\n9876543210\r\n9000000001,x,y,z\r\n', { now: NOW });
  assert.deepEqual(report.headers, ['Phone', 'Phone', 'Column 3']);
  assert.ok(report.fileIssues.some((i) => i.code === 'duplicate_header'));
  assert.deepEqual(report.warnings.filter((w) => w.code === 'column_count').map((w) => w.row), [2, 3]);
  assert.equal(report.summary.imported, 2);
});

test('semicolon files from European Excel and B2B columns', () => {
  const text = 'Institute Name;Contact Name;Email;Number of Students;City\r\nBright Coaching;Anita Rao;anita@bright.in;1,200;Pune\r\n';
  const report = importCsv(text, { now: NOW, defaults: { source: { channel: { type: 'csv_import' } }, audience: 'b2b' } });
  assert.equal(report.delimiter, ';');
  const { enquiry } = report.enquiries[0];
  assert.deepEqual(enquiry.institute, { name: 'Bright Coaching', studentCount: 1200 });
  assert.equal(enquiry.contact.name, 'Anita Rao');
  assert.equal(enquiry.audience, 'b2b');
});

test('a quoted multi-line remark stays in one row and the row numbers stay right', () => {
  const text = 'Name,Phone,Remarks\r\nA,9876543210,"call after 6\r\nnot on Sunday"\r\nB,9000000001,ok\r\n';
  const report = importCsv(text, { now: NOW });
  assert.deepEqual(report.enquiries.map((e) => [e.row, e.line]), [[2, 2], [3, 4]]);
  assert.equal(report.enquiries[0].enquiry.interest.message, 'call after 6\r\nnot on Sunday');
});

test('the default country applies to every row', () => {
  const report = importCsv('Phone\r\n050 123 4567\r\n', { now: NOW, defaultCountry: 'AE' });
  assert.equal(report.enquiries[0].enquiry.contact.phone, '+971501234567');
});
