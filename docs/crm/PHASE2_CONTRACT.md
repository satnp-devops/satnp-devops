# Phase 2 contract: core CRM

Contacts, households, institutes, product lines and products, pipelines, custom fields, deals (a lead is a deal), timeline, tasks, saved views, consent and search.

This document is the source of truth for phase 2. Engineers follow it literally: table and column names, endpoint paths, query and body schemas, response type names, permissions, error codes, events and audit actions. When something here is wrong or missing, fix this document in the same change as the code and tell the other slices. `docs/ARCHITECTURE.md` stays the source of truth for everything phase 1 built (org tree, access, settings, events, audit).

What already exists (built with this contract):

| Piece | Where |
| --- | --- |
| Migration with every table and index below | `apps/api/src/db/migrations/20261106000100_crm_core.js` |
| Demo data | `apps/api/src/db/seeds/02_crm.js` |
| Module skeletons (permissions, grants, settings; no routes yet) | `apps/api/src/modules/{contacts,accounts,pipelines,catalog,fields,deals,timeline,tasks,search}/module.js` |
| Shared server helpers and their tests | `apps/api/src/core/crm/*.js`, `apps/api/test/crm/*.test.js` |
| Search reindex CLI | `apps/api/src/cli/search-reindex.js` (`npm run search:reindex -w @phoenix/api`) |
| Web types and query keys | `apps/web/src/lib/crm/types.ts`, `apps/web/src/lib/crm/keys.ts` |
| Sidebar, settings tabs, stub pages, Leads layout, command palette stub | `apps/web/src/lib/nav.ts`, `apps/web/src/app/(app)/…`, `apps/web/src/components/search/CommandPalette.tsx` |

Sections: 1 decisions · 2 conflicts resolved · 3 slice ownership · 4 scoping · 5 data model · 6 permissions · 7 settings · 8 shared helpers · 9 endpoints · 10 response shapes · 11 events, timeline and audit · 12 stage rules and SLAs · 13 scale · 14 seed · 15 web · 16 definition of done.

---

## 1. Decisions

Where the architecture and brief are silent, phase 2 picks the following. Each is easy to change later.

1. **A lead is a deal.** One table, `deals`. "Lead" is the word the UI uses for open deals in early stages; there is no conversion step.
2. **People and institutes are group-level, everything else is company-level.** `contacts` and `accounts` belong to a group and are de-duplicated across it. A company sees a person or institute through a *link row* (`contact_companies`, `account_companies`) that carries the owning unit, owner, status, tags, source and the company's custom field values. Deals, tasks, saved views and company-made timeline entries carry `group_id`, `company_id`, `unit_id`.
3. **Scoping by unit ids, not denormalised paths.** Lists filter with `unit_id IN (…)`, the ids computed in memory from `org_units.path` and the user's assignments (units are few). Moving a unit therefore never rewrites CRM rows. A unit that holds CRM records may move only within its company (`assertUnitCanChangeCompany`, already wired into the org module's move).
4. **Student facts live in a JSONB profile** (`contacts.student_profile`, zod `studentProfileSchema`: grade, school, board, targetExam, targetDate, graduationYear, stream), not columns. They are basic details shared across the group, filtered rarely, and the list will grow by exam. A GIN `jsonb_path_ops` index covers `@>` filters. Company-specific facts (preferred batch timing, target score) are custom fields on the company link or the deal.
5. **Custom field values** are JSONB keyed by field key: `deals.custom`, `contact_companies.custom`, `account_companies.custom`. Definitions are rows per company and entity. Stage rules refer to custom deal fields as `custom.<key>`.
6. **Enquiry channels are a registry**, like unit types: modules contribute `channels: [...]` in `module.js` (the deals module contributes the ten built-in ones). `deals.channel` is text, so adding a channel needs no migration and no frontend change.
7. **Deal references** are `<prefix>-<number>` (SP-1042): a per-company counter in `crm_sequences` and the prefix from the `deals.referencePrefix` setting at creation. The ref never changes.
8. **The timeline is append-only with soft deletes** and no foreign keys on its subjects, so it can be archived or partitioned. Producers write their own entries synchronously in the same transaction (one rule per event, section 11).
9. **Search is one table**, `search_documents`, written in the same transaction as the change and repaired by event handlers and a reindex CLI. Titles and subtitles never contain personal data; normalised phones and emails live in `keywords`, which the API never returns.
10. **Money** is `bigint` minor units plus an ISO 4217 currency (`value_minor`, `currency`). The API sends `{ valueMinor, currency }`; JavaScript numbers are safe up to `MAX_VALUE_MINOR` (10^14).
11. **SLAs use calendar time** in phase 2 (stage SLA in hours, first reply in minutes). Business-hours SLAs (using the `workingHours` setting) can replace the computation later without schema changes.
12. **Consent** is an append-only history per person, company (or the whole group), channel and purpose. The effective state is the latest applicable record (`core/crm/consent.js`). Marketing needs a grant; transactional and service messages are allowed unless withdrawn.
13. **Bulk actions** on up to 200 deals run synchronously, one transaction per deal. Larger bulk jobs move to background jobs once the jobs framework lands (platform slice).
14. **Products in phase 2 are catalog only** (product lines and products with descriptive attributes). Plans, price lists and taxes arrive with the money phase; the seed's `fee` numbers are only used for demo deal values.

## 2. Conflicts resolved

| Brief says | Architecture says | Phase 2 does |
| --- | --- | --- |
| Hierarchy group → companies → teams → users | Org tree group > company > region > branch > team, roles assigned at any unit and inherited downwards | Follows the architecture. "Company" is the nearest ancestor-or-self unit of type `company` (`companyOf`). |
| "Company switcher at the top with an All companies view" | "Working in" scope picker (section 6, Working scope) | The existing scope picker *is* the company switcher. Choosing the group is "All companies"; choosing a company, region, branch or team narrows lists to it. Every list endpoint takes `unitId` = the working unit. |
| Phases: 2 = contacts and deals, 3 = channel intake, 4 = scheduling, 5 = money … | Roadmap section 17: 2 = core CRM, 3 = integration framework, 4 = capture and intake, 5 = communication, 6 = scheduling, 7 = money, 8 = admissions and delivery, 9 = automation and AI, 10 = partners, 11 = analytics | "Soon" entries in the sidebar use the architecture's phase numbers. |
| Products in phase 2 | Products listed under phase 7 (money) | Product lines and products are catalog in phase 2 (deals carry a product line); plans, price lists and taxes stay in phase 7. |
| Roles: group admin, company admin, manager, counsellor/sales rep, finance, partner | Built-in roles: group owner, group admin, company admin, manager, counsellor, account executive, finance, marketing, support, analyst | Architecture roles. "Sales rep" is `account_executive`; partners arrive with the partner portal (phase 10). |

## 3. Slice ownership map

Wave 1 starts right after this contract, in parallel. Each slice owns its module folders, tests, web route folders, `components/<area>/` and `lib/<area>/`. Nobody edits another slice's files; shared files change only through the integrator.

| Slice | API (owns) | API path prefixes | Web (owns) |
| --- | --- | --- | --- |
| **contacts** | `modules/contacts/**` (contacts, contact methods, households, consents, duplicates and merge, DPDP export and erase); tests `test/integration/contacts.test.js`, `test/contacts/**` | `/contacts`, `/households` | `app/(app)/leads/contacts/**`, `components/contacts/**` (incl. the contact drawer `ContactDrawer.tsx`), `lib/contacts/**` |
| **accounts** | `modules/accounts/**` (institutes, account contacts and decision makers, `findOrCreateAccount`); tests `test/integration/accounts.test.js`, `test/accounts/**` | `/accounts` | `app/(app)/accounts/**`, `components/accounts/**`, `lib/accounts/**` |
| **config** | `modules/pipelines/**`, `modules/catalog/**`, `modules/fields/**`; tests `test/integration/config.test.js`, `test/config/**` | `/pipelines`, `/lost-reasons`, `/product-lines`, `/products`, `/custom-fields`, `/crm` | `app/(app)/settings/pipelines/**`, `app/(app)/settings/products/**`, `app/(app)/settings/fields/**`, `components/config/**`, `lib/config/**` |
| **deals** | `modules/deals/**` (deals, stage moves and `stageRules.js`, SLA sweep, assignment, won/lost/reopen, saved views, bulk actions, duplicate pre-check); tests `test/integration/deals.test.js`, `test/deals/**` | `/deals`, `/saved-views` | `app/(app)/leads/page.tsx` and `app/(app)/leads/LeadsView.tsx` (+ files next to them), `components/deals/**` (list, filters, side preview), `lib/deals/**` |
| **timeline** | `modules/timeline/**`, `modules/tasks/**`; tests `test/integration/timeline.test.js`, `test/timeline/**` | `/timeline`, `/tasks` | `app/(app)/tasks/**`, `components/timeline/**` (reusable `Timeline`, `NoteComposer`), `components/tasks/**` (reusable `TaskList`, `TaskDialog`), `lib/timeline/**` |
| **search** | `modules/search/**`, `cli/search-reindex.js` (already there); tests `test/integration/search.test.js`, `test/search/**` | `/search` | `components/search/**` (the Ctrl/Cmd+K palette, replacing the stub), `lib/search/**` |
| CRM UI kit (separate engineer) | none | none | `components/crm/**`, `lib/crm/format.ts` |
| Platform (four engineers) | integration framework, webhooks and jobs, messaging, AI: their own modules | their own | their own; they don't touch the modules above |

Shared files (owned by the lead, changed only through the integrator): `core/crm/**`, the phase 2 migration and seed, `modules/index.js`, `core/registry.js`, `apps/web/src/lib/crm/types.ts`, `apps/web/src/lib/crm/keys.ts`, `apps/web/src/lib/nav.ts`, `apps/web/src/components/icons.tsx`, `apps/web/src/app/(app)/layout.tsx`, `apps/web/src/app/(app)/leads/layout.tsx`, this document. A slice that needs a change there (a new column, a helper option, a type) writes it in its own report as a contract change; small additive changes to `types.ts` for its own endpoints are expected and are merged by the integrator.

Each slice replaces its module's empty `routes() {}` with `routes: (router) => <name>Routes(router)` from its own `routes.js`, keeping the `permissions`, `roleGrants` and `settings` in `module.js` unchanged unless this contract changes. Server code is split as in phase 1: `routes.js` (zod + handlers), `service.js` (transactions, audit, events), `present.js` (row → API shape).

Wave 2, after the merge: the deal profile page `/leads/[id]`, the pipeline board and table `/pipeline`, QA and performance (load tests at 1 lakh deals per company), docs and OpenAPI.

## 4. Scoping

### 4.1 Rules

1. **Working scope.** Every list takes `unitId`, the unit picked in "Working in". The group means all companies. The unit must be visible (`req.access.canSee`) or the endpoint returns 404, and the user must hold the list's permission at, above or anywhere inside it or the endpoint returns 403.
2. **Company-owned records** (`deals`, `tasks`, `saved_views`, company timeline entries, `contact_companies`, `account_companies`) carry `group_id`, `company_id`, `unit_id`. `unit_id` is the owning unit inside the company (the company itself, a region, branch or team). The user can see a record when they hold the view permission at the record's unit (roles at the unit or above it). A record outside that is **404**, never 403.
3. **"own" level.** With `x.view:own` (or `x.manage:own`) the user sees (or changes) only records they own at the units where the grant applies:
   - deals: `owner_user_id = me`
   - tasks: `assignee_user_id = me OR created_by = me`
   - contact and account links: `owner_user_id = me`
   - saved views: personal views are always the owner's; shared views follow section 9.7.
