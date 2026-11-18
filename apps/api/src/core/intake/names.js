/**
 * Name matching for Indian names written in Latin script.
 *
 * The same person reaches us as "Mohd. Irfan", "Mohammed Irfan" and "MUHAMMAD IRFAN";
 * "Laxmi" and "Lakshmi"; "Sharma Rahul", "R. Sharma" and "Rahul Kumar Sharma". compareNames()
 * folds those differences away and says which rule matched, so dedup can explain itself.
 *
 * Steps: fold (Unicode NFKD, strip accents, lower-case, punctuation to spaces) → cut relation
 * markers ("S/o Ramesh") → drop honorifics (Mr, Smt, Shri, Dr, Kumari …) and a trailing "ji" →
 * map known spelling variants to one form (Mohd/Md → muhammad, Agrawal → agarwal …) →
 * a phonetic key per token for transliteration basics (sh/s, ph/f, th/t, w/v, ee/i, oo/u,
 * x/ksh, z/j, doubled letters, a final -a or -y).
 */

import { similarity } from './trigram.js';

const HONORIFICS = new Set([
  'mr', 'mrs', 'ms', 'miss', 'mx', 'dr', 'prof', 'sir', 'madam', 'mdm',
  'shri', 'sri', 'shree', 'sh', 'smt', 'shrimati', 'srimati', 'sushri', 'kumari', 'km', 'kum',
  'master', 'late', 'capt', 'col', 'adv', 'er',
]);

/** Spelling variants mapped to one canonical token. */
const VARIANT_GROUPS = [
  ['muhammad', 'mohammed', 'mohammad', 'mohamed', 'mohamad', 'muhammed', 'mohd', 'md', 'mohmmad', 'mohammod'],
  ['ahmed', 'ahmad', 'ahamed', 'ahemad'],
  ['hussain', 'husain', 'hussein', 'hossain', 'husein'],
  ['syed', 'sayed', 'sayyed', 'saiyed', 'sayyad'],
  ['sheikh', 'shaikh', 'shekh', 'sk'],
  ['kumar', 'kr', 'kmr'],
  ['agarwal', 'aggarwal', 'agrawal', 'agarwala', 'aggrawal', 'agerwal', 'agrwal'],
  ['chaudhary', 'chaudhari', 'choudhary', 'chowdhury', 'choudhury', 'chaudhry', 'chowdhary', 'choudhari'],
  ['srivastava', 'shrivastava', 'srivastav', 'shrivastav', 'sriwastava', 'srivastwa'],
  ['mishra', 'misra'],
  ['upadhyay', 'upadhyaya', 'upadhaya', 'upadhya'],
  ['bhattacharya', 'bhattacharjee', 'bhattacharyya', 'bhattacharji'],
  ['mukherjee', 'mukherji', 'mukerjee', 'mukhopadhyay'],
  ['banerjee', 'banerji', 'bannerjee', 'bandyopadhyay'],
  ['chatterjee', 'chatterji', 'chattopadhyay'],
  ['iyer', 'aiyar', 'ayyar', 'iyar'],
  ['reddy', 'reddi'],
  ['devi', 'debi'],
  ['venkatesh', 'venkatesan', 'venkatesha'],
  ['subramanian', 'subramaniam', 'subrahmanyam', 'subramanyam'],
];

const VARIANTS = new Map();
for (const group of VARIANT_GROUPS) for (const spelling of group) VARIANTS.set(spelling, group[0]);

/** Lower-case, strip accents and turn punctuation into spaces. Keeps any script's letters. */
export function foldName(raw) {
  return String(raw ?? '')
    .normalize('NFKD')
    .replace(/\p{Mn}+/gu, (marks, offset, whole) => (isLatinBefore(whole, offset) ? '' : marks))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
    .trim();
}

/** Accents on Latin letters are dropped; vowel signs of Indic scripts are part of the letter. */
function isLatinBefore(text, offset) {
  return offset > 0 && /[A-Za-z]/.test(text[offset - 1]);
}

/**
 * Tokens of a name ready for matching: folded, honorifics and relation markers removed.
 * @param {unknown} raw
 * @returns {string[]}
 */
export function nameTokens(raw) {
  // "Rahul S/o Ramesh Sharma", "Priya D/O. Anil" → keep the person, not the relative.
  const own = String(raw ?? '').split(/\b[sdwc]\s*\/\s*o\b\.?/i)[0];
  const tokens = foldName(own).split(' ').filter(Boolean);
  while (tokens.length > 1 && HONORIFICS.has(tokens[0])) tokens.shift();
  if (tokens.length > 1 && tokens[tokens.length - 1] === 'ji') tokens.pop();
  return tokens;
}

/** The canonical spelling of one folded token. */
export function canonicalToken(token) {
  return VARIANTS.get(token) ?? token;
}

