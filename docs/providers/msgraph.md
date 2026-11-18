# Microsoft 365 (Microsoft Graph) provider

Code: `apps/api/src/integrations/providers/msgraph/` · Tests: `apps/api/test/providers/msgraph/` · Adapter kinds: **calendar**, **meetings**

This client gives the platform app-only (daemon) access to a customer's or a Phoenix company's Microsoft 365 tenant. It checks free/busy, books calendar events with Microsoft Teams meetings, updates and cancels them, keeps change-notification subscriptions alive, and reads Teams attendance reports. It has no dependencies beyond `zod`. `fetch`, the clock, the logger, `sleep`, randomness and UUIDs can all be injected.

```js
import { createMsgraphClient } from './integrations/providers/msgraph/index.js';

const graph = createMsgraphClient(config, { fetch, now, logger });
const { schedules } = await graph.getSchedule({ mailbox, emails: [counsellorEmail], start, end, intervalMinutes: 30 });
const event = await graph.createEvent(mailbox, { subject, start, end, attendees, idempotencyKey: booking.id });
```

`mailbox` is the calendar owner or organizer. Use the **Entra user object ID**: online-meeting and attendance endpoints accept only the object ID, and calendar endpoints also accept the UPN.

## Capabilities

| Method | Graph call | Retried automatically | Notes |
| --- | --- | --- | --- |
| `getAccessToken()` | `POST login.microsoftonline.com/{tenant}/oauth2/v2.0/token` | yes (no side effects) | Client credentials and `/.default` scope. Cached until 5 min before expiry. Concurrent callers share one request. |
| `getSchedule({ mailbox, emails, start, end, intervalMinutes })` | `POST /users/{mailbox}/calendar/getSchedule` | yes (read-only) | Times are sent in UTC and `Prefer: outlook.timezone="UTC"` is set. Returns raw items, merged `busy` intervals (busy, tentative and oof), working hours and per-person errors. |
| `createEvent(mailbox, input)` | `POST /users/{mailbox}/events` (or `/calendars/{id}/events`) | yes | Sends `isOnlineMeeting: true` and `onlineMeetingProvider: "teamsForBusiness"` unless `onlineMeeting: false`. **`idempotencyKey` is sent as Graph's `transactionId`**. If you omit it, one is generated per call, which makes in-process retries safe. Pass the booking ID so a job re-run can't create a duplicate. |
| `getEvent(mailbox, eventId)` | `GET /users/{mailbox}/events/{id}` | yes | |
| `updateEvent(mailbox, eventId, patch)` | `PATCH /users/{mailbox}/events/{id}` | yes | Sends only the fields you pass. Unknown fields are refused. Graph emails meeting updates to attendees. |
| `cancelEvent(mailbox, eventId, { comment })` | `POST …/events/{id}/cancel` → 202 | **no** | Organizer only (an attendee gets 400). Graph emails the cancellation and moves the event to Deleted Items. |
| `deleteEvent(mailbox, eventId)` | `DELETE …/events/{id}` → 204 | yes | A 404 counts as done (`alreadyDeleted: true`). This sends no cancellation email. |
| `createSubscription({ mailbox \| resource, changeTypes, expiresAt })` | `POST /subscriptions` → 201 | **no** | Uses resource `users/{mailbox}/events`, all three change types, a self-verifying `clientState`, both notification URLs and `latestSupportedTlsVersion: "v1_2"`. A duplicate gives `kind: 'conflict'` with `details.existingSubscriptionId`. |
| `renewSubscription(id, { expiresAt })` | `PATCH /subscriptions/{id}` | yes | Renewing also reauthorizes the subscription. |
| `reauthorizeSubscription(id)` | `POST /subscriptions/{id}/reauthorize` | yes | Don't call this and `renew` within 10 minutes of each other for the same subscription. |
| `deleteSubscription(id)` / `listSubscriptions()` | `DELETE` / `GET /subscriptions` | yes | Listing follows `@odata.nextLink`, but only to the Graph origin. |
| `findOnlineMeeting(mailbox, joinUrl)` | `GET /users/{id}/onlineMeetings?$filter=JoinWebUrl eq '…'` | yes | Maps `event.joinUrl` to the onlineMeeting ID. |
| `listAttendanceReports` / `listAttendanceRecords` / `getMeetingAttendance(mailbox, { meetingId \| joinUrl })` | `GET /users/{id}/onlineMeetings/{id}/attendanceReports[/{id}/attendanceRecords]` | yes | Guests can have an empty `emailAddress`, which is normalised to `null`. |
| `validationResponse(query)` · `verifyNotification(raw, headers)` · `parseWebhook(body)` | n/a | n/a | Pure webhook helpers (see below). The standalone `verifyWebhook(rawBody, headers, secret, options)` is also exported. |

