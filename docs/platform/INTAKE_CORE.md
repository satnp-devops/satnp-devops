# Intake core

`apps/api/src/core/intake/` is the engine behind phase 4 (capture and intake). It covers what happens to an enquiry between arriving and becoming a lead: normalise it, route it to a company, find the person if we already know them, pick an owner, and import CSV files. Every function is pure. Callers pass data in and get results and explanations back. The engine does no database, network or clock access, so channel features (web forms, WhatsApp, calls, ad lead forms, imports) can wire it in with their own storage.

Import everything from `core/intake/index.js`.

```
toEnquiry()       any channel's payload → the normalised enquiry (zod)
route()           enquiry + channel registry (+ AI classifier) → company / product line, or review
candidateKeys()   enquiry → phone, email, mailbox and name keys to fetch candidates with
findDuplicates()  enquiry + candidate contacts → merge / suggest / new, with reasons
mergePlan()       two contacts → which fields win, what moves, the merge event
assignOwner()     lead + owner pool + fairness state → owner, reasons, next state
importCsv()       CSV text → enquiries + per-row error report (+ errorReportCsv())
```

| File | Holds |
| --- | --- |
| `enquiry.js` | channel types, the enquiry zod schema, `toEnquiry`, `attributionFromUrl` |
| `normalize.js` | reference normalisers for phone (E.164), email and name; `emailMailboxKey` |
| `trigram.js` | trigram similarity with pg_trgm semantics |
| `names.js` | folding, honorifics, Indian spelling variants, phonetic keys, `compareNames` |
| `routing.js` | channel identity matching, `decideRoute` (sync), `route` (async, calls the classifier) |
| `dedup.js` | `toDedupRecord`, `scoreCandidate`, `findDuplicates`, `candidateKeys`, `mergePlan`, `choosePrimary` |
| `assign.js` | `assignOwner`, `assignBatch`, `initialState` |
| `time.js` | Intl-based zone offsets, local time, working hours, wall time to UTC |
| `csv.js` | `parseCsv`, `detectDelimiter`, `toCsv`, `suggestMapping`, `parseDateValue`, `importCsv`, `errorReportCsv` |

Tests: `apps/api/test/intake/*.test.js` (174 tests). Run them with `cd apps/api && node --test "test/intake/*.test.js"`. On Node 24 a bare directory argument doesn't work, so pass the glob.

## 1. Normalisers (injected)

Every function that compares or cleans contact points takes `normalizers: { phone, email, name }`. Any normaliser you leave out falls back to the reference one (`resolveNormalizers`). When phase 2 ships `core/crm/normalize.js`, pass its functions in. The engine doesn't change, and storage and matching then agree.

```js
/** @typedef {{ phone(raw, { defaultCountry }): string | null, email(raw): string | null, name(raw): string }} Normalizers */
```

The reference versions behave as follows:

- **Phone → E.164 or null.** Indian numbers are recognised in every common form: `98765 43210`, `098765-43210`, `919876543210`, `+91 0 98765 43210`, `0091…` and `(+91) …`. STD landlines (`011 2345 6789`) are kept. Extensions are dropped. Placeholders such as `9999999999` and `1234567890` are rejected. Other countries need `+` or `00`, or a `defaultCountry` from `CALLING_CODES`, which covers the Gulf, South Asia, SG, MY, UK, US, CA, AU and NZ. Input over 64 characters is rejected.
- **Email → lower case or null.** The email normaliser trims, strips `mailto:` and `Name <addr>`, and requires a domain and a TLD of at least two letters. `emailMailboxKey()` returns the address a message actually reaches. It drops `+tags` everywhere. For Gmail it also ignores dots and treats googlemail.com as gmail.com, because Gmail itself ignores dots in addresses.
- **Name → display form.** The name normaliser collapses whitespace, drops wrapping quotes and stray punctuation, and title-cases names typed in all caps or all lower case. Mixed case, such as `McDonald`, is left as written.

## 2. The enquiry

`toEnquiry(input, { normalizers, defaultCountry = 'IN', now })` returns either `{ ok: true, enquiry, warnings }` or `{ ok: false, errors, warnings }`. Each issue has the form `{ path, code, message }`.

