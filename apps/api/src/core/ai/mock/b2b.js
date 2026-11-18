import { findMoney } from '../text.js';
import { findCity, findEmail, findPhone, findTargetDate, readName } from './intake.js';
import { NUMBER_WORDS } from './vocab.js';

// Rule-based B2B qualification of an institute's enquiry or call notes: size, branches, current
// tools, budget, timeline and the decision maker.

const TOOLS = [
  ['Excel', /\b(ms\s+)?excel\b|\bspreadsheets?\b/i],
  ['Google Sheets', /\bgoogle sheets?\b/i],
  ['Google Forms', /\bgoogle forms?\b/i],
  ['Tally', /\btally\b/i],
  ['Fedena', /\bfedena\b/i],
  ['Teachmint', /\bteachmint\b/i],
  ['Classplus', /\bclassplus\b/i],
  ['Testbook', /\btestbook\b/i],
  ['Moodle', /\bmoodle\b/i],
  ['Zoho', /\bzoho\b/i],
  ['Entab', /\bentab\b/i],
  ['MyClassboard', /\bmyclassboard\b/i],
  ['Edunext', /\bedunext\b/i],
  ['WhatsApp groups', /\bwhatsapp groups?\b/i],
  ['Zoom', /\bzoom\b/i],
  ['Paper registers', /\b(pen and paper|paper registers?|registers|manual(ly)?|on paper)\b/i],
];

const PRODUCTS = [
  ['test_platform', /\b(test platform|online tests?|mock tests?|test series|exam software|online exams?|assessment)\b/i],
  ['erp', /\b(erp|school management|institute management|fee management|attendance|admissions? management|timetable)\b/i],
  ['lms', /\b(lms|learning management|recorded lectures|video lectures|online classes)\b/i],
];

const ROLES = /\b(director|owner|principal|founder|co-founder|admin(istrator)?|manager|coordinator|ceo|trustee|head|chairman|dean)\b/i;
const INSTITUTE_WORDS = String.raw`academy|institute|institution|school|classes|coaching|tutorials|education|educations|learning|public school|vidyalaya|vidya mandir|college|centre|center|international`;

function numberBefore(text, nounPattern) {
  const digits = text.match(new RegExp(String.raw`(\d[\d,]*(?:\.\d+)?)\s*(k|thousand)?\s*\+?\s*(?:${nounPattern})`, 'i'));
  if (digits) {
    const value = Number(digits[1].replace(/,/g, '')) * (digits[2] ? 1000 : 1);
    return Number.isFinite(value) ? Math.round(value) : null;
  }
  const words = text.match(new RegExp(String.raw`\b(${Object.keys(NUMBER_WORDS).join('|')})\s+(?:${nounPattern})`, 'i'));
  return words ? NUMBER_WORDS[words[1].toLowerCase()] : null;
}

export function findInstitute(text) {
  const source = String(text ?? '');
  const named = source.match(new RegExp(String.raw`\b((?:[A-Z][\w&'.-]*\s+){0,4}(?:${INSTITUTE_WORDS}))\b`, 'i'));
  let name = null;
  if (named) {
    const words = named[1].trim().split(/\s+/);
    // Keep the capitalised run that ends in the institute word ("Sunrise Academy", not "We are Sunrise Academy").
    const start = words.findIndex((w, i) => /^[A-Z]/.test(w) && words.slice(i, -1).every((x) => /^[A-Z&]/.test(x)));
    if (start >= 0 && start < words.length - 1) name = words.slice(start).join(' ');
  }
  const type = /\bschool|vidyalaya|vidya mandir\b/i.test(source)
    ? 'school'
    : /\b(independent|freelance|home) (tutor|mentor|teacher)|\bi teach\b|\bmy (students|tuition)\b/i.test(source)
      ? 'independent_mentor'
      : /\bcoaching|academy|institute|classes|tutorials\b/i.test(source)
        ? 'coaching_institute'
        : null;
  return { name, type };
}

function findTimeline(text, now) {
  const source = String(text ?? '');
  const phrase =
    source.match(/\b(asap|immediately|urgent(ly)?|right away|this week|next week|this month|next month|this quarter|next quarter|within \d+ (days|weeks|months)|in \d+ (days|weeks|months)|before (the )?new session|next session|next academic year)\b/i)?.[0] ??
    null;
  const date = findTargetDate(source, now);
  if (!phrase && !date) return null;
  return { text: phrase ?? date, date };
}

