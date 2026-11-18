# Delivery: enrollments, batches, onboarding and renewals

Architecture phase 8 (the brief's phase 6, admissions and delivery). Code: `apps/api/src/modules/delivery/`, migration `20261107000600_delivery.js`, seed `35_delivery.js`, web `apps/web/src/{lib,components}/delivery/`, `app/(app)/enrollments`, `app/(app)/onboarding`, `app/(app)/settings/onboarding`, `app/checkout/[company]`.

## 1. Summary

- A family's first payment (or a paid website checkout) creates the **enrollment** once, however often the event arrives; the student gets a **seat** in a batch or a place on its **waitlist** (first come, first served), the company's **onboarding checklist** starts, and `enrollment.created` is emitted (messaging sends the welcome through automations).
- **Pause** keeps the seat; **withdrawal** frees it (the next person waiting gets it), revokes platform access and asks the money module for the **pro-rata refund** (`refund.requested`), due within 10 days of the request (MoE coaching guidelines 2024 cl. 8(iv)).
- The **public checkout** (`/checkout/<company code>`) sells batches online, links the family to people already known (`core/crm/contacts.js`), records consent and pays through the money module's payment-link port.
- B2B: a won institute deal, a signed contract or a started subscription creates one **implementation project** (kickoff, data import, training, go-live, with tasks). Subscriptions feed the **renewals** list with reminders (90/60/30/7 days) and nightly **churn-risk** and **upsell** scores.

## 2. Modules and permissions

Two module objects in one folder, registered in `modules/index.js`:

| Module | Permission | Own scope | Default grants |
| --- | --- | --- | --- |
| `enrollments` (`module.js`) | `enrollments.view` | owner | group/company admin, manager, finance, support, analyst; counsellor (own) |
| | `enrollments.manage` | owner | admins, manager, support; counsellor (own) |
| | `enrollments.withdraw` | owner | admins, manager, finance |
| | `enrollments.manage_batches` | | admins, manager |
| `onboarding` (`onboardingModule.js`) | `onboarding.view` | owner | admins, manager, support, analyst; counsellor and account executive (own) |
| | `onboarding.manage` | owner | admins, manager, support; counsellor and account executive (own) |
| | `onboarding.configure` | | group/company admin |
| | `onboarding.view_renewals` | owner | admins, manager, finance, analyst; account executive (own) |

Scoping follows the phase 2 contract §4: enrollments, checklists, projects and renewals are company-owned (`group_id`, `company_id`, `unit_id`, `owner_user_id`), lists use `listScope` + `applyListScope`, single records `loadVisible` (404 outside scope, 403 when visible but the action isn't allowed). **Batches** and **templates** are company configuration: readable with the view permission at, above or inside the company; batch writes need `enrollments.manage_batches` at the batch's unit, template writes `onboarding.configure` at the company. Student and payer details are masked without `contacts.view_pii` at the enrollment's unit.

## 3. Data model

All UUID keys, `timestamptz` in UTC, `date` for calendar days, money as `bigint` minor units + `char(3)` currency. Ids that belong to the money module (`payment_id`, `subscription_id`, `contract_id`, refund ids) are text without foreign keys.

| Table | What | Key rules |
| --- | --- | --- |
| `batches` | A programme's run: product, unit, code (unique per company), schedule jsonb, `starts_on`/`ends_on`, `capacity`, `seats_taken`, `waitlist_enabled`/`waitlist_limit`/`waitlist_count`, fee, `checkout_enabled`, teacher (active staff of the batch's company or the group above it; never another company's staff or a partner), mode, status, `refund_unit` (days or classes) + `total_classes` | `seats_taken` counts active and paused enrollments seated here; changed only under `FOR UPDATE` on the batch row |
| `enrollments` | Student, payer, household (the student's or the payer's own family), deal, product/line, batch, owner, `status` (active, paused, withdrawn, completed), `seat_status` (seated, waitlisted, unassigned), `access_status` (not_required, pending, granted, suspended, revoked), source, fee locked at enrollment, `paid_minor`, dates | `ref` "SP-E1001" per company (`crm_sequences` name `enrollment`, prefix from `deals.referencePrefix`); unique `source_key`; unique `(deal_id, student_contact_id, product_id)` |
| `enrollment_payments` | Payments recorded against an enrollment | unique `(enrollment_id, payment_id)` |
| `waitlist_entries` | One waiting place per enrollment, `queued_seq` identity = order of arrival | unique waiting entry per enrollment |
| `enrollment_withdrawals` | `received_at` (the clock starts here), channel, optional reason, `effective_on`, `refund_basis` jsonb (every input of the computation), `refund_minor`, `refund_due_at`, `refund_status` (requested, processing, paid, not_applicable, failed), reference | one per enrollment |
| `checkout_sessions` | Public checkout: batch, amount, token hash, details (purged once enrolled or expired), consent evidence, payment link, payment id, enrollment | expires after 60 minutes |
| `onboarding_templates` + `_items` | Per company, `kind` b2c (checklist) or b2b (implementation, with `phases` jsonb); optional product or line; items with owner role (record owner, batch teacher, unassigned) and day offset | most specific active template wins: product, line, company default |
| `onboarding_checklists` + `_items` | One per enrollment; items with status (pending, done, skipped), owner, due date; counters `items_total`/`items_done` | closes when every item is done or skipped |
| `implementation_projects` + `_phases` + `_tasks` | Institute, deal, subscription, contract, owner, status (planned, in_progress, live, on_hold, cancelled), kickoff, target go-live; phases with tasks | unique `source_key` (deal:, subscription:, contract:, manual:) and unique `deal_id` |
| `renewals` | Read model of the money module's subscriptions: account or contact, term dates, auto-renew, amount, seats, owner, reminders sent for this term, churn score/level/signals, upsell flags | unique `subscription_id`; older events never overwrite newer ones |

## 4. Enrollments, seats and the waitlist

- `createEnrollment` (service.js) takes transaction-scoped advisory locks on the source key and on deal+student+programme, then looks for an existing enrollment by source key, deal+student+programme or checkout session. A duplicate delivery records its payment (once, by payment id) and returns the existing enrollment.
- `placeInBatch` locks the batch row: a free seat seats the student; a full batch adds a waitlist entry when the waitlist is on and below its limit, otherwise `409 batch_full`. The batch must be of the same company and programme and planned or open.
- Freeing a seat (withdrawal, completion, move) promotes the next people waiting in `queued_seq` order when `enrollments.waitlistAutoPromote` is on (default). Raising a batch's capacity does the same. Placement never looks at marks (MoE cl. 12(vii) forbids segregating batches by performance).
- The fee is locked on the enrollment (the deal's value, the checkout amount or the batch fee): MoE cl. 8(v), the fee can't rise during the course. `paid_minor` only adds payments in the enrollment's currency.
- Pause suspends platform access and keeps the seat; `resume_on` resumes it (job). Completion frees the seat.
- From a deal payment the batch is the one in the event, else (setting `enrollments.autoAssignBatch`, on by default) the earliest open batch of the programme with a seat, else the earliest with a waitlist, else none (`seat_status = unassigned`). Every student on the deal (role student) is enrolled; the deal's value is locked on the first.

## 5. Withdrawals and refunds

`computeWithdrawalRefund` (refunds.js, pure, unit-tested) implements cl. 8(iv) with every choice the rules leave open made in the student's favour:

- the clock starts when the request is **received** (`receivedAt`, can be backdated, never in the future), calendar days; due = received + `enrollments.refundSlaDays` (10);
- the unit is calendar days of the prescribed period (or classes when the batch says so); the day the student leaves counts as used; days before the start are never used; a student never seated used nothing;
- used value = fee × used / total, **rounded down**; refund = paid − used value, never negative (instalment payers get back what they paid beyond what they used); no deductions;
- `enrollments.coolingOffDays` (0 by default; J&K style rules use 10) gives a full refund within that many days of enrolling.

The withdrawal stores the inputs (`refund_basis`) and emits `refund.requested` (aggregate `enrollment_withdrawal`) with `withdrawalId, enrollmentId, enrollmentRef, dealId, contactId (payer), studentContactId, amountMinor, currency, receivedAt, dueAt, reason: 'withdrawal', rule, basis, paymentIds, cancelFutureInstalments: true`. The money module is the authority on what is paid out; it answers with `refund.processing`, `refund.completed` (or `refund.succeeded` / `refund.paid`) and `refund.failed` carrying `withdrawalId` (or `metadata.withdrawalId`), which update the withdrawal and write a timeline entry ("Refund of ₹30,000 paid", "(after the deadline)" when late). Hostel and mess fees are not modelled here.

## 6. Onboarding and settings

- **Checklists** start with the enrollment from the best b2c template; due dates count from the day of enrollment; owners from the item's role (enrollment owner, batch teacher). Ticking items updates the counters and closes the checklist (`onboarding.checklist_completed`, timeline "Onboarding complete").
- **Implementation projects** (`ensureImplementationProject`, idempotent with advisory locks on every key): phases from the b2b template (default kickoff 0, data import 7, training 14, go-live 28 days), tasks from its items; a second trigger for the same deal attaches its subscription or contract id instead of creating another project. Ticking tasks moves phases (in progress, done) and the project to in progress; status `live` emits `implementation.went_live`.
- Which triggers start projects is the setting `onboarding.projectTriggers` (deal won, contract signed, subscription started; all by default).

| Setting | Default | Levels |
| --- | --- | --- |
| `enrollments.refundSlaDays` | 10 | group, company, region, branch |
| `enrollments.coolingOffDays` | 0 | same |
| `enrollments.waitlistAutoPromote` | true | same |
| `enrollments.autoAssignBatch` | true | same |
| `enrollments.checkoutEnabled` | false | group, company |
| `enrollments.refundPolicyText` | the policy shown at checkout | group to branch |
| `onboarding.projectTriggers` | all three | group, company |
| `onboarding.renewalReminderDays` | 90, 60, 30, 7 | group, company |
| `onboarding.churnInactiveDays` | 30 | group, company |
| `onboarding.churnMediumScore` / `churnHighScore` | 30 / 60 | group, company |

## 7. Renewals and churn risk

`renewals` is fed by `subscription.created|started|activated|updated|renewed|cancelled|deleted|ended` (payload `subscriptionId, accountId?, contactId?, dealId?, productId?, termStart, termEnd | currentPeriodEnd | renewsOn, autoRenew, amountMinor, currency, seats?, planName?, ownerUserId?`; the unit comes from the deal, else `unitId`/`companyId`). A new term end resets the reminders.

Churn score (churn.js, pure; weights fixed so scores compare across companies): never contacted 30, quiet (no call, message, email, meeting or note for `churnInactiveDays`) 20 or very quiet (twice that) 30, overdue tasks 5 each up to 15, a lost deal in 6 months 15, implementation cancelled 30 / on hold 20 / go-live overdue 25, consent withdrawn in 90 days 10, renews within 30 days with no auto-renew and no open deal 15; capped at 100. Upsell flags: more students (`accounts.student_count`) than licensed seats; B2B product lines of the company the institute doesn't hold.

## 8. Endpoints

All under `/api/v1`, `describe()` on every route, strict zod bodies and queries, `{ data }` / `{ data, nextCursor }` (keyset). Types: `apps/web/src/lib/delivery/types.ts`.

### 8.1 Batches
`GET /batches/programmes?unitId` (B2C products for forms) · `GET /batches?unitId&productId&status&joinable&q&cursor&limit` (starts_on desc) · `POST /batches` · `GET /batches/:id` · `PATCH /batches/:id` (capacity ≥ seats taken; cancelling with students is 409) · `GET /batches/:id/waitlist`.

### 8.2 Enrollments
`GET /enrollments?unitId&status&seatStatus&batchId&productId&dealId&contactId&owner&q` (created desc; `batchId` also matches people waiting) · `GET /enrollments/counts?unitId` · `POST /enrollments` (manual; 409 `already_enrolled`, 409 `batch_full`) · `GET /enrollments/:id` (withdrawal, payments, checklist items, `can`) · `PATCH /enrollments/:id` (owner, access status, dates) · `POST /enrollments/:id/batch` · `/pause` · `/resume` · `/complete` · `/withdraw/preview` · `/withdraw`.

### 8.3 Public checkout (no session; rate limited per IP; writes still need `X-Phoenix-Client`)
`GET /public/checkout/:company` (company code or id; 404 unless `enrollments.checkoutEnabled`) → batches on sale, policy text and version · `POST /public/checkout/:company/sessions` (409 `batch_full`, 409 `policy_changed`, 503 when the payment link fails) → session id, token, payment URL · `GET /public/checkout/sessions/:id?token` · `POST /public/checkout/sessions/:id/simulate-payment` (development stub only; 404 otherwise).

On `payment.succeeded` for the session (`checkoutSessionId`, `metadata.checkoutSessionId` or `reference`), `completeCheckout`: finds or creates the parent with `findOrCreateContact` (phone, email), reuses a student of the parent's household with the same name (else find-or-create), joins them in the parent's household (or a new "<surname> family"), records the consents given (WhatsApp service updates, marketing; source `checkout`, evidence with policy version, IP and user agent), attaches an open family deal of the company for the programme (its unit and owner), creates the enrollment (`checkout:<session>`), purges the session's personal data and emits `checkout.session_completed`.

### 8.4 Templates
`GET /onboarding/templates?unitId|companyId&kind` · `POST /onboarding/templates` · `PUT /onboarding/templates/:id`.

### 8.5 Checklists and implementation projects
`GET /onboarding/checklists?unitId&status&owner&overdue` · `GET /onboarding/checklists/:id` · `PATCH /onboarding/checklists/:id/items/:itemId` · `GET /implementation-projects?unitId&status&owner&accountId&dealId` · `POST /implementation-projects` (409 when the deal has one) · `GET /implementation-projects/:id` · `PATCH /implementation-projects/:id` · `POST /implementation-projects/:id/tasks` · `PATCH /implementation-projects/:id/tasks/:taskId` · `PATCH /implementation-projects/:id/phases/:phaseId`.

### 8.6 Renewals
`GET /renewals?unitId&status&risk&dueWithinDays&owner&upsell&sort=due|risk` · `GET /renewals/summary?unitId`.

## 9. Events, handlers and ports

**Emitted** (outbox, in the writing transaction; payloads carry `companyId`, `unitId`): `batch.created`, `batch.updated`, `enrollment.created`, `enrollment.batch_assigned`, `enrollment.waitlisted`, `enrollment.updated`, `enrollment.access_changed`, `enrollment.paused`, `enrollment.resumed`, `enrollment.completed`, `enrollment.withdrawn`, `enrollment.refund_updated`, `refund.requested`, `checkout.started`, `checkout.session_completed`, `checkout.needs_attention`, `onboarding.checklist_started`, `onboarding.item_updated`, `onboarding.checklist_completed`, `onboarding.template_created|updated`, `implementation.created|updated|task_added|task_completed|went_live`, `renewal.created|updated|reminder_due|churn_risk_changed`. The module also emits contract events for records it creates through the family flow: `household.created`, `household.member_added`, `consent.recorded`, `contact.company_linked` (and `findOrCreateContact` its own).

Timeline entries (written by the producer, contract §11.1): "Enrolled: …", "Moved to …", "Got a seat … from the waitlist", "Paused / Resumed", "Withdrew; refund of ₹… requested (due …)", "Refund … paid", "Onboarding complete", "Implementation project started", "Went live", "Renews in 30 days" (`sourceEventId` per term and offset).

**Consumed** (handlers.js, all idempotent): `payment.succeeded`, `checkout.completed`, `payment_link.paid` (checkout or deal payment), `refund.processing|completed|succeeded|paid|failed`, `contact.merged` (enrollments and renewals follow the surviving person), `deal.won` (institute deals), `contract.signed`, `subscription.*`.

**Ports** (`ports.js`): `createPaymentLink(input)` → `{ id, url, provider, expiresAt }`. Until connected it is a development stub that links to `/checkout/<company>/pay`, whose "Simulate a successful payment" emits `payment.succeeded`; in production an unconnected port throws (the checkout answers 503). Wire it once at start-up: `connectDeliveryPorts({ createPaymentLink })`.

## 10. Jobs (jobs.js)

`deliveryJobs = [{ name, cron, run }]` for the jobs platform (Asia/Kolkata): `delivery.renewal_reminders` (daily 08:30: only the closest reached offset is sent, the skipped ones count as sent, never twice per term), `delivery.churn_scoring` (03:00, batches of 200 with grouped queries; emits `renewal.churn_risk_changed`), `delivery.enrollment_resumes` (06:15), `delivery.checkout_expiry` (every 10 minutes: expires unpaid sessions and drops their personal data). Each run is safe to repeat and to run on several workers (`FOR UPDATE SKIP LOCKED`).

## 11. Seed and tests

`35_delivery.js` (idempotent): checkout on for SatnPaper and Pi Vector, templates per company, two batches per batch-style programme (running and on sale) plus a small full SAT batch, enrollments for won family deals (with payments, checklists, one paused, one withdrawn), implementation projects for signed institutes (progress, one live) and renewals with scores and reminders.

Tests: `test/delivery/*.test.js` (refund maths, churn and reminders, schemas, registration, payment parsing, ports) and `test/integration/delivery.test.js` (duplicate and concurrent payment events, capacity and waitlist, withdrawal with refund request and promotion, refund completion, pause/resume, checkout linking to an existing family, implementation project and renewal from B2B events, reminders, scoping as owner, company admin, admin.pivector, ritika, kabir, sales.satnpaper and a temporary analyst for masking).

## 12. Web

Sidebar: Enrollments (`/enrollments`, tabs Enrollments and Batches) and Onboarding (`/onboarding`: Student checklists, Implementation, Renewals; `/onboarding/projects/[id]`). Settings tab Onboarding (`/settings/onboarding`, templates). Public pages `/checkout/[company]`, `/checkout/[company]/pay` (dev), `/checkout/[company]/done`. Components: `EnrollmentDrawer` (details, refund, checklist, batch move, pause, withdraw with live refund preview, complete) and `EnrollmentPanel` for the deal profile:

```tsx
<EnrollmentPanel dealId={deal.id} unitId={deal.unit.id} companyId={deal.companyId}
  students={deal.contacts.filter((c) => c.role === 'student').map((c) => c.contact)} productId={deal.product?.id} />
```

## 13. Open questions

- Hostel and mess fees (cl. 8(iv)) are outside the enrollment fee; the money module should add them to the refund when it bills them.
- Age rule (cl. 6(i)(c), 16+ or after secondary school) is not enforced: date of birth is often unknown at checkout.
- A payment that arrives after the checkout expired (personal data already dropped) emits `checkout.needs_attention` instead of enrolling.
- Seats are not held while a family pays; if the last seat goes meanwhile the paid student is waitlisted (the done page says so) and staff decide.
