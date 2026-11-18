# Exotel (calling)

Exotel is an Indian cloud-telephony provider. The CRM uses it to:

- place click-to-call calls. Exotel rings the counsellor or sales rep first, then dials the family or institute and connects the two, showing an ExoPhone as the caller ID.
- receive call status updates: ringing, answered, and ended with duration and recording.
- capture leads from incoming calls on an ExoPhone, through a Passthru applet in the Exotel call flow.
- download call recordings.

Code: `apps/api/src/integrations/providers/exotel/`. It has no dependencies beyond `zod` and Node built-ins. Tests: `apps/api/test/providers/exotel/` (run `cd apps/api && node --test test/providers/exotel/`).

Facts were checked on 2026-11-05 against Exotel's docs. Anything I could not confirm is listed under [Unconfirmed](#unconfirmed).

## Capabilities

| Capability | Client API | Exotel API |
|---|---|---|
| Click-to-call (agent first, then customer) | `connectCall()` | `POST /v1/Accounts/{sid}/Calls/connect.json` |
| Caller ID selection (ExoPhone) | `callerId` config or input | `CallerId` |
| Call recording on/off, single/dual channel, mp3/mp3-hq | `record`, `recordingChannels`, `recordingFormat` | `Record`, `RecordingChannels`, `RecordingFormat` |
| Status webhooks (ringing / answered / terminal) | `verifyWebhook()` + `parseWebhook()` | `StatusCallback`, `StatusCallbackEvents[n]`, `StatusCallbackContentType` |
| Incoming-call leads (Passthru applet) | `buildFlowUrl()`, `parseWebhook()` gives `call.inbound` with `lead` | Passthru applet (GET query) |
| Agent leg events (Connect applet pass-through) | `parseWebhook()` gives `call.agent_leg` | Connect applet URL (GET) |
| Call details, used to reconcile missed callbacks | `getCall()` | `GET /v1/Accounts/{sid}/Calls/{CallSid}.json?details=true` |
| Recording download | `fetchRecording()` | `RecordingUrl` (Basic auth or IP allow-list) |
| TRAI number-series guard | `checkCallCompliance()`, `classifyIndianNumber()` | n/a (local rules) |

Not implemented: bulk call listing, the CCM/agent APIs (`ccm-api.*`), campaigns, SMS, WhatsApp, ExoPhone management, and live audio streaming (`StreamUrl`).

## Module API (for the adapter wrapper)

```js
import { createExotelClient } from './integrations/providers/exotel/index.js';

const exotel = createExotelClient(config, { fetch, now, logger }); // fetch/now/logger optional
exotel.kind;          // 'calling'
exotel.capabilities;  // ['click_to_call', ...]

const call = await exotel.connectCall({
  agentNumber: '+919123456789',     // E.164, Indian national formats, or sip:user@host
  customerNumber: '098765 43210',   // normalised to +919876543210
  ref: 'activity_01HF...',          // optional; sent as CustomField (<=128, [A-Za-z0-9._:-])
  purpose: 'service',               // 'service' | 'transactional' | 'promotional'
  record: true,
});
// call: { callId, status, direction, from, to, callerId, createdAt, ref, legs, price, complianceWarnings, raw, ... }

const details = await exotel.getCall(call.callId);    // final Duration/Price ~2 min after hang-up
const file = await exotel.fetchRecording(details.recordingUrl); // { contentType, sizeBytes, body }

// Webhook route (raw body!)
const check = exotel.verifyWebhook(rawBody, req.headers, { url: req.originalUrl, remoteIp: req.ip });
if (!check.valid) return res.status(401).end();
const events = exotel.parseWebhook(rawBody, { contentType: req.headers['content-type'], query: req.query });
res.status(200).end(); // reply within 15 s; queue the processing
```

Pure helpers are exported too: `verifyWebhook(rawBody, headers, secret, options)`, `parseWebhook(body, options)`, `signCallbackUrl`, `buildFlowUrl`, `normaliseCall`, `toE164`, `classifyIndianNumber`, `checkCallCompliance`, `toUtcIso`, `toMoney`, and every error class.

### Errors

Every error is an `ExotelError` with `code`, `retryable`, `kind` (`retryable` or `permanent`), `status`, `operation`, `providerCode`, `providerMessage` (redacted), `retryAfterMs` and `outcomeUnknown`. `toJSON()` is safe to log.

