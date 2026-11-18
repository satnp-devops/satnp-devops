import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PRODID,
  buildInvite,
  calAddress,
  escapeText,
  foldLine,
  formatIcsDateTime,
  icsContentType,
  octetLength,
  paramValue,
  parseContentLines,
  unescapeText,
  unfold,
} from '../../src/core/scheduling/ics.js';

const base = {
  method: 'REQUEST',
  uid: '7f0c2a52-3b8e-4c1d-9f4e-2a1b3c4d5e6f',
  dtstamp: '2026-11-05T09:00:00Z',
  start: '2026-11-09T15:30:00+05:30',
  end: '2026-11-09T16:00:00+05:30',
  summary: 'Admission counselling: Class 11 (PCM)',
  organizer: { email: 'priya.sharma@pivector.example', name: 'Priya Sharma' },
  attendees: [{ email: 'parent@example.in', name: 'Rakesh Gupta' }],
};

const physicalLines = (text) => text.split('\r\n').slice(0, -1);
const find = (text, name) => parseContentLines(text).filter((l) => l.name === name);

test('a REQUEST carries every property RFC 5546 §3.2.2 requires, in UTC', () => {
  const ics = buildInvite(base);
  const names = parseContentLines(ics).map((l) => l.name);
  assert.deepEqual(names, [
    'BEGIN', 'PRODID', 'VERSION', 'CALSCALE', 'METHOD', 'BEGIN', 'UID', 'SEQUENCE', 'DTSTAMP', 'DTSTART', 'DTEND',
    'SUMMARY', 'STATUS', 'TRANSP', 'ORGANIZER', 'ATTENDEE', 'END', 'END',
  ]);
  const value = (name) => find(ics, name)[0].value;
  assert.equal(value('METHOD'), 'REQUEST');
  assert.equal(value('VERSION'), '2.0');
  assert.equal(value('PRODID'), DEFAULT_PRODID);
  assert.equal(value('UID'), base.uid);
  assert.equal(value('SEQUENCE'), '0');
  assert.equal(value('DTSTAMP'), '20261105T090000Z');
  assert.equal(value('DTSTART'), '20261109T100000Z', '15:30 IST is 10:00 UTC');
  assert.equal(value('DTEND'), '20261109T103000Z');
  assert.equal(value('STATUS'), 'CONFIRMED');
  assert.equal(unescapeText(value('SUMMARY')), base.summary);
  const [organizer] = find(ics, 'ORGANIZER');
  assert.deepEqual([organizer.params.CN, organizer.value], ['Priya Sharma', 'mailto:priya.sharma@pivector.example']);
  const [attendee] = find(ics, 'ATTENDEE');
  assert.deepEqual(attendee.params, { CUTYPE: 'INDIVIDUAL', ROLE: 'REQ-PARTICIPANT', PARTSTAT: 'NEEDS-ACTION', RSVP: 'TRUE', CN: 'Rakesh Gupta' });
  assert.equal(attendee.value, 'mailto:parent@example.in');
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /\r\nEND:VCALENDAR\r\n$/);
  assert.doesNotMatch(ics.replace(/\r\n/g, ''), /[\r\n]/, 'only CRLF line breaks');
});

test('optional properties and several attendees', () => {
  const ics = buildInvite({
    ...base,
    description: 'Bring last year\'s marksheet.\nJoin 5 minutes early.',
    location: 'Pi Vector, Sector 18, Noida',
    url: 'https://meet.example.com/abc-defg-hij',
    created: '2026-11-05T08:00:00Z',
    lastModified: '2026-11-05T08:30:00Z',
    attendees: [
      { email: 'parent@example.in', name: 'Rakesh Gupta' },
      { email: 'student@example.in', name: 'Aarav Gupta', role: 'OPT-PARTICIPANT', rsvp: false },
    ],
  });
  assert.equal(find(ics, 'DESCRIPTION')[0].value, "Bring last year's marksheet.\\nJoin 5 minutes early.");
  assert.equal(find(ics, 'LOCATION')[0].value, 'Pi Vector\\, Sector 18\\, Noida');
  assert.equal(find(ics, 'URL')[0].value, 'https://meet.example.com/abc-defg-hij');
  assert.equal(find(ics, 'CREATED')[0].value, '20261105T080000Z');
  assert.equal(find(ics, 'LAST-MODIFIED')[0].value, '20261105T083000Z');
  const attendees = find(ics, 'ATTENDEE');
  assert.equal(attendees.length, 2);
  assert.deepEqual([attendees[1].params.ROLE, attendees[1].params.RSVP], ['OPT-PARTICIPANT', 'FALSE']);
});

