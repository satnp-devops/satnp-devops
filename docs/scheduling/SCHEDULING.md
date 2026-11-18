# Scheduling (phase 6)

Booking pages for families and institutes, people's weekly hours, bookings with reminders, personal booking links for deals, and meeting attendance. The pure engine (slots, host choice, iTIP invitations, reminder times) is `apps/api/src/core/scheduling` (`docs/platform/SCHEDULING_CORE.md`); this module adds the tables, routes, jobs and pages.

| Piece | Where |
| --- | --- |
| Migration | `apps/api/src/db/migrations/20261107000100_scheduling.js` |
| Seed (6 event types, hosts' hours, 22 bookings around today) | `apps/api/src/db/seeds/30_scheduling.js` |
| Module | `apps/api/src/modules/scheduling/` (`module.js`, `routes.js`, `publicRoutes.js`, services, `ports.js`, `jobs.js`, `attendance.js`, `index.js`) |
| Tests | `apps/api/test/scheduling-module/*.test.js`, `apps/api/test/integration/scheduling.test.js` |
| Web | `app/(app)/bookings`, `app/(app)/settings/booking`, `app/book/[token]`, `app/book/manage/[token]`, `components/scheduling/*` (incl. `SendBookingLinkDialog`), `lib/scheduling/*` |

## Data model

| Table | Holds |
| --- | --- |
| `scheduling_event_types` | What can be booked, per company, owned by a unit: slug (unique per company), duration, slot interval, buffers, minimum notice, daily limit per host, horizon, align zone, location (`zoom`, `google_meet`, `teams`, `phone`, `in_person`) and detail, assignment (`round_robin`, `single`), attendance threshold, reminder offsets, questions, "who will attend" policy, branding, deal kind. Archived = switched off. |
| `scheduling_event_type_hosts` | Hosts: weight (round-robin share), priority tier, languages, active. |
| `scheduling_availability` | One row per person: IANA zone (normalised), weekly ranges (`'09:00-13:00'`), date overrides (`'unavailable'` or ranges). |
| `scheduling_booking_links` | Signed links: one live `public` link per event type, and `personal` links for a deal or contact (prefill, preferred host, expiry, max uses, last sent, revoked). |
| `bookings` | Deal/contact, event type, host, deal owner, status (`booked`, `rescheduled`, `cancelled`, `completed`, `no_show`), `start_at`/`end_at` UTC, buffers copied at booking time, invitee zone and details, guests, answers, location and meeting link, `ics_uid`/`ics_sequence`, `token_nonce` (manage links), reschedule request, cancel and outcome fields, `source_event_id` (idempotency). |
| `booking_reminders` | One row per booking × sequence × offset with its deterministic job id; `scheduled` → `sent` / `skipped` / `cancelled`. |
| `meetings`, `meeting_participants`, `meeting_events` | Per booking: provider meeting id, live/ended, threshold copied from the event type, result, invitee/host seconds, recording ref and AI summary placeholders; people with merged intervals; raw normalised webhook events (unique provider event id). |

**Double booking** is refused twice: the service takes a transaction-scoped advisory lock per host, re-runs `checkSlot` with fresh busy data and only then inserts; and `bookings_no_overlap` (`EXCLUDE USING gist (host_user_id WITH =, tstzrange(start_at, end_at) WITH &&) WHERE status IN ('booked','rescheduled')`) refuses an overlap even from other code. A violation becomes `409 slot_unavailable`.

## Access

Permissions: `scheduling.view` (own), `scheduling.manage` (own; also who may host), `scheduling.assign`, `scheduling.configure`. Grants: group and company admins and managers get all four; counsellors and account executives `view:own` + `manage:own`; support, finance, marketing and analysts `view`.

- Bookings are company-owned (`unit_id` = the deal's unit, else the event type's unit). "Own" = the user hosts it or owns its deal; a host also sees bookings they host on an event type owned above their team. Outside scope → 404.
- Event types: read with `scheduling.view` at, above or inside the unit; write with `scheduling.configure` at the unit.
- Availability: everyone edits their own; others need `scheduling.configure` over every unit the person works in.
- Personal details on bookings are masked without `contacts.view_pii` at the booking's unit (hosts always see their invitee).

## Public pages and tokens

`/book/<token>` (booking page) and `/book/manage/<token>` (reschedule, cancel, ask for another time, `.ics`). Tokens are 44 bytes, base64url: version, kind (`link` or `manage`), id, expiry, nonce, and a 128-bit HMAC-SHA256 with a key derived from `APP_ENCRYPTION_KEY`. Forged or altered tokens fail before any database read (404); expired ones answer 410 `link_expired`; the row is then checked (revoked, used up → 410 `link_used`, switched off → 410 `unavailable`, rotated nonce → 404). Manage links work until 30 days after the meeting. Public endpoints are rate limited per IP in Redis (reads 300, bookings 10 per IP and 20 per token, manage actions 30, per 15 minutes) and send `Cache-Control: no-store`.

The page shows the company's branding (event type colour/logo, else the company profile's brand colour and logo, else the branding settings; colours are darkened to 4.5:1 on white), detects the visitor's zone and lets them pick any zone, asks "who will attend" and the event type's questions, and confirms with `.ics` and Google Calendar links.