```js
{
  externalId, companyId, audience: 'b2c' | 'b2b', receivedAt,            // ISO instant (default: now)
  source: {
    channel: { type, identity },                                         // see CHANNEL_TYPES
    campaign, campaignId, utm: { source, medium, campaign, term, content },
    referrer, partnerId, landingUrl, formId, adId, clickIds: { gclid, fbclid, msclkid }, capturedById,
  },
  contact: { name, firstName, lastName, phone, altPhone, email, relation, language, timeZone, city, state, country, pincode },
  student:   { name, grade, board, school, targetExam, dateOfBirth },   // the learner, when the enquirer isn't
  parent:    { name, phone, email, relation },                          // when the learner enquires
  institute: { name, type, city, studentCount, website },               // B2B
  interest:  { productLineId, product, course, message, preferredTime },
  consent:   { marketing, whatsapp, calls, capturedAt, text },
  raw: { ... },                                                          // the original payload, kept for history
}
```

`toEnquiry` applies these rules:

- Phones become E.164 and emails lower case. A contact point that can't be normalised is dropped with a warning (`invalid_phone`, `invalid_email`) as long as another contact point remains. Otherwise those issues become errors, and the error `contact_point_required` is added.
- `contact.country` sets the default country for reading phones.
- The name is built from first and last name when `name` is missing.
- UTM tags and click ids missing from `source` are read from `source.landingUrl`. Tags given explicitly win. `campaign` defaults to `utm.campaign`.
- `audience` is inferred: an institute means `b2b`, a student or parent means `b2c`.
- Blank strings and nulls count as "not given". Unknown keys, unknown channel types, bad time zones, non-http(s) landing URLs, language codes that aren't ISO 639 and country codes that aren't ISO 3166 alpha-2 are all errors, each with its field path.

Channel types are `website_form`, `landing_page`, `chat_widget`, `whatsapp`, `phone_call`, `missed_call`, `sms`, `email`, `facebook_lead_ad`, `instagram`, `google_lead_form`, `walk_in`, `event`, `partner_referral`, `csv_import`, `api` and `other`. Each type's `identity` says which number, inbox, form, host, branch, partner or batch the enquiry arrived on.

## 3. Routing

From the brief: *"an enquiry goes to the company that owns the channel it arrived on. On a shared channel, an AI classifier picks the company and product line; low confidence goes to a review queue."*

```js
const result = await route({
  channel: enquiry.source.channel,
  identities,                 // the channel registry, see below
  enquiry,                    // passed to the classifier
  classify,                   // async ({ enquiry, channel, companyIds }) => { companyId, productLineId?, confidence, rationale?, alternatives? }
  thresholds: { default: 0.75, byCompany: { scholiq: 0.9 } },   // or a single number
  minMargin: 0.1,
  classifyOwned: false,       // true: also ask the classifier for the product line on owned channels
});
// → { decision: 'route' | 'review', companyId, productLineId?, confidence, reason, message, shared, identityId?, threshold?, classification?, warnings }
```

Each entry in the identity registry has the form `{ id, type, identity, companyId, productLineId?, shared?, companyIds? }`.

| Situation | Result |
| --- | --- |
| Owned channel (one company registered it) | `route`, confidence 1, reason `owned_channel`. The classifier is never asked for the company. A registration with `productLineId` fixes the product line too. |
| Shared channel, classification ≥ the company's threshold and ahead of the next in-scope company by `minMargin` | `route`, reason `classified` |
| Shared, below the threshold | `review`, reason `low_confidence`, with the best guess kept |
| Shared, two companies too close | `review`, reason `ambiguous` |
| Shared, the classifier picks a company outside the channel's `companyIds` | `review`, reason `out_of_scope` |
| Shared, the classifier is missing, throws or returns an invalid answer | `review`, reason `no_classifier`, `classifier_error` or `classifier_invalid` |
| No registration matches | `review`, reason `unknown_channel` |
| Registered without a company and not shared | `review`, reason `misconfigured_identity` |
| The same identity registered by two companies | treated as shared between them, with warning `conflicting_identities` |

Identity matching normalises per type: phones (for WhatsApp, calls, missed calls and SMS) to E.164, inboxes to lower case, and URLs to host plus path with no `www.`, query or trailing slash. Web channels also match by host (subdomains included) or by path prefix at segment boundaries, and the most specific registration wins. An identity only matches its own channel type. `decideRoute()` is the synchronous core, for when a classification has already been made. The classifier is never called for owned channels unless `classifyOwned` is set. Even then it can only add a product line, never change the company.

## 4. Dedup

From the brief: *"lead created, or merged with an existing person (phone, email, parent + student name), keeping all history"*.