All returned times are ISO 8601 UTC (`…Z`). Inputs must be a `Date`, epoch ms, or an ISO string with `Z` or an offset. Local times without a zone are rejected, so a booking can't silently land 5½ hours off. Calendar calls send `Prefer: IdType="ImmutableId"`, which keeps event IDs stable when an item moves between folders. Set `useImmutableIds: false` to turn this off.

### Errors

Everything throws `MsgraphError` with `{ kind, code, status, retryable, retryAfterMs, requestId, clientRequestId, operation, details }`. Messages never contain the client secret, webhook secrets, bearer tokens or request bodies.

| kind | when | retryable |
| --- | --- | --- |
| `throttled` | 429 / 509 | yes. `retryAfterMs` comes from `Retry-After` |
| `unavailable` | 500 / 502 / 503 / 504, or token `temporarily_unavailable` | yes |
| `timeout`, `network` | the per-attempt `AbortSignal` timeout fired, or fetch failed | yes. `details.outcomeUnknown` is true for non-idempotent calls |
| `auth` | 401 after one token refresh, or a token error (`invalid_client`, …) | no |
| `permission` | 403 (missing consent or application access policy) | no |
| `not_found`, `conflict`, `precondition`, `validation` | 404/410, 409, 412, other 4xx, or bad input caught before sending | no |
| `aborted` | the caller's signal aborted | no |
| `config`, `unexpected`, `webhook` | invalid config, a malformed response, or a foreign paging link | no |

### Retry policy

* **Idempotent calls** (GET, PATCH, DELETE, getSchedule, create with `transactionId`, and reauthorize) are retried up to `maxRetries` times (default 3). The client waits `Retry-After` when present, and otherwise uses exponential backoff with full jitter (`retryBaseDelayMs × 2^n`, capped at `maxRetryDelayMs`).
* **Non-idempotent calls** (`cancelEvent`, `createSubscription`) are never retried. They throw a retryable error and the job queue decides what to do.
* A `Retry-After` longer than `maxRetryDelayMs` (30 s by default) is not slept through. The error is returned with `retryAfterMs` so the worker can reschedule the job.
* A 401 invalidates the cached token and replays the request **once**, for every method. A 401 means the request was never executed.
* A process-local limiter keeps at most `maxConcurrentPerMailbox` (default 4) requests in flight per mailbox. This matches Outlook's per-app, per-mailbox concurrency limit.
* Each request carries a fresh `client-request-id` UUID, reused across that request's retries, so Microsoft support can trace it. Graph's `request-id` is copied into errors.

## Config fields

Validate config with `parseMsgraphConfig` (zod). The client never reads `process.env`. Use `redactConfig()` / `client.describe()` for logs and admin screens.

| Field | Required | Where to get it |
| --- | --- | --- |
| `tenantId` | yes | Entra admin center → Overview → **Tenant ID** (GUID). A verified domain also works, but use the GUID so webhook `tenantId` checks are enforced. `common`, `organizations` and `consumers` are rejected. |
| `clientId` | yes | Entra admin center → App registrations → your app → **Application (client) ID**. |
| `clientSecret` | yes (secret) | App registration → Certificates & secrets → New client secret → copy the **Value**, not the Secret ID. It is shown only once. Track its expiry date. |
| `webhookSecret` | yes (secret) | Phoenix-generated, at least 32 random characters (for example `openssl rand -base64 48`). Used to derive and verify `clientState`. |
| `previousWebhookSecrets` | no | Old webhook secrets, still accepted while subscriptions created with them run out (at most 7 days). |
| `notificationUrl` | for subscriptions | The public HTTPS URL of the Phoenix webhook route. |
| `lifecycleNotificationUrl` | recommended | A public HTTPS URL; it can be the same as `notificationUrl`. **It can only be set when the subscription is created.** |
| `authorityHost`, `graphBaseUrl` | no | Defaults: `https://login.microsoftonline.com` and `https://graph.microsoft.com/v1.0`. India uses the global service. |
| `requestTimeoutMs` (15000), `maxRetries` (3), `retryBaseDelayMs` (500), `maxRetryDelayMs` (30000) | no | Tuning. |
| `maxConcurrentPerMailbox` (4, max 4), `subscriptionLifetimeMinutes` (10000, max 10080), `useImmutableIds` (true), `tokenRefreshSkewMs` (300000) | no | Tuning. |

