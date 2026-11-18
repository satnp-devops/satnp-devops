/**
 * Duplicate detection: is this enquiry a person we already know?
 *
 * Brief: "lead created, or merged with an existing person (phone, email, parent + student
 * name), keeping all history". Each rule below gives a score with an explanation; a candidate's
 * score is its best rule, and the score maps to a decision:
 *
 *   score >= thresholds.merge   → 'merge'    (attach to the existing person automatically)
 *   score >= thresholds.suggest → 'suggest'  (create, and offer the match to a person to review)
 *   otherwise                   → 'new'
 *
 * | Rule              | Score                                                                    |
 * | ----------------- | ------------------------------------------------------------------------ |
 * | phone + email     | 1.00 both contact points match                                           |
 * | phone_exact       | 1.00 names agree, 0.95 a name is missing or the enquirer is a household  |
 * |                   | member on record, 0.70 names differ (a family phone)                     |
 * | email_exact       | same as phone_exact                                                      |
 * | email_alias       | phone_exact − 0.05 (same Gmail mailbox, or +tag)                         |
 * | parent_student    | 0.92 × the weaker of the two name scores when both are full names,       |
 * |                   | 0.75 × it otherwise                                                      |
 * | phone_near        | 0.6 + 0.2 × name score, one-digit typo or swap, only when names agree    |
 * | name_similar      | 0.55 × name score, +0.1 in the same city; only above nameOnlyMin, so a  |
 * |                   | name alone is suggested only with the same city, and never merges       |
 *
 * Safety rules: two different contacts at merge level make the enquiry 'suggest' (ambiguous),
 * and pairs marked "not a duplicate" are never merged.
 *
 * Contact shapes from phase 2 are adapted by toDedupRecord(); normalisers are injected.
 */

import { compareNames, nameTokens } from './names.js';
import { emailMailboxKey, resolveNormalizers } from './normalize.js';

/**
 * @typedef {object} DedupRecord
 * @property {string | undefined} id
 * @property {string} name
 * @property {string[]} phones  E.164
 * @property {string[]} emails  normalised
 * @property {string | undefined} city
 * @property {string[]} students  names of learners in this person's family
 * @property {string[]} parents  names of this person's parents or guardians
 */

/**
 * @typedef {object} RuleHit
 * @property {string} rule
 * @property {number} score
 * @property {string} detail
 */

/**
 * @typedef {object} CandidateScore
 * @property {string | undefined} contactId
 * @property {number} score
 * @property {'merge' | 'suggest' | 'new'} decision
 * @property {RuleHit[]} rules  every rule that fired, best first
 * @property {string} explanation  the best rule's detail
 * @property {'person' | 'student' | 'parent'} [matchedAs]  which person in the record matched
 */

export const DEFAULT_DEDUP_OPTIONS = Object.freeze({
  thresholds: Object.freeze({ merge: 0.9, suggest: 0.6 }),
  /** Name score at which two names are taken to be the same person. */
  nameAgree: 0.7,
  /** Name score needed before a name-only match is suggested at all. */
  nameOnlyMin: 0.85,
  /** How many candidates to return. */
  limit: 5,
  defaultCountry: 'IN',
});

const asArray = (value) => (value === undefined || value === null ? [] : Array.isArray(value) ? value : [value]);
const valueOf = (item, keys) => {
  if (item === null || item === undefined) return undefined;
  if (typeof item !== 'object') return item;
  for (const key of keys) if (item[key] !== undefined && item[key] !== null && item[key] !== '') return item[key];
  return undefined;
};
const nameOf = (item) =>
  typeof item === 'string'
    ? item
    : valueOf(item, ['name', 'displayName', 'fullName']) ?? [item?.firstName, item?.lastName].filter(Boolean).join(' ');

const STUDENT_RELATIONS = new Set(['child', 'son', 'daughter', 'student', 'ward', 'learner']);
const PARENT_RELATIONS = new Set(['parent', 'father', 'mother', 'guardian']);