```js
const keys = candidateKeys(enquiry);   // { phones, emails, mailboxes, names } → indexed lookups + pg_trgm `%` on names
const contacts = await loadCandidates(keys);            // caller's query, scoped to the company
const result = findDuplicates(enquiry, contacts, { thresholds: { merge: 0.9, suggest: 0.6 }, notDuplicates });
// → { decision: 'merge' | 'suggest' | 'new', contactId, score, explanation, matchedAs?, candidates: [...] }
```

Each candidate has the form `{ contactId, score, decision, rules: [{ rule, score, detail }], explanation, matchedAs }`. A candidate's score is the score of its best rule.

| Rule | Score |
| --- | --- |
| `phone_and_email` | 1.00. Both contact points match, whatever the names. |
| `phone_exact` | 1.00 if the names agree. 0.95 if a name is missing, or the enquirer matches a student or parent on the record. 0.70 if the names differ (a shared family phone: suggest, don't merge). |
| `email_exact` | as `phone_exact` |
| `email_alias` | `phone_exact` − 0.05. Same mailbox: Gmail dots, googlemail.com, `+tags`. |
| `parent_student` | 0.92 × the weaker of the parent and student name scores when all four are full names (≥ 2 parts). 0.75 × that score otherwise, so first names alone can only be suggested. The rule checks four layouts: the enquirer is a parent or a learner, and the record is a parent or a learner. |
| `phone_near` | 0.6 + 0.2 × the name score, for a one-digit typo or two adjacent digits swapped, same country code. Fires only when the names agree. |
| `name_similar` | 0.55 × the name score, +0.1 in the same city. Fires only at or above `nameOnlyMin` (0.85). A name alone is therefore suggested only within the same city, and never merges. |

Names agree at a score of `nameAgree` (0.7) or above. `compareNames()` gives each match a score and a method:

| Method | Score | Example |
| --- | --- | --- |
| `exact` | 1 | after folding and dropping honorifics: `Mr. Rahul Sharma` / `RAHUL SHARMA` |
| `reordered` | 0.98 | `Sharma Rahul` / `Rahul Sharma` |
| `variant` | 0.95 | `Mohd. Irfan` / `Muhammad Irfan`, `Laxmi` / `Lakshmi`, `Pooja` / `Puja`, `Agrawal` / `Aggarwal`, `Chowdhury` / `Chaudhary` |
| `subset` | 0.88 | `Rahul Sharma` / `Rahul Kumar Sharma` |
| `initials` | 0.85 | `R. K. Sharma` / `Rahul Kumar Sharma` (needs at least one full name part to match) |
| `single_name` | 0.7 | `Rahul` / `Rahul Sharma` |
| `trigram` | pg_trgm similarity | the best of the folded and phonetic forms (`Rahul Sharma` / `Rohit Sharma` ≈ 0.44) |

Name handling:

- Names are folded with Unicode NFKD, accents stripped from Latin letters, lower case, and punctuation turned into spaces. Other scripts keep their vowel signs.
- Honorifics are dropped: Mr, Mrs, Ms, Dr, Prof, Shri, Sri, Smt, Kumari, Km and similar, plus a trailing "ji".
- Relation markers are cut off: `S/o`, `D/o`, `W/o`, `C/o`.
- A small table maps common spelling variants to one form (Muslim given names, frequent surnames, `Kr`/`Kumar`).
- A phonetic key per token handles basic transliteration: sh/s, ph/f, bh, dh, th, kh, gh and jh lose the h, x/ksh, z/j, q/k, w/v, ee/i, oo/u, ou and ow become au, doubled letters collapse, and a final -y becomes -i and a final -a is dropped.

Safety rules:

- If two different contacts reach merge level, the decision is `suggest` with an "ambiguous" explanation. The engine never picks one automatically.
- A pair listed in `notDuplicates` (a reviewer said "not the same person") is capped below the suggest line.
- When a learner enquires from a parent's phone, the match has `matchedAs: 'student'`. Attach the enquiry to the family. Don't rename the parent's contact.

Thresholds, `nameAgree`, `nameOnlyMin` and `limit` (5) are options, so a company can be stricter. `toDedupRecord()` adapts phase 2 contact shapes. It reads `name`, `displayName` or `firstName` + `lastName`; `phone` and `phones` (strings, or objects with `value`, `number`, `phone` or `e164`); `email` and `emails`; `city` or `address.city`; `students`, `children`, `parents` and `guardians`; and `household.members` with a `relation`.

### Trigram similarity (pg_trgm semantics)

`trigram.js` reproduces PostgreSQL's `similarity()` ([pg_trgm docs](https://www.postgresql.org/docs/current/pgtrgm.html)):

- text is lower-cased, and anything that isn't a letter or digit separates words;
- each word is padded with two spaces before and one after;
- the trigrams form a set;
- the score is shared / (|A| + |B| − shared), and 0 when either side is empty.

Tests check the documented values (`similarity('word', 'two words')` = 4/11). As a result, a database prefilter with `name % $1`, which uses the default 0.3 threshold (`PG_TRGM_DEFAULT_THRESHOLD`), and the in-memory scoring agree. The differences don't matter for names: Postgres uses float4 and hashes multi-byte trigrams.

### Merge plans

`mergePlan(primary, duplicate, { relations, preferNewest, at })` describes a merge without performing it. `choosePrimary(a, b)` picks the survivor: the older record (it holds the longest history), then the one with an owner, then the more complete one, then the smaller id.

| Field | Rule |
| --- | --- |
| `id`, `createdAt`, `updatedAt`, `status`, `version`, `groupId`, `deletedAt`, `mergedIntoId` | never merged; `createdAt` becomes the earlier of the two |
| `phones`, `emails`, `tags`, `languages`, `sources`, `productLineIds` | union, primary's values first, deduplicated by value |
| `consent`, `consents`, `doNotCall`, `doNotContact`, `marketingConsent`, `whatsappConsent` | most restrictive: an opt-out on either record wins. Consent is withdrawable under the DPDP Act 2023 (s. 6), and a merge must not re-enable contact. |
| `name` | the duplicate's name wins when it is a fuller form of the same name (`R. Sharma` → `Rahul Sharma`) |
| fields listed in `preferNewest` (paths such as `grade`, `customFields.board`) | the value from the more recently updated record |
| plain objects (`customFields`, `address`) | merged key by key with these same rules |
| everything else | the primary's value wins when it has one; the duplicate fills gaps |

The plan returns:

- `result`: the merged contact.
- `fields`: every field that changed, with its winner and reason.
- `conflicts`: each losing value, which is kept for the timeline and for undo.
- `moves`: one `{ relation, fromId, toId }` per related table. The defaults are listed in `DEFAULT_MERGE_RELATIONS`: enquiries, deals, activities, notes, tasks, messages, calls, meetings, documents, household memberships, consents, tags and list memberships.
- `duplicate: { id, status: 'merged', mergedIntoId }`: the duplicate is kept with a pointer to the primary, not deleted.
- a `contact.merged` event for the outbox.

## 5. Assignment

From the brief: *"Owner assigned by round-robin (capacity, language, time zone; partner leads stay with the partner's counsellor)"*.

```js
const { decision, ownerId, method, reasons, excluded, state } = assignOwner({
  lead: { companyId, productLineId, unitPath, language, timeZone, partnerId, partnerOwnerId, existingOwnerId, existingOwnerLastActivityAt },
  owners,          // the pool: [{ id, active, status, available, away: [{from,to}], companyIds, productLineIds, unitPaths, languages, timeZone, workingHours, openLeads, capacity, partnerIds }]
  state,           // fairness state from the last call for this pool (or nothing)
  now,             // required: epoch ms, ISO string or Date
  options,         // see DEFAULT_ASSIGN_OPTIONS
});
```

The steps run in order:

1. **Partner stickiness.** A lead with `partnerId` goes to `partnerOwnerId`, or to the owner whose `partnerIds` include the partner. This ignores capacity and working hours, but never assigns to someone who is inactive, unavailable, away or out of scope. In those cases the step falls through and says why (`partner_owner_unavailable`, `partner_owner_missing`).
2. **Returning families.** `existingOwnerId` gets the lead if their last activity with the family is within `returningWindowDays` (365) and they can take it, under the same rules as step 1. Otherwise the step falls through with `existing_owner_expired`, `existing_owner_not_in_pool` or `existing_owner_unavailable`. Partner stickiness wins over this step.
3. **Hard filters.** These exclude, in order: inactive (`active: false`, or a status other than `active`), `available: false`, inside an `away` period, wrong company, product line or org unit (`isWithin` from `core/orgTree.js` works both ways), and at the open-lead cap (`openLeads >= capacity`, where a null capacity means no cap). With `languageMatch: 'require'` or `workingHours: 'require'`, language and working hours become hard filters too.
4. **Soft preferences.** Each one narrows the pool only if someone is left afterwards; otherwise it is skipped with a reason. They apply in order: speaks one of the lead's languages, is within working hours now (in their own zone, default `Asia/Kolkata`, Mon–Sat 09:30–18:30 as in the phase 1 settings), and is within `maxOffsetMinutes` (180) of the lead's UTC offset.
5. **Fairness.** Least recently assigned goes first. The state holds a monotonic sequence, so new owners go next and returning owners slot in without catching up a backlog. Ties go to the lighter load (open leads ÷ cap), then the fewer open leads, then id.

The state has the form `{ version: 1, seq, owners: { [id]: { lastSeq, assigned } } }` and never mutates its input. Sticky assignments count in `assigned` but don't use up a round-robin turn. `assignBatch({ leads, owners, state, now })` carries open-lead counts forward, so caps hold across an import. It returns `{ results, state, openLeads }`. When nobody is eligible, the result is `decision: 'unassigned'`, with the exclusions counted ("2 at their open-lead cap, 1 on leave"), and the state unchanged.

## 6. CSV imports

```js
const report = importCsv(text, {
  mapping,                    // optional: { 'Mobile No.': 'contact.phone', 3: 'student.name', 'Notes': '' }
  defaults: { companyId, source: { channel: { type: 'csv_import', identity: batchId } } },
  defaultCountry: 'IN', dateOrder: 'DMY', timeZone: 'Asia/Kolkata', now, maxRows: 50_000,
});
// → { ok, delimiter, headers, mapping, suggestions, enquiries: [{ row, line, enquiry, warnings }], errors, warnings, fileIssues, summary }
const download = errorReportCsv(report);   // Row, Level, Column, Field, Problem, Value
```

- **Parsing** follows RFC 4180 ([rfc-editor.org/rfc/rfc4180](https://www.rfc-editor.org/rfc/rfc4180)). It handles quoted fields with delimiters, `""` escapes and line breaks; CRLF, LF or CR line endings; and a UTF-8 BOM. The delimiter is detected from `,`, `;`, tab and `|`: the one that splits the header and the most following lines into the same number of columns, ignoring quoted text. The parser is lenient where spreadsheet tools are: spaces around a quoted field, a stray quote inside an unquoted field (kept, with warning `stray_quote`), and text after a closing quote (`text_after_quote`). An unterminated quote is an error with its line number.
- **Mapping.** `suggestMapping(headers)` matches normalised headers ("Father's Mobile No." becomes "father mobile no") against the synonyms in `ENQUIRY_FIELDS`. An exact match scores 1. A header that contains every word of a multi-word synonym scores 0.85. Otherwise the score is the trigram similarity, kept from 0.5. A header that lacks a synonym's qualifier is skipped, so "Mobile" never becomes "father mobile". Each field goes to one column, best scores first, and every suggestion lists its alternatives for the mapping screen.
- **Values.** Dates are read as Indian sheets write them: D/M/Y by default with `/`, `-` or `.`, `5 Nov 2026`, `Nov 5, 2026`, ISO with or without an offset, 12- or 24-hour times, and Excel serial numbers. A time without an offset is read in `timeZone`. Impossible dates such as 31/02 are rejected. Booleans accept yes/no, y/n, true/false, 1/0, opted in/out and haan/nahi. Language names become ISO codes (Hindi → `hi`, Tamil → `ta`, and so on). Country names become ISO codes. Relations map to the enquiry's values (father → `parent`).
- **Rows.** Each row is checked with `toEnquiry`. Errors reject the row and carry the row number (the header is row 1, as in a spreadsheet), the physical line, the column, the field, a code, a message and the value. Unreadable optional cells, such as an unparseable date, are dropped with a warning instead of rejecting the row. A row whose phone or email repeats an earlier row is imported with a `duplicate_in_file` warning, and dedup decides the rest. A row with the wrong number of cells gets a warning. Blank rows are counted and skipped. The original cells are kept in `enquiry.raw`.
- **Whole-file errors** set `ok: false` and import nothing: a mapping that names an unknown column or field, no column mapped to a phone or email, or more than `maxRows` rows.
- **Writing.** `toCsv()` writes RFC 4180 with CRLF line endings. It prefixes cells that start with `= + - @`, tab or CR with an apostrophe, so a spreadsheet can't run them as formulas ([OWASP: CSV Injection](https://owasp.org/www-community/attacks/CSV_Injection)). The error report goes through it.

## 7. How features wire it in

A channel handler (a form webhook, the WhatsApp inbound handler, the call integration, an ad lead-form sync or the import worker) does this inside one transaction:

```js
import { toEnquiry, route, candidateKeys, findDuplicates, mergePlan, assignOwner } from '../../core/intake/index.js';
import * as crmNormalize from '../../core/crm/normalize.js';          // phase 2; until then omit `normalizers`

const parsed = toEnquiry(payload, { normalizers: crmNormalize, now: Date.now() });
if (!parsed.ok) throw errors.validation(parsed.errors.map((e) => ({ path: e.path, message: e.message })));
const enquiry = parsed.enquiry;

const routing = await route({ channel: enquiry.source.channel, identities: await loadIdentities(trx), enquiry, classify, thresholds: await loadThresholds(trx) });
if (routing.decision === 'review') return queueForReview(trx, enquiry, routing);       // keep routing.reason / message

const keys = candidateKeys(enquiry, { normalizers: crmNormalize });
const contacts = await findCandidateContacts(trx, routing.companyId, keys);               // indexed phone/email/mailbox + `name % $1`
const dedup = findDuplicates(enquiry, contacts, { normalizers: crmNormalize, notDuplicates: await loadNotDuplicates(trx, contacts) });
const contact = dedup.decision === 'merge' ? await attachToContact(trx, dedup.contactId, enquiry, dedup) : await createContact(trx, enquiry);
if (dedup.decision === 'suggest') await saveSuggestions(trx, contact.id, dedup.candidates);

const pool = await loadOwnerPool(trx, routing);                                           // counsellors of the right team
const fairness = await loadFairnessState(trx, poolKey, { forUpdate: true });
const assignment = assignOwner({ lead: toLead(contact, enquiry, routing), owners: pool, state: fairness, now: Date.now() });
await saveFairnessState(trx, poolKey, assignment.state);
// create the lead with assignment.ownerId (or leave it unassigned), write the audit entry and emit events
```

**Persistence contract.** The engine doesn't implement storage; the owning feature module does. It needs these pieces:

| Need | Suggested storage |
| --- | --- |
| channel registry | `channel_identities (id, group_id, type, identity_normalized, company_id null, product_line_id null, shared bool, company_ids uuid[])`, unique on `(group_id, type, identity_normalized)` unless shared; store `normalizeIdentity(type, identity)` |
| routing thresholds | a setting per company (`intake.routing.threshold`, 0–1), read with `getSetting` |
| review queue | the enquiry with `routing.reason`, `routing.message`, `classification` |
| dedup lookups | indexes on normalised phone, email and `mailbox_key`, plus `CREATE INDEX … USING gin (name gin_trgm_ops)` for `%` |
| suggestions and "not a duplicate" | `duplicate_suggestions (contact_id, candidate_id, score, rules jsonb, status)`, and `not_duplicate_pairs (a, b)` passed as `notDuplicates` |
| merges | apply `mergePlan().result` and `moves` in one transaction, set `merged_into_id`, write `conflicts` to the audit log, and emit `event` |
| fairness | `assignment_state (pool_key, state jsonb, updated_at)`, read `FOR UPDATE` so concurrent intakes don't both pick the same owner |
| CSV | the upload handler enforces the file size, then runs `importCsv` in the worker for large files and stores `errorReportCsv` for download |

Concurrency: `assignOwner` is pure, so two simultaneous enquiries that read the same state would pick the same owner. Lock the state row (`SELECT … FOR UPDATE`) or serialise per pool, for example with a BullMQ job keyed by pool.

## 8. Limits and next steps

- The variant and phonetic tables cover common Latin-script spellings. Names written in Devanagari or other scripts are matched by trigrams within that script only, with no transliteration across scripts. Nicknames ("Bunty", "Pinky") aren't mapped.
- The reference phone normaliser validates Indian numbers fully, but other countries only by length. For full validation, phase 2's helper could wrap libphonenumber, which would need a dependency.
- Assignment has no weighting (giving a senior counsellor twice the share). Capacity is the lever today. Time-zone matching compares UTC offsets now; it doesn't compare overlapping working windows.
- `route()` doesn't apply deterministic hints such as "this campaign belongs to SatnPaper" before calling the classifier. A feature can register campaign-specific landing pages or forms as owned identities instead.
- CSV parsing holds the whole file in memory. That is fine at 50,000 rows; for larger files, stream rows into `importCsv` per chunk. Excel `.xlsx` files aren't read; export them to CSV first.
