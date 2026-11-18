/**
 * iCalendar invitations (RFC 5545) carried by iTIP methods (RFC 5546) for email (RFC 6047).
 *
 *  - METHOD:REQUEST invites or updates (reschedule = same UID, higher SEQUENCE).
 *  - METHOD:CANCEL cancels the whole event: same UID, SEQUENCE higher than the last REQUEST
 *    (RFC 5546 §3.2.5, §2.1.4), STATUS:CANCELLED, and the attendees being told.
 *  - Times are always UTC ('…Z'), so no VTIMEZONE is needed (RFC 5545 §3.3.5 form 2).
 *  - TEXT values escape backslash, semicolon, comma and newlines (§3.3.11); parameter values
 *    with ':', ';' or ',' are quoted and may not contain DQUOTE (§3.1, §3.2).
 *  - Content lines are folded at 75 octets with CRLF + space, never inside a UTF-8 character
 *    (§3.1). Output uses CRLF line breaks and ends with CRLF.
 *  - UIDs should be random UUIDs with no user, host or domain data (RFC 7986 §5.3).
 */
import { toEpochMs } from './tz.js';

export const DEFAULT_PRODID = '-//Phoenix Group//Phoenix CRM Scheduling//EN';
const MAX_OCTETS = 75;

// ---------------------------------------------------------------------------------------------
// Value encoding

/** Remove control characters other than tab and newlines (TEXT and parameters exclude CONTROL). */
const stripControls = (value) => value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');

/**
 * Escape a TEXT value (RFC 5545 §3.3.11): \\ \; \, and \n for line breaks.
 * @param {unknown} value
 */