/**
 * Adapt an enquiry (from toEnquiry) or a stored contact to the fields dedup compares.
 *
 * Contacts may carry: id; name | displayName | firstName + lastName; phone, phones (strings or
 * { value | number | phone }); email, emails (strings or { value | address | email });
 * city | address.city; students | children (names or { name }); parents | guardians;
 * household.members ({ name, relation }).
 *
 * @param {any} input
 * @param {{ normalizers?: Partial<import('./normalize.js').Normalizers>, defaultCountry?: string }} [options]
 * @returns {DedupRecord}
 */
export function toDedupRecord(input, { normalizers, defaultCountry = 'IN' } = {}) {
  const norm = resolveNormalizers(normalizers);
  const isEnquiry = input && typeof input.contact === 'object' && input.source;
  const person = isEnquiry ? input.contact : input ?? {};
  const country = person.country ?? defaultCountry;
  const phoneValues = [
    ...asArray(person.phone),
    ...asArray(person.altPhone),
    ...asArray(person.phones).map((p) => valueOf(p, ['value', 'number', 'phone', 'e164'])),
  ];
  const emailValues = [...asArray(person.email), ...asArray(person.emails).map((e) => valueOf(e, ['value', 'address', 'email']))];
  const phones = unique(phoneValues.map((p) => norm.phone(p, { defaultCountry: country })));
  const emails = unique(emailValues.map((e) => norm.email(e)));

  let students;
  let parents;
  if (isEnquiry) {
    students = asArray(input.student?.name);
    parents = asArray(input.parent?.name);
  } else {
    const members = asArray(person.household?.members);
    students = [
      ...asArray(person.students).map(nameOf),
      ...asArray(person.children).map(nameOf),
      ...members.filter((m) => STUDENT_RELATIONS.has(String(m?.relation ?? '').toLowerCase())).map(nameOf),
    ];
    parents = [
      ...asArray(person.parents).map(nameOf),
      ...asArray(person.guardians).map(nameOf),
      ...members.filter((m) => PARENT_RELATIONS.has(String(m?.relation ?? '').toLowerCase())).map(nameOf),
    ];
  }
  return {
    id: isEnquiry ? input.externalId : person.id,
    name: norm.name(nameOf(person) ?? ''),
    phones,
    emails,
    city: person.city ?? person.address?.city ?? undefined,
    students: unique(students.map((s) => norm.name(s ?? ''))),
    parents: unique(parents.map((s) => norm.name(s ?? ''))),
  };
}

function unique(values) {
  return [...new Set(values.filter((v) => typeof v === 'string' && v.length > 0))];
}

/** Two numbers one digit apart (a typo) or with two adjacent digits swapped, same country code. */
export function phonesNear(a, b) {
  if (a === b || a.length !== b.length || a.length < 10) return false;
  // The country code and the first digits must agree; typos happen in the subscriber part.
  if (a.slice(0, 4) !== b.slice(0, 4)) return false;
  const diffs = [];
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) diffs.push(i);
  if (diffs.length === 1) return true;
  return diffs.length === 2 && diffs[1] === diffs[0] + 1 && a[diffs[0]] === b[diffs[1]] && a[diffs[1]] === b[diffs[0]];
}

const isFullName = (name) => nameTokens(name).length >= 2;
const round = (value) => Math.round(value * 1000) / 1000;
const sameCity = (a, b) => Boolean(a && b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase());

/** Best name comparison of one name against several. */
function bestName(name, others) {
  let best = { score: 0, method: 'missing', detail: 'a name is missing', other: undefined };
  for (const other of others) {
    const result = compareNames(name, other);
    if (result.score > best.score) best = { ...result, other };
  }
  return best;
}

/**
 * How well do the subject's people line up with the candidate's? Considers the subject's own
 * name against the candidate, and against the candidate's students and parents (a learner
 * enquiring from a parent's phone).
 */
function personAgreement(subject, candidate) {
  const direct = compareNames(subject.name, candidate.name);
  const asStudent = bestName(subject.name, candidate.students);
  const asParent = bestName(subject.name, candidate.parents);
  return { direct, asStudent, asParent };
}