4. **People and institutes.** A contact is visible when (a) the user can see one of its company links with `contacts.view` (own: the link's owner), or (b) the user can see a deal that involves it (`deal_contacts` or `deals.primary_contact_id`). Accounts work the same with `accounts.view`, `account_companies` and `deals.account_id`. Basic details are shared across the group. A company's deals, notes, tasks and custom values are visible only inside that company's scope; users with a role at the group unit hold their permissions in every company and therefore see across companies.
5. **Personal data** (phones, emails, dates of birth, street addresses, also an institute's phone and email) is masked unless the user holds `contacts.view_pii` at a unit they see the record through (a visible link's unit or a visible deal's unit). Masking is done by the presenters in `core/crm/pii.js`; the API never sends unmasked values to a user without the permission. Names, city, kind and the student profile are never masked.
6. **Configuration** (pipelines, stages, lost reasons, product lines, products, custom fields) belongs to a company. Reading needs the view permission at, above or anywhere inside the company; writing needs the manage permission at the company itself (so a team manager can't change company pipelines).
7. **Creating** a company-owned record needs the manage permission at the chosen unit, the unit active and inside a company (`requireCreateUnit`). Defaults: `group_id = unit.root_id`, `company_id = companyOf(unit)`, `unit_id = unit.id` (`ownedColumns`).
8. **Ids from the client are never trusted.** Every referenced id (pipeline, stage, product line, contact, account, household, owner, lost reason) is loaded and checked: it must belong to the same group and, for configuration, the same company as the record; people must be visible to the user. Wrong company → 422 with the field path (it's a form mistake); invisible → 422 "not found" on the field, never revealing whether it exists.

### 4.2 Helper API (`apps/api/src/core/crm/scope.js`)

Slices may add options but keep these signatures.

| Helper | Does |
| --- | --- |
| `unitsIndex(req, trx?)` → `Map<id, unit>` | Every unit of the user's groups, loaded once per request (cached on `req`). |
| `companyOf(unit, unitsById)` → unit \| null | Nearest ancestor-or-self of type `company`; null for a group. |
| `companyForUnit(unitOrId, trx?)` | Same, from the database (seeds, workers, handlers). |
| `scopePaths(access, permission)` → `{ all, own }` | Outermost unit paths where the permission applies at each level (pure). |
| `listScope(req, permission, { unitId, trx? })` → `ListScope` | 404/403 checks for the working unit, then `{ permission, userId, unit, company, groupId, allUnitIds, ownUnitIds, ownOnly }`. |
| `scopeFromPaths({ permission, userId, unit, unitsById, paths })` | The pure part of `listScope` (tests, handlers). |
| `applyListScope(query, scope, { unitColumn?, ownerColumns?, companyColumn?, groupColumn? })` | Adds `company_id = …` (or `group_id = …` at group scope) and `(unit IN all) OR (unit IN own AND owner = me)`. An empty scope matches nothing. |
| `applyUnitFilter(query, scope, { unitColumn?, ownerColumns? })` | Only the unit and owner part. |
| `whereLinkedInScope(query, scope, { linkTable?, foreignKey?, idColumn?, includeArchived? })` | Keeps contacts (default) or accounts with a company link in scope. For accounts pass `{ linkTable: 'account_companies', foreignKey: 'account_id', idColumn: 'a.id' }`. |
| `levelForRecord(access, unitsById, permission, record, { userId, unitColumn?, ownerColumns? })` | `'all' \| 'own' \| null` for one row (pure). |
| `recordLevel(req, permission, record, opts)` | Same with the request's units. |
| `loadVisible(req, { table, id, permission, unitColumn?, ownerColumns?, notFound?, trx?, forUpdate? })` → `{ row, level }` | Load a company-owned row or throw 404. |
| `requireRecord(req, permission, record, opts)` | 403 unless the user holds a second permission on a row they can see. |
| `requireCreateUnit(req, unitId, permission, { trx?, path? })` → `{ unit, company, level }` | 404 invisible · 403 no permission · 409 archived · 422 not inside a company. |
| `ownedColumns({ unit, company })` | `{ group_id, company_id, unit_id }`. |
| `requireCompany(req, companyId, permission, { write?, trx?, path? })` → company | Configuration access (rule 6). |
| `companiesInScope(req, unitId, permission, { trx? })` → company[] | Companies a configuration list covers for a working unit: its own company, or every company under a group where the user holds the permission. |
| `usersWithPermissionAt(unit, permission, { trx?, userIds? })` → `[{ id, name, email, level }]` | Active people holding a permission at a unit (owner and assignee pickers, validation). |
| `userLevelAt(userId, unit, permission, { trx? })` | `'all' \| 'own' \| null` for one person. |
| `decideRecordAccess({ access, unitsById, userId, links, deals?, kind? })` | Pure decision for a contact or account: `{ canView, canManage, canViewPii, canMerge, canPrivacy, visibleLinks, visibleDealIds, companyIds }`. Working a deal (`deals.manage` on it) lets the user edit its people. |
| `loadVisibleContact(req, contactId, { trx?, forUpdate? })` | Contact + links + decision, or 404 (code `merged` with `details.mergedIntoId` for a merged record). |
| `loadVisibleAccount(req, accountId, { trx?, forUpdate? })` | Same for institutes. |
| `canViewPiiAt(access, unitsById, unitIds)` | For masking list rows. |
| `assertUnitCanChangeCompany(trx, unit)` | Used by the org module before a move across companies. |

`ListScope` at a glance:

```js
const scope = await listScope(req, 'deals.view', { unitId: req.valid.query.unitId });
const rows = await applyListScope(db('deals as d'), scope, { unitColumn: 'd.unit_id', ownerColumns: ['d.owner_user_id'], companyColumn: 'd.company_id', groupColumn: 'd.group_id' })
  .whereNull('d.archived_at')
  .orderBy([{ column: 'd.updated_at', order: 'desc' }, { column: 'd.id', order: 'desc' }])
  .limit(limit + 1);
```

## 5. Data model

All tables are created by `20261106000100_crm_core.js`. Conventions as in phase 1: UUID keys (`gen_random_uuid()`), `timestamptz` in UTC, `created_at`/`updated_at` default `now()` (services set `updated_at = now()` on every update), JSONB for typed profiles (validated by zod before writing), text + check constraints for small fixed vocabularies, text without constraints for vocabularies that grow by configuration (channels, product kinds, timeline kinds, account kinds; validated in code against `core/crm/constants.js` or the registry). `pg_trgm` and `citext` are created with `create extension if not exists`. FKs to `org_units` are `RESTRICT`; FKs to `users` are `SET NULL`. People, institutes and deals are never hard-deleted (merge, erase and archive keep the rows).

### 5.1 contacts (people, once per group)

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid pk | |
| group_id | uuid not null → org_units | |
| kind | text not null default `other` | `parent \| student \| staff \| other` (check) |
| first_name, last_name | text | |
| display_name | text not null | "Priya Sharma"; `Unnamed contact` when no name; `Erased contact` after erasure |
| name_normalized | text not null default '' | `normalizeName(display_name)` |
| primary_phone | text | E.164 of the primary phone (else primary WhatsApp) method. PII |
| primary_email | text | lower-case primary email. PII |
| date_of_birth | date | PII (API: `YYYY-MM-DD` string) |
| address | jsonb not null default {} | `addressSchema`. PII |
| city | text | |
| country_code | char(2) | |
| time_zone | text | IANA |
| language | text | `en`, `hi`, `mr`… |
| student_profile | jsonb not null default {} | `studentProfileSchema` |
| merged_into_id | uuid → contacts RESTRICT | set when merged into another contact |
| merged_at, erased_at | timestamptz | |
| created_by | uuid → users | |
| created_at, updated_at | timestamptz | |

Indexes: `contacts_group_updated_idx (group_id, updated_at desc, id desc) where merged_into_id is null`; `contacts_group_created_idx (group_id, created_at desc, id desc) where merged_into_id is null`; `contacts_group_name_idx (group_id, name_normalized, id) where merged_into_id is null`; `contacts_name_trgm_idx gin (name_normalized gin_trgm_ops)`; `contacts_student_profile_idx gin (student_profile jsonb_path_ops) where kind = 'student'`; `contacts_merged_into_idx (merged_into_id) where merged_into_id is not null`.

**contact_methods**: id; contact_id → contacts CASCADE; group_id (copied from the contact); kind `phone \| email \| whatsapp` (check); value (as entered); normalized (E.164 or lower-case email); label ("Mobile", "Father's WhatsApp"); is_primary bool; verified_at; opted_out_at (the person asked not to be contacted on this number or address); timestamps. Unique `(contact_id, kind, normalized)`; unique `(contact_id, kind) where is_primary`; lookup index `contact_methods_lookup_idx (group_id, normalized)` for exact phone and email search and de-duplication. The same number may belong to several people (a parent and child often share one).

**contact_companies** (a company knows this person): id; contact_id → contacts CASCADE; group_id; company_id; unit_id (owning unit inside the company); owner_user_id → users; status `lead \| customer \| former` (check, default lead); first_seen_at; source jsonb (`touchSourceSchema` of the first enquiry with this company); tags text[]; custom jsonb (the company's custom contact fields); archived_at (hidden from this company's lists); created_by; timestamps. Unique `(contact_id, company_id)`; indexes `(company_id, unit_id)`, `(unit_id)`, `(owner_user_id) where owner_user_id is not null`, gin `(tags)`.

### 5.2 De-duplication (people)

`findOrCreateContact(trx, input, { req })` (`core/crm/contacts.js`) is the only way to turn "someone with this name, phone and email" into a contact: manual entry, deals, institute staff now; channel intake and imports later.

1. Normalise phones with the default country (`contacts.defaultCountry` setting of the company, India by default) and emails. Invalid values → 422 (`invalidMethods: 'skip'` drops them instead, for intake).
2. Take a transaction-scoped advisory lock per normalised value (`crm.contact:<group>:<value>`), so concurrent intakes for one number wait for each other.
3. Candidates: non-merged, non-erased contacts in the group with any matching normalised method (`contact_methods_lookup_idx`), locked `FOR UPDATE`.
4. `chooseContactMatch`: a candidate is ruled out when both kinds are known and differ (parent vs student sharing a number), or both names are known and clearly differ (`namesLikelySame` with the `contacts.fuzzyMatchThreshold` setting). Email matches beat phone matches, then a matching name, then the most recently updated.
5. On a match: add new methods (primary only for kinds with no primary yet), fill blanks only (`fillBlanks`: never overwrite what someone entered). Otherwise create the contact with its methods.
6. Ensure the company link (`contact_companies`, insert … on conflict do nothing). Owner, source and tags apply only when the link is created by this call.
7. Write the search document, a `system` timeline entry ("Contact added" / "Contact added to this company") unless `writeTimeline: false`, the event `contact.created` / `contact.company_linked` / `contact.updated`, and the audit entry when `req` is given.

Returns `{ contact, created, matchedBy: 'email' | 'phone' | null, link, linkCreated, addedMethods }`. `mode: 'create'` skips matching (the user said "this is a different person").

Fuzzy duplicates (similar names without a shared phone or email) are never merged automatically: the contacts slice lists them (section 9.1, duplicates) for a person to merge.

### 5.3 Households

**households**: id; group_id; name ("Sharma family"); city; archived_at; created_by; timestamps. Index `(group_id, lower(name), id)`.

**household_members**: household_id → households CASCADE; contact_id → contacts CASCADE; role `parent \| guardian \| student \| other` (check); relation ("Mother", "Father", "Uncle"); is_primary (the household's main contact); created_at. PK `(household_id, contact_id)`; index `(contact_id)`. Siblings are the students of the same household. A person may belong to several households (separated parents).

### 5.4 Institutes (B2B accounts, once per group)

**accounts**: id; group_id; kind (text, `ACCOUNT_KINDS`: coaching_institute, school, college, independent_mentor, other); name; name_normalized; legal_name; website; domain citext (normalised host for de-duplication); primary_phone (E.164; masked like PII); primary_email (masked like PII); city; state; country_code; address jsonb; branch_count int ≥ 0; student_count int ≥ 0; current_software; profile jsonb (`accountProfileSchema`, section 9.2); merged_into_id → accounts; merged_at; created_by; timestamps. Indexes: `(group_id, updated_at desc, id desc)`, `(group_id, created_at desc, id desc)`, `(group_id, name_normalized, id)` (all `where merged_into_id is null`), gin trigram on `name_normalized`, `(group_id, domain) where domain is not null`.

**account_companies**: same shape as `contact_companies` with `account_id`. Unique `(account_id, company_id)`.

**account_contacts** (people at an institute): account_id → accounts CASCADE; contact_id → contacts CASCADE; title ("Director"); role `decision_maker \| influencer \| champion \| user \| billing \| other` (check); is_primary; timestamps. PK `(account_id, contact_id)`; index `(contact_id)`.

### 5.5 Catalog

**product_lines**: id; group_id; company_id; key citext (unique per company); name; kind (text, `PRODUCT_KINDS`: group_batch, mentorship_1to1, crash_course, test_series, program, software_test_platform, software_erp, software_other); audience `b2c \| b2b` (from the kind, check); description; position; active; created_by; timestamps. Index `(company_id, position)`.

**products**: id; group_id; company_id; product_line_id → product_lines RESTRICT; code citext (unique per company when set); name; description; attributes jsonb (`productAttributesSchema`, section 9.4); position; active; created_by; timestamps. Indexes `(product_line_id, position)`, `(company_id, position)`.

### 5.6 Pipelines, stages, lost reasons

**pipelines**: id; group_id; company_id; key citext (unique per company); name; kind `b2c \| b2b` (check); is_default (unique per company and kind among non-archived: `pipelines_default_uq`); product_line_ids uuid[] (empty = any product line); position; archived_at; created_by; timestamps.

**pipeline_stages**: id; pipeline_id → pipelines CASCADE; company_id; key citext (unique per pipeline); name; category `open \| won \| lost` (check); position; probability 0–100; sla_hours (> 0 or null = no target); required_fields text[] (deal field keys required to ENTER the stage, section 12); entry_rules jsonb (`{ allowedFrom?: string[] }` stage keys); colour (`#RRGGBB` or null); archived_at; timestamps. Index `(pipeline_id, position)`. A deal's status always equals its stage's category.

**lost_reasons**: id; group_id; company_id; label citext (unique per company); kind `b2c \| b2b \| null` (both); requires_note; position; active; timestamps.

### 5.7 Custom fields

**custom_field_definitions**: id; group_id; company_id; entity `deal \| contact \| account` (check); key citext (unique per company and entity); label; type `text \| textarea \| number \| date \| select \| multiselect \| boolean \| phone \| email \| url` (check); options jsonb `[{ value, label }]` (select types only); required; applies_to (`b2c \| b2b \| null`, deal fields only, check); help; position; active; created_by; timestamps. Index `(company_id, entity, position)`.

Values: `deals.custom`, `contact_companies.custom`, `account_companies.custom`, validated with `validateCustomValues` (section 8).

### 5.8 Deals

**crm_sequences**: company_id + name (PK), value bigint. Deal numbers: `insert … on conflict (company_id, name) do update set value = crm_sequences.value + 1 returning value` with name `deal`.

**deals**:

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid pk | |
| group_id, company_id, unit_id | uuid not null → org_units | ownership (section 4) |
| number | bigint not null | per company (unique `(company_id, number)`) |
| ref | text not null | `SP-1042`, fixed at creation |
| title | text not null | default "<main contact or institute> – <product line or 'Enquiry'>" |
| kind | text not null | `b2c \| b2b` (check) |
| pipeline_id | uuid → pipelines RESTRICT | same company and kind |
| stage_id | uuid → pipeline_stages RESTRICT | stage of that pipeline |
| status | text default `open` | `open \| won \| lost` (check) = stage category |
| product_line_id, product_id | uuid → RESTRICT | optional; same company; product inside the line |
| owner_user_id | uuid → users | must hold `deals.manage` at the unit |
| value_minor | bigint default 0 (≥ 0) | |
| currency | char(3) | ISO code (check `^[A-Z]{3}$`) |
| primary_contact_id | uuid → contacts | the parent (b2c) or main institute contact (b2b) |
| household_id | uuid → households | b2c |
| account_id | uuid → accounts | b2b; check: `primary_contact_id is not null or account_id is not null` |
| channel | text not null | registered channel key |
| first_touch, last_touch | jsonb | `touchSourceSchema`: `{ channel, campaign?, utm?, referrer?, partnerId?, landingUrl?, formId?, adId?, at? }` |
| original_message | jsonb | `originalMessageSchema`: `{ channel, text, subject?, receivedAt, from? }` |
| ai_fields | jsonb default {} | filled by the intake agent later: `{ extracted?: { parentName?, studentName?, grade?, exam?, targetDate?, intent?, language?, city?, timeZone? }, confidence?, model?, extractedAt? }` |
| custom | jsonb default {} | custom deal fields |
| tags | text[] | |
| lost_reason_id | uuid → lost_reasons | required when status = lost (check) |
| lost_note | text | |
| nurture | bool | the lead goes to a nurture flow (phase 9) |
| stage_entered_at | timestamptz | |
| sla_due_at | timestamptz | `stage_entered_at + sla_hours` while open, else null |
| sla_breached_at | timestamptz | set once by the SLA sweep; cleared on every stage change |
| first_reply_due_at | timestamptz | `created_at + deals.firstReplySlaMinutes` for channels with `firstReplySla` |
| first_replied_at | timestamptz | set by `addTimelineEvent` on the first outbound reply |
| first_reply_breached_at | timestamptz | set once by the SLA sweep |
| expected_close_on | date | |
| closed_at | timestamptz | set iff status ≠ open (check) |
| last_activity_at | timestamptz | moved forward by every timeline entry on the deal |
| source_event_id | text | idempotency key of the intake event that created it (unique when set) |
| archived_at | timestamptz | soft delete |
| created_by | uuid → users | |
| created_at, updated_at | timestamptz | |

Indexes (all partial `where archived_at is null` unless noted). Keyset list sorts: `(company_id, updated_at desc, id desc)`, `(group_id, updated_at desc, id desc)`, `(company_id, created_at desc, id desc)`, `(company_id, last_activity_at desc, id desc)`, `(company_id, value_minor desc, id desc)`, `(company_id, coalesce(expected_close_on, 'infinity'), id)`, `(company_id, coalesce(sla_due_at, 'infinity'), id)`, `(company_id, stage_entered_at, id)`. Own and team lists and board columns: `(owner_user_id, updated_at desc, id desc)`, `(unit_id, updated_at desc, id desc)`, `(pipeline_id, stage_id, updated_at desc, id desc)`. Waiting for a first reply: `(company_id, first_reply_due_at) where first_replied_at is null and status = 'open'`. SLA sweep: `(sla_due_at) where open and sla_breached_at is null`, `(first_reply_due_at) where open and first_replied_at is null and first_reply_breached_at is null`. Lookups (not partial): `(primary_contact_id)`, `(account_id)`, `(household_id)`, gin `(tags)`, gin trigram `(title)`. Unique: `(company_id, number)`, `(source_event_id) where not null`.

Sort expressions must match the indexes exactly: `expectedCloseOn` sorts by `coalesce(expected_close_on, 'infinity'::date)` and `slaDueAt` by `coalesce(sla_due_at, 'infinity'::timestamptz)`, with `id` in the same direction.

**deal_contacts**: deal_id → deals CASCADE; contact_id → contacts RESTRICT; role `parent \| student \| guardian \| decision_maker \| influencer \| other` (check); created_at. PK `(deal_id, contact_id)`; index `(contact_id, deal_id)`. The primary contact is always also a `deal_contacts` row. Student participants (b2c) are rows with role `student`.

**deal_stage_history** (append-only, bigint identity): deal_id → deals CASCADE; group_id; company_id; pipeline_id; from_stage_id (null at creation); to_stage_id; from_status; to_status; lost_reason_id; moved_by_user_id; seconds_in_from_stage; moved_at. Indexes `(deal_id, moved_at desc, id desc)`, `(company_id, moved_at desc)` (funnel analytics). One row on creation and one per stage change.

### 5.9 Saved views

**saved_views**: id; group_id; company_id (null for a view at group level); unit_id (where it applies); owner_user_id → users CASCADE; entity (`deals` for now, check); name; visibility `personal \| shared` (check); filters jsonb (`dealFiltersSchema`); sort (a `DEAL_SORTS` value); columns text[] (`dealColumnSchema`); position; timestamps. Indexes `(owner_user_id, entity, position) where personal`, `(unit_id, entity, position) where shared`.

### 5.10 Timeline

**timeline_events** (append-only, millions of rows, no FKs on subjects):

| Column | Type | Notes |
| --- | --- | --- |
| id | bigint generated always as identity pk | API sends it as a string |
| group_id | uuid not null | |
| company_id | uuid | null = a group-level fact about a person (shown wherever the person is visible) |
| unit_id | uuid | the owning unit (deal's unit, or the company link's unit) |
| deal_id, contact_id, account_id | uuid | any combination, at least one (check). Entries on a deal also carry its primary contact and account, so they show on those timelines |
| kind | text not null | `TIMELINE_KINDS`: note, message, call, email, meeting, system, stage_change, task, ai (later phases add kinds; not constrained) |
| channel | text | registered channel key (whatsapp, email, voice_call…) |
| direction | text | `inbound \| outbound \| internal` (check) |
| title | text | ≤ 300 chars |
| body | text | |
| meta | jsonb default {} | kind-specific (section 11.3) |
| actor_type | text default `system` | `user \| system \| ai \| contact` (check) |
| actor_user_id | uuid | |
| source_event_id | text | unique when set: idempotency key (webhook event id, provider message id, `event:<outbox id>`) |
| occurred_at | timestamptz | when it happened (sort key) |
| created_at | timestamptz | when it was recorded |
| edited_at, pinned_at, deleted_at | timestamptz | soft delete: lists filter `deleted_at is null` |

Indexes: `(deal_id, occurred_at desc, id desc) where deal_id is not null`, same for `contact_id` and `account_id`, unique `(source_event_id) where not null`, BRIN `(occurred_at)` for archiving.

**timeline_events_archive**: same columns (`like timeline_events including defaults including constraints`) plus `archived_at`, PK `id` (identity not copied, ids are preserved), the same three subject indexes.

**Partitioning plan** (not done in phase 2; the shape allows it without code changes):
1. Archive first: a monthly job (phase 12) moves entries with `occurred_at < now() - 24 months` (or of deals closed and archived for 12 months) to `timeline_events_archive` in batches with `with moved as (delete … returning *) insert into …archive`. Timeline reads query the hot table and, when a page comes back short and `includeArchive=true`, continue in the archive with the same cursor.
2. Partition when the hot table passes ~50 million rows: recreate `timeline_events` as `partition by range (occurred_at)` with monthly partitions, the PK becoming `(id, occurred_at)`; the unique `source_event_id` index moves to a small side table `timeline_event_keys (source_event_id pk, event_id, occurred_at)` written in the same statement. Subject indexes are created per partition. Detaching old partitions replaces the archive job.

### 5.11 Tasks

**tasks**: id; group_id; company_id; unit_id; title; notes; kind `call \| message \| email \| meeting \| follow_up \| other` (check, default follow_up); priority `low \| normal \| high` (check); status `open \| done \| cancelled` (check); due_at (UTC); reminder_at; reminder_sent_at; assignee_user_id → users; deal_id → deals RESTRICT; contact_id → contacts RESTRICT; account_id → accounts RESTRICT; created_by; completed_at (set iff done, check); completed_by; timestamps.

Indexes: `(assignee_user_id, coalesce(due_at, 'infinity'), id) where open` (My tasks), `(assignee_user_id, completed_at desc, id desc) where done`, `(company_id, coalesce(due_at, 'infinity'), id) where open`, `(company_id, created_at desc, id desc)`, `(unit_id)`, `(created_by)`, `(deal_id, created_at desc)`, `(contact_id, created_at desc)`, `(account_id, created_at desc)` (partial, not null), `(reminder_at) where open and reminder_at is not null and reminder_sent_at is null` (reminder job).

### 5.12 Consents (DPDP Act)

**consents** (append-only history): id; group_id; contact_id → contacts RESTRICT; company_id (null = the whole group); channel `whatsapp \| sms \| email \| voice \| all` (check); purpose `marketing \| transactional \| service` (check); status `granted \| withdrawn` (check); source (`CONSENT_SOURCES`: web_form, checkout, whatsapp, call, email, sms, unsubscribe_link, import, manual); evidence jsonb (form URL, IP, message id, the wording shown); captured_at; captured_by → users; created_at. Index `(contact_id, channel, purpose, captured_at desc)`.

Effective state (`core/crm/consent.js`): for a company, channel and purpose, the latest record (by `captured_at`, then `created_at`) among the company's own records and group-wide ones, matching the channel or `all`. No record = `unknown`. `consentAllows(status, purpose)`: marketing needs `granted`; transactional and service are allowed unless `withdrawn`. `contact_methods.opted_out_at` additionally blocks one number or address for everything (`canContact`).

### 5.13 Search documents

**search_documents**: PK `(entity_type, entity_id)`; entity_type `deal \| contact \| account` (check); group_id; company_id, unit_id, owner_user_id (deals only; null for contacts and accounts, which are group-level and visible through their links); title; subtitle; keywords (normalised phones in every typed form, emails, codes, extra name words; space-separated); tsv (generated: `simple` config, title and keywords weight A, subtitle B); updated_at. Indexes: gin `(tsv)`, gin trigram `(title)`, gin trigram `(keywords)`, `(group_id, entity_type, company_id)`.

### 5.14 List sorts and their indexes

| List | Sort keys (`sort=`) | Index |
| --- | --- | --- |
| GET /deals | `-updatedAt` (default), `updatedAt` | `deals_company_updated_idx` / `deals_group_updated_idx` / `deals_owner_updated_idx` |
| | `-createdAt`, `createdAt` | `deals_company_created_idx` |
| | `-lastActivityAt`, `lastActivityAt` | `deals_company_activity_idx` |
| | `-value`, `value` | `deals_company_value_idx` (sorts by `value_minor` regardless of currency) |
| | `expectedCloseOn`, `-expectedCloseOn` | `deals_company_close_idx` |
| | `slaDueAt`, `-slaDueAt` | `deals_company_sla_idx` |
| | `stageEnteredAt`, `-stageEnteredAt` | `deals_company_stage_entered_idx` |
| GET /contacts | `-updatedAt`, `-createdAt`, `name` | `contacts_group_*_idx` + `EXISTS` on `contact_companies` |
| GET /accounts | `-updatedAt`, `-createdAt`, `name` | `accounts_group_*_idx` + `EXISTS` on `account_companies` |
| GET /households | `name` | `households_group_idx` |
| GET /tasks | `dueAt` (default for open), `-dueAt`, `-createdAt`, `-completedAt` (default for done) | `tasks_assignee_*`, `tasks_company_*` |
| GET /timeline | `occurred_at desc, id desc` (fixed) | `timeline_events_{deal,contact,account}_idx` |

Cursors are opaque (`encodeCursor({ v, id })` from `lib/pagination.js`), carry the sort value of the last row and its id, and are rejected (400 `bad_request`) when they don't decode. A cursor is only valid with the same sort and filters.

## 6. Permissions and default grants

Defined in each `module.js` (already final). `supportsOwn` permissions accept the `:own` suffix. Group owners hold `*`.

| Permission | Own | Meaning |
| --- | --- | --- |
| `contacts.view` | yes | See families, students and institute staff known to a unit |
| `contacts.manage` | yes | Add and edit contacts, households and consent records |
| `contacts.view_pii` | | See phones, emails, dates of birth and addresses (masked otherwise) |
| `contacts.merge` | | Merge duplicates (needed at every company that knows both people) |
| `contacts.privacy` | | Export or erase a person's data on request (needed at every company that knows them) |
| `accounts.view` | yes | See institutes and their people |
| `accounts.manage` | yes | Add and edit institutes and their decision makers |
| `deals.view` | yes | See leads and deals |
| `deals.manage` | yes | Create and edit deals, move stages, win, lose, reopen, manage participants |
| `deals.assign` | | Change a deal's owner |
| `deals.archive` | | Archive (soft delete) and restore deals; see archived deals |
| `deals.share_views` | | Save shared list views for a unit |
| `pipelines.view` / `pipelines.manage` | | See / set up pipelines, stages, stage rules, lost reasons |
| `catalog.view` / `catalog.manage` | | See / set up product lines and products |
| `fields.view` / `fields.manage` | | See / set up custom fields |
| `timeline.write` | | Add notes and log calls, meetings, emails on records the user can see |
| `timeline.moderate` | | Delete other people's notes and logged activities |
| `tasks.view` | yes | See tasks (own: assigned to or created by the user) |
| `tasks.manage` | yes | Create, edit, complete, cancel and reassign tasks |

Search has no permission of its own: results follow the records' visibility.

Default grants (`roleGrants`, applied by `npm run roles:sync`):

| Role | contacts | accounts | deals | pipelines / catalog / fields | timeline | tasks |
| --- | --- | --- | --- | --- | --- | --- |
| group_admin | view, manage, view_pii, merge, privacy | view, manage | view, manage, assign, archive, share_views | view, manage | write, moderate | view, manage |
| company_admin | view, manage, view_pii, merge, privacy | view, manage | view, manage, assign, archive, share_views | view, manage | write, moderate | view, manage |
| manager | view, manage, view_pii, merge | view, manage | view, manage, assign, archive, share_views | view | write, moderate | view, manage |
| counsellor | view, manage, view_pii | none | view:own, manage:own | view | write | view:own, manage:own |
| account_executive | view, manage, view_pii | view, manage | view:own, manage:own | view | write | view:own, manage:own |
| finance | view, view_pii | view | view | view | write | view:own, manage:own |
| marketing | view | view | view | view | none | view:own, manage:own |
| support | view, manage, view_pii | view | view | view | write | view:own, manage:own |
| analyst | view (PII masked) | view | view | view | none | view |

Counsellors and account executives work their own deals but see every contact (and, for account executives, every institute) in their unit, so they can spot duplicates and existing families. Managers and company admins see everything in their unit. Analysts read everything with personal data masked.

## 7. Settings

Declared in `core/crm/settings.js`, listed by the modules (so they show on the Settings screen), read with `crmSetting(unit, definition)`.

| Key | Module | Type, default | Levels | Used by |
| --- | --- | --- | --- | --- |
| `contacts.defaultCountry` | contacts | select of `PHONE_COUNTRIES`, `IN` | group, company | phone normalisation for numbers without +CC |
| `contacts.fuzzyMatchThreshold` | contacts | number 0.2–0.95, `0.5` | group | name check in de-duplication and the duplicates list |
| `deals.firstReplySlaMinutes` | deals | int 1–10080, `30` | group … team | `first_reply_due_at` (read at the deal's unit) |
| `deals.referencePrefix` | deals | `^[A-Z][A-Z0-9]{0,5}$`, `D` | company | deal refs (seed: SP, PV, EX) |
| `deals.nurtureOnLost` | deals | boolean, `true` | group, company | default of `nurture` when losing a deal |

Phase 1 settings also used: `locale.currency` (default deal currency), `locale.timezone` (task "today" when the user has no time zone).

## 8. Shared server helpers (`apps/api/src/core/crm/`)

Signatures are stable; slices may add options. Unit tests live in `apps/api/test/crm/`.

| File | Exports |
| --- | --- |
| `constants.js` | Vocabularies: `CONTACT_KINDS`, `CONTACT_METHOD_KINDS`, `LINK_STATUSES`, `HOUSEHOLD_ROLES`, `ACCOUNT_KINDS`, `ACCOUNT_CONTACT_ROLES`, `DEAL_KINDS`, `DEAL_STATUSES`, `STAGE_CATEGORIES`, `DEAL_CONTACT_ROLES`, `DEAL_SORTS`, `DEAL_COLUMNS`, `TIMELINE_KINDS`, `MANUAL_TIMELINE_KINDS`, `REPLY_KINDS`, `TIMELINE_DIRECTIONS`, `ACTOR_TYPES`, `TASK_STATUSES`, `TASK_PRIORITIES`, `TASK_KINDS`, `SAVED_VIEW_ENTITIES`, `SAVED_VIEW_VISIBILITIES`, `SEARCH_ENTITY_TYPES`, `CONSENT_CHANNELS`, `CONSENT_PURPOSES`, `CONSENT_STATUSES`, `CONSENT_SOURCES`, `CUSTOM_FIELD_ENTITIES`, `CUSTOM_FIELD_TYPES`, `PRODUCT_KINDS`; `productKind(key)`, `accountKind(key)` |
| `channels.js` | `BUILT_IN_CHANNELS`, `CHANNEL_GROUPS`, `assertChannelDefinition`, `listChannels(registry)`, `isKnownChannel(registry, key)`, `channelHasFirstReplySla(registry, key)`. The registry is `req.app.locals.registry` in routes and `registry` in handlers. |
| `normalize.js` | `normalizePhone(input, defaultCountry='IN')` → `{ e164, country, national } \| null` (spaces, dashes, dots, brackets, `tel:`, `+CC`, `00CC`, trunk `0`, 10-digit Indian numbers, `91XXXXXXXXXX`, `(+91)`); `toE164`; `splitE164`; `phoneSearchTokens`; `normalizeEmail`; `emailDomain`; `isFreeEmailDomain`; `normalizeDomain`; `nameTokens`; `normalizeName` (lower-case, accents, punctuation and honorifics removed); `nameSimilarity`; `namesLikelySame(a, b, threshold)` → `true \| false \| null` (null = can't tell); `displayName`; `splitFullName`; `PHONE_COUNTRIES`, `DEFAULT_PHONE_COUNTRY`. No dependencies. |
| `contacts.js` | `findOrCreateContact(trx, input, { req })` (section 5.2); pure parts `normalizeMethods`, `assignPrimaries`, `chooseContactMatch`, `fillBlanks`, `primaryPhoneOf`, `primaryEmailOf`; `UNNAMED_CONTACT`. |
| `timeline.js` | `addTimelineEvent(trx, entry)` → `{ entry, created }`: idempotent on `sourceEventId`; moves `deals.last_activity_at`; the first outbound reply (message, call, email, meeting by a user or the AI) sets `deals.first_replied_at` and emits `deal.first_replied`. `insertTimelineEvents(trx, entries)` (bulk, seeds and imports), `timelineRow`, `isFirstReplyCandidate`, `presentTimelineEntry(row, { actor })`. |
| `search.js` | `upsertSearchDocument(trx, doc)`, `upsertSearchDocuments`, `removeSearchDocument(trx, type, id)`, `refreshSearchDocument(trx, type, id)` / `refreshSearchDocuments(trx, type, ids)` (rebuild from the database, removing docs that should no longer be searchable), `reindexSearch(knex, { entityTypes?, groupId?, batchSize?, onBatch? })`, builders `contactDocument`, `accountDocument`, `dealDocument`, `searchKeywords`. |
| `money.js` | `MAX_VALUE_MINOR`, `isCurrencyCode`, `currencyExponent`, `toMinor(amount, currency)`, `fromMinor`, `formatMoney(minor, currency, locale='en-IN')`, `sumByCurrency(items)`, `minorFromDb` (pg returns bigint as a string). |
| `customFields.js` | `customFieldDefinitionSchema` (POST body minus `companyId`), `valueSchemaFor(definition)`, `applicableDefinitions(definitions, { kind })`, `buildCustomFieldsSchema(definitions, { partial, enforceRequired, kind })`, `validateCustomValues(definitions, values, { existing, enforceRequired, kind, defaultCountry, path })` → merged object to store (null removes a key; 422 paths like `body.custom.grade`), `isFilled`, `customFieldRef(key)` = `custom.<key>`, `customFieldKeyOf(ref)`, `presentCustomFieldDefinition(row)`. |
| `dealFields.js` | `DEAL_REQUIRED_FIELDS` (built-in keys a stage can require, with how each is read), `requiredFieldOptions(customDefinitions)`, `unknownRequiredFields(keys, customDefinitions)`. |
| `pii.js` | `maskPhone`, `maskEmail`, `maskMethodValue`, `presentContactMethod(row, canViewPii)`, `presentContactPii(row, canViewPii)` → `{ primaryPhone, primaryEmail, dateOfBirth, address, piiMasked }`. |
| `consent.js` | `effectiveConsent(records, { companyId, channel, purpose })`, `consentAllows(status, purpose)`, `consentMatrix(records, companyId)`, `loadConsentRecords(contactId, companyId, trx?)`, `canContact({ contactId, companyId, channel, purpose, normalized? }, trx?)`. |
| `schemas.js` | zod pieces: `text`, `requiredText`, `optionalText`, `nullableText`, `keySchema`, `tagSchema`, `tagsSchema`, `colourSchema`, `dateOnlySchema`, `dateTimeSchema`, `currencySchema`, `valueMinorSchema`, `percentSchema`, `idsSchema`, `csvList`, `booleanQuery`, `pageQuery`, `utmSchema`, `touchSourceSchema`, `originalMessageSchema`, `addressSchema`, `studentProfileSchema`, `phoneInputSchema`, `emailInputSchema`, `countryCodeSchema`, `languageSchema`, `contactInputSchema`, `channelKeySchema`, `ownerFilterSchema`, `dealFiltersSchema`, `dealListQuerySchema`, `dealColumnSchema`, `dealSortSchema`, `webUrlSchema`. |
| `settings.js` | Setting definitions (section 7), `crmSetting(unit, definition, trx?)`. |
| `scope.js` | Section 4.2. |

Every write endpoint follows phase 1: validate with zod (`validate()`), then one `db.transaction` that loads and scopes the rows (`forUpdate` where it changes them), writes, calls `writeAudit(trx, req, …)`, `emitEvent(trx, …)`, the timeline entry (section 11) and the search document, then presents the result after commit.

## 9. Endpoints

### 9.0 Conventions

- Everything is under `/api/v1`, behind `requireAuth()`. Bodies and queries are `z.strictObject` unless noted (unknown keys → 422). Schema pieces refer to `core/crm/schemas.js` and `constants.js`; `timeZoneSchema` and `webUrlSchema` come from `lib/schemas.js`.
- Responses: `{ data }`; lists `{ data, nextCursor }` (keyset, `limit` default 50, max 100, unless noted). Small configuration lists (pipelines, products, custom fields, lost reasons) return every row (`{ data }`, capped at 1000) because a company has tens of them.
- Response type names refer to `apps/web/src/lib/crm/types.ts`. Times are ISO 8601 UTC strings, dates `YYYY-MM-DD`, money `{ valueMinor, currency }`, timeline ids strings.
- Errors use `lib/errors.js` (one format): `422 validation_failed` with `details: [{ path, message }]` (paths like `body.contact.phones.0`); `404 not_found` for anything outside the user's scope; `403 forbidden` when the record is visible but the action isn't allowed; `409 conflict` for state conflicts. Phase 2 adds three codes, built with `new AppError(...)`: `404 merged` (`details: { mergedIntoId }`), `409 stage_changed` (`details: { currentStageId }`), `422 stage_rules` (`details: { missing: [{ key, label }], allowedFrom: string[] | null }`).
- "Visible" means section 4. "Manage on X" means the manage permission on that record (own level respected).
- Audit entries carry `entityType` and `entityId` of the main record and `unit: { id: unit_id, root_id: group_id }` of its owning unit (for people and institutes: the link's unit in the acting company). Audit `before`/`after` never contain phone numbers, emails, dates of birth, addresses or message bodies: log the field names (`{ changed: ['primaryPhone'] }`) instead.
- Owner and assignee pickers use `GET /crm/people` (9.4).
- Inside a module, register literal paths (`/deals/stage-counts`, `/deals/bulk`, `/contacts/check`) before `/:id` routes.
- OpenAPI (`docs/platform/OPENAPI.md`, section 4): every route carries `describe({ summary, permission, ... })` from `core/openapi/describe.js` as its first handler, with `status: 201`/`204` and `list: true` where they apply; `test/openapi/app.test.js` fails on a route without a summary. Register routes directly on the router the module receives (no sub-routers: their routes are not recorded). Response schemas in `describe()` are welcome but optional in wave 1; the full OpenAPI pass is wave 2.

### 9.1 Contacts, households, consents (contacts slice)

Body schemas (in `modules/contacts/schemas.js`):

```js
contactCreateBody = contactInputSchema-fields + {                // kind, firstName, lastName, phones, emails, city, countryCode, timeZone, language, studentProfile
  unitId: z.uuid(),                                              // owning unit of the company link
  dateOfBirth: dateOnlySchema.optional(),
  address: addressSchema.optional(),
  ownerUserId: z.uuid().nullable().optional(),                   // default: the creator; must hold contacts.view at unitId
  status: z.enum(LINK_STATUSES).optional(),                      // default 'lead'
  tags: tagsSchema.optional(),
  custom: z.record(z.string(), z.unknown()).optional(),          // the company's custom contact fields (entity 'contact')
  source: touchSourceSchema.optional(),
  household: z.strictObject({ householdId: z.uuid(), role: z.enum(HOUSEHOLD_ROLES), relation: optionalText(40) }).optional(),
  mode: z.enum(['link', 'create']).default('link'),
}                                                                // keep the refine: a name, a phone or an email
contactPatchBody = z.strictObject({
  kind: z.enum(CONTACT_KINDS), firstName: nullableText(80), lastName: nullableText(80),
  dateOfBirth: dateOnlySchema.nullable(), address: addressSchema.nullable(),          // personal data: needs canViewPii
  city: nullableText(80), countryCode: countryCodeSchema.nullable(), timeZone: timeZoneSchema.nullable(), language: languageSchema.nullable(),
  studentProfile: studentProfileSchema with every key .nullable(),                    // merged; null removes a key
}).partial()
linkPatchBody = z.strictObject({
  unitId: z.uuid(), ownerUserId: z.uuid().nullable(), status: z.enum(LINK_STATUSES),
  tags: tagsSchema, custom: z.record(z.string(), z.unknown()), archived: z.boolean(),
}).partial()
methodBody = z.strictObject({ kind: z.enum(CONTACT_METHOD_KINDS), value: z.string().trim().min(3).max(254), label: optionalText(40), isPrimary: z.boolean().default(false) })
methodPatchBody = z.strictObject({ label: nullableText(40), isPrimary: z.literal(true), verified: z.boolean(), optedOut: z.boolean() }).partial()
householdMemberBody = z.strictObject({ contactId: z.uuid(), role: z.enum(HOUSEHOLD_ROLES), relation: optionalText(40), isPrimary: z.boolean().default(false) })
consentBody = z.strictObject({
  companyId: z.uuid().nullable(),                                // null = for the whole group
  channel: z.enum(CONSENT_CHANNELS), purpose: z.enum(CONSENT_PURPOSES), status: z.enum(CONSENT_STATUSES),
  source: z.enum(CONSENT_SOURCES).default('manual'),
  evidence: z.record(z.string().max(40), z.union([z.string().max(2000), z.number(), z.boolean(), z.null()])).default({}),   // at most 20 keys
  capturedAt: dateTimeSchema.optional(),                         // default now; not in the future
})
```

| Method and path | Query / body | Response | Permission and rules | Events · audit |
| --- | --- | --- | --- | --- |
| `GET /contacts` | `unitId`, `q?` (≤100), `kind?` csv, `status?` csv (link status), `owner?` csv (`ownerFilterSchema`), `tag?` csv, `householdId?`, `accountId?`, `includeArchived?` (default false), `sort?` `-updatedAt` (default) \| `-createdAt` \| `name`, `cursor`, `limit` | `Page<ContactListItem>` | `listScope(req, 'contacts.view')`; `whereLinkedInScope` on `contact_companies`; not merged; erased contacts are listed as "Erased contact". `q`: a phone (`normalizePhone`, company default country) or an email → exact `contact_methods (group_id, normalized)`; otherwise `name_normalized` prefix or trigram match. `link` (owner, status, tags) is the link of the working company (null at group scope). `openDealCount`: open, non-archived deals of the person in the visible companies (one grouped query per page). `lastActivityAt`: the newest timeline entry of the person in the visible companies or group-wide (one grouped query per page). PII masked per row (`canViewPiiAt` over the visible link units). | none |
| `GET /contacts/:id` | | `ContactDetail` | `loadVisibleContact`. Methods; visible links; households (visible members only, `hiddenMemberCount`); institutes (`account_contacts` whose account is visible); `deals`: the deals the person takes part in that the viewer may see (`DealSummary`, newest 20); `can`. | none |
| `POST /contacts/check` | `{ unitId, kind?, firstName?, lastName?, phones?, emails? }` | `ContactMatchCheck` | `contacts.manage` at `unitId` (`requireCreateUnit`). The same matching as `findOrCreateContact`, without writing. A match the user can't see returns `match: null, hiddenMatch: true` ("known elsewhere in the group: saving links them"). `candidates`: visible fuzzy duplicates. | none |
| `POST /contacts` | `contactCreateBody` | `ContactCreateResult`: 201 when created, 200 when an existing person was matched or linked | `requireCreateUnit(req, unitId, 'contacts.manage')`; `findOrCreateContact` with the company's default country and name threshold. Then: `dateOfBirth`/`address` only when created (or blank); `status`/`custom`/`tags`/owner only when the link was created; `household` adds a membership (manage the household). | `contact.created` \| `contact.company_linked` \| `contact.updated` (by the helper) · `contact.created` \| `contact.linked` |
| `PATCH /contacts/:id` | `contactPatchBody` | `ContactDetail` | `loadVisibleContact(…, { forUpdate: true })`; `canManage` (403); `dateOfBirth`/`address` need `canViewPii` (403); erased → 409. Recompute `display_name`, `name_normalized`; refresh the contact's and its deals' search documents. | `contact.updated { contactId, changes }` · `contact.updated` |
| `PATCH /contacts/:id/links/:companyId` | `linkPatchBody` | `ContactDetail` | The link must be visible with `contacts.manage` on it (`levelForRecord`). `unitId`: same company, `contacts.manage` there. `ownerUserId` must hold `contacts.view` at the link's unit (422). `custom`: `validateCustomValues(contact definitions, …, { existing })`. | `contact.link_updated { contactId, companyId, changes }` · `contact.link_updated` |
| `POST /contacts/:id/methods` | `methodBody` | `ContactMethod` (201) | `canManage`. Normalise (phones: default country of the first visible link's company); invalid → 422 `body.value`; already on this contact → 409. `isPrimary` replaces the kind's primary; keep `contacts.primary_phone`/`primary_email` in step; refresh search. Masked in the response without `canViewPii`. | `contact.updated { changes: ['methods'] }` · `contact.method_added` |
| `PATCH /contacts/:id/methods/:methodId` | `methodPatchBody` | `ContactMethod` | `canManage`. `verified` sets or clears `verified_at`; `optedOut` sets or clears `opted_out_at`. | `contact.updated` · `contact.method_updated` |
| `DELETE /contacts/:id/methods/:methodId` | | 204 | `canManage`. Deleting a primary promotes the oldest other method of the kind. | `contact.updated` · `contact.method_removed` |
| `GET /contacts/:id/duplicates` | | `ContactDuplicates` | Visible contact. Up to 20 visible candidates (`hiddenCount` for the others): non-merged, non-erased contacts of the group sharing a normalised phone or email (`reasons: phone \| email`), or with `similarity(name_normalized) ≥ contacts.fuzzyMatchThreshold` and the same household, city or a shared number (`reasons: name`), or with a similar name in another household that also has a member named like one of the contact's household members (`reasons: household`: parent + student names, a family entered twice). `score` 0–1. | none |
| `POST /contacts/:id/merge` | `{ sourceId: z.uuid() }` | `ContactDetail` (the kept contact) | Both visible; `canMerge` on both; same group; neither merged nor erased; `sourceId ≠ id` (422). Keeps `:id` and fills its blanks from the source, then moves in one transaction: methods (duplicates dropped), company links (same company: keep the target's, fill blanks, union tags, earliest `first_seen_at`, target custom values win), household and institute memberships, `deal_contacts`, `deals.primary_contact_id`, `tasks.contact_id`, `consents.contact_id`, `timeline_events.contact_id` (and the archive). The source gets `merged_into_id` and `merged_at`; its search document is removed; the target's and the affected deals' documents are refreshed. One group-level `system` timeline entry on the target. | `contact.merged { targetId, sourceId, companyIds }` · `contact.merged` |
| `GET /contacts/:id/export` | | `ContactExport` (JSON, `Content-Disposition: attachment; filename="contact-<id>.json"`) | `canPrivacy`. Unmasked: everything the group holds about the person (contact, methods, links, households, institutes, consents, the deals they take part in, their timeline entries, their tasks). | none · `contact.exported` |
| `POST /contacts/:id/erase` | `{ reason: requiredText(500), confirm: z.literal(true) }` | `ContactDetail` | `canPrivacy`; already erased → 409. Anonymises (DPDP right to erasure): names null, `display_name = 'Erased contact'`, `name_normalized = ''`, primary phone and email, date of birth, address, city and student profile cleared, `erased_at` set; deletes its `contact_methods`, `household_members`, `account_contacts`; on its links `source = null`, `custom = {}`, `tags = {}`; on deals it takes part in `original_message = null`, `ai_fields = {}`, touches reduced to `{ channel, campaign, at }`; on its timeline entries `body = null`, `meta = {}` (keeping `meta.action`), `title = null` except system, stage_change and task entries; consents kept as proof of the person's choices, with `evidence = {}`. Search document removed, deal documents refreshed. A group-level `system` entry "Personal data erased on request". Deals, tasks and stage history stay. | `contact.erased { contactId, companyIds }` · `contact.erased` (meta: reason) |
| `GET /contacts/:id/consents` | | `ContactConsents` | Visible contact. `records`: the records of the visible companies and the group, newest first. `effective`: `consentMatrix` for the group (`companyId: null`) and each visible company. | none |
| `POST /contacts/:id/consents` | `consentBody` | `ConsentRecord` (201) | `canManage`. `companyId` must be one of the decision's `companyIds` (422 `body.companyId`). Group-wide withdrawals need only `canManage`; group-wide grants need `contacts.manage` at the group unit. Append-only: no update or delete. | `consent.recorded { consentId, contactId, companyId, channel, purpose, status, source }` · `consent.recorded` |
| `GET /households` | `unitId`, `q?` (name prefix), `cursor`, `limit` | `Page<HouseholdListItem>` | `listScope(req, 'contacts.view')`: households with at least one member visible through `whereLinkedInScope`; sort `lower(name), id`; only visible members are listed. | none |
| `GET /households/:id` | | `Household` | Visible when any member is visible (else 404). | none |
| `POST /households` | `{ unitId, name: requiredText(120), city: optionalText(80), members: z.array(householdMemberBody).min(1).max(20) }` | `Household` (201) | `contacts.manage` at, above or inside `unitId` (403); `group_id = unit.root_id`; every member visible with `canManage` (422 `body.members.<i>.contactId`); at most one `isPrimary`. | `household.created { householdId, memberIds }` · `household.created` |
| `PATCH /households/:id` | `{ name?, city?, archived?: z.boolean() }` | `Household` | Manage the household. | `household.updated { householdId, changes }` · `household.updated` |
| `POST /households/:id/members` | `householdMemberBody` | `Household` (201) | Manage the household and `canManage` on the contact; already a member → 409. Group-level `system` entry on the contact. | `household.member_added { householdId, contactId, role }` · `household.member_added` |
| `PATCH /households/:id/members/:contactId` | `{ role?, relation?: nullableText(40), isPrimary? }` | `Household` | Manage the household. | `household.member_updated` · `household.member_updated` |
| `DELETE /households/:id/members/:contactId` | | `Household` | Manage the household; removing the last member archives it. Group-level `system` entry on the contact. | `household.member_removed { householdId, contactId }` · `household.member_removed` |

"Manage the household" = `canManage` on at least one of its visible members. Siblings (for the deal page) are the other `student` members of a student's households.

Service exports for wave 2 and later phases (`modules/contacts/service.js`): `mergeContacts(trx, { targetId, sourceId }, { req })`, `eraseContact(trx, contactId, { req, reason })`.

### 9.2 Institutes (accounts slice)

```js
accountProfileSchema = z.strictObject({
  boards: z.array(text(40)).max(10), exams: z.array(text(60)).max(20),
  budgetBand: text(40), decisionTimeline: text(40), notes: text(2000),
}).partial()
accountCreateBody = z.strictObject({
  unitId: z.uuid(), kind: z.enum(ACCOUNT_KINDS keys), name: requiredText(200),
  legalName: optionalText(200), website: webUrlSchema.optional(), phone: optionalText(40), email: optionalText(254),
  city: optionalText(80), state: optionalText(80), countryCode: countryCodeSchema.optional(), address: addressSchema.optional(),
  branchCount: z.number().int().min(0).max(100_000).optional(), studentCount: z.number().int().min(0).max(10_000_000).optional(),
  currentSoftware: optionalText(200), profile: accountProfileSchema.optional(),
  ownerUserId: z.uuid().nullable().optional(), status: z.enum(LINK_STATUSES).optional(), tags: tagsSchema.optional(),
  custom: z.record(z.string(), z.unknown()).optional(), source: touchSourceSchema.optional(),
  contacts: z.array(z.strictObject({
    contactId: z.uuid().optional(), contact: contactInputSchema.optional(),   // exactly one of the two
    title: optionalText(80), role: z.enum(ACCOUNT_CONTACT_ROLES).default('other'), isPrimary: z.boolean().default(false),
  })).max(10).default([]),
  mode: z.enum(['link', 'create']).default('link'),
})
accountPatchBody = the detail fields of accountCreateBody (kind, name, legalName, website, phone, email, city, state,
  countryCode, address, branchCount, studentCount, currentSoftware, profile), all optional, nullable except kind and name
```

| Method and path | Query / body | Response | Permission and rules | Events · audit |
| --- | --- | --- | --- | --- |
| `GET /accounts` | `unitId`, `q?`, `kind?` csv, `status?` csv, `owner?` csv, `tag?` csv, `includeArchived?`, `sort?` `-updatedAt` \| `-createdAt` \| `name`, `cursor`, `limit` | `Page<AccountListItem>` | `listScope(req, 'accounts.view')` + `whereLinkedInScope(…, { linkTable: 'account_companies', foreignKey: 'account_id', idColumn: 'a.id' })`. `q`: a domain or email domain → `domain`; a phone → `primary_phone`; otherwise name prefix or trigram. Phone and email masked without `contacts.view_pii`. `openDealCount` as for contacts. | none |
| `GET /accounts/:id` | | `AccountDetail` | `loadVisibleAccount`. `contacts`: `account_contacts`, each person a `ContactSummary` (masked per the user's PII right at the account's visible units). `openDeals`: visible open deals of the account (`DealSummary[]`, max 20); `closedDeals`: the 10 most recent won or lost deals the viewer may see. | none |
| `POST /accounts` | `accountCreateBody` | `AccountCreateResult`: 201 created, 200 matched | `requireCreateUnit(req, unitId, 'accounts.manage')`. `findOrCreateAccount(trx, input, { req })` (exported from `modules/accounts/service.js` for intake): advisory lock on the domain or normalised name; match in the group by `domain` (from `website`, or `email` unless a free provider, via `normalizeDomain`), else `name_normalized` + lower(city); `mode: 'create'` skips matching; fill blanks on a match (phone and email also match, so `matchedBy` is `domain` \| `email` \| `phone` \| `name` \| `null`). A match in a team the caller can't see answers 409 instead of revealing the record. `profile.gstin` (15 characters) is optional. Ensure the `account_companies` link (owner, status, tags, custom, source only when created). `contacts`: `findOrCreateContact` (kind `staff`, same company and unit), then `account_contacts`. Search document; `system` timeline entry on the account ("Institute added" / "Institute added to this company"). | `account.created` \| `account.company_linked` · `account.created` \| `account.linked` |
| `PATCH /accounts/:id` | `accountPatchBody` | `AccountDetail` | `canManage`; `phone`, `email`, `address` need `canViewPii`; recompute `name_normalized` and `domain`; refresh the account's and its deals' search documents. | `account.updated { accountId, changes }` · `account.updated` |
| `PATCH /accounts/:id/links/:companyId` | `linkPatchBody` (custom entity `account`) | `AccountDetail` | As for contacts, with `accounts.manage`. | `account.link_updated` · `account.link_updated` |
| `POST /accounts/:id/contacts` | `{ contactId? \| contact?, title?, role, isPrimary? }` | `AccountContact` (201) | `canManage` on the account; an existing `contactId` must be visible; a new `contact` goes through `findOrCreateContact` (kind `staff`) in the company of the user's first manageable link. Already linked → 409. One primary per account. `system` entry on the account. | `account.contact_added { accountId, contactId, role }` · `account.contact_added` |
| `PATCH /accounts/:id/contacts/:contactId` | `{ title?: nullableText(80), role?, isPrimary? }` | `AccountContact` | `canManage` on the account. | `account.contact_updated` · `account.contact_updated` |
| `DELETE /accounts/:id/contacts/:contactId` | | 204 | `canManage`; the person stays a contact. `system` entry on the account. | `account.contact_removed` · `account.contact_removed` |

Merging institutes is not in phase 2 (`accounts.merged_into_id` is there for later).

### 9.3 Pipelines, stages, lost reasons (config slice)

```js
stageInput = z.strictObject({
  key: keySchema, name: requiredText(60), category: z.enum(STAGE_CATEGORIES),
  probability: percentSchema.default(0), slaHours: z.number().int().min(1).max(8760).nullable().default(null),
  requiredFields: z.array(z.string().max(80)).max(30).default([]),
  entryRules: z.strictObject({ allowedFrom: z.array(keySchema).max(30) }).partial().default({}),
  colour: colourSchema.nullable().default(null),
})
pipelineCreateBody = z.strictObject({
  companyId: z.uuid(), key: keySchema, name: requiredText(80), kind: z.enum(DEAL_KINDS),
  isDefault: z.boolean().default(false), productLineIds: z.array(z.uuid()).max(50).default([]),
  position: z.number().int().min(0).max(1000).optional(),
  stages: z.array(stageInput).min(3).max(30),
})
```

Validation (422 with paths such as `body.stages.3.requiredFields.1`): stage keys unique; at least one active stage of each category (open, won, lost); `requiredFields` known (`unknownRequiredFields(keys, companyDealFields)`); `allowedFrom` keys exist in the pipeline; product lines belong to the company and match `kind`. `isDefault: true` clears the previous default of that company and kind in the same transaction; a company's first pipeline of a kind becomes the default.

| Method and path | Query / body | Response | Permission and rules | Events · audit |
| --- | --- | --- | --- | --- |
| `GET /pipelines` | `unitId?` \| `companyId?` (exactly one), `kind?`, `includeArchived?` | `Pipeline[]` (stages by position; archived stages only with `includeArchived`) | `pipelines.view`: `companyId` → `requireCompany` (read); `unitId` → `companiesInScope(req, unitId, 'pipelines.view')` (every company at group scope). Sorted by company name, then position. | none |
| `GET /pipelines/required-field-options` | `companyId`, `kind?` (`b2c` \| `b2b`: leaves out deal fields the other kind never has) | `RequiredFieldOption[]` | `pipelines.view`; `requiredFieldOptions(active custom deal fields)`. | none |
| `GET /pipelines/:id` | | `Pipeline` | `pipelines.view` at, above or inside its company (else 404). | none |
| `POST /pipelines` | `pipelineCreateBody` | `Pipeline` (201) | `requireCompany(req, companyId, 'pipelines.manage', { write: true })`; key unique per company (409). | `pipeline.created { pipelineId, companyId, kind }` · `pipeline.created` |
| `PATCH /pipelines/:id` | `{ name?, isDefault?: z.literal(true), productLineIds?, position? }` | `Pipeline` | `pipelines.manage` at the company. Key and kind are fixed. | `pipeline.updated { pipelineId, changes }` · `pipeline.updated` |
| `POST /pipelines/:id/archive` | | `Pipeline` | 409 when it has open, non-archived deals or is the only active pipeline of its kind; a default passes to the next active pipeline of the kind. | `pipeline.archived` · `pipeline.archived` |
| `POST /pipelines/:id/restore` | | `Pipeline` | | `pipeline.restored` · `pipeline.restored` |
| `POST /pipelines/:id/stages` | `stageInput` + `position?` | `Pipeline` (201) | `pipelines.manage`; inserted at `position` (default: before the first won stage), later stages shift. | `pipeline_stage.created { pipelineId, stageId }` · `pipeline_stage.created` |
| `PATCH /pipelines/:id/stages/:stageId` | `stageInput` without `key` and `category`, all optional | `Pipeline` | `pipelines.manage`. A new `slaHours` applies to deals entering the stage from now on. | `pipeline_stage.updated { pipelineId, stageId, changes }` · `pipeline_stage.updated` |
| `PUT /pipelines/:id/stages/order` | `{ stageIds: z.array(z.uuid()).min(3).max(30) }` (every active stage once) | `Pipeline` | `pipelines.manage`; positions become 0..n-1. | `pipeline_stage.reordered { pipelineId }` · `pipeline_stage.reordered` |
| `POST /pipelines/:id/stages/:stageId/archive` | `{ moveToStageId?: z.uuid() }` | `Pipeline` | `pipelines.manage`. The last active stage of its category → 409. With open deals in the stage, `moveToStageId` (an active stage of the same pipeline and category) is required (409): deals move set-based without stage rules, one `deal_stage_history` row and one `stage_change` entry per deal (`insert … select`), `sla_due_at` recomputed; the search handler refreshes the deals of both stages in batches of 500 after the event. The archived key is removed from other stages' `entryRules.allowedFrom`; 409 when that would leave a stage with an empty list. 409 details for stages or pipelines with deals: `{ openDealCount, dealCount? }`. | `pipeline_stage.archived { pipelineId, stageId, moveToStageId, movedDealCount }` · `pipeline_stage.archived` |
| `GET /lost-reasons` | `unitId?` \| `companyId?`, `kind?` (that kind plus shared reasons), `includeInactive?` | `LostReason[]` (by position) | `pipelines.view` | none |
| `POST /lost-reasons` | `{ companyId, label: requiredText(80), kind: z.enum(DEAL_KINDS).nullable().default(null), requiresNote: z.boolean().default(false), position? }` | `LostReason` (201) | `pipelines.manage` at the company; label unique per company (409). | `lost_reason.created` · `lost_reason.created` |
| `PATCH /lost-reasons/:id` | `{ label?, kind?, requiresNote?, position?, active? }` | `LostReason` | `pipelines.manage`. No delete: deactivate (deals keep their reason). | `lost_reason.updated` · `lost_reason.updated` |

### 9.4 Product lines, products, CRM vocabularies and people (config slice, catalog module)

```js
productAttributesSchema = z.strictObject({
  mode: z.enum(['online', 'centre', 'hybrid']), sessions: z.number().int().min(1).max(1000),
  durationWeeks: z.number().int().min(1).max(520), tests: z.number().int().min(1).max(1000),
  exam: text(60), grades: z.array(text(20)).max(20),
  billing: z.enum(['one_time', 'monthly', 'annual', 'per_student_year', 'per_branch_year', 'per_institute_year', 'per_seat_month']),
  addOn: z.boolean(),
}).partial()
productCodeSchema = trimmed, upper-cased, /^[A-Z0-9][A-Z0-9-]{0,29}$/
```

| Method and path | Query / body | Response | Permission and rules | Events · audit |
| --- | --- | --- | --- | --- |
| `GET /crm/vocabularies` | | `CrmVocabularies` | Any signed-in user. Channels from the registry (`listChannels`), the rest from `constants.js` and `dealFields.js`. `Cache-Control: private, max-age=300`. | none |
| `GET /crm/people` | `unitId`, `permission` (one of `deals.manage`, `deals.view`, `tasks.view`, `tasks.manage`, `contacts.view`, `contacts.manage`, `accounts.view`, `accounts.manage`), `q?` | `PersonOption[]` (max 200, by name) | Unit visible; the caller holds any of `deals.view`, `contacts.view`, `tasks.view`, `accounts.view` at, above or inside it (403). `usersWithPermissionAt(unit, permission)`. | none |
| `GET /product-lines` | `unitId?` \| `companyId?`, `includeInactive?` | `ProductLine[]` (with `productCount`) | `catalog.view` (resolved like `GET /pipelines`) | none |
| `POST /product-lines` | `{ companyId, key: keySchema, name: requiredText(80), kind: z.enum(PRODUCT_KINDS keys), description: optionalText(500), position? }` | `ProductLine` (201) | `catalog.manage` at the company; key unique (409); `audience` from the kind. | `product_line.created` · `product_line.created` |
| `PATCH /product-lines/:id` | `{ name?, description?: nullableText(500), position?, active? }` (key and kind fixed) | `ProductLine` | `catalog.manage`. Inactive lines stay on existing deals; new deals can't pick them. | `product_line.updated { productLineId, changes }` · `product_line.updated` |
| `GET /products` | `unitId?` \| `companyId?`, `productLineId?`, `q?`, `includeInactive?` | `Product[]` | `catalog.view` | none |
| `POST /products` | `{ productLineId, code?: productCodeSchema.nullable(), name: requiredText(120), description: optionalText(1000), attributes: productAttributesSchema.default({}), position? }` | `Product` (201) | `catalog.manage` at the line's company; code unique per company (409). | `product.created` · `product.created` |
| `PATCH /products/:id` | `{ productLineId? (same company and audience), code?, name?, description?, attributes?, position?, active? }` | `Product` | `catalog.manage` | `product.updated` · `product.updated` |

### 9.5 Custom fields (config slice, fields module)

| Method and path | Query / body | Response | Permission and rules | Events · audit |
| --- | --- | --- | --- | --- |
| `GET /custom-fields` | `unitId?` \| `companyId?`, `entity?` (`deal` \| `contact` \| `account`), `includeInactive?` | `CustomFieldDefinition[]` (by entity, position) | `fields.view` (resolved like `GET /pipelines`). Deal, contact and institute forms read their company's active definitions here. | none |
| `POST /custom-fields` | `customFieldDefinitionSchema` + `companyId: z.uuid()` | `CustomFieldDefinition` (201) | `fields.manage` at the company; key unique per company and entity (409); at most 100 active fields per entity (409). | `custom_field.created` · `custom_field.created` |
| `PATCH /custom-fields/:id` | `{ label?, options?, required?, appliesTo?, help?, position?, active?, type? }` (entity and key fixed; `type` only while no record stores a value for the field, else 409; option rules as on create) | `CustomFieldDefinition` | `fields.manage`. Deactivating a deal field a stage requires → 409 naming the stages. A removed option keeps stored values (shown raw); new writes must use the remaining options. | `custom_field.updated { definitionId, changes }` · `custom_field.updated` |
| `PUT /custom-fields/order` | `{ companyId, entity, ids: z.array(z.uuid()).min(1).max(200) }` | `CustomFieldDefinition[]` | `fields.manage`; the listed ids come first, other fields keep their relative order after them | `custom_field.reordered` · `custom_field.reordered` |

Values are written by the owners of the records (`deals.custom` by deals, link `custom` by contacts and accounts) through `validateCustomValues(definitions, body.custom, { existing, kind, enforceRequired: true, defaultCountry })`. System writers (intake, imports) pass `enforceRequired: false`.

### 9.6 Deals (deals slice)

```js
dealContactRef = z.union([z.strictObject({ contactId: z.uuid() }), z.strictObject({ contact: contactInputSchema })])
dealFieldsPatch = z.strictObject({
  title: requiredText(200), productLineId: z.uuid().nullable(), productId: z.uuid().nullable(),
  valueMinor: valueMinorSchema, currency: currencySchema, primaryContactId: z.uuid(), householdId: z.uuid().nullable(),
  accountId: z.uuid().nullable(), expectedCloseOn: dateOnlySchema.nullable(), tags: tagsSchema,
  custom: z.record(z.string(), z.unknown()), nurture: z.boolean(), lastTouch: touchSourceSchema,
}).partial()
dealCreateBody = z.strictObject({
  unitId: z.uuid(), kind: z.enum(DEAL_KINDS), title: optionalText(200),
  pipelineId: z.uuid().optional(), stageId: z.uuid().optional(),
  productLineId: z.uuid().nullable().optional(), productId: z.uuid().nullable().optional(),
  ownerUserId: z.uuid().nullable().optional(), valueMinor: valueMinorSchema.optional(), currency: currencySchema.optional(),
  primaryContactId: z.uuid().optional(), contact: contactInputSchema.optional(),    // at most one of the two
  students: z.array(dealContactRef).max(10).optional(),                              // b2c only
  householdId: z.uuid().nullable().optional(), accountId: z.uuid().optional(),       // accountId: b2b only
  channel: channelKeySchema.default('manual'), firstTouch: touchSourceSchema.optional(),
  originalMessage: originalMessageSchema.optional(), expectedCloseOn: dateOnlySchema.nullable().optional(),
  tags: tagsSchema.optional(), custom: z.record(z.string(), z.unknown()).optional(), nurture: z.boolean().optional(),
  sourceEventId: z.string().min(1).max(200).optional(),
})
moveBody = z.strictObject({
  stageId: z.uuid(), fromStageId: z.uuid().optional(),
  lostReasonId: z.uuid().optional(), lostNote: optionalText(1000), nurture: z.boolean().optional(),
  fields: dealFieldsPatch.optional(),                      // fill required fields in the same request
})
bulkBody = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('assign'), ids: idsSchema(200), ownerUserId: z.uuid().nullable() }),
  z.strictObject({ action: z.literal('move'), ids: idsSchema(200), stageId: z.uuid(), lostReasonId: z.uuid().optional(), lostNote: optionalText(1000) }),
  z.strictObject({ action: z.literal('addTags'), ids: idsSchema(200), tags: tagsSchema }),
  z.strictObject({ action: z.literal('removeTags'), ids: idsSchema(200), tags: tagsSchema }),
  z.strictObject({ action: z.literal('setNurture'), ids: idsSchema(200), nurture: z.boolean() }),
  z.strictObject({ action: z.literal('archive'), ids: idsSchema(200) }),
  z.strictObject({ action: z.literal('restore'), ids: idsSchema(200) }),
])
```

Create rules (`createDeal(trx, input, ctx)` in `modules/deals/service.js`, exported for intake and imports; `ctx` is `{ req }` for people or `{ actor: { type: 'system' | 'ai' } }` for system callers, which skip permission checks and `enforceRequired`):

1. `requireCreateUnit(req, unitId, 'deals.manage')`.
2. Pipeline: `pipelineId` (same company and kind, not archived) or the company's default for `kind` (422 `body.pipelineId` when none). Stage: `stageId` (active, in the pipeline) or the first active open stage by position.
3. People: b2c needs `primaryContactId` or `contact` (422 `body.contact`); b2b needs `accountId`, `primaryContactId` or `contact`. `contact` and new students go through `findOrCreateContact` (kind `parent`/`student` for b2c, `staff` for b2b) in the deal's company and unit. Existing ids must be visible people or institutes of the group (422 on the field). The primary contact is also a `deal_contacts` row (`parent` for b2c, `decision_maker` for b2b); students are rows with role `student`.
4. Household (b2c with students): `householdId` if given (it must include the primary contact); else the first household where the primary contact is a parent or guardian; else a new household "<parent's last name, or display name> family" with the parent (primary) and the students. New students join it with role `student`, so siblings end up in one household.
5. Owner: `ownerUserId` or the creator. Users with only `deals.manage:own` can set only themselves (403); picking someone else or `null` (unassigned) needs `deals.assign` at the unit; the owner must hold `deals.manage` at the unit (`userLevelAt`, 422 `body.ownerUserId`).
6. Product line and product: same company, active, audience matches `kind`, product inside the line (422).
7. Value and currency: default 0 and the unit's `locale.currency` setting.
8. Custom: `validateCustomValues(company deal fields, custom, { kind, enforceRequired: true })`.
9. Initial stage rules: `requiredFields` must be filled (422 `stage_rules`); `allowedFrom` is not checked on creation.
10. Number and ref (`crm_sequences` + the `deals.referencePrefix` setting), `first_touch` (default `{ channel, at: now }`), `last_touch = first_touch`, `first_reply_due_at` when `channelHasFirstReplySla` (now + `deals.firstReplySlaMinutes` at the unit), `stage_entered_at`, `sla_due_at`, default title "<primary contact or institute> – <product line or 'Enquiry'>".
11. `sourceEventId`: when a deal with it exists, return that deal (200) and write nothing.
12. Write the `deal_stage_history` row (from null), the timeline entries (section 11), the search document, the event and the audit.

| Method and path | Query / body | Response | Permission and rules | Events · audit |
| --- | --- | --- | --- | --- |
| `GET /deals` | `dealListQuerySchema`: `unitId`, `pipelineId`, `stageId` csv, `status` csv, `kind`, `channel` csv, `owner` csv (`me`, `none`, ids), `productLineId` csv, `tag` csv (any of), `q`, `nurture`, `slaBreached` (open and `sla_due_at < now()`), `firstReplyOverdue` (open, no reply, `first_reply_due_at < now()`), `createdFrom`, `createdTo`, `contactId` (via `deal_contacts`), `accountId`, `householdId`, `archived` (default false; `true` lists only archived and needs `deals.archive` somewhere in scope, else 403), `sort`, `cursor`, `limit` | `Page<DealListItem>` | `listScope(req, 'deals.view')` + `applyListScope`. Unknown channel keys → 422. `q`: a ref (case-insensitive exact), a phone or email (deals whose `deal_contacts` include a contact with that normalised method), otherwise `title ILIKE %q%` (trigram index). Stages, product lines, products, owners, units, primary contacts, accounts and student names are loaded with one query each per page (no N+1). Primary contact PII masked per deal unit. | none |
| `GET /deals/stage-counts` | `dealListQuerySchema` without `stageId`, `status`, `sort`, `cursor`, `limit`; `pipelineId` required | `StageCounts` | As `GET /deals`; one grouped query on `(stage_id, currency)`: count, sum of `value_minor`, count with `sla_due_at < now()`. | none |
| `POST /deals/check-duplicates` | `{ unitId, kind?, contactId?, accountId?, phones?, emails?, firstName?, lastName? }` | `DealDuplicateCheck` | `deals.manage` at `unitId`. Finds the person (as `POST /contacts/check`) or institute, then deals of the unit's company involving them: `openDeals` (visible, open, max 10), `recentlyLost` (visible, lost in the last 180 days, max 5: reopen instead of creating), `hiddenOpenDealCount` (open deals of the company the user can't see). `contact` / `account`: the visible match; `knownElsewhere: true` when the match exists but isn't visible. | none |
| `POST /deals` | `dealCreateBody` | `DealDetail` (201; 200 for a repeated `sourceEventId`) | Create rules above. | `deal.created` (+ `contact.*` from the helper) · `deal.created` |
| `GET /deals/:id` | | `DealDetail` | `loadVisible(req, { table: 'deals', id, permission: 'deals.view', notFound: 'Deal' })`; archived deals only with `deals.archive` (else 404). | none |
| `GET /deals/:id/stage-history` | | `StageHistoryEntry[]` (newest first, max 200) | Visible deal. | none |
| `PATCH /deals/:id` | `dealFieldsPatch` + `unitId?` (another unit of the same company, with `deals.manage` there) | `DealDetail` | `deals.manage` on the deal (own ok); archived → 409. Fields validated as on create; `primaryContactId` must be a participant or is added with the default role; `custom` merged over the stored values. Search document refreshed when the title, people or product line change. | `deal.updated { dealId, companyId, changes }` (+ `deal.unit_changed`) · `deal.updated` |
| `POST /deals/:id/move` | `moveBody` | `DealDetail` | `deals.manage` on the deal; archived → 409. `fromStageId` given and not the current stage → 409 `stage_changed`. Same stage → 200, nothing written. Otherwise apply `fields` (as PATCH), then `evaluateStageMove` (section 12): failure → 422 `stage_rules`. A lost stage needs `lostReasonId` (active, the company's, matching the kind; a note when `requires_note`) and takes `nurture` (default the `deals.nurtureOnLost` setting). Updates stage, status, `stage_entered_at`, `sla_due_at`, `sla_breached_at = null`, `closed_at`, lost fields (cleared when moving to open), the history row, one timeline entry, the search document. | `deal.stage_changed`, plus `deal.won` \| `deal.lost` \| `deal.reopened` when the status changes · `deal.stage_changed` |
| `POST /deals/:id/win` | `{ stageId?: z.uuid(), fields?: dealFieldsPatch }` | `DealDetail` | `move` to `stageId` (a won stage) or the first active won stage. | as move |
| `POST /deals/:id/lose` | `{ stageId?, lostReasonId: z.uuid(), lostNote?: optionalText(1000), nurture?: z.boolean() }` | `DealDetail` | `move` to `stageId` (a lost stage) or the first active lost stage. | as move |
| `POST /deals/:id/reopen` | `{ stageId?: z.uuid() }` | `DealDetail` | Won or lost deals only (409). Target: `stageId` (an open stage), else the open stage the deal left when it closed (stage history), else the first open stage. `allowedFrom` isn't applied; required fields are. Clears `closed_at`, the lost reason and note; `nurture = false`. | `deal.stage_changed` + `deal.reopened` · `deal.reopened` |
| `POST /deals/:id/assign` | `{ ownerUserId: z.uuid().nullable() }` | `DealDetail` | `deals.assign` at the deal's unit; the new owner holds `deals.manage` there (422). No change → 200. | `deal.owner_changed { dealId, companyId, unitId, fromUserId, toUserId }` · `deal.assigned` |
| `POST /deals/:id/archive` | `{ reason?: optionalText(300) }` | `DealDetail` | `deals.archive` at the unit; already archived → 409. Removes the search document. | `deal.archived` · `deal.archived` |
| `POST /deals/:id/restore` | | `DealDetail` | `deals.archive`; restores the search document. | `deal.restored` · `deal.restored` |
| `POST /deals/:id/contacts` | `dealContactRef` and `{ role: z.enum(DEAL_CONTACT_ROLES) }` | `DealDetail` (201) | `deals.manage`; already a participant → 409; new students join the deal's household. | `deal.contact_added { dealId, contactId, role }` · `deal.contact_added` |
| `DELETE /deals/:id/contacts/:contactId` | | `DealDetail` | `deals.manage`; the primary contact can't be removed (409: change it first). | `deal.contact_removed` · `deal.contact_removed` |
| `POST /deals/bulk` | `DealBulkTarget & DealBulkAction`: `{ ids }` or `{ filter: DealBulkFilter }` (up to 1000 matches, else 422), actions as `bulkBody` plus `lose` (`lostReasonId`, `lostNote?`, `nurture?`) | `DealBulkResult` (`updated`, `unchanged`, `failed` with code and reason, `total`) | Route permission: any of `deals.manage`, `deals.assign`, `deals.archive`; the action's permission is then checked per record at its unit. Records go in chunks of 100 per transaction (rows locked), each with the same checks, events, timeline entries and audit as the single endpoint (tags and nurture as PATCH); a chunk whose transaction fails reports all its records as failed. Invisible ids are reported as `not_found`. The same core runs as the background job `deals.bulk` (`modules/deals/jobs.js`: `enqueueJob('deals.bulk', { userId, input }, { track: true, unitId, createdBy })`). | per deal · per deal (meta `{ bulk: true }`) |

SLA sweep (`modules/deals/sla.js`): `sweepSlaBreaches({ db, now = new Date(), limit = 500 })` sets `sla_breached_at = now` on open deals with `sla_due_at < now` and no `sla_breached_at`, and `first_reply_breached_at = now` on open deals with `first_reply_due_at < now`, no reply and no `first_reply_breached_at` (sweep indexes, `for update skip locked`), emitting `deal.sla_breached` / `deal.first_reply_overdue` per deal in the same transaction. It runs every minute as the repeating job `deals.sla_sweep` (`modules/deals/jobs.js`, core/jobs).

### 9.7 Saved views (deals slice)

```js
savedViewBody = z.strictObject({
  unitId: z.uuid(), entity: z.enum(SAVED_VIEW_ENTITIES).default('deals'), name: requiredText(60),
  visibility: z.enum(SAVED_VIEW_VISIBILITIES).default('personal'),
  filters: dealFiltersSchema.default({}), sort: dealSortSchema.default('-updatedAt'),
  columns: z.array(dealColumnSchema).max(30).default([]), position: z.number().int().min(0).max(1000).optional(),
})
```

| Method and path | Query / body | Response | Permission and rules | Events · audit |
| --- | --- | --- | --- | --- |
| `GET /saved-views` | `unitId`, `entity?` (default deals) | `SavedView[]` (personal first, then shared; each by position, name) | Personal: the user's own, any unit. Shared: `unit_id` is the working unit, an ancestor of it or inside it, visible, and the user holds `deals.view` at, above or inside it. | none |
| `POST /saved-views` | `savedViewBody` | `SavedView` (201) | Unit visible with `deals.view` at, above or inside it; shared needs `deals.share_views` at the unit. `company_id = companyOf(unit)` (null at group level). At most 50 personal views per user (409). Filter ids are stored as given; the list re-checks them when it runs. | `saved_view.created` · `saved_view.created` |
| `PATCH /saved-views/:id` | `savedViewBody` without `unitId`, `entity`; all optional | `SavedView` | Personal: the owner. Shared: the owner or `deals.share_views` at its unit. Making it shared needs `deals.share_views`. | `saved_view.updated` · `saved_view.updated` |
| `DELETE /saved-views/:id` | | 204 | As PATCH. | `saved_view.deleted` · `saved_view.deleted` |

The web applies a view by turning `filters` into `GET /deals` parameters (arrays → comma lists) plus `sort`. `owner: ['me']` resolves on the server when the list runs.

### 9.8 Timeline (timeline slice)

```js
timelineListQuery = z.strictObject({
  dealId: z.uuid().optional(), contactId: z.uuid().optional(), accountId: z.uuid().optional(),   // exactly one
  kind: csvList(z.string().regex(/^[a-z][a-z0-9_]{1,39}$/), 20).optional(),
  pinned: booleanQuery.optional(),
  cursor: z.string().max(500).optional(), limit: z.coerce.number().int().min(1).max(100).default(30),
})
timelineCreateBody = z.strictObject({
  dealId: z.uuid().optional(), contactId: z.uuid().optional(), accountId: z.uuid().optional(),    // exactly one
  companyId: z.uuid().optional(),     // contact or account seen in several companies: which one the entry belongs to
  kind: z.enum(MANUAL_TIMELINE_KINDS),
  direction: z.enum(TIMELINE_DIRECTIONS).optional(),   // default: note → internal, others → outbound
  channel: channelKeySchema.nullable().optional(),
  title: optionalText(300), body: z.string().trim().max(20_000).optional(),   // required for notes
  occurredAt: dateTimeSchema.optional(),               // default now; at most 5 minutes ahead
  meta: z.strictObject({
    durationSeconds: z.number().int().min(0).max(86_400),
    outcome: z.enum(['connected', 'no_answer', 'busy', 'voicemail', 'wrong_number', 'left_message']),
    attendees: z.array(text(120)).max(20), subject: text(300),
  }).partial().default({}),
})
```

Which entries a user sees (one query per page):
- **Deal timeline:** the deal is visible (`deals.view`, own respected); every non-deleted entry with `deal_id = :id`.
- **Contact or institute timeline:** the subject is visible (`loadVisibleContact` / `loadVisibleAccount`); its non-deleted entries that (a) have `company_id is null` (group-level facts), or (b) belong to a deal the user can see (join `deals`, `applyUnitFilter` with the user's `deals.view` scope over the whole group), or (c) have no deal and a `unit_id` where the user holds `contacts.view` (institutes: `accounts.view`) at level all, or at level own with `actor_user_id = me`.
- Order `occurred_at desc, id desc`; cursor `{ v: occurred_at, id }`. `pinned=true` returns only pinned entries (max 20, no cursor).

| Method and path | Query / body | Response | Permission and rules | Events · audit |
| --- | --- | --- | --- | --- |
| `GET /timeline/kinds` | | `TimelineKind[]` | Any signed-in user. | none |
| `GET /timeline` | `timelineListQuery` | `Page<TimelineEntry>` | Visibility above; subject not visible → 404; not exactly one subject → 422. Actors and deal refs loaded once per page. `meta.phone`, `meta.email`, `meta.from`, `meta.to` masked without `contacts.view_pii` at the entry's unit. | none |
| `POST /timeline` | `timelineCreateBody` | `TimelineEntry` (201) | Subject visible and `timeline.write` at its unit (a deal's unit; for people and institutes the unit of the link in `companyId`, which must be a visible link company; required when there are several, 422 `body.companyId`). Entries on a deal also store its primary contact and account. Written with `addTimelineEvent` (`actorType: 'user'`), so an outbound call, email, message or meeting logged on a deal counts as the first reply. | `timeline.entry_added { entryId, kind, dealId, contactId, accountId, companyId }` · `timeline.entry_added` (no body) |
| `PATCH /timeline/:id` | `{ title?: nullableText(300), body?: text(20_000), occurredAt?: dateTimeSchema }` | `TimelineEntry` | The author (`actor_user_id = me`), manual kinds only, not deleted (403); sets `edited_at`. | `timeline.entry_edited { entryId }` · `timeline.entry_edited` |
| `POST /timeline/:id/pin`, `POST /timeline/:id/unpin` | | `TimelineEntry` | Entry visible and `timeline.write` at its unit; at most 5 pinned per subject (409). | `timeline.entry_pinned` / `timeline.entry_unpinned` · same |
| `DELETE /timeline/:id` | | 204 | Manual kinds only (system, stage_change, task, ai and inbound messages can't be deleted: 403); the author, or `timeline.moderate` at the entry's unit. Soft delete (`deleted_at`). | `timeline.entry_deleted { entryId }` · `timeline.entry_deleted` |

Timeline event handlers (`modules/timeline/module.js` `eventHandlers`, section 11.2): `deal.sla_breached`, `deal.first_reply_overdue`.

### 9.9 Tasks (timeline slice)

```js
taskBody = z.strictObject({
  unitId: z.uuid().optional(),                         // required unless dealId is given
  dealId: z.uuid().optional(), contactId: z.uuid().optional(), accountId: z.uuid().optional(),
  title: requiredText(200), notes: nullableText(5000).optional(),
  kind: z.enum(TASK_KINDS).default('follow_up'), priority: z.enum(TASK_PRIORITIES).default('normal'),
  dueAt: dateTimeSchema.nullable().optional(), reminderAt: dateTimeSchema.nullable().optional(),   // reminderAt ≤ dueAt
  assigneeUserId: z.uuid().nullable().optional(),       // default: the creator
})
taskListQuery = z.strictObject({
  unitId: z.uuid(),
  assignee: csvList(ownerFilterSchema, 50).optional(),  // default ['me']; 'none' = unassigned
  status: csvList(z.enum(TASK_STATUSES), 3).optional(), // default ['open']
  due: z.enum(['overdue', 'today', 'upcoming', 'none']).optional(),
  dealId: z.uuid().optional(), contactId: z.uuid().optional(), accountId: z.uuid().optional(),
  priority: csvList(z.enum(TASK_PRIORITIES), 3).optional(), q: z.string().trim().min(1).max(100).optional(),
  tz: timeZoneSchema.optional(),                        // for "today": default the user's time zone, else the unit's locale.timezone
  sort: z.enum(['dueAt', '-dueAt', '-createdAt', '-completedAt']).optional(),  // default dueAt (-completedAt when only done)
  ...pageQuery,
})
```

"today" is `[start of today, start of tomorrow)` in `tz`, in UTC; "overdue" is open with `due_at < now()`; "upcoming" is `due_at ≥ start of tomorrow`; "none" is `due_at is null`. `dueAt` sorts by `coalesce(due_at, 'infinity')`, `id`.

| Method and path | Query / body | Response | Permission and rules | Events · audit |
| --- | --- | --- | --- | --- |
| `GET /tasks` | `taskListQuery` | `Page<Task>` | `listScope(req, 'tasks.view')` + `applyListScope(…, { ownerColumns: ['assignee_user_id', 'created_by'] })`. Subjects (deal ref and title, contact name, institute name) and people loaded once per page. | none |
| `GET /tasks/counts` | `unitId`, `assignee?` (default me), `tz?` | `TaskCounts` | As the list; one query with `count(*) filter (where …)`. | none |
| `GET /tasks/:id` | | `Task` | `loadVisible(…, { permission: 'tasks.view', ownerColumns: ['assignee_user_id', 'created_by'] })` | none |
| `POST /tasks` | `taskBody` | `Task` (201) | Unit: the deal's when `dealId` is given (deal visible), else `unitId` (`requireCreateUnit(…, 'tasks.manage')`). A contact or institute must be visible and linked to that company. The assignee must hold `tasks.view` at the unit (422 `body.assigneeUserId`). A `task` timeline entry on the related subject, if any. | `task.created` · `task.created` |
| `PATCH /tasks/:id` | `taskBody` without `unitId`, `dealId`, `contactId`, `accountId`; all optional | `Task` | `tasks.manage` on the task (own: assignee or creator). A new `dueAt` or `reminderAt` resets `reminder_sent_at`. | `task.updated { taskId, changes }` (+ `task.assigned`) · `task.updated` |
| `POST /tasks/:id/complete` | | `Task` | `tasks.manage`; open only (409). Sets `completed_at`, `completed_by`; `task` timeline entry. | `task.completed` · `task.completed` |
| `POST /tasks/:id/reopen` | | `Task` | Done or cancelled only. | `task.reopened` · `task.reopened` |
| `POST /tasks/:id/cancel` | | `Task` | Open only. | `task.cancelled` · `task.cancelled` |

Reminders (`modules/tasks/reminders.js`): `processDueTaskReminders({ db, now = new Date(), limit = 500 })` sets `reminder_sent_at` on open tasks with `reminder_at ≤ now` (`tasks_reminder_idx`, `for update skip locked`) and emits `task.reminder_due` per task. It runs every minute as the repeating job `tasks.reminders` (`modules/tasks/module.js`); notifications consume the event in a later phase.

### 9.10 Search (search slice)

| Method and path | Query / body | Response | Permission and rules | Events · audit |
| --- | --- | --- | --- | --- |
| `GET /search` | `unitId`, `q` (trimmed, 2–100 chars), `types?` csv of `SEARCH_ENTITY_TYPES` (default all), `limit?` 1–20 per type (default 6) | `SearchResponse` | Working unit visible (404). Deals: `applyListScope` on `search_documents` with the `deals.view` scope (owner column `owner_user_id`). Contacts: `whereLinkedInScope` with the `contacts.view` scope (`idColumn: 'sd.entity_id'`). Institutes: the same with `accounts.view` and `account_companies`. Types the user has no view permission for are skipped (no 403). Matching: a phone (`normalizePhone`, the working company's default country) or email → exact token in `keywords`; a ref (`/^[A-Z]{1,6}-\d+$/i`) → `keywords`; otherwise prefix full-text (`to_tsquery('simple', 'priy:* & sha:*')`) or trigram on `title` (`title % q`). Rank: exact keyword match, then `ts_rank`, then `similarity(title, q)`, then `updated_at`. `matchedOn` says why it matched. Results carry no personal data. | none |

Consistency handlers (`modules/search/module.js` `eventHandlers`, idempotent, via `refreshSearchDocuments`): `deal.*` and `contact.*` events refresh their aggregate; `contact.merged` removes the source and refreshes the target; `contact.erased` removes the contact and refreshes its deals; `account.*` refresh the institute; `pipeline_stage.updated` and `pipeline_stage.archived` refresh the deals of that stage, `product_line.updated` the deals of that line (batches of 500 by id). Producers already write documents synchronously; the handlers repair drift and cover set-based changes.

Web links for hits: deal → `/leads/{id}`; contact → `/leads/contacts?contact={id}` (opens the contact drawer); institute → `/accounts/{id}`.

## 10. Response shapes

Every response type is defined once in `apps/web/src/lib/crm/types.ts` (strict TypeScript, no `any`); the server's `present*` functions produce exactly those shapes, in camelCase. Rules shared by all slices:

1. **Reused summaries.** Wherever a record appears inside another, use the summary type, built with the same rules in every slice: `UserRef { id, name }`, `UnitRef { id, name, type }`, `CompanyRef { id, name, code }`, `ContactSummary` (id, kind, displayName, firstName, lastName, city, primaryPhone, primaryEmail, piiMasked, erased), `AccountRef { id, name, kind }`, `DealRef { id, ref, title, status }`, `StageRef { id, key, name, category, colour }`, `ProductLineRef`, `ProductRef`, `LostReasonRef`.
2. **Masking.** `ContactSummary.primaryPhone`/`primaryEmail` and every `ContactMethod.value` go through `core/crm/pii.js` with the viewer's PII right *at the unit the record is seen through* (the deal's unit inside a deal, the visible link units on a contact page). `piiMasked: true` tells the UI to show the masked value with a lock. `ContactMethod.normalized` is null when masked. `dateOfBirth` and `address` are null when masked. Institutes: `primaryPhone`/`primaryEmail` masked the same way. `OriginalMessage.from.phone`/`email` masked the same way (the message text is not masked). Phone and email **custom fields** (`type` phone or email) are masked the same way in `custom` (deals, contact and institute links), and a masked value sent back unchanged on a PATCH is no change. Deal `aiFields` and system-written explanations that quote a matched number or address (intake dedup and routing notes, review messages) have phones and emails masked inside the text; CSV imports show raw rows only to people with `contacts.view_pii` there and to the person who uploaded the file.
3. **Money** is `Money { valueMinor: number, currency: string }`. Totals across currencies are `Money[]` (one per currency), never summed across currencies.
4. **Times** are ISO strings in UTC (`2026-11-05T09:30:00.000Z`); dates `YYYY-MM-DD`; durations in seconds.
5. **`can` flags** tell the UI which actions to offer: `ContactDetail.can { manage, viewPii, merge, privacy }`, `AccountDetail.can { manage, viewPii }`, `DealDetail.can { manage, assign, archive }`, `TimelineEntry { canEdit, canDelete, canPin }`, `Task.can { manage }`, `SavedView.can { edit }`, `Household.can { manage }`. The server enforces them again on every write.
6. **Custom values** are `CustomValues = Record<string, CustomValue>` keyed by field key; `CustomValue = string | number | boolean | string[] | null`.
7. **Configuration** responses (`Pipeline`, `Stage`, `LostReason`, `ProductLine`, `Product`, `CustomFieldDefinition`) always carry `companyId`, so lists across companies can be grouped.
8. **Lists** are `Page<T> { data: T[], nextCursor: string | null }` (from `lib/types.ts`).

Type names per endpoint are given in section 9. The integrator checks `types.ts` against the presenters when merging.

## 11. Events, timeline entries and audit

Every change emits one domain event through the outbox (`emitEvent`), in the transaction that makes the change, with `groupId`, `unitId` (the record's owning unit; for group-level people the acting link's unit), `aggregateType`, `aggregateId`, `actorUserId` and the payload below. Payload ids are strings; times ISO strings.

### 11.1 Timeline rule: one writer per event

**Producers write their own timeline entries synchronously** with `addTimelineEvent(trx, …)` in the same transaction. The timeline module's event handlers write entries **only** for events emitted by background sweeps (11.2), using `sourceEventId: 'event:<outbox id>'` so a retried job writes nothing twice. No other handler writes timeline entries for the events below. Later phases follow the same rule: a webhook handler (messages, calls, meetings, payments) writes its entry with the provider's event id as `sourceEventId`.

### 11.2 Events

| Event | Payload | Timeline entry (kind · title) | Written by |
| --- | --- | --- | --- |
| `deal.created` | `dealId, companyId, unitId, pipelineId, stageId, kind, channel, ownerUserId, primaryContactId, accountId, productLineId, valueMinor, currency, sourceEventId` | `system` · "Lead created" (`meta.action = 'deal.created', channel, ref`); plus, when `originalMessage` is given, the message itself (kind from the channel: message/email/call, `direction: 'inbound'`, `actorType: 'contact'`, `meta.original = true`) | deals service |
| `deal.updated` | `dealId, companyId, changes: string[]` | `system` · "Value changed to ₹55,000" etc., only for `valueMinor`/`currency`, `productLineId`, `productId`, `expectedCloseOn`, `primaryContactId`, `accountId` (`meta.changes: { field: { from, to } }`); other edits are audit only | deals service |
| `deal.unit_changed` | `dealId, companyId, fromUnitId, toUnitId` | `system` · "Moved to SAT admissions" | deals service |
| `deal.stage_changed` | `dealId, companyId, unitId, pipelineId, fromStageId, toStageId, fromStatus, toStatus, secondsInFromStage, lostReasonId` | `stage_change` · "Moved to Demo booked" / "Won: Enrolled" / "Lost: Fee too high" / "Reopened in Contacted" (`meta: { fromStageId, toStageId, fromStatus, toStatus, lostReasonId, lostNote }`). **One entry per move**; the status events below add none. | deals service (also the config slice when archiving a stage moves deals) |
| `deal.won` | `dealId, companyId, stageId, valueMinor, currency, productLineId, productId, ownerUserId` | none (covered by `stage_change`) | deals service |
| `deal.lost` | `dealId, companyId, stageId, lostReasonId, nurture` | none | deals service |
| `deal.reopened` | `dealId, companyId, stageId, previousStatus` | none | deals service |
| `deal.owner_changed` | `dealId, companyId, unitId, fromUserId, toUserId` | `system` · "Assigned to Ritika Rao" / "Unassigned" | deals service |
| `deal.archived` / `deal.restored` | `dealId, companyId, reason?` | `system` · "Archived" / "Restored" | deals service |
| `deal.contact_added` / `deal.contact_removed` | `dealId, companyId, contactId, role` | `system` · "Aarav Shah added as student" | deals service |
| `deal.first_replied` | `dealId, companyId, timelineEventId, repliedAt, dueAt` | none (the reply is the entry) | `core/crm/timeline.js` |
| `deal.sla_breached` | `dealId, companyId, unitId, stageId, dueAt, ownerUserId` | `system` · "Stage SLA missed" (`meta.action`, `dueAt`) | **timeline module handler** |
| `deal.first_reply_overdue` | `dealId, companyId, unitId, channel, dueAt, ownerUserId` | `system` · "First reply overdue" | **timeline module handler** |
| `contact.created` | `contactId, companyId, unitId, kind, matchedBy: null, source: { channel } \| null` | `system` · "Contact added" (company-level) | `findOrCreateContact` |
| `contact.company_linked` | `contactId, companyId, unitId, kind, matchedBy, source` | `system` · "Contact added to this company" | `findOrCreateContact` |
| `contact.updated` | `contactId, companyId?, changes: string[]` | none | `findOrCreateContact`, contacts service |
| `contact.link_updated` | `contactId, companyId, changes` | none | contacts service |
| `contact.merged` | `targetId, sourceId, companyIds` | `system` · "Merged with Priya S." (group-level, on the target) | contacts service |
| `contact.erased` | `contactId, companyIds` | `system` · "Personal data erased on request" (group-level) | contacts service |
| `household.created` / `household.updated` | `householdId, memberIds \| changes` | none | contacts service |
| `household.member_added` / `household.member_removed` / `household.member_updated` | `householdId, contactId, role` | `system` · "Added to the Sharma family" (group-level, on the contact) for added and removed | contacts service |
| `consent.recorded` | `consentId, contactId, companyId, channel, purpose, status, source` | `system` · "WhatsApp marketing consent withdrawn" (company-level, or group-level for group-wide records) | contacts service |
| `account.created` / `account.company_linked` | `accountId, companyId, unitId, kind, matchedBy` | `system` · "Institute added" / "Institute added to this company" | accounts service |
| `account.updated` / `account.link_updated` | `accountId, companyId?, changes` | none | accounts service |
| `account.contact_added` / `account.contact_removed` / `account.contact_updated` | `accountId, contactId, role` | `system` · "Ravi Kumar added as decision maker" (added and removed) | accounts service |
| `pipeline.created` / `.updated` / `.archived` / `.restored` | `pipelineId, companyId, kind?, changes?` | none | config |
| `pipeline_stage.created` / `.updated` / `.reordered` / `.archived` | `pipelineId, stageId?, changes?, moveToStageId?, movedDealCount?` | none (archiving with moves writes `stage_change` entries per moved deal) | config |
| `lost_reason.created` / `.updated`, `product_line.created` / `.updated`, `product.created` / `.updated`, `custom_field.created` / `.updated` / `.reordered` | `<entity>Id, companyId, changes?` | none | config |
| `saved_view.created` / `.updated` / `.deleted` | `savedViewId, visibility, unitId` | none | deals service |
| `task.created` | `taskId, companyId, unitId, assigneeUserId, dueAt, dealId, contactId, accountId` | `task` · "Task: Call back about batch timings" (on the related subject; none without one) | tasks service |
| `task.updated` / `task.assigned` | `taskId, changes` / `taskId, fromUserId, toUserId` | none | tasks service |
| `task.completed` | `taskId, companyId, completedBy, dealId, contactId, accountId` | `task` · "Completed: Call back about batch timings" | tasks service |
| `task.reopened` / `task.cancelled` | `taskId` | none | tasks service |
| `task.reminder_due` | `taskId, assigneeUserId, dueAt` | none | reminders job |
| `timeline.entry_added` / `.entry_edited` / `.entry_pinned` / `.entry_unpinned` / `.entry_deleted` | `entryId, kind, dealId, contactId, accountId, companyId` | none (it is the entry) | timeline service |

Event handlers must be idempotent (jobs retry). The search module subscribes to `deal.*`, `contact.*`, `account.*`, `pipeline_stage.updated`, `pipeline_stage.archived`, `product_line.updated` (section 9.10).

### 11.3 Timeline kinds and `meta`

| Kind | Typical writer | `meta` keys |
| --- | --- | --- |
| `note` | people (POST /timeline) | none |
| `message` | people (logged), messaging (phase 5), intake | `templateKey?`, `providerMessageId?`, `original?` |
| `call` | people (logged), calling integration | `durationSeconds?`, `outcome?`, `recordingFileId?` (later) |
| `email` | people (logged), email integration | `subject?`, `providerMessageId?` |
| `meeting` | people (logged), scheduling (phase 6) | `durationSeconds?`, `attendees?`, `bookingId?` |
| `system` | producers in 11.2 | `action` (the event type), plus details (`channel`, `ref`, `changes`, `dueAt`) |
| `stage_change` | deals | `fromStageId, toStageId, fromStatus, toStatus, lostReasonId?, lostNote?` |
| `task` | tasks | `action` (`task.created` \| `task.completed`), `taskId`, `dueAt?` |
| `ai` | AI agents (phase 9) | `agent`, `confidence?`, `model?` |

Later phases add kinds (`booking`, `payment`, `document`…) to `TIMELINE_KINDS`; the column isn't constrained.

### 11.4 Audit actions

Written with `writeAudit` next to every event; names are listed in section 9 per endpoint. Phase 2 actions: `contact.created`, `contact.linked`, `contact.updated`, `contact.link_updated`, `contact.method_added`, `contact.method_updated`, `contact.method_removed`, `contact.merged`, `contact.exported`, `contact.erased`, `consent.recorded`, `household.created`, `household.updated`, `household.member_added`, `household.member_updated`, `household.member_removed`, `account.created`, `account.linked`, `account.updated`, `account.link_updated`, `account.contact_added`, `account.contact_updated`, `account.contact_removed`, `pipeline.created`, `pipeline.updated`, `pipeline.archived`, `pipeline.restored`, `pipeline_stage.created`, `pipeline_stage.updated`, `pipeline_stage.reordered`, `pipeline_stage.archived`, `lost_reason.created`, `lost_reason.updated`, `product_line.created`, `product_line.updated`, `product.created`, `product.updated`, `custom_field.created`, `custom_field.updated`, `custom_field.reordered`, `deal.created`, `deal.updated`, `deal.stage_changed`, `deal.reopened`, `deal.assigned`, `deal.archived`, `deal.restored`, `deal.contact_added`, `deal.contact_removed`, `saved_view.created`, `saved_view.updated`, `saved_view.deleted`, `timeline.entry_added`, `timeline.entry_edited`, `timeline.entry_pinned`, `timeline.entry_unpinned`, `timeline.entry_deleted`, `task.created`, `task.updated`, `task.completed`, `task.reopened`, `task.cancelled`. The Audit log screen shows them without changes (it lists actions as text).

## 12. Stage rules and SLAs

### 12.1 The evaluator (`modules/deals/stageRules.js`, deals slice)

A pure function, unit-tested, used by move, win, lose, reopen, bulk move and create:

```js
/**
 * @param {{
 *   deal: { kind, stage_id, status, product_line_id, product_id, owner_user_id, value_minor, expected_close_on,
 *           primary_contact_id, household_id, account_id, custom },      // after applying the request's `fields`
 *   fromStage: Stage | null,          // null on creation
 *   toStage: Stage,                   // rows of pipeline_stages
 *   pipelineStages: Stage[],          // every stage of the pipeline (for keys)
 *   facts: { studentCount: number, contactHasPhone: boolean, contactHasEmail: boolean },
 *   customDefinitions: CustomFieldDefinitionRow[],     // the company's deal fields (labels, active)
 *   mode: 'create' | 'move' | 'reopen',
 * }} input
 * @returns {{ ok: boolean, missing: Array<{ key: string, label: string }>, allowedFrom: string[] | null,
 *             reason: null | 'other_pipeline' | 'archived_stage' | 'not_allowed_from' | 'missing_fields' }}
 */
export function evaluateStageMove(input)
```

Rules, in order:
1. `toStage.pipeline_id` must be the deal's pipeline (`other_pipeline`) and not archived (`archived_stage`).
2. `entry_rules.allowedFrom` (stage keys): when non-empty and `mode === 'move'`, `fromStage.key` must be in it (`not_allowed_from`; `allowedFrom` returned for the message "Enrolled can only be reached from Demo done or Fee proposed"). Not applied on create or reopen.
3. `required_fields`: every key must be filled (`missing_fields`, each with its label). Built-in keys per `DEAL_REQUIRED_FIELDS`: `productLineId`, `productId`, `ownerUserId`, `expectedCloseOn`, `primaryContactId`, `householdId`, `accountId` (column set), `valueMinor` (> 0), `students` (`studentCount > 0`), `contactPhone`, `contactEmail` (facts). `custom.<key>`: `isFilled(deal.custom[key])`; a key whose definition is inactive or missing is ignored (it can't be filled). Required fields of stages the deal skips are not checked.
4. Lost reason requirements are checked by the service (not the evaluator).

The service turns a failure into `422 stage_rules` with `details: { missing, allowedFrom }` and a message such as "Fill Product and Value to move to Fee proposed".

### 12.2 SLA fields

- `sla_due_at = stage_entered_at + stage.sla_hours` when the deal is open and the stage has an SLA, else null; recomputed on every stage change, with `sla_breached_at = null`.
- `first_reply_due_at = created_at + deals.firstReplySlaMinutes` (read at the deal's unit) when the channel has `firstReplySla`; `first_replied_at` set by the first reply (section 8, `timeline.js`).
- "Breached" in lists is computed live (`sla_due_at < now()`); `sla_breached_at` and `first_reply_breached_at` only make the sweep's events happen once.
- The web shows "Due in 3 h", "2 h overdue" (amber within 25% of the SLA, red when overdue) from these fields.

## 13. Scale

Targets: 1 lakh+ deals per company, millions of timeline entries, design for 10x.

- Every list is keyset-paginated with an index matching its sort (section 5.14); never `OFFSET`; never `count(*)` over a whole list (stage counts are grouped by stage on the board only).
- Scope filters are `company_id = ?` (leading column of the deal indexes) plus `unit_id IN (…)` with tens of ids at most. Own-scope lists add `owner_user_id = ?` (`deals_owner_updated_idx`).
- Pages load related rows with one `whereIn` query per relation (stages, people, units, contacts), never per row.
- Contact and institute lists drive from the group-level sort index with an `EXISTS` on the link table (`(company_id, unit_id)` index). If QA finds slow pages for small companies in a large group, add `contact_companies (company_id, updated_at desc)` and sort by the link's `updated_at` (contract change).
- Exact phone and email lookups hit `contact_methods_lookup_idx`; name search uses trigram GIN indexes; global search hits one table.
- Timeline reads use `(subject, occurred_at desc, id desc)` partial indexes; archiving and partitioning follow section 5.10.
- Remote Postgres in development (100–300 ms per query): keep handlers to a handful of queries; use `Promise.all` for independent reads outside transactions.

## 14. Seed data (`apps/api/src/db/seeds/02_crm.js`)

Idempotent: it does nothing when the Phoenix group already has pipelines (run `npm run db:rollback` then `db:migrate` and `db:seed` to rebuild the CRM tables only). Deterministic (fixed random seed).

- **Excel admin**: adds `admin.excel@phoenix.test` (company admin of Excel, password `Phoenix@12345`) so Excel's leads have an owner who works there. Pi Vector's profile gains the `b2b` business line.
- **Per company** (prefixes SP, PV, EX): product lines and products (SatnPaper: SAT batches, 1:1 mentorship, crash course, test series, US admissions program, TestHub and Campus ERP software; Pi Vector: JEE batches, mentorship, crash course, test series, Olympiad, Test Engine and Coaching ERP; Excel: board batches, NEET crash course and test series, tutoring, foundation); the B2C **Admissions** pipeline (New enquiry 4 h SLA > Contacted 48 h > Demo booked 72 h, requires product line, a student and `custom.grade` > Demo done 48 h > Fee proposed 120 h, requires product and value > Enrolled (won, from Demo done or Fee proposed) > Lost); the B2B **Software sales** pipeline for SatnPaper and Pi Vector (New > Qualified (requires institute and `custom.student_count`) > Discovery call > Product demo (requires product line) > Trial (14 days) > Quote sent (requires product and value) > Negotiation > Contract signed (won, from Quote sent or Negotiation; requires product, value and expected close date) > Lost); lost reasons for each; custom fields (deal: grade, target exam, school board, preferred mode, batch timing, target score, and for B2B student count, branches, current software, decision timeline, budget; contact: how they heard of us, referred by; institute: current software renews on).
- **People**: about 80 families (parents and students in households, siblings), about 15 institutes with 2–3 staff each (decision makers), some families and institutes known to two companies. Plausible Indian names, phone numbers in the fake range `+91 90000 0xxxx`, emails `@example.com`.
- **Deals**: about 200 across companies, stages, owners and every channel, with first and last touch (campaigns, UTM), original messages, AI fields on some, values in INR (a few USD), lost reasons, nurture flags, SLA and first-reply timestamps (some overdue), stage history, timeline entries (created, inbound message, replies, notes, calls, stage changes) and tasks (some overdue, some done). Owners: kabir and ritika for SatnPaper B2C (SAT admissions team), sales.satnpaper for SatnPaper B2B, the company admins for Pi Vector and Excel.
- **Consents** for most people, a few withdrawals (and opted-out WhatsApp numbers); four **saved views** on SatnPaper (three shared: "New WhatsApp enquiries", "Past the stage SLA", "Waiting for a first reply"; one personal for Ritika: "My booked demos"); **search documents** for everything.

Useful seeded checks: ritika sees only her own SatnPaper B2C deals but every SatnPaper › Online › SAT admissions contact; kabir sees all deals of SatnPaper › Online; admin.pivector sees nothing of SatnPaper (404); the group owner sees everything; an analyst (none seeded) would see masked PII.

## 15. Web groundwork

### 15.1 Navigation (`apps/web/src/lib/nav.ts`)

Sidebar order: Home; **Work**: My tasks (`/tasks`, `tasks.view`), Leads (`/leads`, `deals.view` or `contacts.view`), Pipeline (`/pipeline`, `deals.view`), Bookings (Soon, phase 6), Accounts (`/accounts`, `accounts.view`); **Money**: Fees and billing (Soon, 7), Subscriptions (Soon, 7); **Delivery**: Enrollments (Soon, 8), Onboarding (Soon, 8); **Grow**: Automations (Soon, 9), Partners (Soon, 10), Analytics (Soon, 11); **Admin**: Settings. Phase 1's Inbox and Integrations placeholders are gone (the inbox becomes the deal timeline; integrations live under Settings in phase 3).

Settings tabs added: Pipelines (`/settings/pipelines`, `pipelines.manage` anywhere in scope), Products (`/settings/products`, `catalog.manage`), Custom fields (`/settings/fields`, `fields.manage`).

### 15.2 Routes and stubs

Stub pages exist (PageHeader + "Being built in this phase"); each slice replaces its own:

| Route | Owner | Notes |
| --- | --- | --- |
| `/tasks` | timeline | My tasks: tabs Overdue, Today, Upcoming, No date, Done; counts from `GET /tasks/counts` |
| `/leads` | deals | Leads list with channel filters, saved views, bulk actions, side preview (original message, AI fields, one-click actions) |
| `/leads/contacts` | contacts | Contacts list and the contact drawer (`?contact=<id>` opens it) |
| `/leads/[id]` | wave 2 | Deal profile |
| `/pipeline` | wave 2 | Board and table per pipeline |
| `/accounts`, `/accounts/[id]` | accounts | Institutes list and profile |
| `/settings/pipelines`, `/settings/products`, `/settings/fields` | config | Company configuration |

`app/(app)/leads/layout.tsx` renders the "Leads" page header with **Leads** and **Contacts** tabs on `/leads` and `/leads/contacts`, and nothing around `/leads/[id]` (the profile has its own header). Pages under it render only their content (toolbar, list). `components/search/CommandPalette.tsx` is mounted once in `app/(app)/layout.tsx`; the search slice replaces the stub (Ctrl/Cmd+K opens it; it must render nothing until opened).

### 15.3 Types, query keys, styles

- `lib/crm/types.ts`: every request and response type of section 9. Slices import from it and add missing details there in their own change (the integrator merges).
- `lib/crm/keys.ts`: TanStack Query keys for every CRM module, so mutations in one slice can refresh another's lists without importing its code: e.g. a deal move invalidates `crmKeys.deals.all`, `crmKeys.timeline.subject('deal', id)` and `crmKeys.tasks.all`; a contact edit invalidates `crmKeys.contacts.all` and `crmKeys.deals.all` (deals show contact names). Mutations refresh exactly the keys they affect.
- Formatting (money, phone display, relative times, SLA labels) and shared UI (badges, stage bubbles, owner avatars, PII-masked values, empty and error states) come from the CRM kit (`components/crm/`, `lib/crm/format.ts`, another engineer). Until it lands, use `components/ui.tsx` and keep formatting inside your own folder.
- Styles: a CSS file next to your page or component, classes prefixed by your area (`contacts-`, `deals-`, `tasks-`, `timeline-`, `config-`, `accounts-`, `search-`), built on the variables in `app/globals.css`. Works at 390 px; WCAG AA; keyboard reachable; visible focus.
- Every query sends `unitId = scope.id` from `useSession()`; config queries send `companyId` when a company is chosen, or `unitId` for "all companies".

## 16. Definition of done (every slice)

1. Endpoints exactly as section 9 (paths, schemas, response types, permissions, errors, events, audit), with `types.ts` matching the presenters, and a `describe({ summary, permission })` on every route (9.0).
2. Unit tests for pure logic (`test/<area>/`), integration tests in `test/integration/<area>.test.js` (skipped unless `INTEGRATION=1`, in-process app, unique names per run, rate-limit keys cleaned like `api.test.js`) that prove scoping as different seeded users: the group owner; `admin.pivector` against SatnPaper records (404); `ritika` (own deals and tasks only; sees SAT admissions contacts); `kabir` (all of SatnPaper › Online); PII masking for a user without `contacts.view_pii` (create a temporary analyst assignment in the test and remove it after).
3. No N+1 on lists; indexes used by every filter and sort (check `explain` on the seeded data for the main list).
4. Every write: one transaction with audit, event, timeline entry (where 11.2 says so) and search document (where it applies).
5. Web: loading, empty and error states; keyboard use; screenshots as the owner, a company admin and a counsellor, and at 390 px width.
6. `npm test`, `INTEGRATION=1 npm test`, `npm run typecheck` and `next build --webpack` pass. Report contract changes, shared files touched and anything not done.

## 17. Changes agreed at the wave-1 integration

The slices reported these additions; the integrator accepted them, and section 9 above and `apps/web/src/lib/crm/types.ts` follow them.

- **Contacts (9.1):** `ContactListItem.lastActivityAt`, `ContactDetail.deals` (visible deals, newest 20, `DealSummary`), `DuplicateCandidate.reasons` adds `household`. The contact drawer shows the person's timeline (`<Timeline subject={{ contactId }} />`).
- **Institutes (9.2):** `AccountDetail.closedDeals`, `AccountCreateResult.matchedBy` widened to `domain | email | phone | name | null`, optional `profile.gstin`, 409 when the dedup match is in a team the caller can't see. Migration `20261106001200_accounts.js` adds the dedup and filter indexes. Intake and CSV import call `findOrCreateAccount(trx, input, { req })`. The institute page's Activity section is the shared timeline.
- **Config (9.3–9.5):** `PATCH /custom-fields/:id` accepts `type` while the field has no values; `GET /pipelines/required-field-options?kind=`; stage archive cleans `allowedFrom`; `PUT /custom-fields/order` keeps unlisted fields after the listed ones; 409 details `DealCountConflictDetails`.
- **Deals (9.6):** column `deals.owner_seen_at` and `POST /deals/:id/seen` (204, `deals.view`; only the current owner's visit counts; cleared when the owner changes). "New" means open, not archived, created in the last 7 days and not yet opened by the owner. `GET /deals` adds sort `title` / `-title` (keyset on `lower(title), id`) and filters `sla=breached|due_soon`, `campaign`, `source`, `updatedFrom` and `updatedTo` (`LIST_SORTS` in `modules/deals/schemas.js`). `DealListItem` adds `slaDueSoon`, `firstReplyDueSoon` and `isNew` (due soon means less than 25 % of the window is left). Bulk: see the `POST /deals/bulk` row. Background jobs: `deals.bulk` and `deals.sla_sweep`.
- **Timeline and tasks (9.8–9.9):** `TimelineEvent.archived` and `TimelineListFilters`. `GET /tasks` adds `due=later_today`, `related=deal|contact|account|none`, `companyId` and `completedAfter`; `GET /tasks/counts` returns `laterToday`, `timeZone`, `startOfToday` and `startOfTomorrow`. Migration `20261106001500_timeline.js` adds the pinned partial indexes. Background job: `tasks.reminders`. Only entries with `actor_type = 'user'` can be deleted, even with `timeline.moderate`.
- **Search (9.10):** ranking is exact keyword match, then `similarity(title, q)`, then `ts_rank`, then `updated_at` (one `ORDER BY` in `modules/search/query.js`). `SearchHit` adds `snippet`, `company`, `status`, `value`, `owner`, `contactPoint` (the primary phone or email, masked without `contacts.view_pii`) and `piiMasked`; this replaces "results carry no personal data". `search_documents.words_tsv` (migration `20261106001600_search.js`) holds the words without phone and email lexemes, which match only exactly through the keyword index. After migrating an existing database, run `npm run search:reindex -w @phoenix/api`.
- **Seed:** `02_crm.js` now fills the `{student}`-style placeholders in seeded messages, and younger siblings get a school grade (up to 10) instead of "Gap year"; both regexes had lost their backslashes. Databases seeded earlier keep the old values until they are reseeded.
