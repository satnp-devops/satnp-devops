# Google Calendar and Google Meet

Code: `apps/api/src/integrations/providers/google/` · Tests: `apps/api/test/providers/google/` · Adapter kinds: `calendar` + `meetings`

A dependency-free client (global `fetch` + `node:crypto` + `zod`) for:

- **Auth:** a service account (RS256 JWT, optionally impersonating a Workspace user through domain-wide delegation), or per-user OAuth with a refresh token.
- **Calendar v3:** freeBusy, events insert/get/patch/delete, incremental sync, push channels (`events.watch`, `channels.stop`).
- **Meet:** a conference created through `conferenceData.createRequest` on the event. Attendance comes from the Meet REST API v2 (conference records, participants, participant sessions).

Facts below were checked against Google's own documentation on **2026-11-05** (see [Sources](#sources)). Anything not confirmed is listed under [Unconfirmed](#unconfirmed).

## Quick start

```js
import { createGoogleClient, serviceAccountFromJson, verifyWebhook, parseWebhook } from './integrations/providers/google/index.js';

const google = createGoogleClient(
  {
    auth: serviceAccountFromJson(keyFileJson, { subject: 'counsellor@school.example.in' }),
    webhook: { address: 'https://crm.example.in/webhooks/google/calendar', channelSecret: process.env.X },
  },
  { fetch, now: Date.now, logger },
);

const { calendars } = await google.calendar.freeBusy({ calendarIds: ['counsellor@school.example.in'], timeMin, timeMax });
let event = await google.calendar.insertEvent({
  idempotencyKey: `booking:${booking.id}`,         // deterministic event id, safe to retry
  summary: 'Admission counselling', start, end,    // Date | epoch ms | ISO string WITH offset
  attendees: [{ email: parent.email, displayName: parent.name }],
  withMeet: true, sendUpdates: 'all',
});
if (event.meet?.status === 'pending') event = await google.calendar.waitForConference({ eventId: event.id });
event.meet.url;          // https://meet.google.com/abc-mnop-xyz
event.meet.meetingCode;  // abc-mnop-xyz  (use it for attendance)
```

## Capabilities