/**
 * Score for an exact shared contact point, adjusted by whether the names agree.
 * @returns {RuleHit & { matchedAs: 'person' | 'student' | 'parent' }}
 */
function contactPointHit(rule, label, value, subject, candidate, options, base = 1) {
  const { direct, asStudent, asParent } = personAgreement(subject, candidate);
  if (direct.method === 'missing') {
    return { rule, score: round(base - 0.05), detail: `Same ${label} ${value}; a name is missing, so names were not compared`, matchedAs: 'person' };
  }
  if (direct.score >= options.nameAgree) {
    return { rule, score: base, detail: `Same ${label} ${value}; names agree (${direct.detail})`, matchedAs: 'person' };
  }
  const household = asStudent.score >= options.nameAgree ? ['student', asStudent] : asParent.score >= options.nameAgree ? ['parent', asParent] : null;
  if (household) {
    const [role, match] = household;
    return {
      rule,
      score: round(base - 0.05),
      detail: `Same ${label} ${value}; the enquirer matches the ${role} on this record (${match.other})`,
      matchedAs: /** @type {'student' | 'parent'} */ (role),
    };
  }
  return {
    rule,
    score: round(base - 0.3),
    detail: `Same ${label} ${value}, but the names differ (${subject.name} / ${candidate.name}): possibly a family member sharing it`,
    matchedAs: 'person',
  };
}

/** Best comparison across two lists of names. */
function bestAcross(as, bs) {
  let best = { score: 0, detail: '', a: '', b: '' };
  for (const a of as) {
    for (const b of bs) {
      const result = compareNames(a, b);
      if (result.score > best.score) best = { score: result.score, detail: result.detail, a, b };
    }
  }
  return best;
}

/**
 * Parent + student rule. Lines the subject's family up with the candidate's four ways:
 * the enquirer is a parent (with students) or the learner (with parents), and the candidate
 * record is a parent (with students) or a learner (with parents).
 * @returns {(RuleHit & { matchedAs: 'person' | 'student' | 'parent' }) | null}
 */
function parentStudentHit(subject, candidate) {
  /** @type {{ parentsA: string[], parentsB: string[], kidsA: string[], kidsB: string[], as: 'person' | 'student' | 'parent' }[]} */
  const layouts = [];
  if (subject.students.length) {
    layouts.push({ parentsA: [subject.name], parentsB: [candidate.name], kidsA: subject.students, kidsB: candidate.students, as: 'person' });
    layouts.push({ parentsA: [subject.name], parentsB: candidate.parents, kidsA: subject.students, kidsB: [candidate.name], as: 'student' });
  }
  if (subject.parents.length) {
    layouts.push({ parentsA: subject.parents, parentsB: [candidate.name], kidsA: [subject.name], kidsB: candidate.students, as: 'parent' });
    layouts.push({ parentsA: subject.parents, parentsB: candidate.parents, kidsA: [subject.name], kidsB: [candidate.name], as: 'person' });
  }
  let best = null;
  for (const layout of layouts) {
    const parent = bestAcross(layout.parentsA.filter(Boolean), layout.parentsB.filter(Boolean));
    const kid = bestAcross(layout.kidsA.filter(Boolean), layout.kidsB.filter(Boolean));
    const weaker = Math.min(parent.score, kid.score);
    if (weaker <= 0) continue;
    const full = [parent.a, parent.b, kid.a, kid.b].every(isFullName);
    const score = round((full ? 0.92 : 0.75) * weaker);
    if (best && score <= best.score) continue;
    best = {
      rule: 'parent_student',
      score,
      detail:
        `Parent ${parent.a} ~ ${parent.b} (${parent.detail}) and student ${kid.a} ~ ${kid.b} (${kid.detail})` +
        (full ? '' : '; not all are full names, so this can only be suggested'),
      matchedAs: layout.as,
    };
  }
  return best;
}