### App registration and permissions (application, admin consent)

| Need | Least-privileged application permission |
| --- | --- |
| getSchedule | `Calendars.ReadBasic` (`Calendars.Read` or `Calendars.ReadWrite` also work) |
| Create, update, cancel, delete events | `Calendars.ReadWrite` |
| Event change subscriptions | `Calendars.Read` (listed on the create-subscription page) |
| Look up an onlineMeeting by join URL | `OnlineMeetings.Read.All` |
| Attendance reports and records | `OnlineMeetingArtifact.Read.All` |

Both online-meeting rows also need a **Teams application access policy**. A Teams admin runs `New-CsApplicationAccessPolicy -Identity Phoenix-CRM -AppIds "<clientId>"`, then `Grant-CsApplicationAccessPolicy -PolicyName Phoenix-CRM -Identity <user object id>` (or `-Global`). Changes can take up to 30 minutes to apply. Without the policy, these calls fail with `kind: 'permission'`.

Application `Calendars.*` permissions cover **every mailbox in the tenant**. Ask the customer's Exchange admin to scope the app to the counsellors' or sales team's mailboxes (Exchange Online application access policies, or RBAC for Applications). This document hasn't verified those steps (see Unconfirmed).

## Webhooks

### Setup

1. Deploy the route first. Graph validates `notificationUrl`, and `lifecycleNotificationUrl` too, **while** `POST /subscriptions` is running.
2. Call `createSubscription({ mailbox })` once per mailbox. Store `id` and `expiresAt`.
3. Renew well before expiry. Outlook event subscriptions last at most 10,080 minutes (under 7 days); the default is 10,000. Renewing daily, or whenever less than 48 h remain, is a safe schedule. Every notification also carries `subscriptionExpirationDateTime`.
4. Handle lifecycle events:
   * `subscription.reauthorization_required`: `renewSubscription(id)`, which reauthorizes and extends in one call. Alternatively call `reauthorizeSubscription(id)`, but don't do both within 10 minutes.
   * `subscription.removed`: create the subscription again, then resync the calendar. Delta sync isn't in this client yet.
   * `subscription.missed`: resync, because some notifications were dropped.
5. Optional: restrict inbound traffic to Microsoft's published notification IP ranges ("additional endpoints for Microsoft 365").

### Route sketch (wave 2)

```js
router.post('/webhooks/msgraph/:connectionId', express.raw({ type: () => true, limit: '4mb' }), async (req, res) => {
  const graph = await clientFor(req.params.connectionId);
  const handshake = graph.validationResponse(req.query);           // Graph's endpoint validation
  if (handshake) return res.status(handshake.status).set(handshake.headers).send(handshake.body);
  const check = graph.verifyNotification(req.body, req.headers, { isKnownSubscription });
  if (check.reason && check.notifications.length === 0 && !check.rejected.length) return res.sendStatus(400); // not JSON / empty
  await enqueue(parseWebhook({ value: check.notifications }));     // dedupe on event.dedupeKey
  if (check.rejected.length) log.warn({ rejected: check.rejected }, 'msgraph notifications rejected');
  res.sendStatus(202);                                              // within 3 s, always after queueing
});
```

Respond with **2xx within 3 seconds**. Graph treats anything else as a failure and redelivers for up to 4 hours, with a 10 s timeout on retries. Endpoints that are often slow get delayed ("slow" state), and then their notifications get dropped ("drop" state); dropped notifications can't be recovered. So verify, enqueue and return 202. Don't call Graph inside the request.

### Verification scheme (exact)