| Situation | Class | `code` | Retryable |
|---|---|---|---|
| Bad config | `ExotelConfigError` | `config_invalid` | no |
| Bad input, invalid phone, missing caller ID, compliance block, HTTP 400/422 | `ExotelValidationError` | `invalid_request`, `invalid_phone`, `caller_id_missing`, `compliance_blocked` | no |
| HTTP 401 / 403 | `ExotelAuthError` | `unauthorized` / `forbidden` | no |
| HTTP 404 | `ExotelNotFoundError` | `not_found` (`recording_not_available` for recordings, which is retryable later) | no / yes |
| HTTP 429 | `ExotelRateLimitError` | `rate_limited` | yes |
| HTTP 402 (balance / plan limit) | `ExotelProviderError` | `payment_required` | no |
| HTTP 409 | `ExotelProviderError` | `conflict` | no |
| HTTP 408 / 5xx | `ExotelProviderError` | `timeout` / `provider_unavailable` | yes |
| Network error / timeout / caller abort | `ExotelNetworkError` | `network_error` / `timeout` / `aborted` | yes / yes / no |
| Undecodable webhook | `ExotelWebhookError` | `webhook_invalid` | no |

`outcomeUnknown: true` appears on `connectCall` timeouts, network errors and 5xx responses. In those cases Exotel may have placed the call anyway. `error.details.ref` holds the `CustomField`. If the call was placed, its status callback arrives with that ref, so do not redial automatically.

### Retries, timeouts, idempotency

- Each attempt has its own timeout (`timeoutMs`, default 15 s), enforced with an `AbortController`. A caller's `signal` is combined with it.
- GET requests (`getCall`, `fetchRecording`) retry on network errors, timeouts, 408, 429 and 5xx. Backoff is exponential with jitter (`retryBaseDelayMs × 2^n`, randomised between 50% and 100%), up to `maxRetries` (default 2). A `Retry-After` header is honoured up to `maxRetryAfterMs` (30 s); a longer wait is returned to the caller as an error.
- `connectCall` is a POST and Exotel offers no idempotency keys, so the client only retries it on HTTP 429. A 429 means Exotel rejected the request without placing the call. `CustomField` (our `ref`) serves as the correlation key in place of an idempotency key.
- Rate limit: 200 requests per minute per account for the Voice v1 API. The client does no client-side throttling; the adapter or queue should cap concurrency per account.

## Configuration

Validated with zod (`exotelConfigSchema`), which rejects unknown keys. Error messages name the fields but never their values.

| Field | Required | Default | Where to get it |
|---|---|---|---|
| `accountSid` | yes | | Exotel Dashboard > Settings > API Settings (`https://my.exotel.com/apisettings/site#api-credentials`) |
| `apiKey` (secret) | yes | | Same page. It is the Basic-auth username. You can create extra keys there, with limited permissions. |
| `apiToken` (secret) | yes | | Same page. It is the Basic-auth password. |
| `region` | no | `singapore` | `singapore` uses `api.exotel.com`; `mumbai` uses `api.in.exotel.com`. If your dashboard is `my.exotel.in`, use `mumbai`. The wrong cluster makes authentication fail. |
| `baseUrl` | no | | Override for the host (https only) |
| `callerId` | for calls | | An ExoPhone on the account (Dashboard > ExoPhones). It can also be passed per call. |
| `statusCallbackUrl` | recommended | | Public https URL of our status webhook route |
| `webhookSecret` (secret) | recommended | | At least 32 random characters, generated by us. An array allows rotation: the first entry signs, every entry verifies. |
| `allowedWebhookIps` | no | `[]` | IPs or CIDRs of Exotel's callback servers. Ask Exotel support for them (they are not published). |
| `statusCallbackEvents` | no | `['terminal','answered']` | Add `ringing` if wanted. The answered and ringing events may need Exotel to enable them on the account. |
| `statusCallbackContentType` | no | `application/json` | or `multipart/form-data` |
| `callbackTtlSeconds` | no | 7 days | How long a signed callback URL is valid. The client always allows at least `TimeLimit` + 1 h. |
| `record`, `recordingChannels`, `recordingFormat` | no | `false`, `single`, `mp3` | |
| `timeLimitSeconds` | no | | Maximum call length, up to 14400 |
| `ringTimeoutSeconds` | no | | Sent as `TimeOut` (how long each leg rings) |
| `timeZoneOffset` | no | `+05:30` | Offset of Exotel's zone-less timestamps (see Times) |
| `currency` | no | `INR` | Currency of `Price` |
| `defaultCountryCode` | no | `91` | For numbers written without a country code |
| `timeoutMs`, `maxRetries`, `retryBaseDelayMs`, `maxRetryAfterMs` | no | 15000, 2, 300, 30000 | |
| `recordingTimeoutMs`, `maxRecordingBytes` | no | 120000, 100 MB | |