/**
 * Score one existing record against the incoming one.
 * @param {DedupRecord} subject
 * @param {DedupRecord} candidate
 * @param {Partial<typeof DEFAULT_DEDUP_OPTIONS> & { notDuplicates?: Iterable<string> }} [options]
 * @returns {CandidateScore}
 */
export function scoreCandidate(subject, candidate, options = {}) {
  const opts = { ...DEFAULT_DEDUP_OPTIONS, ...options, thresholds: { ...DEFAULT_DEDUP_OPTIONS.thresholds, ...options.thresholds } };
  /** @type {(RuleHit & { matchedAs?: 'person' | 'student' | 'parent' })[]} */
  const hits = [];

  const sharedPhone = subject.phones.find((p) => candidate.phones.includes(p));
  const sharedEmail = subject.emails.find((e) => candidate.emails.includes(e));
  if (sharedPhone && sharedEmail) {
    hits.push({ rule: 'phone_and_email', score: 1, detail: `Same phone ${sharedPhone} and email ${sharedEmail}`, matchedAs: 'person' });
  }
  if (sharedPhone) hits.push(contactPointHit('phone_exact', 'phone', sharedPhone, subject, candidate, opts));
  if (sharedEmail) hits.push(contactPointHit('email_exact', 'email', sharedEmail, subject, candidate, opts));
  if (!sharedEmail) {
    const candidateBoxes = new Map(candidate.emails.map((e) => [emailMailboxKey(e), e]));
    const alias = subject.emails.find((e) => candidateBoxes.has(emailMailboxKey(e)));
    if (alias) {
      const hit = contactPointHit('email_alias', 'mailbox', `${alias} ~ ${candidateBoxes.get(emailMailboxKey(alias))}`, subject, candidate, opts, 0.95);
      hits.push(hit);
    }
  }

  // Parent + student: the subject's enquirer and learner against the candidate's family.
  const bestPair = parentStudentHit(subject, candidate);
  if (bestPair) hits.push(bestPair);

  const names = compareNames(subject.name, candidate.name);
  if (!sharedPhone && names.score >= opts.nameAgree) {
    const near = subject.phones.flatMap((a) => candidate.phones.filter((b) => phonesNear(a, b)).map((b) => [a, b]))[0];
    if (near) {
      hits.push({
        rule: 'phone_near',
        score: round(0.6 + 0.2 * names.score),
        detail: `Phones ${near[0]} and ${near[1]} differ by one digit and the names agree (${names.detail})`,
        matchedAs: 'person',
      });
    }
  }
  if (names.score >= opts.nameOnlyMin) {
    const city = sameCity(subject.city, candidate.city);
    hits.push({
      rule: 'name_similar',
      score: round(Math.min(0.55 * names.score + (city ? 0.1 : 0), opts.thresholds.merge - 0.01)),
      detail: `Similar name only (${names.detail})${city ? `, same city ${candidate.city}` : ''}`,
      matchedAs: 'person',
    });
  }

  hits.sort((a, b) => b.score - a.score);
  const best = hits[0];
  let score = best?.score ?? 0;
  const blocked = candidate.id !== undefined && new Set(options.notDuplicates ?? []).has(candidate.id);
  let explanation = best?.detail ?? 'Nothing in common';
  if (blocked && score > 0) {
    score = Math.min(score, opts.thresholds.suggest - 0.01);
    explanation = `Marked as not a duplicate. ${explanation}`;
  }
  const decision = score >= opts.thresholds.merge ? 'merge' : score >= opts.thresholds.suggest ? 'suggest' : 'new';
  /** @type {CandidateScore} */
  const out = {
    contactId: candidate.id,
    score,
    decision,
    rules: hits.map(({ rule, score: s, detail }) => ({ rule, score: s, detail })),
    explanation,
  };
  if (best?.matchedAs) out.matchedAs = best.matchedAs;
  return out;
}

