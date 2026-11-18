# Zoom Meetings provider

A Zoom client for Phoenix with no dependencies beyond zod. It schedules demo and counselling meetings, receives Zoom webhooks, and works out who attended. Wave 2 wraps it in the `meetings` adapter interface.

- Code: `apps/api/src/integrations/providers/zoom/`
- Tests: `apps/api/test/providers/zoom/` (run them with `cd apps/api && node --test "test/providers/zoom/*.test.js"`; Node 24 does not accept a bare directory argument)
- Auth model: one **Server-to-Server OAuth** app per Zoom account (a company connection), using `grant_type=account_credentials`.

## Capabilities

| Capability | Function | Zoom endpoint | Scopes (classic / granular) | Rate-limit label |
| --- | --- | --- | --- | --- |
| Test connection | `client.getAccessToken()` | `POST https://zoom.us/oauth/token` | n/a | n/a |
| Create meeting | `client.createMeeting(input)` | `POST /users/{userId}/meetings` → 201 | `meeting:write:admin` / `meeting:write:meeting:admin` | Light, plus 100 per host per day |
| Get meeting | `client.getMeeting(id, { occurrenceId })` | `GET /meetings/{meetingId}` | `meeting:read:admin` / `meeting:read:meeting:admin` | Light |
| Update meeting | `client.updateMeeting(id, patch, { occurrenceId })` | `PATCH /meetings/{meetingId}` → 204 | `meeting:write:admin` / `meeting:update:meeting:admin` | Light, plus 100 per day |
| Delete meeting | `client.deleteMeeting(id, { occurrenceId, notifyHosts, notifyRegistrants })` | `DELETE /meetings/{meetingId}` → 204 | `meeting:write:admin` / `meeting:delete:meeting:admin` | Light |
| Participants report | `client.listParticipants(idOrUuid)` / `iterateParticipants` | `GET /report/meetings/{id}/participants` (default) | `report:read:admin` / `report:read:list_meeting_participants:admin` | **Heavy**, Pro plan or higher |
| Past participants | `listParticipants(idOrUuid, { source: 'past' })` | `GET /past_meetings/{id}/participants` | `meeting:read:admin` / `meeting:read:list_past_participants:admin` | Medium, paid plan |
| Past meeting details | `client.getPastMeeting(idOrUuid)` | `GET /past_meetings/{id}` | `meeting:read:admin` / `meeting:read:past_meeting:admin` | Light |
| Past instances | `client.listPastInstances(id)` | `GET /past_meetings/{id}/instances` | `meeting:read:admin` / `meeting:read:list_past_instances:admin` | Medium |
| Webhook verify | `verifyWebhook(rawBody, headers, secret, { now, toleranceSeconds })` | n/a | n/a | n/a |
| URL validation | `buildUrlValidationResponse(plainToken, secret)` | n/a | n/a | n/a |
| Webhook route | `handleWebhookRequest({ rawBody, headers }, { secret })` or `client.webhooks.handle()` | n/a | n/a | n/a |
| Parse events | `parseWebhook(body, { headers })` | `meeting.participant_joined`, `meeting.participant_left`, `meeting.started`, `meeting.ended`, `endpoint.url_validation` | `meeting:read:participant:admin` for participant events | n/a |
| Attendance | `computeAttendance(sessions, options)`, `sessionsFromWebhookEvents(events)` | n/a (pure) | n/a | n/a |

The pure helpers (webhooks, attendance, normalisers) need no config and no network.

## Config fields

Validated by `zoomConfigSchema` (zod). A failed validation throws `ZoomConfigError`, which names the bad fields but never shows their values.

