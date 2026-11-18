import {
  nameTokens,
  normalizeDomain,
  normalizeEmail,
  normalizePhone,
  phoneSearchTokens,
  splitE164,
} from '../../core/crm/normalize.js';
import { maskEmail, maskPhone } from '../../core/crm/pii.js';

// The pure half of global search (docs/crm/PHASE2_CONTRACT.md §9.10): read what a query asks for,
// decide why a document matched, rank the hits and write the short reason shown under each one.
// The SQL that uses it is in service.js.

/** A deal reference as people type it: "SP-1042". */
export const REF_PATTERN = /^[A-Z]{1,6}-\d+$/i;
/** Only digits and the separators people put in phone numbers, optionally after a plus. */
const PHONE_LIKE = /^\(?\+?[\d\s().\-/]+$/;
/** Shortest run of digits matched inside a phone number (people type the last five or more). */
export const MIN_PARTIAL_DIGITS = 5;
/** Shortest fragment of an email address matched inside one ("sharma@ex"). */
export const MIN_PARTIAL_EMAIL = 4;
/** Longest number treated as a deal number rather than part of a phone number. */
const MAX_CODE_DIGITS = 6;
/** Words beyond this are ignored: names are short, and every word is one more index lookup. */
export const MAX_QUERY_WORDS = 6;
/** pg_trgm's default similarity threshold: titles at least this close count as name matches. */
const NAME_SIMILARITY = 0.3;

/**
 * Work out what a search query asks for.
 *
 *   "+91 90000 01234" → phone: exact keyword tokens (+919000001234, 919000001234, 9000001234)
 *   "priya@example.com" → email: exact token
 *   "SP-1042" → ref: exact token; "1042" → a deal number, and words
 *   "aimhigh.example" → an institute's domain: exact token
 *   "01234" → digits found inside a phone number (only for people who may see phone numbers)
 *   "priya sha" → words: prefix full text "priya:* & sha:*" and trigram similarity on titles
 *
 * @param {string} input the trimmed query (2–100 characters)
 * @param {{ defaultCountry?: string }} [options] country for numbers typed without +CC
 * @returns {ParsedQuery}
 * @typedef {{
 *   text: string,
 *   exactKind: 'phone' | 'email' | 'ref' | 'code' | 'domain' | null,
 *   phone: string | null,
 *   email: string | null,
 *   exactTokens: string[],
 *   partial: string | null,
 *   partialKind: 'phone' | 'email' | null,
 *   words: string[],
 *   tsquery: string | null,
 * }} ParsedQuery
 */
export function parseSearchQuery(input, { defaultCountry = 'IN' } = {}) {
  const text = String(input ?? '').trim().replace(/\s+/g, ' ');
  const parsed = {
    text,
    exactKind: null,
    phone: null,
    email: null,
    exactTokens: [],
    partial: null,
    partialKind: null,
    words: [],
    tsquery: null,
  };
  if (!text) return parsed;

  const email = text.includes('@') ? normalizeEmail(text) : null;
  if (email) return { ...parsed, exactKind: 'email', email, exactTokens: [email] };

  if (REF_PATTERN.test(text)) return { ...parsed, exactKind: 'ref', exactTokens: [text.toLowerCase()] };

  if (PHONE_LIKE.test(text)) {
    const digits = text.replace(/\D/g, '');
    const phone = digits.length >= 7 ? normalizePhone(text, defaultCountry) : null;
    if (phone) return { ...parsed, exactKind: 'phone', phone: phone.e164, exactTokens: phoneSearchTokens(phone.e164) };
    const isCode = digits.length > 0 && digits.length <= MAX_CODE_DIGITS && !text.includes('+');
    return withWords(
      {
        ...parsed,
        exactKind: isCode ? 'code' : null,
        exactTokens: isCode ? [digits.replace(/^0+(?=\d)/, '')] : [],
        partial: digits.length >= MIN_PARTIAL_DIGITS ? digits : null,
        partialKind: digits.length >= MIN_PARTIAL_DIGITS ? 'phone' : null,
      },
      // Short numbers can be grades or batch years ("Grade 11"); long ones are only phone digits.
      isCode ? text : '',
    );
  }

  const singleToken = !text.includes(' ');
  if (singleToken && !text.includes('@') && text.includes('.')) {
    const domain = normalizeDomain(text);
    if (domain) return withWords({ ...parsed, exactKind: 'domain', exactTokens: [domain] }, text);
  }

  // Part of an email address ("priya.sharma@", "@school.example", "sharma@ex").
  const lower = text.toLowerCase();
  const partialEmail = singleToken && lower.includes('@') && lower.length >= MIN_PARTIAL_EMAIL ? lower : null;
  return withWords({ ...parsed, partial: partialEmail, partialKind: partialEmail ? 'email' : null }, text);
}

/** Add the word part: name tokens (lower-case, accents and punctuation removed) as prefixes. */
function withWords(parsed, text) {
  const words = [...new Set(nameTokens(text))].slice(0, MAX_QUERY_WORDS);
  return { ...parsed, words, tsquery: buildTsQuery(words) };
}

/**
 * A prefix query for to_tsquery('simple', ...): every word must match the start of a word.
 * Words come from nameTokens, so they hold only letters, marks and digits (no tsquery syntax).
 */
export function buildTsQuery(words) {
  const safe = words.map((word) => String(word).replace(/[^\p{L}\p{N}\p{M}]/gu, '')).filter(Boolean);
  return safe.length ? safe.map((word) => `${word}:*`).join(' & ') : null;
}

/** Escape LIKE wildcards so a fragment matches literally (used with ESCAPE '\'). */
export function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** Does every query word start one of the text's words? */
export function wordsMatch(words, text) {
  if (!words.length || !text) return false;
  const tokens = nameTokens(text);
  return words.every((word) => tokens.some((token) => token.startsWith(word)));
}

/**
 * Why a document matched, for SearchHit.matchedOn.
 * @param {{ exact: boolean, partial: boolean, sim: number, title: string, keywords: string }} row
 * @param {ParsedQuery} parsed
 * @returns {'phone' | 'email' | 'ref' | 'name' | 'text'}
 */
export function matchedOnFor(row, parsed) {
  if (row.exact) {
    if (parsed.exactKind === 'phone') return 'phone';
    if (parsed.exactKind === 'email') return 'email';
    if (parsed.exactKind === 'ref' || parsed.exactKind === 'code') return 'ref';
    return 'text';
  }
  if (row.partial) return parsed.partialKind === 'email' ? 'email' : 'phone';
  if (wordsMatch(parsed.words, row.title) || Number(row.sim) >= NAME_SIMILARITY) return 'name';
  return 'text';
}

/**
 * Order hits: exact phone, email and reference matches first, then phone or email fragments,
 * then how close the title is to the query (trigram similarity), then full-text rank, then the
 * most recently updated. Ties break on id so the order is stable.
 */
export function compareHits(a, b) {
  return (
    Number(b.exact) - Number(a.exact) ||
    Number(b.partial) - Number(a.partial) ||
    Number(b.sim) - Number(a.sim) ||
    Number(b.rank) - Number(a.rank) ||
    new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime() ||
    String(a.id).localeCompare(String(b.id))
  );
}

/** "+919000001234" → "+91 9000001234". */
export function displayPhone(e164) {
  const parts = splitE164(e164);
  return parts?.callingCode ? `+${parts.callingCode} ${parts.national}` : e164;
}

/** The keyword token a fragment matched: the +E.164 form for phones, the address for emails. */
export function tokenContaining(keywords, fragment, kind) {
  const tokens = String(keywords ?? '').split(' ');
  if (kind === 'email') return tokens.find((token) => token.includes('@') && token.includes(fragment)) ?? null;
  return tokens.find((token) => token.startsWith('+') && token.includes(fragment)) ?? null;
}

/**
 * The short reason shown under a hit. Phones and emails are masked unless the viewer may see
 * personal data where they see this record; names, references and websites never are.
 * @param {{ matchedOn: string, row: object, parsed: ParsedQuery, canViewPii: boolean, names?: Array<[string, string | null]> }} input
 *   names: labelled names the document was found by besides its title, e.g. [['Contact', 'Priya Sharma']]
 * @returns {{ snippet: string | null, masked: boolean }}
 */
export function snippetFor({ matchedOn, row, parsed, canViewPii, names = [], ref = null }) {
  if (matchedOn === 'phone') {
    const phone = row.exact ? parsed.phone : tokenContaining(row.keywords, parsed.partial, 'phone');
    if (!phone) return { snippet: null, masked: false };
    return { snippet: `Phone ${canViewPii ? displayPhone(phone) : maskPhone(phone)}`, masked: !canViewPii };
  }
  if (matchedOn === 'email') {
    const email = row.exact ? parsed.email : tokenContaining(row.keywords, parsed.partial, 'email');
    if (!email) return { snippet: null, masked: false };
    return { snippet: `Email ${canViewPii ? email : maskEmail(email)}`, masked: !canViewPii };
  }
  if (matchedOn === 'ref') return { snippet: ref ? `Ref ${ref}` : null, masked: false };
  if (matchedOn === 'text') {
    if (row.exact && parsed.exactKind === 'domain') return { snippet: `Website ${parsed.exactTokens[0]}`, masked: false };
    for (const [label, name] of names) {
      if (name && wordsMatch(parsed.words, name)) return { snippet: `${label} ${name}`, masked: false };
    }
  }
  return { snippet: null, masked: false };
}