/**
 * @typedef {object} DedupResult
 * @property {'merge' | 'suggest' | 'new'} decision
 * @property {string | null} contactId  the contact to merge into ('merge' only)
 * @property {number} score
 * @property {string} explanation
 * @property {'person' | 'student' | 'parent'} [matchedAs]  on merge: who in the record matched (a learner enquiring
 *   from a parent's phone matches as 'student', so attach the enquiry to the family, don't rename it)
 * @property {CandidateScore[]} candidates  best first, only those at 'suggest' or above
 */

/**
 * Score an incoming enquiry (or contact) against existing contacts and decide.
 *
 * Callers fetch candidates cheaply first (same phone, same email or mailbox, trigram name
 * search via pg_trgm, or the family's students) and pass them here; this ranks and explains.
 *
 * @param {any} incoming  an enquiry from toEnquiry(), a contact, or a DedupRecord
 * @param {any[]} contacts  stored contacts (any shape toDedupRecord accepts) or DedupRecords
 * @param {Partial<typeof DEFAULT_DEDUP_OPTIONS> & { normalizers?: object, notDuplicates?: Iterable<string> }} [options]
 * @returns {DedupResult}
 */
export function findDuplicates(incoming, contacts, options = {}) {
  const opts = { ...DEFAULT_DEDUP_OPTIONS, ...options, thresholds: { ...DEFAULT_DEDUP_OPTIONS.thresholds, ...options.thresholds } };
  const adapt = (value) => (isDedupRecord(value) ? value : toDedupRecord(value, opts));
  const subject = adapt(incoming);
  const seen = new Set();
  const scored = [];
  for (const contact of contacts ?? []) {
    const record = adapt(contact);
    if (record.id !== undefined) {
      if (seen.has(record.id) || record.id === subject.id) continue;
      seen.add(record.id);
    }
    scored.push(scoreCandidate(subject, record, opts));
  }
  const ranked = scored.filter((c) => c.decision !== 'new').sort((a, b) => b.score - a.score || String(a.contactId).localeCompare(String(b.contactId)));
  const candidates = ranked.slice(0, opts.limit);
  const merges = ranked.filter((c) => c.decision === 'merge');
  if (merges.length === 1) {
    return {
      decision: 'merge',
      contactId: merges[0].contactId ?? null,
      score: merges[0].score,
      explanation: merges[0].explanation,
      matchedAs: merges[0].matchedAs,
      candidates,
    };
  }
  if (merges.length > 1) {
    return {
      decision: 'suggest',
      contactId: null,
      score: merges[0].score,
      explanation: `Matches ${merges.length} existing contacts strongly; a person must choose (${merges.map((m) => m.contactId).join(', ')})`,
      candidates,
    };
  }
  if (candidates.length) {
    return { decision: 'suggest', contactId: null, score: candidates[0].score, explanation: candidates[0].explanation, candidates };
  }
  return { decision: 'new', contactId: null, score: 0, explanation: 'No existing contact matches', candidates: [] };
}

function isDedupRecord(value) {
  return value && Array.isArray(value.phones) && Array.isArray(value.emails) && Array.isArray(value.students) && Array.isArray(value.parents) && typeof value.name === 'string';
}

/**
 * Lookup keys a caller can use to fetch candidates with indexed queries before scoring:
 * normalised phones, emails and mailbox keys, plus names for a pg_trgm `%` search.
 * @param {any} incoming
 * @param {{ normalizers?: object, defaultCountry?: string }} [options]
 */
export function candidateKeys(incoming, options = {}) {
  const record = isDedupRecord(incoming) ? incoming : toDedupRecord(incoming, options);
  return {
    phones: record.phones,
    emails: record.emails,
    mailboxes: unique(record.emails.map(emailMailboxKey)),
    names: unique([record.name, ...record.students, ...record.parents]),
  };
}

// ---------------------------------------------------------------------------------------------
// Merge plans

/** Related records that move from the duplicate to the primary when two contacts merge. */
export const DEFAULT_MERGE_RELATIONS = Object.freeze([
  'enquiries',
  'deals',
  'activities',
  'notes',
  'tasks',
  'messages',
  'calls',
  'meetings',
  'documents',
  'household_memberships',
  'consents',
  'tags',
  'list_memberships',
]);