export function escapeText(value) {
  return stripControls(String(value ?? ''))
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * A parameter value (e.g. CN): line breaks become spaces, DQUOTE becomes an apostrophe
 * (it cannot be escaped), and values containing ':', ';' or ',' are wrapped in quotes.
 * @param {unknown} value
 */
export function paramValue(value) {
  const clean = stripControls(String(value ?? ''))
    .replace(/\r\n|\r|\n|\t/g, ' ')
    .replace(/"/g, "'")
    .trim();
  return /[:;,]/.test(clean) ? `"${clean}"` : clean;
}

/** UTC DATE-TIME: 20261105T103000Z (seconds kept, milliseconds dropped). */
export function formatIcsDateTime(instant) {
  const iso = new Date(toEpochMs(instant)).toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
}

const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/** CAL-ADDRESS for an email: 'mailto:a@b.in'. Refuses anything that could break the line. */
export function calAddress(email) {
  const value = String(email ?? '').trim();
  if (value.length > 254 || !EMAIL.test(value)) throw new RangeError(`Not an email address: ${JSON.stringify(email)}`);
  return `mailto:${value}`;
}

/** UID: printable ASCII without spaces, at most 255 characters. */
function checkUid(uid) {
  const value = String(uid ?? '');
  if (!/^[\x21-\x7E]{1,255}$/.test(value)) throw new RangeError('UID must be 1–255 printable ASCII characters');
  return value;
}

function checkUri(uri) {
  const value = String(uri);
  if (!/^https?:\/\/[^\s"<>\\^`{|}\x00-\x1F\x7F]+$/i.test(value)) throw new RangeError('URL must be an http(s) link');
  return value;
}

/** UTF-8 length of one code point. */
const octets = (codePoint) => (codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4);

/**
 * Fold one content line to at most 75 octets per physical line (CRLF not counted). The space
 * that starts each continuation line counts toward its 75.
 * @param {string} line
 */
export function foldLine(line) {
  const out = [];
  let current = '';
  let size = 0;
  for (const char of line) {
    const length = octets(char.codePointAt(0));
    if (size + length > MAX_OCTETS) {
      out.push(current);
      current = ' ';
      size = 1;
    }
    current += char;
    size += length;
  }
  out.push(current);
  return out.join('\r\n');
}

/** Undo folding (CRLF or LF followed by one space or tab). */
export const unfold = (text) => String(text).replace(/\r?\n[ \t]/g, '');

/** UTF-8 octet length of a string. */
export const octetLength = (text) => {
  let total = 0;
  for (const char of String(text)) total += octets(char.codePointAt(0));
  return total;
};

/**
 * One content line: NAME;PARAM=value:VALUE (value already encoded).
 * @param {string} name
 * @param {Record<string, string|number|boolean|undefined>} params
 * @param {string} value
 */
function contentLine(name, params, value) {
  const encoded = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([key, v]) => `;${key}=${typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : paramValue(v)}`)
    .join('');
  return `${name}${encoded}:${value}`;
}

// ---------------------------------------------------------------------------------------------
// Invitations

/**
 * @typedef {{ email: string, name?: string }} Organizer
 * @typedef {{ email: string, name?: string, role?: 'REQ-PARTICIPANT'|'OPT-PARTICIPANT'|'CHAIR'|'NON-PARTICIPANT',
 *   partstat?: 'NEEDS-ACTION'|'ACCEPTED'|'DECLINED'|'TENTATIVE', rsvp?: boolean }} Attendee
 * @typedef {{
 *   method: 'REQUEST'|'CANCEL',
 *   uid: string,
 *   sequence?: number,
 *   dtstamp: number|string|Date,
 *   start: number|string|Date,
 *   end: number|string|Date,
 *   summary?: string,
 *   description?: string,
 *   location?: string,
 *   url?: string,
 *   organizer: Organizer,
 *   attendees: Attendee[],
 *   created?: number|string|Date,
 *   lastModified?: number|string|Date,
 *   prodId?: string,
 * }} InviteInput
 */

/**
 * Build an iTIP REQUEST or CANCEL calendar object.
 * @param {InviteInput} input
 * @returns {string} CRLF-separated, folded iCalendar text ending in CRLF
 */
export function buildInvite(input) {
  const method = input.method;
  if (method !== 'REQUEST' && method !== 'CANCEL') throw new RangeError('method must be REQUEST or CANCEL');
  const sequence = input.sequence ?? 0;
  if (!Number.isInteger(sequence) || sequence < 0) throw new RangeError('sequence must be a whole number ≥ 0');
  if (method === 'CANCEL' && sequence < 1) {
    throw new RangeError('A CANCEL must carry a SEQUENCE higher than the original REQUEST (≥ 1)');
  }
  const startMs = toEpochMs(input.start);
  const endMs = toEpochMs(input.end);
  if (endMs <= startMs) throw new RangeError('end must be after start');
  if (!input.organizer) throw new RangeError('organizer is required');
  const attendees = input.attendees ?? [];
  if (attendees.length === 0) throw new RangeError('At least one attendee is required');

  const lines = [
    'BEGIN:VCALENDAR',
    `PRODID:${escapeText(input.prodId ?? DEFAULT_PRODID)}`,
    'VERSION:2.0',
    'CALSCALE:GREGORIAN',
    `METHOD:${method}`,
    'BEGIN:VEVENT',
    `UID:${checkUid(input.uid)}`,
    `SEQUENCE:${sequence}`,
    `DTSTAMP:${formatIcsDateTime(input.dtstamp)}`,
  ];
  if (input.created !== undefined) lines.push(`CREATED:${formatIcsDateTime(input.created)}`);
  if (input.lastModified !== undefined) lines.push(`LAST-MODIFIED:${formatIcsDateTime(input.lastModified)}`);
  lines.push(`DTSTART:${formatIcsDateTime(startMs)}`, `DTEND:${formatIcsDateTime(endMs)}`);
  lines.push(`SUMMARY:${escapeText(input.summary ?? '')}`);
  if (input.description) lines.push(`DESCRIPTION:${escapeText(input.description)}`);
  if (input.location) lines.push(`LOCATION:${escapeText(input.location)}`);
  if (input.url) lines.push(`URL:${checkUri(input.url)}`);
  lines.push(`STATUS:${method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED'}`, 'TRANSP:OPAQUE');
  lines.push(contentLine('ORGANIZER', { CN: input.organizer.name }, calAddress(input.organizer.email)));
  for (const attendee of attendees) {
    lines.push(
      contentLine(
        'ATTENDEE',
        {
          CUTYPE: 'INDIVIDUAL',
          ROLE: attendee.role ?? 'REQ-PARTICIPANT',
          PARTSTAT: attendee.partstat ?? 'NEEDS-ACTION',
          RSVP: method === 'REQUEST' ? (attendee.rsvp ?? true) : undefined,
          CN: attendee.name,
        },
        calAddress(attendee.email),
      ),
    );
  }
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}

/** Content-Type for an email part or download carrying the invite (RFC 6047 §2.4). */
export const icsContentType = (method) => `text/calendar; charset=UTF-8; method=${method}`;

/**
 * Parse unfolded iCalendar text into [name, params, value] rows. Only for tests and for reading
 * our own output; it does not unescape TEXT or handle quoted ':' inside parameters beyond CN.
 * @param {string} text
 * @returns {{ name: string, params: Record<string, string>, value: string }[]}
 */
export function parseContentLines(text) {
  return unfold(text)
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      let i = 0;
      let inQuote = false;
      for (; i < line.length; i += 1) {
        if (line[i] === '"') inQuote = !inQuote;
        else if (line[i] === ':' && !inQuote) break;
      }
      const head = line.slice(0, i);
      const value = line.slice(i + 1);
      const [name, ...rawParams] = head.split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/);
      const params = Object.fromEntries(
        rawParams.map((p) => {
          const eq = p.indexOf('=');
          return [p.slice(0, eq), p.slice(eq + 1).replace(/^"|"$/g, '')];
        }),
      );
      return { name, params, value };
    });
}

/** Reverse escapeText (for tests and round trips). */
export function unescapeText(value) {
  return String(value).replace(/\\([\\;,nN])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));
}