Secrets reach the client only through config. They are sent only in the `Authorization` header, never in URLs. Error messages pass through a redactor that removes the key, the token, the base64 Basic credential, webhook secrets and `user:pass@` URL credentials. The logger receives only metadata (operation, status, attempt, duration), never request bodies, phone numbers or headers.

## Click-to-call

`connectCall` sends a form-encoded `POST https://{host}/v1/Accounts/{sid}/Calls/connect.json` with header `Authorization: Basic base64(apiKey:apiToken)`:

| Form field | Value |
|---|---|
| `From` | Agent number (E.164 or SIP URI). Exotel calls this leg first. |
| `To` | Customer number (E.164). Exotel dials it once the agent answers. |
| `CallerId` | ExoPhone, sent exactly as configured (it is validated as a phone number first) |
| `CallType` | `trans` when given. `promo` is documented as no longer supported. |
| `TimeLimit`, `TimeOut`, `WaitUrl` | Optional |
| `Record`, `RecordingChannels`, `RecordingFormat` | When recording |
| `CustomField` | Our `ref` (128 characters at most). Exotel echoes it in callbacks, Passthru and call details. |
| `StatusCallback` | Signed URL (see below) |
| `StatusCallbackEvents[0..n]` | `terminal`, `answered`, `ringing` |
| `StatusCallbackContentType` | `application/json` or `multipart/form-data` |

The response is `{ "Call": { Sid, Status, Direction: "outbound-api", ... } }` and is normalised to `ExotelCall`. Leg 1 is the agent and leg 2 the customer. `Duration`, `Price` and `EndTime` become final about 2 minutes after the call ends, so use `getCall` (with `details=true`, which adds `ConversationDuration`, `Leg1Status`, `Leg2Status` and `Legs`) for final values. `Price` is returned as integer minor units (`{ amountMinor: 188, currency: 'INR' }` for `"1.875"`, rounded half up).

## Webhooks

Exotel calls us in three ways:

| Source | Configured where | Method / body | Normalised `type` |
|---|---|---|---|
| Status callback | `StatusCallback` on each `connectCall` (automatic) | POST, JSON or multipart (default payload: `CallSid`, `Status`, `RecordingUrl`, `DateUpdated`) | `call.ringing`, `call.answered`, `call.ended` |
| Passthru applet | URL pasted into the call flow in App Bazaar | GET with query parameters (`CallSid`, `CallFrom`, `CallTo`, `Direction`, `CallStatus`, `CallType`, `digits`, `Legs[i][..]`, `RecordingUrl`, `CustomField`, ...) | `call.inbound` (with `lead`) or `call.flow_step` |
| Connect applet agent pass-through | URL on the Connect applet | GET (`EventType` = Dial / Ringing / Answered / Terminal, `DialWhomNumber`, `Status` busy/free) | `call.agent_leg` |

Exotel expects an HTTP 200 within 15 seconds and retries up to 2 times on a timeout or a non-2xx response. It sends no event ID, so `parseWebhook` produces a deterministic `eventId` that stays the same across retries:

- terminal: `{CallSid}:terminal`
- answered / ringing: `{CallSid}:{answered|ringing}:leg{n}`, where n is the leg that just progressed
- Passthru / Connect applet: `{CallSid}:passthru:{hash}`. The hash is a sha256 of the payload, ignoring `CurrentTime`.