/**
 * Phonetic key of one token, for transliteration differences.
 * "Lakshmi"/"Laxmi" → "laksmi", "Pooja"/"Puja" → "puj", "Mohith"/"Mohit" → "mohit".
 * Tokens outside Latin script are returned unchanged.
 * @param {string} token  a folded token
 */
export function phoneticToken(token) {
  let t = canonicalToken(token);
  if (!/^[a-z]+$/.test(t)) return t;
  t = t
    .replace(/ksh/g, 'ks')
    .replace(/x/g, 'ks')
    .replace(/chh/g, 'ch')
    .replace(/ph/g, 'f')
    .replace(/bh/g, 'b')
    .replace(/dh/g, 'd')
    .replace(/th/g, 't')
    .replace(/kh/g, 'k')
    .replace(/gh/g, 'g')
    .replace(/jh/g, 'j')
    .replace(/sh/g, 's')
    .replace(/ck/g, 'k')
    .replace(/q/g, 'k')
    .replace(/z/g, 'j')
    .replace(/ow/g, 'au')
    .replace(/ou/g, 'au')
    .replace(/w/g, 'v')
    .replace(/ee/g, 'i')
    .replace(/oo/g, 'u')
    .replace(/iy(?=[aeiou])/g, 'i')
    .replace(/y$/, 'i')
    .replace(/(.)\1+/g, '$1');
  if (t.length > 3) t = t.replace(/a$/, '');
  if (t.length > 2) t = t.replace(/([aeiou])h$/, '$1');
  return t;
}

/** A stable key for a name: phonetic tokens, sorted. "Sharma, Rahul" and "Rahul Sarma" agree. */
export function nameKey(raw) {
  return nameTokens(raw).map(phoneticToken).sort().join(' ');
}

/**
 * @typedef {'exact' | 'reordered' | 'variant' | 'subset' | 'initials' | 'single_name' | 'trigram' | 'missing'} NameMethod
 * @typedef {{ score: number, method: NameMethod, detail: string }} NameComparison
 */

const sameMultiset = (a, b) => a.length === b.length && [...a].sort().join(' ') === [...b].sort().join(' ');

/**
 * Compare two names. Scores: exact 1, reordered 0.98, variant 0.95, subset 0.88, initials 0.85,
 * a single matching name 0.7, otherwise the best pg_trgm similarity of the folded or phonetic forms.
 * @param {unknown} a
 * @param {unknown} b
 * @returns {NameComparison}
 */
export function compareNames(a, b) {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (ta.length === 0 || tb.length === 0) return { score: 0, method: 'missing', detail: 'a name is missing' };
  const fa = ta.join(' ');
  const fb = tb.join(' ');
  if (fa === fb) return { score: 1, method: 'exact', detail: 'same name' };
  if (sameMultiset(ta, tb)) return { score: 0.98, method: 'reordered', detail: 'same names in a different order' };
  const pa = ta.map(phoneticToken);
  const pb = tb.map(phoneticToken);
  if (sameMultiset(pa, pb)) return { score: 0.95, method: 'variant', detail: 'spelling or transliteration variant' };

  const candidates = [];
  // With equal lengths either side may hold the initials, so try both ways round.
  for (const aligned of pa.length === pb.length ? [alignTokens(pa, pb), alignTokens(pb, pa)] : [alignTokens(pa, pb)]) {
    if (aligned) candidates.push(aligned);
  }
  const plain = similarity(fa, fb);
  const phonetic = similarity(pa.join(' '), pb.join(' '));
  const trigram = Math.max(plain, phonetic);
  candidates.push({ score: round(trigram), method: 'trigram', detail: `trigram similarity ${round(trigram)}` });
  return candidates.reduce((best, c) => (c.score > best.score ? c : best));
}

/**
 * Every token of the shorter name matches a distinct token of the longer one, either fully or
 * as an initial ("R" ~ "Rahul"). Needs at least one full-token match.
 * @returns {NameComparison | null}
 */
function alignTokens(pa, pb) {
  const [short, long] = pa.length <= pb.length ? [pa, pb] : [pb, pa];
  const used = new Set();
  let initials = 0;
  let full = 0;
  // Full matches first, so an initial never steals a token a full name needed.
  const pending = [];
  for (const token of short) {
    const index = long.findIndex((other, i) => !used.has(i) && other === token);
    if (index >= 0) {
      used.add(index);
      full += 1;
    } else pending.push(token);
  }
  for (const token of pending) {
    if (token.length !== 1) return null;
    const index = long.findIndex((other, i) => !used.has(i) && other.startsWith(token));
    if (index < 0) return null;
    used.add(index);
    initials += 1;
  }
  if (full === 0) return null;
  if (initials > 0) return { score: 0.85, method: 'initials', detail: 'matches with initials' };
  if (short.length === 1) return { score: 0.7, method: 'single_name', detail: 'only one name given, and it matches' };
  return { score: 0.88, method: 'subset', detail: 'one name has extra parts (middle name or surname)' };
}

const round = (value) => Math.round(value * 1000) / 1000;