/** Fields that never merge: identity and bookkeeping. */
const SYSTEM_FIELDS = new Set(['id', 'createdAt', 'updatedAt', 'mergedIntoId', 'status', 'version', 'groupId', 'deletedAt']);
/** Multi-valued fields: values from both records are kept. */
const UNION_FIELDS = new Set(['phones', 'emails', 'tags', 'languages', 'sources', 'productLineIds']);
/** Consent: if either record opted out, the merged person has opted out (DPDP Act 2023, s. 6). */
const RESTRICTIVE_FIELDS = new Set(['consent', 'consents', 'marketingConsent', 'whatsappConsent', 'doNotCall', 'doNotContact']);

const isEmpty = (value) =>
  value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0) ||
  (isPlainObject(value) && Object.keys(value).length === 0);
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Opt-out wins: false beats true for consents, true beats false for do-not-contact flags. */
function restrictive(field, a, b) {
  if (isEmpty(a)) return b;
  if (isEmpty(b)) return a;
  if (typeof a === 'boolean' && typeof b === 'boolean') return field.startsWith('doNot') ? a || b : a && b;
  if (isPlainObject(a) && isPlainObject(b)) {
    const out = { ...a };
    for (const [key, value] of Object.entries(b)) out[key] = key in a ? restrictive(key, a[key], value) : value;
    return out;
  }
  return a;
}

function unionValues(a, b) {
  const out = [];
  const keys = new Set();
  for (const item of [...asArray(a), ...asArray(b)]) {
    const key = JSON.stringify(isPlainObject(item) ? valueOf(item, ['value', 'address', 'number', 'email', 'phone']) ?? item : item);
    if (keys.has(key)) continue;
    keys.add(key);
    out.push(item);
  }
  return out;
}

/** Is `b` the same name as `a` with more parts (initials expanded, a surname added)? */
function fullerName(a, b) {
  const { method } = compareNames(a, b);
  return ['subset', 'initials', 'single_name'].includes(method) && nameTokens(b).join('').length > nameTokens(a).join('').length;
}

/**
 * Choose which of two contacts survives a merge: the older record (it carries the longest
 * history), then the one with an owner, then the more complete one, then the smaller id.
 * @param {any} a
 * @param {any} b
 * @returns {[any, any]} [primary, duplicate]
 */
export function choosePrimary(a, b) {
  const time = (c) => (c?.createdAt ? new Date(c.createdAt).getTime() : Infinity);
  const filled = (c) => Object.values(c ?? {}).filter((v) => !isEmpty(v)).length;
  const order =
    time(a) - time(b) ||
    Number(Boolean(b?.ownerId)) - Number(Boolean(a?.ownerId)) ||
    filled(b) - filled(a) ||
    String(a?.id).localeCompare(String(b?.id));
  return order <= 0 ? [a, b] : [b, a];
}

/**
 * @typedef {object} FieldDecision
 * @property {string} field
 * @property {'primary' | 'duplicate' | 'union' | 'restrictive' | 'newest'} winner
 * @property {unknown} value
 * @property {string} reason
 * @property {unknown} [discarded]  the losing value, kept in the merge history
 */

/**
 * Describe how `duplicate` merges into `primary`. Nothing is deleted: the duplicate is marked
 * merged with a pointer to the primary, every related record moves, and values that lose are
 * kept in the merge event so the timeline shows them and an admin can undo.
 *
 * Field rules:
 * - id, timestamps and status are never merged;
 * - phones, emails, tags (UNION_FIELDS) keep every value from both, primary's first;
 * - consent and do-not-contact fields take the most restrictive value;
 * - fields in `options.preferNewest` take the value from whichever record was updated last;
 * - plain objects (custom fields, address) merge key by key with the same rules;
 * - name: the duplicate's wins when it is a fuller form of the same name ("R. Sharma" → "Rahul Sharma");
 * - everything else: the primary's value wins when it has one, else the duplicate's fills it.
 *
 * @param {any} primary
 * @param {any} duplicate
 * @param {{ relations?: readonly string[], preferNewest?: string[], at?: string }} [options]
 */
