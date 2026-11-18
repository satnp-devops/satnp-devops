import { normalizeEmail, normalizePhone } from '../../crm/normalize.js';
import { detectLanguage, findTopics } from '../text.js';
import {
  BOARDS,
  CALLING_CODE_ZONES,
  CITY_SPELLINGS,
  EXAMS,
  MONTH_PATTERN,
  ROMAN_GRADES,
  ZONE_WORDS,
  monthIndex,
} from './vocab.js';

// The deterministic intake extractor behind the mock AI model. It reads the enquiries Indian
// families send (English and Hinglish, WhatsApp style: lower case, no punctuation, signatures)
// with rules, so seeds, tests and local runs give realistic answers offline. Each finder is
// exported for the generic extract() mock.

export const INTENTS = ['book_demo', 'fee_enquiry', 'admission', 'callback', 'course_info', 'refund', 'complaint', 'other'];

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------- Contact points ----------

const PHONE_CANDIDATE = /(?<![\w])(?:\+|00)?\d[\d\s().-]{7,16}\d(?![\w])/g;
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

/** The first phone number written in the text, as E.164. */
export function findPhone(text, defaultCountry = 'IN') {
  for (const match of String(text ?? '').matchAll(PHONE_CANDIDATE)) {
    const digits = match[0].replace(/\D/g, '');
    if (digits.length < 10 || /^(19|20)\d{2}$/.test(digits)) continue;
    const phone = normalizePhone(match[0].trim(), defaultCountry);
    if (phone) return phone.e164;
  }
  return null;
}

export function findEmail(text) {
  const match = String(text ?? '').match(EMAIL);
  return match ? normalizeEmail(match[0]) : null;
}

// ---------- Places and time zones ----------

/** The first city mentioned: { name, timeZone, country } or null. */
export function findCity(text) {
  const source = String(text ?? '').toLowerCase();
  let best = null;
  for (const { spelling, city } of CITY_SPELLINGS) {
    const match = source.match(new RegExp(`(?<![\\p{L}])${escape(spelling)}(?![\\p{L}])`, 'u'));
    if (match && (best === null || match.index < best.index)) best = { index: match.index, city };
  }
  return best ? { name: best.city.name, timeZone: best.city.timeZone, country: best.city.country } : null;
}

/** A time zone from an abbreviation in the text, the city, or a phone's calling code. */
export function findTimeZone(text, { city, phones = [] } = {}) {
  for (const [pattern, zone] of ZONE_WORDS) if (pattern.test(String(text ?? ''))) return zone;
  if (city?.timeZone) return city.timeZone;
  for (const phone of phones) {
    if (typeof phone !== 'string' || !phone.startsWith('+')) continue;
    const entry = CALLING_CODE_ZONES.find(([code]) => phone.slice(1).startsWith(code));
    if (entry) return entry[1];
  }
  return null;
}

// ---------- Exams, boards and grades ----------

/** Exams in order of mention, without duplicates ("JEE Advanced" doesn't also count as "JEE Main"). */
export function findExams(text) {
  const source = String(text ?? '');
  const hits = [];
  const taken = [];
  for (const exam of EXAMS) {
    const match = source.match(exam.pattern);
    if (!match) continue;
    const start = match.index;
    const end = start + match[0].length;
    if (taken.some(([s, e]) => start < e && end > s)) continue;
    taken.push([start, end]);
    hits.push({ name: exam.name, index: start });
  }
  return hits.sort((a, b) => a.index - b.index).map((h) => h.name);
}

export function findBoard(text) {
  const source = String(text ?? '');
  let best = null;
  for (const board of BOARDS) {
    const match = source.match(board.pattern);
    if (match && (best === null || match.index < best.index)) best = { index: match.index, name: board.name };
  }
  return best?.name ?? null;
}

const GRADE_PATTERNS = [
  /\b(?:class|grade|std\.?|standard)\s*[-:]?\s*(\d{1,2})(?:st|nd|rd|th)?\b/i,
  new RegExp(String.raw`\b(\d{1,2})(?:st|nd|rd|th)\b(?!\s*(?:of\s+)?(?:${MONTH_PATTERN})\b)`, 'i'),
  /\b(\d{1,2})\s+(?:class\s+)?(?:mein|me|main)\s+(?:hai|h|padh)/i,
];