Each normalised event has the fields `provider`, `eventId`, `type`, `source`, `callId`, `status` (`queued|ringing|in_progress|completed|busy|no_answer|failed|canceled|unknown`), `providerStatus`, `direction` (`inbound|outbound`), `from`, `to`, `callerId`, `occurredAt`, `createdAt`, `startedAt`, `endedAt` (all ISO UTC), `durationSeconds` (talk time), `legs[]` (`index`, `role` agent/customer, `status`, `onCallDurationSeconds`, `ringingDurationSeconds`, `answeredBy`, `number`, `causeCode`, `cause`), `leg`, `outcome` (`connected|agent_missed|customer_missed|failed|unknown`, terminal only), `recordingUrl`, `ref`, `extra`, `lead` and `raw`.

### Verification scheme

Exotel does not sign webhooks: there is no signature header and no HMAC. Its docs recommend checking that requests come from Exotel's IP ranges but do not publish them. So we authenticate the URL we give Exotel, and optionally the source IP. `verifyWebhook` fails closed: with no secret and no IP list it returns `{ valid: false, reason: 'no_verification_configured' }`.

1. **Signed callback URL** (status callbacks from `connectCall`). The client appends three parameters:
   `?phx_ref={ref}&phx_exp={unix seconds}&phx_sig={sig}`, where
   `sig = base64url(HMAC-SHA256(key = webhookSecret as UTF-8, message = "exotel-cb.v1\n" + ref + "\n" + exp))`.
   To verify, the server recomputes the signature with each configured secret and compares in constant time (sha256 of both values, then `timingSafeEqual`). It rejects the request if `now > exp + clockSkewSeconds` (default 300 s). If the raw body contains `CustomField`, it must equal `phx_ref` (`ref_mismatch` otherwise). This binds the payload to the URL for extended callbacks; the default payload has no `CustomField`.
2. **Static flow token** (Passthru and Connect-applet URLs, which are pasted once into the flow builder). The token is
   `phx_token = base64url(HMAC-SHA256(webhookSecret, "exotel-static.v1\n" + purpose))`, with `purpose` defaulting to `passthru`. Generate the URL with `client.buildFlowUrl('https://crm.example/hooks/exotel/passthru')`. Exotel appends its own query parameters after ours. If a flow rejects URLs that already contain a query string, use `{ inPath: true }` and pass the path segment as `options.token`.
3. **IP allow-list** (`allowedWebhookIps`, as CIDRs). When it is set, the source IP must match, in addition to the token. Pass `remoteIp` as resolved by the trusted-proxy chain (Express `req.ip` with `trust proxy`), never a raw `X-Forwarded-For` header. If no secret is configured, the IP check alone is accepted (`scheme: 'ip_only'`).

Exotel itself does not authenticate the body, and a leaked URL can be replayed until it expires. Treat callbacks as notifications. For anything that affects billing, SLAs or reports, confirm with `getCall(callId)` (the Call Details API, authenticated with our credentials). This also covers lost callbacks, which Exotel's docs warn about.

Test vectors (secret `test-secret-0123456789abcdefghijklmnop`; computed with `node:crypto`; no official vectors exist because Exotel does not sign webhooks):

| Input | Output |
|---|---|
| ref `lead-42`, exp `1767225600` | `phx_sig = 9A_4JD5CCnFK6kmTiQtGvuCRgbermpp_UgwC7Wjy1IE` |
| purpose `passthru` | `phx_token = NcZ5T0sv_ceNpORgvtxqUCYlcnvAIr6PNGbgng2vjKs` |

### Setup steps

1. Create an API key and token for the CRM (Dashboard > API Settings). Note the account SID and the cluster: `my.exotel.com` is Singapore, `my.exotel.in` is Mumbai.
2. Pick an ExoPhone as the caller ID for each company, and record it as `callerId`.
3. Set `statusCallbackUrl` to the public https route and generate `webhookSecret`. `connectCall` signs each call's callback URL itself.
4. To get answered and ringing events, ask Exotel (hello@exotel.com or your account manager) to enable them if they do not arrive.
5. For incoming-call leads: in App Bazaar, add a Passthru applet near the start of the ExoPhone's flow. Paste in `client.buildFlowUrl(<route>)` and tick "Make Passthru Async" so the caller is not kept waiting. Each Passthru request becomes a `call.inbound` event with a `lead { phone, calledNumber, digits, receivedAt }`.
6. Optional: ask Exotel support for the source IP ranges of callbacks and Passthru, and set `allowedWebhookIps`.
7. Webhook routes must keep the raw body (`express.raw({ type: '*/*' })` or `verify` hook) and answer 200 quickly.