function findBudget(text) {
  const source = String(text ?? '');
  const anchor = source.search(/\b(budget|spend|afford|pay up to|price range|kharcha)\b/i);
  const amounts = findMoney(anchor >= 0 ? source.slice(anchor) : source);
  if (!amounts.length) return null;
  const amount = amounts[0];
  const after = source.slice(anchor >= 0 ? anchor : 0);
  const period = /\b(per|a|each)\s+(year|annum)|\bannual(ly)?\b|\byearly\b|\bp\.?a\.?\b/i.test(after)
    ? 'year'
    : /\b(per|a|each)\s+month\b|\bmonthly\b/i.test(after)
      ? 'month'
      : null;
  return { amountMinor: amount.amountMinor, currency: amount.currency, period, text: amount.text };
}

function findDecisionMaker(text) {
  const source = String(text ?? '');
  const self = source.match(new RegExp(String.raw`\b(?:i am|i'm|im|this is|myself)\s+(?:the\s+)?${ROLES.source}[\s,]*(?:of [^,.]+?,\s*)?`, 'i'));
  if (self) return { name: readName(source, self.index + self[0].length), role: self[1].toLowerCase(), isContact: true };
  const named = source.match(new RegExp(String.raw`\b(?:our|the)\s+${ROLES.source}\s*(?:is|,)?\s*`, 'i'));
  if (named) return { name: readName(source, named.index + named[0].length), role: named[1].toLowerCase(), isContact: false };
  return null;
}

/** Qualify a B2B enquiry. Pure and deterministic. */
export function qualifyInstitute(input, { now = new Date() } = {}) {
  const text = String(input.text ?? '');
  const institute = findInstitute(text);
  const students = numberBefore(text, 'students|learners|kids|children|bachche|pupils');
  const branches = /\b(single|one) (branch|centre|center|campus)\b/i.test(text) ? 1 : numberBefore(text, 'branches|branch|centres|centers|campuses|locations');
  const currentTools = TOOLS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
  const interestedIn = PRODUCTS.filter(([, pattern]) => pattern.test(text)).map(([key]) => key);
  const budget = findBudget(text);
  const timeline = findTimeline(text, now);
  const decisionMaker = findDecisionMaker(text);
  const city = findCity(text);

  let points = 0;
  if (students !== null) points += students >= 500 ? 2 : 1;
  if (branches !== null && branches > 1) points += 1;
  if (budget) points += 2;
  if (timeline) points += /asap|immediately|urgent|this (week|month)|next (week|month)|within/i.test(timeline.text) ? 2 : 1;
  if (decisionMaker) points += 1;
  if (interestedIn.length) points += 1;
  const fit = points >= 6 ? 'hot' : points >= 3 ? 'warm' : 'cold';

  const missing = [
    students === null && 'students',
    branches === null && 'branches',
    currentTools.length === 0 && 'currentTools',
    !budget && 'budget',
    !timeline && 'timeline',
    !decisionMaker && 'decisionMaker',
  ].filter(Boolean);
  const found = 6 - missing.length;
  return {
    instituteName: institute.name,
    instituteType: institute.type,
    city: city?.name ?? null,
    students,
    branches,
    currentTools,
    interestedIn,
    budget,
    timeline,
    decisionMaker,
    phone: findPhone(text),
    email: findEmail(text),
    fit,
    missing,
    summary: [
      institute.name ?? 'An institute',
      students !== null ? `${students} students` : null,
      branches !== null ? `${branches} branch${branches === 1 ? '' : 'es'}` : null,
      currentTools.length ? `uses ${currentTools.join(', ')}` : null,
      budget ? `budget ${budget.text}${budget.period ? ` per ${budget.period}` : ''}` : null,
      timeline ? `timeline ${timeline.text}` : null,
    ]
      .filter(Boolean)
      .join(', ') + '.',
    confidence: Math.round(Math.min(0.92, 0.35 + found * 0.09 + (institute.name ? 0.03 : 0)) * 100) / 100,
  };
}