* **Handshake.** Graph sends `POST {url}?validationToken=<opaque>` with `Content-Type: text/plain`. `validationResponse` reads the URL-decoded token from the query and answers `200`, `text/plain; charset=utf-8`, with the token as the entire body, plus `nosniff` and `no-store`. Graph allows 10 seconds. Tokens that contain `<`, `>` or control characters, or that are over 8192 characters, get a 400 with an empty body. Graph says it never sends markup.
* **Change and lifecycle notifications.** Basic notifications are **not signed** by Graph. The documented authenticity check is that `clientState` matches the value set on the subscription (at most 128 characters). Phoenix makes `clientState` a MAC:

  ```
  clientState = "v1." + nonce + "." + base64url( HMAC-SHA256( webhookSecret, "msgraph.clientState.v1." + nonce ) )
  nonce       = 16 random bytes, base64url (22 chars) → clientState is 69 chars
  ```

  `verifyWebhook(rawBody, headers, secret | secrets[], options)` parses the **raw body**: Content-Type must be JSON when present, the body must be at most 4 MB, and it must have a non-empty `value[]`. It then checks every item:
  1. `clientState` recomputed and compared with `crypto.timingSafeEqual`, against the current and each previous secret, with no early exit.
  2. `subscriptionId` is a GUID.
  3. `tenantId` equals the configured tenant GUID.
  4. The optional `isKnownSubscription(id)` returns true.
  5. The item has `changeType` or `lifecycleEvent`.
  6. **Expiry.** Graph defines no timestamp on notifications, so there's no signature-age tolerance. Items are rejected when `subscriptionExpirationDateTime` is more than 4 h 15 min in the past. That's Graph's 4-hour redelivery window plus 15 min of skew.

  It returns `{ valid, reason, notifications, rejected: [{ index, reason }], validationTokensChecked }`. Valid items are returned even when others in the batch fail. One batch can mix several subscriptions.