## Recordings

Since October 2024, recording URLs are private. Downloading one needs Basic auth with the API key and token (a browser shows a login prompt), unless the calling IP has been whitelisted with Exotel (up to 20 IPs or CIDRs). An account-level "secure recordings" option (beta, paid) adds a `PreSignedRecordingUrl` to Call Details; once it is on, the plain `RecordingUrl` is no longer playable. `fetchRecording`:

- accepts https URLs only and refuses URLs with embedded credentials;
- sends `Authorization` only to `exotel.com`, `*.exotel.com`, `exotel.in` and `*.exotel.in`;
- follows redirects manually (at most 3) and drops credentials when a redirect leaves Exotel, for example to a pre-signed S3 URL;
- enforces `maxRecordingBytes` (default 100 MB) and `recordingTimeoutMs` (default 120 s);
- maps 404 to `recording_not_available` with `retryable: true`, because recordings can appear with a delay. Reschedule the job; do not loop.

Retention depends on the plan (30 to 365 days), so copy recordings to our own storage soon after the call.

## Times

Exotel timestamps such as `DateCreated`, `StartTime`, `EventTime`, `CurrentTime` and `Created` are `YYYY-MM-DD HH:mm:ss` with no zone. They are read as local to the account (`timeZoneOffset`, default `+05:30`) and emitted as ISO UTC. The evidence for IST: the Passthru docs describe `EndTime` as the constant `1970-01-01 05:30:00`, which is the Unix epoch in IST. That placeholder, `0000-00-00 ...` and `"null"` all become `null`. ISO strings that carry an offset are honoured as given.

## Sandbox / test mode

Exotel's docs describe no separate sandbox host or test credentials. New accounts start as trial accounts (Getting Started > Trial Account, with KYC needed to upgrade), and calls on them go over the real network. In CI and local development, use the injectable `fetch` (see `test/providers/exotel/fake-fetch.js`). For end-to-end checks, use a trial account with your own numbers, and point the status callback at a tunnel URL (https).

## India-specific notes (TRAI / TCCCPR)

- **140xx series**: TRAI requires promotional voice calls, from any sector, to come from 140-series numbers. Telecom operators check those calls against the DND (NCPR) registry: a customer who blocked a category on the DND registry does not receive them. `checkCallCompliance({ purpose: 'promotional' })` blocks dialling from any other caller ID (`promotional_calls_require_140_series_caller_id`).
- **1600xx series**: reserved for service and transactional calls by entities regulated by RBI, SEBI, IRDAI or PFRDA, and for government-to-citizen calls. Education companies should not use it, and the check warns if they do.
- **1601xx series**: TRAI's Third Amendment to TCCCPR (2026) records that DoT has allotted a separate 1601xx series for transactional and service calls by other sectors. A Direction of 10 Aug 2026 rolls it out first to utilities, logistics and courier. Education is not covered yet, so watch for later phases.
- **Service calls**, such as a call-back to a family that enquired or a call to an existing institute customer, may use ordinary ExoPhones (`CallType=trans`). They still need a real relationship or a consent record; Exotel's guidance is to keep consent timestamps and opt-out records. Calling a DND-registered number with promotional content from a normal number is a TCCCPR violation, and the client cannot see the customer's DND status.
- **Recording**: under DPDP, call recordings and callers' numbers are personal data. Announce recording (for example with an Exotel greeting or `StartPlaybackValueNew`) and apply retention rules.
- Indian numbers are normalised to E.164 (`+91` plus 10 digits; toll-free `1800`/`1860` numbers have 11 digits). Mobile and fixed-line numbers cannot be told apart by prefix, so both are classified as `standard`.

## Sources (accessed 2026-11-05 unless noted)