test('a reschedule is a REQUEST with the same UID and a higher SEQUENCE', () => {
  const update = buildInvite({ ...base, sequence: 1, start: '2026-11-10T10:00:00Z', end: '2026-11-10T10:30:00Z' });
  assert.equal(find(update, 'UID')[0].value, base.uid);
  assert.equal(find(update, 'SEQUENCE')[0].value, '1');
  assert.equal(find(update, 'DTSTART')[0].value, '20261110T100000Z');
});

test('a CANCEL (RFC 5546 §3.2.5) echoes the UID, bumps SEQUENCE and sets STATUS:CANCELLED', () => {
  const ics = buildInvite({ ...base, method: 'CANCEL', sequence: 2 });
  assert.equal(find(ics, 'METHOD')[0].value, 'CANCEL');
  assert.equal(find(ics, 'STATUS')[0].value, 'CANCELLED');
  assert.equal(find(ics, 'SEQUENCE')[0].value, '2');
  assert.equal(find(ics, 'UID')[0].value, base.uid);
  assert.equal(find(ics, 'ATTENDEE').length, 1, 'cancelling the whole event tells the attendees');
  assert.equal(find(ics, 'ATTENDEE')[0].params.RSVP, undefined, 'no reply is requested');
  assert.throws(() => buildInvite({ ...base, method: 'CANCEL' }), /SEQUENCE/);
  assert.throws(() => buildInvite({ ...base, method: 'CANCEL', sequence: 0 }), /SEQUENCE/);
});

test('folding keeps every physical line within 75 octets and unfolds back exactly', () => {
  const long = 'Counselling for JEE Main and Advanced, NEET and the Class 11 foundation batch. '.repeat(6);
  const ics = buildInvite({ ...base, description: long, location: 'x'.repeat(200) });
  for (const line of physicalLines(ics)) assert.ok(octetLength(line) <= 75, `${octetLength(line)}: ${line}`);
  const continuations = physicalLines(ics).filter((l) => l.startsWith(' '));
  assert.ok(continuations.length >= 6);
  const description = find(ics, 'DESCRIPTION')[0].value;
  assert.equal(unescapeText(description), long);
  assert.equal(find(ics, 'LOCATION')[0].value, 'x'.repeat(200));
});

test('foldLine boundaries: 75 octets fit, the 76th folds, continuation lines hold 74 more', () => {
  assert.equal(foldLine('a'.repeat(75)), 'a'.repeat(75));
  assert.equal(foldLine('a'.repeat(76)), `${'a'.repeat(75)}\r\n a`);
  assert.equal(foldLine('a'.repeat(149)), `${'a'.repeat(75)}\r\n ${'a'.repeat(74)}`);
  assert.equal(foldLine('a'.repeat(150)), `${'a'.repeat(75)}\r\n ${'a'.repeat(74)}\r\n a`);
  assert.equal(foldLine(''), '');
  assert.equal(unfold(foldLine('b'.repeat(500))), 'b'.repeat(500));
  assert.equal(unfold('AB\r\n C\n\tD'), 'ABCD', 'unfolds CRLF or LF followed by space or tab');
});

test('folding never splits a multi-byte character (Hindi, Tamil, emoji)', () => {
  const summary = 'प्रवेश परामर्श — कक्षा 11 विज्ञान 🎓 சேர்க்கை ஆலோசனை 👨‍👩‍👧 '.repeat(4);
  const ics = buildInvite({ ...base, summary, attendees: [{ email: 'parent@example.in', name: 'राकेश गुप्ता' }] });
  for (const line of physicalLines(ics)) {
    const bytes = Buffer.from(line, 'utf8');
    assert.ok(bytes.length <= 75, `${bytes.length} octets`);
    assert.equal(bytes.toString('utf8'), line, 'each physical line is valid UTF-8 on its own');
    assert.ok(!/[\uD800-\uDBFF]$/.test(line), 'no lone high surrogate at a fold');
  }
  assert.equal(unescapeText(find(ics, 'SUMMARY')[0].value), summary);
  assert.equal(find(ics, 'ATTENDEE')[0].params.CN, 'राकेश गुप्ता');
  // A 3-octet character that would end at octet 76 moves to the next line.
  const folded = foldLine(`${'a'.repeat(73)}प`);
  assert.equal(folded, `${'a'.repeat(73)}\r\n प`);
});