* **Replay and dedupe.** `parseWebhook` gives each event `id` (Graph's optional notification `id`, or `derived:<hash>`) and a `dedupeKey`. The key is sha256 of subscriptionId, changeType or lifecycleEvent, the resource ID, `@odata.etag`, and, for lifecycle events, the subscription expiry. Store the keys for at least 4 hours.
* **Rich notifications (not used by default).** If `includeResourceData` is ever turned on, payloads carry `validationTokens` (RS256 JWTs). `verifyValidationToken` / `verifyWebhook({ jwks, clientId })` check the signature against the supplied Microsoft JWKS, `exp`/`nbf` (with a 300 s tolerance), `aud` = our client ID, `iss` = `https://login.microsoftonline.com/{tid}/v2.0` (or `https://sts.windows.net/{tid}/` for v1.0), `tid`, and the publisher. The publisher is `azp` for v2.0 tokens and `appid` for v1.0, and must equal `0bf30f3b-4a52-48df-9a82-234910c4a086`. The caller fetches and caches the JWKS from `https://login.microsoftonline.com/common/.well-known/openid-configuration` → `jwks_uri`. Keys rotate daily.

Test vectors (webhook secret `whsec-test-0123456789abcdef0123456789abcdef`), recomputed independently with `node:crypto` in `webhook.test.js`:

| nonce | clientState |
| --- | --- |
| `AAECAwQFBgcICQoLDA0ODw` | `v1.AAECAwQFBgcICQoLDA0ODw.m5lQXkS4qjI772P3LvRasgC1-IapNOUs74T12WeOCw4` |
| `phoenix-crm-sub-0001` | `v1.phoenix-crm-sub-0001.mSE7pOSme91JwEr30a6MemXLxeeB9l0Y2NUbOd8qf78` |

Microsoft publishes no signature examples to check these against, because basic notifications have no signature. The JWT checks are tested with locally generated RSA keys and claims shaped like the example token in Graph's docs.

### Normalised events (`parseWebhook`)

`{ provider: 'msgraph', id, providerEventId, dedupeKey, kind: 'change'|'lifecycle', type, changeType, lifecycleEvent, subscriptionId, subscriptionExpiresAt, tenantId, resource, resourceType, resourceId, etag, mailboxId }`, where `type` is one of `calendar.event.created|updated|deleted|unknown` or `subscription.reauthorization_required|removed|missed|unknown`. Basic notifications carry no event data. Fetch the event with `getEvent(mailboxId, resourceId)`. A 404 means it was deleted.

## Rate limits (Microsoft documentation, checked 2026-11-05)

| Scope | Limit |
| --- | --- |
| Outlook (calendar), per app and mailbox | 10,000 requests per 10 minutes; **4 concurrent requests**; 150 MB of uploads per 5 minutes |
| Subscriptions, per app per tenant (all tenants) | POST/PATCH/DELETE 500 (2,000) per 20 s; reauthorize 1,000 (4,000) per 20 s; GET by ID 500 (2,000) per 20 s; list 25 (40) per 20 s |
| Global, per app across all tenants | 130,000 requests per 10 s |
| Meeting information (cloud communications) | 2,000 meetings per user per month |
| Throttled response | `429 Too Many Requests` plus `Retry-After` (seconds). With no header, use exponential backoff. 503 may also carry `Retry-After`. |
| Notification endpoint | 2xx within 3 s. "Slow" when more than 10% of responses take over 3 s in a 10-min window; "drop" when more than 15% take over 10 s |

## Sandbox and test mode

* Graph has **no sandbox endpoint**. Testing needs a real Microsoft 365 tenant.
  * Option 1: the Microsoft 365 Developer Program E5 sandbox (25 licences, short-lived, with sample calendar and Teams data). It is available only to qualifying members: Visual Studio Professional/Enterprise subscribers, ISV Success, or eligible Microsoft AI Cloud Partner Program tiers.
  * Option 2: a separate trial or test tenant with a few licensed test users.
  * Never point development at a customer's production tenant.
* Webhooks need a public HTTPS URL, such as a staging deployment or a tunnel. Graph doesn't deliver to `localhost` or plain HTTP.
* Unit tests use the fake `fetch` in `test/providers/msgraph/helpers.js`. They make no network calls. Run them with:
  `cd apps/api && node --test test/providers/msgraph/`. The folder's `index.js` makes the directory form work on Node 24. You can also use the glob `"test/providers/msgraph/*.test.js"` or run `npm test`.

## India-specific notes

* There's no Indian national cloud. Tenants in India use the global endpoints `graph.microsoft.com` and `login.microsoftonline.com`.
* Mailboxes in India usually report the Windows time-zone name `India Standard Time` (Asia/Kolkata, UTC+05:30, no DST). The client never sends local times: it converts everything to UTC and asks for UTC back, so IST bookings need no DST handling. Show IST in the UI from the platform's `locale.timeZone` setting.
* Many Indian institutes work Monday to Saturday. `workingHours.daysOfWeek` from getSchedule reflects each mailbox's own setting, so don't assume Mon–Fri.
* Teams dial-in numbers (`onlineMeeting.tollNumber`) may be +91 numbers, but only when the organizer has Audio Conferencing. Treat the field as optional; the client returns `null` when it's absent.
* Personal data (DPDP Act 2023): attendee emails, names and attendance intervals for families and students are personal data. The client never logs bodies, emails, subjects or tokens. Its logs contain only the operation, method, status, attempt, duration and request-id. Store attendance only for the stated purpose (admissions follow-up) and apply the platform's retention rules.

## Sources (fetched 2026-11-05; "updated" is the page's own updated_at)

* OAuth 2.0 client credentials flow, Microsoft identity platform (updated 2026-06-15): https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow
* calendar: getSchedule (updated 2026-05-19): https://learn.microsoft.com/en-us/graph/api/calendar-getschedule?view=graph-rest-1.0
* Create event (updated 2026-08-03): https://learn.microsoft.com/en-us/graph/api/user-post-events?view=graph-rest-1.0
* event resource type, including transactionId (updated 2026-04-20): https://learn.microsoft.com/en-us/graph/api/resources/event?view=graph-rest-1.0
* Update event (updated 2026-05-19) · event: cancel (updated 2026-05-14) · Delete event (updated 2026-05-14): https://learn.microsoft.com/en-us/graph/api/event-update · …/event-cancel · …/event-delete
* Receive change notifications through webhooks (updated 2026-04-22): https://learn.microsoft.com/en-us/graph/change-notifications-delivery-webhooks
* Lifecycle notifications (updated 2026-04-07): https://learn.microsoft.com/en-us/graph/change-notifications-lifecycle-events
* subscription resource type and lifetimes (updated 2026-09-17): https://learn.microsoft.com/en-us/graph/api/resources/subscription?view=graph-rest-1.0
* Create subscription (updated 2026-04-07) · Update subscription: https://learn.microsoft.com/en-us/graph/api/subscription-post-subscriptions?view=graph-rest-1.0
* changeNotification resource: https://learn.microsoft.com/en-us/graph/api/resources/changenotification?view=graph-rest-1.0
* Change notifications with resource data and validation tokens (updated 2026-04-17): https://learn.microsoft.com/en-us/graph/change-notifications-with-resource-data
* Throttling guidance (updated 2025-08-06) and service-specific limits (updated 2026-09-17): https://learn.microsoft.com/en-us/graph/throttling · https://learn.microsoft.com/en-us/graph/throttling-limits
* List meetingAttendanceReports and attendanceRecords (updated 2026-10-28): https://learn.microsoft.com/en-us/graph/api/meetingattendancereport-list?view=graph-rest-1.0 · …/attendancerecord-list
* Get onlineMeeting (updated 2026-10-28): https://learn.microsoft.com/en-us/graph/api/onlinemeeting-get?view=graph-rest-1.0
* Online meeting application access policy (updated 2025-08-06): https://learn.microsoft.com/en-us/graph/cloud-communication-online-meeting-application-access-policy
* Immutable IDs for Outlook (updated 2025-08-06): https://learn.microsoft.com/en-us/graph/outlook-immutable-id
* Error responses (updated 2025-08-06): https://learn.microsoft.com/en-us/graph/errors
* National cloud deployments: https://learn.microsoft.com/en-us/graph/deployments
* Microsoft 365 Developer Program FAQ (updated 2026-10-26): https://learn.microsoft.com/en-us/office/developer-program/microsoft-365-developer-program-faq

## Unconfirmed (not stated in the docs above, or the docs disagree)

* **Re-POSTing the same `transactionId`.** Microsoft says the property exists "to avoid redundant POST operations", but doesn't document the response to a duplicate (the existing event, or an error). Exercise it against a test tenant before relying on job-level retries.
* **Combined `Prefer` header.** The client sends `Prefer: outlook.timezone="UTC", IdType="ImmutableId"` as one comma-separated header. RFC 7240 allows this, but Graph's docs only show single preferences.
* **JoinWebUrl filter encoding.** The client percent-encodes the whole `$filter` value once, so the join URL's own `%3a` becomes `%253a` on the wire and Graph decodes it back. The docs show the pattern but don't say how to encode it.
* **Event notification resource format.** The docs' example is for messages (`users/{id}@{tenant}/messages/{id}`). The fixtures assume events look like `Users/{id}/Events/{id}`. The parser accepts either casing and either form.
* **`clientState` limit.** It is 128 characters on the subscription page and 255 on the changeNotification page. Phoenix uses 69.
* **`availabilityView` digits.** The getSchedule example shows `workingElsewhere` and `oof` as `0`. The client exposes the raw string and status items, and computes `busy` from item statuses rather than digits.
* **getSchedule limits.** The page states no maximum for the number of `schedules` or the time span. It only gives the error for more than 1,000 calendar entries.
* **`POST /subscriptions/{id}/reauthorize` status code.** Not checked; any 2xx is treated as success.
* **`Calendars.ReadWrite` for subscriptions.** Only `Calendars.Read` is listed for creating event subscriptions. It's assumed that granting `Calendars.ReadWrite` alongside it is fine.
* **Scoping app access to selected mailboxes.** The steps for Exchange application access policies or RBAC for Applications weren't checked this session.
* **Validation-token characters.** Microsoft calls the token opaque. The 8192-character cap and the rejection of markup and control characters are Phoenix policy. `+` in the query string is decoded as a space (standard form decoding, as Express does).
* **`Retry-After` on 503/504 and on Outlook `MailboxConcurrency` 429s.** The docs say it "can" be present. The client falls back to backoff when it isn't.
* **Teams Audio Conferencing in India,** and whether `tollNumber` is set for Indian organizers.
* **Client secret maximum lifetime** in the Entra portal.