| Field | Required | Default | Where to get it |
| --- | --- | --- | --- |
| `accountId` | yes | | Zoom App Marketplace → Develop → Build App → **Server-to-Server OAuth** → App credentials → Account ID |
| `clientId` | yes | | Same page → Client ID |
| `clientSecret` | yes (secret) | | Same page → Client secret. Regenerating it invalidates the old one. |
| `webhookSecretToken` | for webhooks (secret) | | The app's **Features → Access** page → Secret Token (the token itself is not shown in this repository) |
| `apiBaseUrl` | no | `https://api.zoom.us/v2` | Global by default. Set `https://api-in.zoom.us/v2` to pin the India region. |
| `oauthTokenUrl` | no | `https://zoom.us/oauth/token` | |
| `useTokenApiUrl` | no | `false` | When true, calls go to the `api_url` that comes back with the token (the regional cluster), but only if that host is under `*.zoom.us`. |
| `defaultHostUserId` | no | `me` | The Zoom user ID or email that hosts meetings when a call names no host. With S2S, `me` is the app owner. |
| `defaultTimezone` | no | `Asia/Kolkata` | Zoom uses this only to display times. `start_time` is always sent in UTC. |
| `timeoutMs` | no | 10000 | Timeout for each attempt, set with `AbortSignal.timeout` |
| `maxRetries` | no | 2 | Applies to idempotent calls only |
| `retryBaseDelayMs` / `maxRetryDelayMs` | no | 500 / 15000 | Exponential backoff with 50–100% jitter. If Retry-After asks for a longer wait than the maximum, the client throws instead of waiting. |
| `tokenRefreshSkewSeconds` | no | 60 | How long before expiry the token is refreshed (Zoom's Rivet SDK also uses 60 s) |
| `webhookToleranceSeconds` | no | 300 | Phoenix policy, not a Zoom rule. 0 turns the check off. |
| `meetingSettings` | no | `{}` | Raw Zoom `settings` merged over `DEMO_MEETING_SETTINGS` for every created meeting (per company) |

Setting up the app: create a Server-to-Server OAuth app, add the scopes from the table above, add an Event Subscription (next section), then **Activate** the app. Tokens stop working when the app is deactivated. An account admin has to grant the scopes to the app developer's role.

## Meetings

- **Times**: inputs are instants (a `Date`, or ISO 8601 with an offset such as `2026-11-10T16:00:00+05:30`). The client sends `start_time` as `yyyy-MM-ddTHH:mm:ssZ` (UTC, no milliseconds) plus `timezone` for display. Every normalised output is a UTC ISO string. A scheduled start more than 5 minutes in the past is rejected, because Zoom would otherwise silently move it to "now".
- **Demo defaults** (`DEMO_MEETING_SETTINGS`): host and participant video on, waiting room on (the host admits prospects), join before host off, no registration (`approval_type: 2`), audio `both`, `auto_recording: 'none'`, no sign-in required (prospects rarely have Zoom accounts), and Zoom-generated passcode (`default_password` is left at its default, and the passcode is embedded in `join_url`). Settings the Zoom account admin has locked still override these.
- `alternativeHosts` becomes `settings.alternative_hosts` (separated by `;`). `invitees` becomes `settings.meeting_invitees`. `settings` is an escape hatch for raw Zoom settings and is merged last.
- `kind: 'instant'` creates a type 1 meeting with no start time.
- **IDs**: meeting IDs are int64 values and Zoom says they can be longer than 10 digits. They are returned as digit strings. The JSON parser keeps integers above 2^53 as strings (on Node 21+, through the reviver's `context.source`).
- **`startUrl` is a host credential**: anyone who has it can start the meeting as the host. It expires after 2 hours (90 days for `custCreate` users). Never send it to attendees or write it to logs. Call `getMeeting` to get a fresh one.
- Update is a PATCH that sends only the changed fields and returns `{ updated: true }`. Call `getMeeting` for the new state.
- Delete is idempotent: a 404 counts as `{ deleted: true, alreadyDeleted: true }`. Notification emails are off by default (`schedule_for_reminder=false`, `cancel_meeting_reminder=false`), because the CRM sends its own.

## Retries, idempotency and errors

Zoom has **no idempotency keys**. The client therefore follows these rules:

- **Idempotent calls** (GET, PATCH, DELETE and token requests) are retried up to `maxRetries` times on network errors, timeouts, 5xx and 429. A Retry-After value (seconds or a date) is honoured.
- **Create meeting (POST) is never retried automatically.** A 5xx or timeout on create gives an error with `ambiguous: true` and `retryable: false`, because the meeting may have been created. The caller must reconcile before trying again, for example by storing a pending booking and checking the host's upcoming meetings by topic and start time. A 429, or a connection refused before anything was sent (`ECONNREFUSED`, `ENOTFOUND`), gives `retryable: true` with `ambiguous: false`, so the caller may retry later. A 401 is handled by one token refresh (next point).
- **A 401 from the API** (code 124 "Invalid/expired access token", or 4700) drops the cached token. The call is retried once with a new token, which is safe for any method because Zoom rejected the request. A second 401 gives `ZoomAuthError`.
- **Daily limits**: a 429 whose `X-RateLimit-Type` or message says "daily" and that has no Retry-After gets `retryAfterMs` set to the next 00:00 UTC, when Zoom resets per-user create and update counts.

| HTTP / Zoom code | Error class | `kind` | retryable |
| --- | --- | --- | --- |
| Invalid config | `ZoomConfigError` | config | no |
| 400, 422 | `ZoomValidationError` (`details` = Zoom `errors[]`) | validation | no |
| 400 with code 200 ("No permission" / "Only available for paid account") or 3161 (user not allowed to host) | `ZoomPermissionError` | permission | no |
| 401 (after one token refresh), or the token endpoint answering 4xx | `ZoomAuthError` | auth | no |
| 403 | `ZoomPermissionError` | permission | no |
| 404 (code 3001: meeting not found or expired) | `ZoomNotFoundError` | not_found | no |
| 409 | `ZoomValidationError` | conflict | no |
| 429 | `ZoomRateLimitError` (`retryAfterMs`, `limitType`, `limitCategory`) | rate_limited | yes |
| 5xx | `ZoomServerError` | server | yes if idempotent; otherwise `ambiguous` |
| Network failure or timeout | `ZoomNetworkError` | network / timeout | yes if idempotent or never sent; otherwise `ambiguous` |
| Invalid caller input | `ZoomValidationError` (thrown before any request) | validation | no |

Every error has `provider: 'zoom'`, `status`, `providerCode`, `method` and `path`, and a `toJSON()` that is safe to log. The client secret, the webhook secret and the current access token are replaced with `[REDACTED]` in every error message. The logger (pino-compatible, injected) receives only method, path, status, attempt and duration. It never sees headers or bodies.

## Webhooks

### Setup

1. In the app's Features → Access page, turn on **Event Subscriptions** and add a subscription. An app can have at most 20 subscriptions.
2. Choose events: Meeting → *Participant/Host joined meeting* (`meeting.participant_joined`), *Participant/Host left meeting* (`meeting.participant_left`), *Start Meeting* and *End Meeting* (`meeting.ended`). Participant events need the scope `meeting:read:participant(:admin)`.
3. Endpoint URL: a public **HTTPS** fully qualified domain name with TLS 1.2+ and a CA-issued certificate, which accepts JSON POSTs. Click **Validate**: Zoom sends `endpoint.url_validation`, and the subscription cannot be saved until it passes.
4. Zoom revalidates the URL **every 72 hours**. It emails the account owner after 2 and after 4 consecutive failures, and turns the subscription off after 6.
5. Answer every notification with 200 or 204 **within 3 seconds**. Queue the work and reply first. For responses ≥500 and timeouts, Zoom retries 3 times: 5 minutes after the first attempt, then 20 minutes later, then 60 minutes later. It never retries 3xx or 4xx responses.

Express wiring: the route needs the **raw body**, and the app's global `express.json()` would consume it first. Mount the webhook route before that parser, or give the route its own raw parser:

```js
router.post('/webhooks/zoom/:connectionId', express.raw({ type: '*/*', limit: '256kb' }), async (req, res) => {
  const result = handleWebhookRequest({ rawBody: req.body, headers: req.headers }, { secret: connection.webhookSecretToken });
  res.status(result.status).json(result.body);
  for (const event of result.events) await enqueue(event); // de-duplicate on event.id
});
```

### Verification scheme (exact)

```
message   = "v0:" + <x-zm-request-timestamp header, as received> + ":" + <raw request body bytes>
signature = "v0=" + lowercase_hex( HMAC-SHA256( key = webhookSecretToken, message ) )
valid     = constantTimeEqual(signature, x-zm-signature header)  AND  |now - timestamp| <= tolerance
```

- `x-zm-request-timestamp` is in **seconds**. `event_ts` in the body is in milliseconds.
- The HMAC is computed over the **raw bytes**. Zoom's own sample re-serialises the parsed JSON (`JSON.stringify(req.body)`), which only works when the body survives a parse and re-serialise unchanged. Raw bytes are always exact.
- The signature is compared as 32 bytes with `crypto.timingSafeEqual`, after a format check (`^v0=[0-9a-f]{64}$`, case-insensitive).
- Tolerance: **Zoom does not document one.** Phoenix rejects timestamps more than 300 s away from now in either direction (`webhookToleranceSeconds`). If production shows that Zoom's retries keep the original timestamp, raise it above 85 minutes (see Unconfirmed).
- To rotate the secret, pass `[newSecret, oldSecret]`. Every candidate is checked, and `secretIndex` says which one matched.
- `verifyWebhook` never throws. It returns `{ valid: false, reason }`, where reason is one of `missing_secret`, `invalid_body`, `missing_signature`, `missing_timestamp`, `malformed_signature`, `malformed_timestamp`, `timestamp_out_of_tolerance` or `signature_mismatch`.

### URL validation

Zoom sends `{"payload":{"plainToken":"…"},"event_ts":…,"event":"endpoint.url_validation"}`. The answer is `{ plainToken, encryptedToken }`, where `encryptedToken = hex(HMAC-SHA256(secret, plainToken))`.

`handleWebhookRequest` **answers only signed challenges**, as Zoom's sample does. Answering an unsigned challenge would hand an attacker an HMAC oracle: sending `plainToken = "v0:<ts>:<forged body>"` would return a valid signature for a forged event.

### Test vectors

- **Official** (Zoom docs example): secret `SECRET_TOKEN` (worked out by checking candidates against the published value), plainToken `qgg8vlvZRS6UYooatFL8Aw` → `23a89b634c017e5364a1c8d9c8ea909b60dd5599e2bb04bb1558d9c3a121faa5`. The test suite reproduces it.
- The docs' signature example (`v0=a05d830f…8es270341`) is a placeholder: it is 61 characters and contains a non-hex `s`, so it cannot be reproduced.
- **Self-computed** with node:crypto (secret `test-webhook-secret-token`, timestamp `1793869200`): the official `participant_joined` example body gives `v0=1f99899de548122ef60c354dd11b3a363b38c87fff8b5ee66cebe77500861b57`. More vectors, including a Devanagari body, are in `webhooks.test.js`.

### Normalised events

`parseWebhook` returns `ZoomWebhookEvent[]`, one per request. Each event has these fields:

- `provider`, `type` (`participant.joined | participant.left | meeting.started | meeting.ended | url_validation | unknown`) and `providerEventType`
- `occurredAt` (UTC), `accountId`, `requestId` (the `x-zm-request-id` header, when headers are passed)
- `meeting {id, uuid, hostId, hostEmail, topic, type, startTime, endTime, timezone, durationMinutes}`
- `participant {userId, zoomUserId, participantUuid, registrantId, name, email, customerKey, phoneNumber, joinTime, leaveTime, leaveReason, …}`
- `raw`

**Event ID**: Zoom puts no event ID in the body. `id` is therefore `zoom_` followed by the first 32 hex characters of a SHA-256 over (event, event_ts, account_id, meeting UUID, participant session, join/leave time). Those fields are the same on every retry of a notification, so it works as a de-duplication key, even if the body is re-serialised. Unknown events are kept with `type: 'unknown'`. Malformed bodies give `[]`.

Zoom's official `participant_joined` example has `date_time`, while the schema field is `join_time`. The parser reads both.

## Attendance

Zoom reports one row per **join session**. A person who drops and rejoins gets a new meeting-scoped `user_id` and a new row, so Zoom's per-row `duration` understates their time. `computeAttendance(sessions, { thresholdMinutes | thresholdRatio, meetingStart, meetingEnd, now, includeWaitingRoom, keyOf })` handles this in five steps:

1. **Group sessions into people.** Sessions that share any strong identifier are one person: registrant ID, email (lower-cased), Zoom user ID or SDK customer key. This uses union-find, so chains of shared identifiers merge too. A session with no strong identifier joins the single group with the same display name (normalised for case, spacing and NFKC). If no group or several groups share that name, it is grouped by name alone. Two guests with the same name and no email are merged; pass `keyOf` to override.
2. **Clip** every session to `[meetingStart, meetingEnd]` when given (use `getPastMeeting()` for the actual start and end).
3. **Close open sessions** (no leave time) at `meetingEnd`, or at `now`. Without either, they are ignored.
4. **Merge** overlapping or touching intervals, so two devices or the overlap during a reconnect are never counted twice.
5. **Compare** with the threshold: minutes, a share of the window, or both (the stricter applies). The comparison is inclusive.

Rows with `status: 'in_waiting_room'` are excluded by default. Each attendee gets `attendedSeconds`, `attendedMinutes`, `attendedRatio`, `sessionCount` (rejoins = count − 1), the merged `intervals`, `firstJoinAt`, `lastLeaveAt`, `stillInMeeting` and `meetsThreshold`.

For live attendance, `sessionsFromWebhookEvents(events)` rebuilds sessions from joined/left webhooks. It drops duplicate events by `id`, sorts out-of-order deliveries, and pairs joined/left by `user_id`. A "left" with no "joined" starts at the meeting's start time. `meeting.ended` or `endAt` closes sessions that are still open. Recommended flow: use webhooks for live status, then reconcile with `listParticipants(uuid)` after `meeting.ended`. The report can lag: Zoom notes that durations may read 0 until processing finishes.

**UUIDs**: pass the instance UUID from `meeting.ended` or `listPastInstances` to target one occurrence. A numeric ID means "latest instance". Zoom requires double URL-encoding for a UUID that begins with `/` or contains `//` (report docs), or contains any `/` (past_meetings docs). `encodeMeetingRef` double-encodes whenever there is a `/`, which satisfies both rules, and encodes other UUIDs once (`+` and `=` still need escaping).

## Rate limits

Limits apply per **account** and are shared by every app on it (developers.zoom.us/docs/api/rate-limits):

| Request type | Free | Pro | Business+ (incl. Education) |
| --- | --- | --- | --- |
| Light | 4/s, 6,000/day | 30/s | 80/s |
| Medium | 2/s, 2,000/day | 20/s | 60/s |
| Heavy | 1/s, 1,000/day | 10/s* | 40/s* |
| Resource-intensive | 10/min, 30,000/day | 10/min* | 20/min* |

\* Heavy and resource-intensive calls share a daily total: 30,000/day on Pro and 60,000/day on Business+.

Per-user limits:

- **100 meeting create/update requests per host per day (UTC)**, reset at 00:00 UTC. Spread demo bookings across hosts.
- 3 registration requests per day for the same registrant.

Apps with high error rates can be disabled by Zoom, so validate input before calling (the client does).

## Sandbox / test mode

Zoom has **no sandbox environment**. Options:

- A separate Zoom account for development, or a Zoom Build developer plan (it uses the Pro rate limits).
- The report endpoints need **Pro or higher**, and `past_meetings` participants needs a paid plan. On a free account, use webhooks for attendance.
- To receive webhooks locally, use an HTTPS tunnel with a valid certificate (cloudflared or ngrok), because Zoom rejects plain HTTP and self-signed certificates.
- Unit tests never touch the network. They use an injected fake `fetch`, a fixed clock and a no-op `sleep`.

## India-specific notes

- **Data residency / region**: the India cluster is `https://api-in.zoom.us`. Set `apiBaseUrl` to it, or turn on `useTokenApiUrl` when the token's `api_url` points there. The global URL works for every account.
- **Time zones**: Zoom's list contains both `Asia/Kolkata` ("Mumbai, Kolkata, New Delhi") and the legacy `Asia/Calcutta` ("India"). Phoenix sends `Asia/Kolkata`. Meetings created in Zoom's own UI may come back with `Asia/Calcutta`, so treat the two as equal when comparing. IST is UTC+05:30 with no daylight saving time. The client always sends UTC, so offsets never matter for correctness.
- **Connectivity**: drops and rejoins on mobile data are common, which is why attendance merges sessions instead of trusting Zoom's per-row `duration`.
- **Personal data (DPDP Act 2023 and DPDP Rules 2025, notified 14 Nov 2025, with phased compliance over 18 months)**: participant names, emails, phone numbers and join times are personal data. Store only what attendance needs, tie it to the booking's purpose, and honour erasure requests. Zoom also blanks emails of external participants in many cases. Auto recording is off by default; recording a counselling session needs the participant's informed consent.
- Dial-in (`audio: 'both'`) depends on the account's audio plan. Indian toll-free or local numbers need Zoom's audio conferencing add-on (unconfirmed for India pricing).

## Adapter mapping (for wave 2)

`createZoomClient(config, { fetch, now, logger })` returns a frozen object, and every method is async and side-effect free beyond HTTP. Suggested adapter mapping:

| Adapter (kind: meetings) | Zoom client |
| --- | --- |
| `testConnection()` | `getAccessToken()` |
| `createMeeting(booking)` | `createMeeting({ hostUserId, topic, startTime, durationMinutes, timezone, agenda, invitees })` → store `id`, `uuid`, `joinUrl`. Keep `startUrl` server-side or don't store it. |
| `rescheduleMeeting` / `cancelMeeting` | `updateMeeting(id, { startTime, durationMinutes })` / `deleteMeeting(id)` |
| `getAttendance(meeting)` | `getPastMeeting(uuid)` + `listParticipants(uuid)` → `computeAttendance(participants, { thresholdMinutes, meetingStart, meetingEnd })` |
| Webhook route | `client.webhooks.handle({ rawBody, headers })` → status/body; de-duplicate `events[].id` |
| Error → job outcome | `retryable` → retry with `retryAfterMs`; `ambiguous` → reconcile; everything else → fail and surface `kind` |

`ZOOM_CAPABILITIES` lists the capability strings.

## Sources (fetched 2026-11-05)

- Server-to-Server OAuth: https://developers.zoom.us/docs/internal-apps/s2s-oauth/
- Using webhooks (structure, verification, URL validation, delivery and retries): https://developers.zoom.us/docs/api/webhooks/
- Zoom webhook sample: https://github.com/zoom/webhook-sample (`index.js`, README)
- Rate limits: https://developers.zoom.us/docs/api/rate-limits/
- Using Zoom APIs (regional URLs, meeting ID and UUID, double-encoding, time formats): https://developers.zoom.us/docs/api/using-zoom-apis/
- Errors: https://developers.zoom.us/docs/api/errors/
- Pagination: https://developers.zoom.us/docs/api/pagination/
- Meetings API OpenAPI spec (`meetingCreate`, `meetingUpdate`, `meetingDelete`, `meeting`, `reportMeetingParticipants`, `pastMeetingParticipants`, `pastMeetingDetails`, `pastMeetings`) and Meetings events spec (`meeting.participant_joined`, `meeting.participant_left`, `meeting.ended`, `meeting.started`), from developers.zoom.us API reference downloads
- Timezone list: https://developers.zoom.us/docs/api/references/abbreviations/
- Zoom Rivet JavaScript SDK (`@zoom/rivet`), for comparing token refresh skew (60 s) and webhook verification (no tolerance, re-serialised body)
- Zoom developer forum, 2020 threads on 429 headers (`X-RateLimit-Category`, `X-RateLimit-Type: QPS | Daily-limit`, `Retry-After` as an ISO date): community evidence only
- PIB backgrounder "DPDP Rules, 2025 Notified" (17 Nov 2025)

## Unconfirmed

- **Timestamp on retries**: whether `x-zm-request-timestamp` is regenerated for each delivery attempt or keeps the original value. If it keeps the original, the 300 s tolerance rejects Zoom's retries, which arrive 5 to 85 minutes later.
- Whether `x-zm-request-id` stays the same across retries. It is exposed as `requestId` but not used as the event ID.
- **Rate-limit headers** (`X-RateLimit-Category`, `X-RateLimit-Type`, `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `Retry-After`) are not in current official docs. They are known only from 2020 forum posts. The client reads them if present and falls back to 1 s (per-second limits) or the next 00:00 UTC (daily limits).
- The exact error body from the token endpoint (`{ reason, error }`) and its status codes for bad credentials or a wrong account ID: the client maps any 4xx except 429 to `ZoomAuthError`.
- Whether `start_time` in UTC (`…Z`) together with a `timezone` value keeps the UTC instant and uses `timezone` only for display. That is how the docs read, but it was not tested against a live account.
- Whether `participant_uuid` stays stable across rejoins. Pairing uses `user_id` first.
- Whether moving into or out of a breakout room fires `participant_left` / `participant_joined` for the main meeting (`*_breakout_room` events exist and are ignored here).
- Whether double-encoding a UUID that has no `/` would also be accepted (we encode those once).
- The free plan's meeting length cap, and India dial-in availability and pricing.
- There is no live end-to-end test against a real Zoom account; every behaviour is checked against docs and fakes.
- With Server-to-Server OAuth, `userId=me` resolves to the app owner. The S2S docs call `/users/me` but do not say this explicitly. Set `defaultHostUserId` to a real host to be safe.