/** The student's class: "1".."12", "dropper" or "college". */
export function findGrade(text) {
  const source = String(text ?? '');
  if (/\b(dropper|drop year|repeater|gap year)\b/i.test(source)) return 'dropper';
  for (const pattern of GRADE_PATTERNS) {
    const match = source.match(pattern);
    const value = match ? Number(match[1]) : null;
    if (value && value >= 1 && value <= 12) return String(value);
  }
  const roman = source.match(/\b(?:class|grade|std\.?)\s+(xii|xi|ix|x|viii|vii|vi|v|iv)\b/i);
  if (roman) return String(ROMAN_GRADES[roman[1].toLowerCase()]);
  if (/\b(college|undergrad(uate)?|graduation|b\.?\s?tech|bachelor'?s|engineering student)\b/i.test(source)) return 'college';
  return null;
}

// ---------- Dates ----------

const pad = (n) => String(n).padStart(2, '0');

/**
 * When the student is aiming for (the exam sitting or start date), as an ISO 8601 date of the
 * precision written: "2026-12-05", "2026-12" or "2027". Relative words use `now`.
 */
export function findTargetDate(text, now = new Date()) {
  const source = String(text ?? '');
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const plausible = (y) => y >= year - 1 && y <= year + 6;
  const fullYear = (y) => (y.length === 2 ? 2000 + Number(y) : Number(y));

  const day = source.match(new RegExp(String.raw`\b(\d{1,2})(?:st|nd|rd|th)?\s+(${MONTH_PATTERN})\.?,?\s+(\d{4})\b`, 'i'));
  if (day && plausible(Number(day[3])) && Number(day[1]) <= 31) {
    return `${day[3]}-${pad(monthIndex(day[2]) + 1)}-${pad(Number(day[1]))}`;
  }
  const monthYear = source.match(new RegExp(String.raw`\b(${MONTH_PATTERN})\.?,?\s*'?(\d{4}|\d{2})\b`, 'i'));
  if (monthYear && plausible(fullYear(monthYear[2]))) return `${fullYear(monthYear[2])}-${pad(monthIndex(monthYear[1]) + 1)}`;
  const yearOnly = source.match(/(?<![\d+])(20[2-4]\d)(?!\d)/);
  if (yearOnly && plausible(Number(yearOnly[1]))) return yearOnly[1];
  const monthOnly =
    source.match(new RegExp(String.raw`\b(?:in|by|before|till|until|this|coming|next)\s+(${MONTH_PATTERN})\b`, 'i')) ??
    source.match(new RegExp(String.raw`\b(${MONTH_PATTERN})\s+(?:me|mein|tak|attempt|sitting|exam)\b`, 'i'));
  if (monthOnly) {
    const m = monthIndex(monthOnly[1]);
    return `${m >= month ? year : year + 1}-${pad(m + 1)}`;
  }
  if (/\bnext year\b|\bagle saal\b/i.test(source)) return String(year + 1);
  if (/\bthis year\b|\bis saal\b/i.test(source)) return String(year);
  return null;
}

// ---------- Names ----------

const NAME_STOP = new Set(
  (
    'is am are was were be in from and with of the a an my our here there studying studies study student students class grade std ' +
    'standard who which looking interested calling writing wants want wanted need needs preparing prepare planning appearing taking ' +
    'giving going will would can could please kindly regarding for about at on to this that but so then also plus i im we us you your ' +
    'he she his her they them it hi hello hey namaste good morning evening afternoon thanks thank regards sir madam mam maam ji ' +
    'mother father parent parents mom dad mum mummy papa guardian son daughter child kid beta beti hai hain hu hoon hun se ka ki ke ' +
    'ko mein me main bol raha rahi ne jo aur name naam currently right now just very not yet already new old sending send call ' +
    'enquiry inquiry query question details info information admission demo course coaching batch fees fee'
  ).split(/\s+/),
);
const HONORIFIC = /^(dr|mr|mrs|ms|miss|shri|sri|smt|prof|er|adv)\.?$/i;
const NAME_TOKEN = /^[A-Za-zऀ-ॿ][A-Za-zऀ-ॿ'’-]*$/;

const titleCase = (word) => (word === word.toLowerCase() || word === word.toUpperCase() ? word.charAt(0).toUpperCase() + word.slice(1).toLowerCase() : word);

function notAPlaceOrExam(name) {
  const lower = name.toLowerCase();
  if (CITY_SPELLINGS.some(({ spelling }) => spelling === lower)) return false;
  return !EXAMS.some((exam) => exam.pattern.test(name) && exam.name.toLowerCase() === lower);
}

/** Read up to three name words starting at `index`, stopping at punctuation or a non-name word. */
export function readName(text, index) {
  const rest = String(text ?? '').slice(index);
  const words = [];
  for (const raw of rest.split(/(\s+)/)) {
    if (/^\s+$/.test(raw)) {
      if (/\n/.test(raw) && words.length) break;
      continue;
    }
    const stopsAfter = /[,.!?;:()\-–—/|]$/.test(raw);
    const word = raw.replace(/^[("'“]+/, '').replace(/[,.!?;:()"'”\-–—/|]+$/, '');
    if (!word) break;
    if (HONORIFIC.test(word) && words.length === 0) {
      if (stopsAfter && !raw.endsWith('.')) break;
      continue;
    }
    if (!NAME_TOKEN.test(word) || NAME_STOP.has(word.toLowerCase())) break;
    words.push(titleCase(word));
    if (stopsAfter || words.length === 3) break;
  }
  const name = words.join(' ');
  return name && notAPlaceOrExam(name) ? name : null;
}

const RELATION_WORDS = [
  [/^(mother|mom|mum|mummy|maa|mata|mommy)$/i, 'mother'],
  [/^(father|dad|daddy|papa|pita|pitaji)$/i, 'father'],
  [/^(guardian|uncle|aunt|aunty|chacha|chachi|mama|mami|nephew|niece|bhanja|bhanji|bhatija|bhatiji)$/i, 'guardian'],
];
const relationOf = (word) => RELATION_WORDS.find(([pattern]) => pattern.test(word))?.[1] ?? 'parent';

const CHILD_WORD = String.raw`son|daughter|child|kid|ward|nephew|niece|younger brother|younger sister|brother|sister|beta|beti|bachcha|bachchi|bacha|baccha|bhai|behen|bhanja|bhanji|bhatija|bhatiji`;
const CHILD_PATTERN = new RegExp(
  String.raw`\b(?:my|mera|meri|mere|our|hamara|hamari|humara|humari)\s+(${CHILD_WORD})\b(?:'s name is|\s+ka naam|\s+ki naam|\s+named|\s+is named|\s+name is|\s+naam)?\s*,?\s*`,
  'gi',
);
const PARENT_OF = /\b(mother|father|mom|dad|mum|mummy|papa|parent|guardian)\s+of\s+/gi;
const SELF_RELATION = /\b(?:i am|i'm|im|this is|main|mai)\s+(?:his|her|their|the student'?s|uska|uski)\s+(mother|father|mom|dad|mum|mummy|papa|parent|guardian)\b\s*,?\s*/gi;
const SELF_INTRO = /\b(?:i am|i'm|im|i m|this is|my name is|my name's|myself|name is|name\s*:|mera naam|mera name|my naam)\s+/gi;
const SELF_HINDI = /\b(?:main|mai)\s+([a-zऀ-ॿ]+(?:\s+[a-zऀ-ॿ]+)?)\s+(?:bol\s+rah[ai]|hu\b|hoon\b|hun\b)/i;
const HERE = /^(?:\s*(?:hi|hello|hey|namaste|good \w+)[\s,!.]*)?([A-Za-z]+(?:\s+[A-Za-z]+)?)\s+here\b/i;
const SIGNATURE = /(?:^|\n|[.!?]\s+)(?:-{1,2}|—|–|~|regards,?|thanks,?|thank you,?|warm regards,?|best,?|dhanyavaad,?|shukriya,?)\s*([A-Za-z]+(?:\s+[A-Za-z]+){0,2})\s*[.!]?\s*$/i;
const STUDENT_SELF = [
  /\b(?:i am|i'm|im)\s+(?:a\s+|an\s+)?(?:class\s+\d{1,2}|grade\s+\d{1,2}|\d{1,2}(?:st|nd|rd|th)?\s*(?:class|grade|std)?)?\s*student\b/i,
  /\b(?:i am|i'm|im|i m)\s+(?:currently\s+)?in\s+(?:class|grade|std|\d)/i,
  /\b(?:class|grade|std)\s*\d{1,2}(?:st|nd|rd|th)?\s+student\b|\b\d{1,2}(?:st|nd|rd|th)\s+(?:class|grade|std)\s+student\b/i,
  /\b(?:i|main|mai)\s+(?:study|studying|padh(?:ta|ti)|padhai kar)\b/i,
  /\bmujhe\b|\bmeri taiyari\b|\bmy (?:exam|score|preparation|prep)\b/i,
  /\bi (?:want|wanna|plan|am planning) to (?:give|take|write|appear|crack|prepare|join)\b/i,
];

/**
 * Who wrote and who the student is.
 * @returns {{ contactName, parentName, studentName, enquirer: 'parent'|'student'|null, relation }}
 */
export function findNames(text) {
  const source = String(text ?? '');
  let studentName = null;
  let relation = null;
  let parentMarker = false;
  let selfName = null;

  for (const match of source.matchAll(CHILD_PATTERN)) {
    parentMarker = true;
    const word = match[1].toLowerCase();
    if (['nephew', 'niece', 'bhanja', 'bhanji', 'bhatija', 'bhatiji'].includes(word)) relation ??= 'guardian';
    studentName ??= readName(source, match.index + match[0].length);
  }
  for (const match of source.matchAll(PARENT_OF)) {
    parentMarker = true;
    relation ??= relationOf(match[1]);
    studentName ??= readName(source, match.index + match[0].length);
  }
  for (const match of source.matchAll(SELF_RELATION)) {
    parentMarker = true;
    relation = relationOf(match[1]);
    selfName ??= readName(source, match.index + match[0].length);
  }
  if (!studentName) {
    const named = source.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(?:is|hai)\s+(?:currently\s+)?(?:in|studying in)\s+(?:class|grade|std|\d)/);
    if (named) {
      const candidate = readName(named[1], 0);
      if (candidate) studentName = candidate;
    }
  }

  if (!selfName) {
    for (const match of source.matchAll(SELF_INTRO)) {
      const candidate = readName(source, match.index + match[0].length);
      if (candidate) {
        selfName = candidate;
        break;
      }
    }
  }
  if (!selfName) {
    const hindi = source.match(SELF_HINDI);
    if (hindi) selfName = readName(hindi[1], 0);
  }
  if (!selfName) {
    const here = source.match(HERE);
    if (here) selfName = readName(here[1], 0);
  }
  if (!selfName) {
    const signature = source.trim().match(SIGNATURE);
    if (signature) selfName = readName(signature[1], 0);
  }
  if (selfName && studentName && selfName.toLowerCase() === studentName.toLowerCase()) selfName = null;

  const studentWrote = !parentMarker && STUDENT_SELF.some((pattern) => pattern.test(source));
  if (studentWrote) {
    return { contactName: selfName, parentName: null, studentName: selfName ?? studentName, enquirer: 'student', relation: null };
  }
  if (parentMarker) {
    return { contactName: selfName, parentName: selfName, studentName, enquirer: 'parent', relation: relation ?? 'parent' };
  }
  return { contactName: selfName, parentName: null, studentName, enquirer: null, relation: null };
}

// ---------- Intent and audience ----------

const INTENT_PATTERNS = [
  ['book_demo', /\b(demo|trial (class|session|lesson)|free (class|session|trial)|sample class|counsel+ing (session|call)|book (a )?(call|session|slot|meeting|demo))\b/i],
  ['fee_enquiry', /\b(fees?|price|pricing|cost|charges?|how much|kitne (ka|ki|ke)|kitna (paisa|kharcha)|emi|instal+ments?)\b/i],
  ['admission', /\b(admission|enrol+(ment)?|register|registration|join|joining|sign up|seat|dakhila|book (a )?seat)\b/i],
  ['callback', /\b(call me|call back|callback|give (me )?a call|contact me|reach (me|out)|phone (karo|kariye|kijiye|kar do)|call (karo|kijiye|kariye|kar do|karna)|baat karni|baat karna|ring me|whatsapp me)\b/i],
  ['course_info', /\b(details?|information|info|syllabus|batch(es)?|timings?|schedule|course|coaching|classes|tuition|tutor|prep(aration)?|taiyari|tayari|jaankari|jankari|guidance|mentorship|test series|mock tests?)\b/i],
];

const B2B_PATTERN = /\b(erp|software|test platform|online test(ing)? platform|exam software|lms|our (institute|school|coaching|academy|classes|centre|center)|for (our|my) (institute|school|coaching|academy|students)|\d+\s*branches|school management|fee management system)\b/i;

/** Every intent the message shows, most actionable first, and the audience. */
export function findIntents(text) {
  const source = String(text ?? '');
  const intents = [];
  const topics = findTopics(source, ['refund', 'complaint']);
  if (topics.some((t) => t.key === 'refund')) intents.push('refund');
  if (topics.some((t) => t.key === 'complaint')) intents.push('complaint');
  for (const [intent, pattern] of INTENT_PATTERNS) if (pattern.test(source)) intents.push(intent);
  return { intent: intents[0] ?? 'other', intents: intents.length ? intents : ['other'], audience: B2B_PATTERN.test(source) ? 'b2b' : 'b2c' };
}

// ---------- The whole extraction ----------

const LABELS = {
  book_demo: 'Demo request',
  fee_enquiry: 'Fee enquiry',
  admission: 'Admission enquiry',
  callback: 'Call-back request',
  course_info: 'Course enquiry',
  refund: 'Refund request',
  complaint: 'Complaint',
  other: 'Enquiry',
};

/** "Fee enquiry from parent Sunita Verma: JEE Main for Rohan (class 11), Jaipur." */
function summaryOf(out) {
  const who = out.parentName
    ? ` from ${out.relation && out.relation !== 'parent' ? out.relation : 'parent'} ${out.parentName}`
    : out.enquirer === 'student' && out.studentName
      ? ` from student ${out.studentName}`
      : out.contactName
        ? ` from ${out.contactName}`
        : '';
  const grade = out.grade ? (/^\d+$/.test(out.grade) ? `(class ${out.grade})` : `(${out.grade})`) : null;
  const student = out.studentName && out.enquirer !== 'student' ? `for ${out.studentName}` : null;
  const details = [[out.exam, student, grade].filter(Boolean).join(' '), out.city, out.targetDate ? `target ${out.targetDate}` : null].filter(Boolean);
  return `${LABELS[out.intent]}${who}${details.length ? `: ${details.join(', ')}` : ''}.`;
}

/**
 * Extract intake fields from an enquiry. Pure and deterministic.
 * @param {{ message: string, senderName?: string|null, senderPhone?: string|null }} input
 * @param {{ now?: Date, defaultCountry?: string }} [options]
 */
export function extractIntake(input, { now = new Date(), defaultCountry = 'IN' } = {}) {
  const text = String(input.message ?? '');
  const names = findNames(text);
  const exams = findExams(text);
  const city = findCity(text);
  const phone = findPhone(text, defaultCountry);
  const { intent, intents, audience } = findIntents(text);
  const { language, hinglish } = detectLanguage(text);
  const senderName = input.senderName ? readName(input.senderName, 0) : null;
  const out = {
    contactName: names.contactName ?? senderName,
    enquirer: names.enquirer,
    relation: names.relation,
    parentName: names.parentName ?? (names.enquirer === 'parent' ? senderName : null),
    studentName: names.studentName,
    grade: findGrade(text),
    board: findBoard(text),
    exam: exams[0] ?? null,
    exams,
    targetDate: findTargetDate(text, now),
    intent,
    intents,
    audience,
    language,
    hinglish,
    city: city?.name ?? null,
    timeZone: findTimeZone(text, { city, phones: [phone, input.senderPhone].filter(Boolean) }),
    phone,
    email: findEmail(text),
  };
  const missing = ['studentName', 'grade', 'exam', 'city'].filter((key) => !out[key]);
  if (!out.parentName && !out.contactName) missing.unshift('contactName');
  const score =
    0.3 +
    (out.parentName || out.studentName || out.contactName ? 0.12 : 0) +
    ((out.parentName || out.contactName) && out.studentName ? 0.08 : 0) +
    (out.grade ? 0.1 : 0) +
    (out.exam ? 0.12 : 0) +
    (out.city ? 0.08 : 0) +
    (out.intent !== 'other' ? 0.1 : 0) +
    (out.targetDate ? 0.05 : 0);
  return { ...out, summary: summaryOf(out), missing, confidence: Math.round(Math.min(0.95, score) * 100) / 100 };
}