- Connect Two Numbers: https://developer.exotel.com/api/make-a-call-api and https://developer.exotel.com/docs/voice-v1/api-reference/connect-two-numbers
- Authentication and regional hosts: https://developer.exotel.com/docs/voice-api/getting-started/authentication
- Call Details: https://developer.exotel.com/docs/voice-v1/api-reference/call-details
- StatusCallback: https://developer.exotel.com/docs/voice-v1/api-reference/status-callback
- Webhooks (15 s, 2 retries, IP guidance): https://developer.exotel.com/docs/references/webhooks
- Error codes and rate limits: https://developer.exotel.com/docs/references/error-codes
- Answered and ringing events with sample payloads (support article 3000106308): https://support.exotel.com/support/solutions/articles/3000106308-how-to-get-answered-or-ringing-event-in-crm
- Passthru applet parameters (support article 48283): https://support.exotel.com/support/solutions/articles/48283-working-with-passthru-applet
- Passthru guide (developer docs): https://developer.exotel.com/docs/app-bazaar/passthru-applet-guide
- Recording access: https://support.exotel.com/support/solutions/articles/3000129050-accessing-exotel-call-recordings-on-connectors (modified 12 Nov 2024), https://developer.exotel.com/docs/reporting/recording-access, https://docs.exotel.com/business-phone-system/secure-call-recording
- NDNC/DND FAQ: https://developer.exotel.com/docs/faqs/ndnc-dnd
- Connect API legacy `CallType` notes (support article 48259): https://support.exotel.com/support/solutions/articles/48259-outbound-call-to-connect-a-customer-to-an
- Cluster hosts as listed by an integrator (cross-check): https://elevenlabs.io/docs/eleven-agents/phone-numbers/telephony/exotel
- TRAI Press Release 91/2026 (10 Jul 2026) on the 1600 and 140 series; TCCCPR (Third Amendment) Regulations 2026, notified 18 Sep 2026, on the 1601xx series. Both are TRAI PDFs downloaded earlier into the research scratch area.

## Unconfirmed

- **Webhook source IPs**: Exotel tells customers to allow-list its IP ranges but publishes none (the IP-whitelisting doc page currently redirects to an overview). Ask support for them.
- **Whether Exotel ever signs callbacks** or supports `user:pass@` credentials in callback URLs: neither is documented. The scheme above does not rely on either.
- **Status-callback form encoding**: with `multipart/form-data`, the encoding of `Legs` (bracketed keys or JSON) is not documented. The decoder accepts bracketed keys and JSON bodies. The content type of the default callback when `StatusCallbackContentType` is omitted is also undocumented; the decoder handles JSON, urlencoded and multipart.
- **Passthru**: the method is documented as GET by the support article but as GET or POST by the newer developer guide; both are parsed. The `Created` timestamp format is not documented (both `YYYY-MM-DD HH:mm:ss` and RFC-2822 style are parsed). The sync-mode timeout is "15 s default" in the developer guide only.
- **Time zone**: that timestamps are IST is inferred from the `1970-01-01 05:30:00` placeholder. It is not confirmed for Singapore-cluster accounts. `timeZoneOffset` is configurable.
- **Price currency**: assumed to be the account currency (INR). Whether `Price` is ever negative or in another currency is not documented.
- **Recording auth**: that Basic auth works directly on `RecordingUrl` hosts is supported by the support article's description of a login prompt. The exact recording host after the October 2024 change, and the name and range of the validity parameter (`RecordingUrlValidity` is given as 5–60 or 1–1440 minutes), conflict between pages. `fetchRecording` does not send a validity parameter.
- **`CallType`**: whether Exotel still accepts or needs `trans` today (the new docs list only `trans`), and how DND-blocked calls appear in the call status (a third-party wrapper reports a `DND` status; the Exotel error dictionary lists code 23005 `FAILED_DND`).
- **Answered/ringing events**: the support article says they must be enabled per account. In its samples, the top-level `Status` of answered events is inconsistent (for example `no-answer` while in progress), so the normaliser derives status from `EventType` and `Legs`.
- **Rate limit**: 200 requests/min per account comes from the 429 error text and the error-code page. Burst behaviour and the presence of `Retry-After` are not documented.
- **CallerId format**: the docs say only "your ExoPhone", so it is sent exactly as configured. That E.164 is accepted there too is not confirmed.
- **Trial-account limits**, such as calls only to verified numbers, are not confirmed.
- **TRAI calling-hour windows** for promotional calls are not encoded or verified here.