test('TEXT escaping (RFC 5545 §3.3.11) and its inverse', () => {
  assert.equal(escapeText('a\\b;c,d'), 'a\\\\b\\;c\\,d');
  assert.equal(escapeText('line1\nline2\r\nline3\rline4'), 'line1\\nline2\\nline3\\nline4');
  assert.equal(escapeText('tab\tkept'), 'tab\tkept');
  assert.equal(escapeText('bell\u0007 and nul\u0000 removed'), 'bell and nul removed');
  assert.equal(escapeText('colon: is fine'), 'colon: is fine');
  assert.equal(escapeText(undefined), '');
  for (const sample of ['C:\\path;x,y\nz', 'a\\nb', 'plain', '\\;\\,']) {
    assert.equal(unescapeText(escapeText(sample)), sample);
  }
});

test('parameter values are quoted when needed and cannot carry quotes or line breaks', () => {
  assert.equal(paramValue('Priya Sharma'), 'Priya Sharma');
  assert.equal(paramValue('Sharma, Priya'), '"Sharma, Priya"');
  assert.equal(paramValue('Dr. Rao: Principal'), '"Dr. Rao: Principal"');
  assert.equal(paramValue('A;B'), '"A;B"');
  assert.equal(paramValue('The "Best" Tutor'), "The 'Best' Tutor");
  assert.equal(paramValue('two\r\nlines'), 'two lines');
  const ics = buildInvite({ ...base, organizer: { email: 'o@example.in', name: 'Sharma, Priya "PS"' } });
  const [organizer] = find(ics, 'ORGANIZER');
  assert.equal(organizer.params.CN, "Sharma, Priya 'PS'");
  assert.equal(organizer.value, 'mailto:o@example.in');
});

test('injection attempts stay inside their own property', () => {
  const ics = buildInvite({
    ...base,
    summary: 'Hi\r\nMETHOD:CANCEL\r\nATTENDEE:mailto:evil@x.com',
    attendees: [{ email: 'parent@example.in', name: 'Evil\r\nATTENDEE:mailto:evil@x.com' }],
  });
  assert.equal(find(ics, 'METHOD').length, 1);
  assert.equal(find(ics, 'METHOD')[0].value, 'REQUEST');
  assert.equal(find(ics, 'ATTENDEE').length, 1);
  assert.throws(() => buildInvite({ ...base, attendees: [{ email: 'a@b.com\r\nX:y' }] }), RangeError);
  assert.throws(() => buildInvite({ ...base, organizer: { email: 'mailto:o@example.in' } }), RangeError);
  assert.throws(() => buildInvite({ ...base, uid: 'abc\r\nMETHOD:CANCEL' }), RangeError);
  assert.throws(() => buildInvite({ ...base, url: 'javascript:alert(1)' }), RangeError);
  assert.throws(() => buildInvite({ ...base, url: 'https://ok.example/\r\nX' }), RangeError);
});

test('calAddress accepts ordinary emails only', () => {
  assert.equal(calAddress('Parent.Name+tag@school.example.in'), 'mailto:Parent.Name+tag@school.example.in');
  assert.equal(calAddress('  a@b.co  '), 'mailto:a@b.co');
  for (const bad of ['', 'no-at-sign', 'a@b', 'a b@c.com', 'a@b..com', '<a@b.com>', 'a@b.com;x', null]) {
    assert.throws(() => calAddress(bad), RangeError, String(bad));
  }
});

test('invalid invitations are refused', () => {
  assert.throws(() => buildInvite({ ...base, method: 'PUBLISH' }), /method/);
  assert.throws(() => buildInvite({ ...base, end: base.start }), /end/);
  assert.throws(() => buildInvite({ ...base, attendees: [] }), /attendee/);
  assert.throws(() => buildInvite({ ...base, organizer: undefined }), /organizer/);
  assert.throws(() => buildInvite({ ...base, sequence: 1.5 }), /sequence/);
  assert.throws(() => buildInvite({ ...base, sequence: -1 }), /sequence/);
  assert.throws(() => buildInvite({ ...base, uid: '' }), /UID/);
  assert.throws(() => buildInvite({ ...base, uid: 'has space' }), /UID/);
  assert.throws(() => buildInvite({ ...base, start: '2026-11-09T10:00:00' }), RangeError, 'times must be instants');
});

test('date-time formatting and content type', () => {
  assert.equal(formatIcsDateTime('2026-11-05T10:30:45.678Z'), '20261105T103045Z');
  assert.equal(formatIcsDateTime('2026-11-06T01:15:00+05:45'), '20261105T193000Z');
  assert.equal(formatIcsDateTime(0), '19700101T000000Z');
  assert.equal(icsContentType('REQUEST'), 'text/calendar; charset=UTF-8; method=REQUEST');
  assert.equal(icsContentType('CANCEL'), 'text/calendar; charset=UTF-8; method=CANCEL');
});