## API

Staff (session): `GET|POST /scheduling/event-types`, `GET|PATCH /scheduling/event-types/:id`, `POST …/:id/archive|restore`, `PUT …/:id/hosts`, `GET …/:id/slots`, `GET /scheduling/host-candidates?unitId`, `GET|PUT /scheduling/availability/:userId|me`, `GET /scheduling/bookings?unitId&view&from&to&status&hostUserId&eventTypeId&dealId&contactId&cursor&limit`, `GET /scheduling/bookings/summary?unitId`, `GET /scheduling/bookings/:id`, `GET …/:id/slots`, `POST …/:id/reschedule|cancel|reassign|no-show|attended`, `GET …/:id/reassign-candidates`, `POST|GET /scheduling/links`, `GET /scheduling/links/:id`, `POST /scheduling/links/:id/send|revoke`.

Public: `GET /public/booking/:token`, `GET …/slots?from&to&timeZone`, `POST …/book`, `GET /public/bookings/:token`, `GET …/slots`, `POST …/reschedule|cancel|reschedule-request`, `GET …/invite.ics`.

## Events

`booking.created`, `booking.rescheduled`, `booking.cancelled`, `booking.attended`, `booking.no_show` (the deals module moves stages on these), plus `booking.reassigned`, `booking.reschedule_requested`, `booking_link.created|sent|revoked`, `event_type.created|updated|archived|restored`, `availability.updated`. Booking payloads: `bookingId, companyId, unitId, eventTypeId, dealId, contactId, hostUserId, startAt, endAt, status, source` and per type `assignmentReason`, `fromStartAt`, `by`, `reason`, `inviteeSeconds`, `thresholdMin`. No personal data in payloads.

Scheduling writes its own timeline entries on the deal and contact (`system` for lifecycle, `meeting` for attended, `meta.action` = event type, `meta.bookingId`), idempotent on `<action>:<booking>:<sequence>`.

Handled: `deal.owner_changed`, `deal.unit_changed` (active bookings follow), `contact.merged` (repoint), `contact.erased` (blank personal data).

## Attendance

`ingestAttendanceEvents({ provider, events })` takes normalised webhook events (Zoom `parseWebhook()` output as is; Meet and Teams mapped to the same shape), stores each once, rebuilds join sessions, merges each person's intervals (rejoins and second devices count once), takes the union of the non-host side and compares it with the event type's threshold. Reaching it records `booking.attended` at once; `booking.no_show` only once the meeting has ended (or at the attendance check after the booked end). Nobody joining is never "attended". The check job asks the `fetchAttendance` port for the provider report first; with neither report nor webhook data it leaves the outcome to the host (Bookings › Outcome due).

## Reminders and jobs

Reminder times come from `computeReminders` (offsets per event type, quiet hours in the invitee's zone from `scheduling.quietHoursStart/End`), stored in `booking_reminders`, and handed to the jobs module after commit through the `scheduleJobs` port as `{ name: 'scheduling.reminder', jobId, runAt, delayMs, data }`. A reschedule bumps the sequence, so old job ids never collide; their rows are cancelled and `cancelJobs` gets their ids. Processors: `jobProcessors['scheduling.reminder']`, `jobProcessors['scheduling.attendance_check']`. `pendingJobs()` lists every reminder still due; `sweepDueReminders()` and `sweepAttendanceChecks()` are interval fallbacks (SKIP LOCKED, safe alongside queued jobs).

## Ports (connected by the integrator)

`configureSchedulingPorts({ createOnlineMeeting, updateOnlineMeeting, cancelOnlineMeeting, fetchAttendance, getExternalBusy, sendBookingMessage, sendBookingLink, scheduleJobs, cancelJobs })`. Development defaults: simulated Zoom/Meet/Teams links, emails through the console mailer, no external calendars, jobs left to the sweep. Ports run after commit and never undo a booking (failures are logged), except the reminder processor, which lets a send failure throw so the job retries.

## Settings

`scheduling.quietHoursStart` / `scheduling.quietHoursEnd` (group, company), `scheduling.fairnessWindowDays`, `scheduling.personalLinkDays` (down to team), `scheduling.attendanceCheckMinutes`.

## Known gaps

- No external calendar sync yet (`getExternalBusy` returns nothing until phase 3 connectors), no recurring events, invitations are outbound only.
- Staff can't create a booking directly; they send a personal link (or open the public page).
- Recording fetch and AI summaries are columns only.