| Area | Method | Notes |
|---|---|---|
| Auth | `getAccessToken()` | Cached. Refreshed 60 s before `expires_in` runs out, with one refresh in flight at a time. A 401 from an API call invalidates the token and resends the call once. |
| Auth helpers | `buildAuthorizationUrl()`, `exchangeAuthorizationCode()`, `revokeToken()` | Per-user connect and disconnect flow. The consent URL sets `access_type=offline` and `prompt=consent`, so Google returns a refresh token. |
| Calendar | `calendar.freeBusy({ calendarIds, timeMin, timeMax })` | Splits requests into batches of 50 calendars (Google's `calendarExpansionMax` limit). Busy intervals come back as UTC ISO strings, with errors listed per calendar. |
| | `calendar.insertEvent(input)` | `withMeet: true` sets `conferenceDataVersion=1` and sends `createRequest {requestId, conferenceSolutionKey.type: 'hangoutsMeet'}`. With an `idempotencyKey`, the call is retried and a 409 returns the existing event (`deduplicated: true`). |
| | `calendar.waitForConference({ eventId })` | Polls `events.get` until `createRequest.status.statusCode` leaves `pending`. |
| | `calendar.getEvent`, `patchEvent`, `deleteEvent` | Patch sends only the fields you pass; any array you pass replaces the stored one. Delete treats 410 as `alreadyDeleted`. |
| | `calendar.listEvents`, `calendar.syncEvents({ syncToken })` | Full or incremental sync. A 410 raises `FullSyncRequiredError`. Filters that Google rejects alongside `syncToken` are refused locally. |
| | `calendar.watchEvents()`, `calendar.stopChannel()` | Push channel with an HMAC channel token. Returns `{ channelId, resourceId, expiresAt }`. |
| Meet | `meet.getSpace({ space })` | Accepts `spaces/{id}` or a meeting code. |
| | `meet.listConferenceRecords`, `listParticipants`, `listParticipantSessions` | One page per call, with page sizes capped at Google's maximums (100/250/250). |
| | `meet.getMeetingAttendance({ meetingCode })` | Walks every page and returns each participant's sessions and `attendedSeconds`. Overlapping sessions are merged; open sessions count up to `now()`. |
| Webhooks | `verifyWebhook(rawBody, headers, secret)`, `parseWebhook(rawBody, headers)` | Pure functions. Also available as `client.verifyWebhook(rawBody, headers)`, which reads the secrets from config. |
| Utilities | `eventIdFromKey`, `extractMeet`, `normalizeEvent`, `unionSeconds`, `conferenceRecordFilter`, `redact` | Pure functions. |

**Normalised event** (`normalizeEvent`):
`{ provider, id, calendarId, status, summary, description, location, start: {at, date, timeZone}, end, allDay, attendees[], organizer, meet: {url, meetingCode, conferenceId, status, phone[], moreUri} | null, htmlLink, iCalUID, sequence, recurringEventId, created, updated, extendedProperties: {private, shared}, raw }`.
All instants (`at`, `created`, `updated`) are UTC ISO. `timeZone` is the IANA display zone. The provider's ids are `id` and `iCalUID`.

**Money:** none. This provider handles no amounts.

## Configuration

Validated with zod (`configSchema`). A validation error lists **field paths only**, never values.

| Field | Default | Where to get it |
|---|---|---|
| `auth.type` | (required) | `service_account` or `oauth_user` |
| `auth.clientEmail` | (required for SA) | `client_email` in the service-account JSON key: Cloud console → IAM & Admin → Service accounts → Keys → Add key → JSON. `serviceAccountFromJson()` maps the file. |
| `auth.privateKey` | (required for SA) | `private_key` from the same file (PKCS#8 PEM). Escaped `\n` sequences are converted to newlines. **Secret.** |
| `auth.privateKeyId` | none | `private_key_id`. Sent as the JWT `kid`. |
| `auth.subject` | none | The Workspace user to impersonate. Requires domain-wide delegation: a super admin adds the service account's **numeric client ID** with the scopes in Admin console → Security → API controls → Domain-wide delegation. The Meet REST API needs this (or per-user OAuth). |
| `auth.clientId`, `auth.clientSecret` | (required for OAuth) | Cloud console → APIs & Services → Credentials → OAuth client ID (Web application). The client secret is a **secret**. |
| `auth.refreshToken` | (required for OAuth) | `exchangeAuthorizationCode()` after the user consents to `buildAuthorizationUrl()`. **Secret**: store it encrypted. |
| `scopes` | `calendar.events`, `calendar.events.freebusy`, `meetings.space.readonly` | Under domain-wide delegation, these must exactly match the scopes the admin authorised. `calendar.events` alone does **not** allow freeBusy. |
| `calendarId` | `primary` | Calendar used when a call doesn't name one. |
| `defaultTimeZone` | `Asia/Kolkata` | IANA zone set on events (display and recurrence). The instants themselves are sent in UTC. |
| `quotaUser` | none | Sent as `x-goog-quota-user` so quota is charged per company or user instead of to the service account. |
| `webhook.address` | none | Public HTTPS URL of the push receiver. It needs a valid certificate; self-signed certificates are rejected. |
| `webhook.channelSecret` | none | 32 or more random characters. Used to derive channel tokens. **Secret.** |
| `webhook.previousChannelSecrets` | `[]` | Old secrets that are still accepted while you rotate to a new one. |
| `webhook.ttlSeconds` | `604800` (7 days, Google's default for events channels) | Google may shorten it; the expiry Google returns is the one used. |
| `timeoutMs` / `maxRetries` / `backoffBaseMs` / `maxBackoffMs` | 15000 / 3 / 1000 / 32000 | Per-attempt timeout (`AbortSignal.timeout`) and truncated exponential backoff. |
| `endpoints.*` | Google production URLs | Override only for tests or proxies. Must be `https://`. |

Also enable the **Google Calendar API** and the **Google Meet REST API** in the Cloud project.

### Dependencies (second argument)
`{ fetch, now, logger, sleep?, random? }`. The logger only ever receives `{ provider, operation, status, attempt, ms }`. URLs (which contain calendar ids, usually email addresses), request bodies and tokens are never logged.

## Retries, idempotency and errors

| Operation | Retried on 5xx, 429, rate-limit 403, timeout, network error | Why |
|---|---|---|
| token, freeBusy, events.get/list, Meet reads | yes | Reads, or no side effects. |
| events.insert **with** `idempotencyKey` or `eventId` | yes | A repeated insert hits 409 `duplicate`; the client then fetches and returns the existing event. |
| events.insert without a key | no | It could create a second event. |
| events.patch | no | A repeat could send guest notifications again. The error says `retryable: true`, so the job queue can decide. |
| events.delete, channels.stop | yes | 410 (delete) or 404 (stop) on a repeat is treated as success. |
| events.watch | no | Google rejects a reused channel id. |
| OAuth code exchange or revoke | no | An authorization code can be used only once. |

The backoff for attempt n is `min(maxBackoffMs, backoffBaseMs·2ⁿ + rand(0..1000) ms)`, which is the truncated exponential backoff Google recommends. A `Retry-After` header takes precedence, and if it asks for longer than `maxBackoffMs`, the error is surfaced instead of waiting.

`GoogleError { code, status, reason, retryable, retryAfterMs, operation }`:

| HTTP / reason | `code` | retryable |
|---|---|---|
| 400 (e.g. `timeRangeEmpty`) | `bad_request` | no |
| 401 `authError` (after one token refresh) | `auth_failed` | no |
| 403/429 `rateLimitExceeded`, `userRateLimitExceeded` (`usageLimits`) | `rate_limited` | yes |
| 403 `quotaExceeded`, `dailyLimitExceeded` | `quota_exceeded` | no |
| 403 other (e.g. `forbiddenForNonOrganizer`) | `permission_denied` | no |
| 404 | `not_found` | no |
| 409 `duplicate` / other | `duplicate` / `conflict` | no |
| 410 `fullSyncRequired`, `updatedMinTooLongAgo`, or any 410 on a sync | `full_sync_required` (`FullSyncRequiredError`) | no: wipe local state and run a full sync |
| 410 other (`deleted`) | `gone` | no |
| 412 `conditionNotMet` | `precondition_failed` | no |
| 5xx | `server_error` | yes |
| Token endpoint 4xx (`invalid_grant`, `unauthorized_client`, `access_denied`, `invalid_scope`, ...) | `auth_failed` with `reason` set to the OAuth error | no: reconnect, or fix the delegation setup |
| fetch threw, or the timeout fired | `network` / `timeout` | yes |
| config problems | `config_invalid` | no |

Error messages pass through `redact()`. It removes every configured secret, the current access token, `Bearer …`, `ya29.…` and `1//…` tokens, and PEM blocks.

## Webhooks (Calendar push notifications)

**What Google sends** (documented): an HTTPS `POST` with **no body**. These headers are always present: `X-Goog-Channel-ID`, `X-Goog-Message-Number` (1 for `sync`; increases afterwards, but not one at a time), `X-Goog-Resource-ID`, `X-Goog-Resource-State` (`sync` | `exists` | `not_exists`) and `X-Goog-Resource-URI`. These are optional: `X-Goog-Channel-Expiration` (an RFC 1123 date) and `X-Goog-Channel-Token`. The user agent is `APIs-Google`. Reply with 200, 201, 202, 204 or 102. Notifications don't say what changed, so call `syncEvents`. They are not 100% reliable, so also run a periodic sync.

**Google does not sign notifications.** The only authenticator is the `token` we choose when creating the channel (up to 256 characters), and Google echoes it back. We make that token a MAC:

```
exp   = channel expiry, epoch seconds
token = "v1." + exp + "." + base64url( HMAC-SHA256( channelSecret, "v1." + channelId + "." + exp ) )
```

`verifyWebhook(rawBody, headers, secret | [secrets], { now, toleranceSeconds = 300 })` checks these, in order:

1. The required `X-Goog-*` headers are present (looked up case-insensitively; works with `Headers` or an Express headers object).
2. The token is well-formed `v1.<digits>.<43 base64url chars>`, with canonical base64url and 32 bytes.
3. The HMAC, recomputed for the `X-Goog-Channel-ID` actually received, matches under `crypto.timingSafeEqual`. Every configured secret is tried, without short-circuiting.
4. `now <= exp + tolerance`. Google stops delivering when a channel expires, so anything presented later is treated as a replay.

The result is `{ ok: true, channelId, expiresAtMs }` or `{ ok: false, reason }`, where `reason` is one of `missing_headers`, `missing_token`, `malformed_token`, `bad_signature`, `expired` or `no_secret`. The raw body is accepted for interface symmetry and is never trusted. A token can't be replayed on another channel id. A token leaked from a log stops working when its channel expires.

`parseWebhook(rawBody, headers)` returns `[{ provider: 'google', id: "<channelId>:<messageNumber>", type, channelId, resourceId, resourceUri, resourceState, messageNumber, calendarId, channelExpiresAt, requiresSync }]`. `type` is `calendar.channel.sync`, `calendar.events.changed`, `calendar.events.resource_gone` or `calendar.unknown`. Use `id` for de-duplication.

**Setup:**
1. Set `webhook.address`. It must be publicly reachable over HTTPS; for local development, expose it with a tunnel.
2. Call `watchEvents({ calendarId })` once per calendar (events channels are per calendar), and store `{ channelId, resourceId, calendarId, expiresAt }`.
3. The receiver: check `verifyWebhook`, reply 200 quickly, enqueue `syncEvents({ calendarId, syncToken })`, then save the new `nextSyncToken`.
4. Channels **don't renew**. Before `expiresAt`, create a new channel with a new id (the two may overlap), then `stopChannel` the old one.

Test vectors (`webhook.test.js`): secret `phoenix-test-channel-secret-0123456789`, channel `4ba78bf0-6a47-11e2-bcfd-0800200c9a66`, exp `1700000000` give the token `v1.1700000000.hKaa_WnLX4AWsvDq0JFjhwfW-3nxTi-kyy60TBNrg-8`. It was computed with node:crypto and separately with `openssl dgst -sha256 -hmac`, and both agree. Google publishes no official vectors because it doesn't sign notifications. The RS256 JWT signer is checked byte for byte against **RFC 7515 Appendix A.2** (`fixtures/rfc7515-a2.json`, a published test key).

## Rate limits (as documented 2026-11-05)

| API | Limit |
|---|---|
| Calendar | 10,000 requests per minute per project; 600 per minute per user per project (sliding window). Exceeding either returns 403 or 429 `usageLimits`. |
| Calendar | 1,000,000 requests per day per project is a *billing threshold* for projects created on or after **2026-05-01**. Google says charges for exceeding it are "planned … later in 2026". |
| Calendar | `events.patch` costs 3 quota units. Service-account calls count against the service account's own per-user quota unless `quotaUser` is set. Separate Workspace "Calendar usage limits" (invitations, event creation) and operational limits also apply. |
| Meet REST | Reads: 6,000 per minute per project and 600 per minute per user. Writes: 1,000 and 100. `spaces.create`: 100 and 10. Exceeding these returns 429. There is no daily limit. |

To stay inside the limits, use push notifications instead of polling, spread full syncs over time with about ±25% jitter, and set `quotaUser` per company.

## Sandbox / test mode

Google has **no sandbox** for Calendar or Meet. Use instead:
- A separate Cloud project, and a test Workspace domain or test Google accounts, for development.
- For per-user OAuth: an OAuth consent screen in *Testing* status with listed test users. Refresh tokens may expire sooner in this status (see [Unconfirmed](#unconfirmed)).
- Unit tests in this repo use a fake `fetch` (no network), a throwaway RSA key generated at test time, and fixtures modelled on the documented resource shapes.
- Run them with `cd apps/api && node --test "test/providers/google/*.test.js"`. Passing only the directory (`node --test test/providers/google/`) failed with MODULE_NOT_FOUND on Node 24 here.

## India-specific notes

- **Time:** `defaultTimeZone` is `Asia/Kolkata` (IST, UTC+05:30, no daylight saving). Inputs must carry an offset or be a `Date`; naive local strings are rejected so they aren't read in the server's zone by mistake. Outputs are UTC.
- **Families on personal Gmail:** invitations go out by email when `sendUpdates` is `all` or `externalOnly`. The default is `none`, which is also Google's default, because the CRM may send its own invite or reminder. Google warns that `none` can stop events from syncing to some external calendars.
- **DPDP Act 2023:** attendee emails and names, participant display names, attendance sessions, and Meet phone users (shown partially redacted) are personal data. Keep the minimum needed, record the notice or consent basis on the Phoenix side, and never log it (the client doesn't). Google deletes Meet conference records **30 days after the conference ends**, so schedule attendance capture well within that window.
- **Meet codes:** meeting codes can be reassigned to other spaces later, so store the `spaces/{id}` name from `getSpace` for anything long-term.
- **Data residency:** see [Unconfirmed](#unconfirmed). An India Workspace data region was not confirmed.

## Wave 2: wrapping notes

- One client per company connection: `createGoogleClient(connection.config, { fetch, now, logger })`. Decrypt the secrets just before you create the client.
- The `calendar` kind maps to `freeBusy`, `insertEvent`, `patchEvent`, `deleteEvent` and `syncEvents`. The `meetings` kind maps to `insertEvent({ withMeet: true })` plus `waitForConference` (create) and `getMeetingAttendance` (attendance).
- Webhook route: keep the raw request, call `client.verifyWebhook(raw, req.headers)` (or the pure `verifyWebhook` with secrets from the connection), then `parseWebhook`. Dedupe on `event.id`, reply 200, and enqueue the sync.
- Persist channels `{ channelId, resourceId, calendarId, expiresAt }` and sync tokens per calendar. Add a renewal job that runs about a day before `expiresAt`.
- `GoogleError.retryable` and `retryAfterMs` tell the job queue whether, and when, to try again.

## Sources

All fetched **2026-11-05**:

- Service-account JWT flow: https://developers.google.com/identity/protocols/oauth2/service-account
- Web-server OAuth (refresh, revoke, offline access): https://developers.google.com/identity/protocols/oauth2/web-server
- Push notifications: https://developers.google.com/workspace/calendar/api/guides/push
- events.watch: https://developers.google.com/workspace/calendar/api/v3/reference/events/watch
- events.insert, events.patch, events.list, Event resource: https://developers.google.com/workspace/calendar/api/v3/reference/events (plus `/insert`, `/patch`, `/list`)
- freeBusy.query: https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query
- Errors: https://developers.google.com/workspace/calendar/api/guides/errors
- Quotas: https://developers.google.com/workspace/calendar/api/guides/quota
- Conferences on events: https://developers.google.com/workspace/calendar/api/guides/create-events
- Incremental sync: https://developers.google.com/workspace/calendar/api/guides/sync
- Calendar scopes: https://developers.google.com/workspace/calendar/api/auth
- Meet conferenceRecords.list and the ConferenceRecord resource: https://developers.google.com/meet/api/reference/rest/v2/conferenceRecords/list and https://developers.google.com/meet/api/reference/rest/v2/conferenceRecords
- Meet participants and participant sessions: https://developers.google.com/meet/api/reference/rest/v2/conferenceRecords.participants (and `/list`), https://developers.google.com/meet/api/reference/rest/v2/conferenceRecords.participants.participantSessions (and `/list`)
- Meet spaces: https://developers.google.com/meet/api/reference/rest/v2/spaces and https://developers.google.com/meet/api/reference/rest/v2/spaces/get
- Meet conferences guide, limits, overview, scopes: https://developers.google.com/meet/api/guides/conferences, https://developers.google.com/meet/api/guides/limits, https://developers.google.com/meet/api/guides/overview, https://developers.google.com/meet/api/guides/authenticate-authorize
- RFC 7515 (JWS), Appendix A.2: https://www.rfc-editor.org/rfc/rfc7515.txt

## Unconfirmed

- **Insert with an existing id:** Google's errors guide lists 409 `duplicate`, but the Event resource says ID collisions "may not be detected at creation time". Treat idempotent insert as best effort, and also store the event id on the booking.
- **`channels.stop` on an unknown or expired channel:** the status code isn't documented. The client assumes 404 and treats it as already stopped.
- **`not_exists`:** listed as a resource state but not described for events channels. It is mapped to `calendar.events.resource_gone` and triggers a sync.
- **Channel TTL:** the default of 604800 s is documented; a maximum TTL for events channels is not. The config caps it at 31 days locally, and the expiry Google returns is used.
- **Service accounts without domain-wide delegation:** whether they can add attendees or create Meet conferences on their own calendar was not confirmed. Expect a 403; use `subject` or per-user OAuth.
- **Meet REST API eligibility:** account and edition requirements (Workspace editions vs personal Gmail) are not stated on the overview page. `conferenceRecords.list` returns only conferences where the caller is the organizer.
- **Attendance timing:** how soon conference, participant and session data appear after a call ends is not documented.
- **Refresh-token expiry:** the specific rules (7 days for apps in Testing status, 6 months of inactivity, per-client token count limits) were not in the section of the OAuth page that was read. The page does confirm `refresh_token_expires_in` for time-based access, and that refresh tokens can be revoked.
- **OAuth parameters:** PKCE (`code_challenge` with S256), `include_granted_scopes`, `login_hint` and the `authorization_code` exchange parameter names follow Google's standard OAuth flow but were not re-read word for word this session. The optional DPoP header that Google mentions is not implemented.
- **Retry-After:** whether the Calendar or Meet APIs send it on 429 is not documented. It is honoured if present.
- **Domain verification:** whether push `address` domains still need to be verified is not mentioned on the current push guide.
- **Default freeBusy scope:** `calendar.events.freebusy` ("availability on calendars you have access to") was chosen over `calendar.freebusy` ("your availability") from the scope descriptions. Both are accepted by freeBusy.query.
- **India data region:** no Workspace data region for India was found (search results showed only US, Europe and global). Confirm with Google or the Admin console before promising residency.
- **Indian Meet dial-in numbers:** availability was not confirmed. The `+91` number in the fixtures is made up.
- **Fixtures:** payloads are modelled on the documented resource shapes, not captured from the live API.
- **Console menu paths:** the Cloud console and Admin console paths in the configuration table were written from memory and were not re-verified this session.