export function mergePlan(primary, duplicate, { relations = DEFAULT_MERGE_RELATIONS, preferNewest = [], at } = {}) {
  if (!primary?.id || !duplicate?.id) throw new Error('Both contacts need an id');
  if (primary.id === duplicate.id) throw new Error('A contact cannot merge into itself');
  const newest = new Set(preferNewest);
  const duplicateIsNewer =
    duplicate.updatedAt && primary.updatedAt && new Date(duplicate.updatedAt).getTime() > new Date(primary.updatedAt).getTime();

  /** @type {FieldDecision[]} */
  const fields = [];
  /** @type {{ field: string, kept: unknown, discarded: unknown }[]} */
  const conflicts = [];

  const decide = (field, a, b, path) => {
    if (UNION_FIELDS.has(field)) {
      const value = unionValues(a, b);
      return { field: path, winner: 'union', value, reason: 'kept every value from both records' };
    }
    if (RESTRICTIVE_FIELDS.has(field)) {
      const value = restrictive(field, a, b);
      return { field: path, winner: 'restrictive', value, reason: 'an opt-out on either record wins' };
    }
    if (newest.has(path) && !isEmpty(a) && !isEmpty(b) && !same(a, b)) {
      const value = duplicateIsNewer ? b : a;
      return { field: path, winner: 'newest', value, reason: 'the more recently updated record wins', discarded: duplicateIsNewer ? a : b };
    }
    if (isPlainObject(a) && isPlainObject(b)) return null; // handled key by key
    if (path === 'name' && typeof a === 'string' && typeof b === 'string' && fullerName(a, b)) {
      return { field: path, winner: 'duplicate', value: b, reason: 'a fuller form of the same name', discarded: a };
    }
    if (isEmpty(a) && !isEmpty(b)) return { field: path, winner: 'duplicate', value: b, reason: 'primary had no value' };
    if (!isEmpty(a) && !isEmpty(b) && !same(a, b)) {
      return { field: path, winner: 'primary', value: a, reason: 'both had a value; primary wins', discarded: b };
    }
    return { field: path, winner: 'primary', value: a, reason: isEmpty(b) ? 'duplicate had no value' : 'same value' };
  };

  const mergeObjects = (a, b, prefix) => {
    const out = {};
    const keys = [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])];
    for (const key of keys) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (!prefix && SYSTEM_FIELDS.has(key)) continue;
      const av = a?.[key];
      const bv = b?.[key];
      if (isEmpty(av) && isEmpty(bv)) continue;
      const decision = decide(key, av, bv, path);
      if (decision === null) {
        out[key] = mergeObjects(av, bv, path);
        continue;
      }
      out[key] = decision.value;
      if (!same(av, bv) || decision.winner === 'duplicate') fields.push(decision);
      if (decision.discarded !== undefined) conflicts.push({ field: path, kept: decision.value, discarded: decision.discarded });
    }
    return out;
  };

  const merged = mergeObjects(primary, duplicate, '');
  const result = { ...merged, id: primary.id };
  if (primary.createdAt || duplicate.createdAt) {
    const times = [primary.createdAt, duplicate.createdAt].filter(Boolean).map((t) => new Date(t).getTime());
    result.createdAt = new Date(Math.min(...times)).toISOString();
  }
  const moves = relations.map((relation) => ({ relation, fromId: duplicate.id, toId: primary.id }));
  return {
    primaryId: primary.id,
    duplicateId: duplicate.id,
    result,
    fields,
    conflicts,
    moves,
    duplicate: { id: duplicate.id, status: 'merged', mergedIntoId: primary.id },
    event: {
      type: 'contact.merged',
      aggregateId: primary.id,
      payload: { primaryId: primary.id, duplicateId: duplicate.id, conflicts, fields: fields.map((f) => f.field), at },
    },
  };
}
