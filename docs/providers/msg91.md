# MSG91 SMS provider (India, DLT)

Module: `apps/api/src/integrations/providers/msg91/` · Tests: `apps/api/test/providers/msg91/` · Adapter kind: `messaging.sms`

A dependency-free client (global `fetch`, `node:crypto`, `zod`) for MSG91's SMS Flow API, SendOTP and delivery-report webhooks. It also checks India's DLT rules on the client side, so a message that the operator scrubber would reject fails locally before any credit is spent.

```js
import { createMsg91Client, verifyWebhook, parseWebhook } from '../integrations/providers/msg91/index.js';

const sms = createMsg91Client(connection.config, { fetch, now: () => new Date(), logger });
const result = await sms.sendTemplate({
  template: 'admission.counselling_reminder',          // key in config.templates
  to: '98765 43210',                                     // normalised to 919876543210
  variables: { name: 'Asha', date: '12 Nov 4pm', link: 'https://phoenix.edu.in/apply?id=42' },
  reference: message.id,                                 // becomes CRQID, echoed in webhooks
});
// → { requestId, status: 'accepted', recipients: [{ to, reference, providerMessageId }], estimate, warnings }
```

## Capabilities

| Capability (`MSG91_CAPABILITIES`) | Method | MSG91 endpoint |
|---|---|---|
| `sms.template.send` | `sendTemplate(input)` | `POST /api/v5/flow` |
| `sms.template.schedule` | `sendTemplate({ scheduleAt })` | same, with `schtime` |
| `sms.template.validate` | `validateTemplateSend(input)` (no network) | none |
| `sms.otp.send` | `sendOtp({ to, otp?, length?, expiryMinutes?, variables? })` | `POST /api/v5/otp` |
| `sms.otp.verify` | `verifyOtp({ to, otp })` | `GET /api/v5/otp/verify` |
| `sms.otp.resend` | `resendOtp({ to, channel: 'text' \| 'voice' })` | `GET /api/v5/otp/retry` |
| `sms.delivery_reports.webhook` | `verifyWebhook()`, `parseWebhook()` | Webhook (New), legacy v2/v3/v4 |
| `sms.delivery_reports.logs` | `getDeliveryLogs({ startDate, endDate, requestId? })` | `POST /api/v5/report/logs/p/sms` |
| `sms.templates.list` | `listTemplates()`, `getTemplateVersions({ templateId })` | `GET /api/v5/flows`, `POST /api/v5/sms/getTemplateVersions` |
| `connection.check` | `checkCredentials()` | `GET /api/v5/flows` |

Every request uses base URL `https://control.msg91.com` and sends the auth key **only** in the `authkey` header, never in the URL.

Not implemented: plain-text (non-template) SMS, MSG91's legacy `sendhttp.php` / v2 `sendsms` APIs, template creation (`addTemplate`), the OTP widget, campaigns, analytics, and voice, WhatsApp or RCS.

## Config fields

Validated by `msg91ConfigSchema` (zod). Secrets are read only from this object. They are never logged and are scrubbed (`[REDACTED]`) from every error message.

| Field | Required | Default | Where to get it |
|---|---|---|---|
| `authKey` (secret) | yes | none | MSG91 panel → profile menu → **Authkey**. Create a dedicated key per environment. Optional **API security** (IP whitelisting) is configured on the same key; requests from other IPs fail with code 418. |
| `baseUrl` | no | `https://control.msg91.com` | none |
| `senderId` | no | none | The approved 6-character DLT **header** (MSG91 → SMS → Sender ID; it must also be registered on the operator DLT portal). Used when a template does not set one. |
| `defaultCountryCode` | no | `91` | none |
| `allowInternational` | no | `false` | Keep `false`: DLT and these checks only cover Indian numbers. |
| `templates.<key>` | for `sendTemplate` | `{}` | See the next table. |
| `otp.templateId` | for `sendOtp` | none | MSG91 → OTP → templates. The text must contain `##OTP##` and be DLT-approved. |
| `otp.length` / `otp.expiryMinutes` | no | MSG91 defaults (4 digits / 15 min) | 4–9 digits; 1–10080 minutes. |
| `dlt.enforce` | no | `true` | Turn off only for non-Indian traffic. |
| `dlt.principalEntityId` | no | none | 19-digit PE id from the DLT portal (stored for reference only). |
| `dlt.whitelistedUrls` | if messages contain links | `[]` | The CTA URLs whitelisted on DLT, copied exactly. An entry ending in `?` (dynamic URL) or `/` matches as a prefix; any other entry must match exactly. |
| `dlt.whitelistedCallbackNumbers` | if templates use `{#cbn#}` | `[]` | CTA-whitelisted callback numbers. |
| `dlt.promotionalWindow` | no | `10:00`–`21:00` IST | none |
| `dlt.outsideWindow` | no | `reject` | `schedule` moves promotional sends to the next window opening. |
| `dlt.maxVariableLength` | no | `40` | none |
| `webhook.secret` (secret) | for webhooks | none | Generate it yourself (≥ 16 chars, e.g. `deriveWebhookToken(masterKey, connectionId)`) and put it in MSG91's webhook headers (see **Webhooks**). |
| `webhook.headerName` | no | `x-phoenix-webhook-token` | none |
| `webhook.queryParam` | no | `token` | Used only for legacy webhooks that cannot send headers. |
| `http.timeoutMs` / `maxRetries` / `retryBaseDelayMs` / `retryMaxDelayMs` | no | 10000 / 2 / 250 / 5000 | none |
| `maxRecipientsPerRequest` | no | `500` | Larger batches must be split by the caller. |
| `currency` | no | `INR` | Wallet currency, used for webhook cost fields. |
| `mode` | no | `live` | `dry_run` validates and logs but never calls MSG91. |
| `dryRunOtp` | no | none | The code `verifyOtp` accepts in `dry_run` mode. |

### Template definitions (`templates.<key>`)

| Field | Required | Notes |
|---|---|---|
| `templateId` | yes | The MSG91 template (flow) id, e.g. `669a29fbd6fc053066739b42` (MSG91 → SMS → Templates). |
| `dltTemplateId` | yes | The 19-digit DLT content-template id. It is also attached to the template in MSG91. |
| `category` | yes | `transactional`, `service_implicit`, `service_explicit` or `promotional`, as approved on DLT. |
| `senderId` | no | Overrides `config.senderId`. Promotional headers are 6 digits; other headers are 6 letters (some DLTs also accept letters and digits). |
| `body` | recommended | MSG91 template text with `##name##` placeholders. Enables rendering, URL scanning and length estimates. |
| `dltBody` | recommended | DLT-approved text with `{#var#}` placeholders (or typed tags such as `{#numeric#}`, `{#url#}`, `{#cbn#}`, `{#alphanumeric#}`, `{#email#}`, `{#urlott#}`). It must line up with `body`; typed tags set the variable types. |
| `variables` | no | `[{ name, type?, maxLength? }]`. Derived from `body` when omitted. |

At client creation the definitions are checked: `body`/`dltBody` mismatch, malformed `{#…#}` tokens, undeclared placeholders and bad headers are config errors (`Msg91ConfigError`). A variable as the last word and static URLs missing from the whitelist produce warnings, which are logged.

## DLT rules enforced on the client

`sendTemplate` throws `Msg91ValidationError` (`delivery: 'not_sent'`, with `issues[]`) and nothing is sent when any of these fail:

* **Registered template only.** `template` must be a configured key or a complete inline definition.
* **Variables:** every declared variable must be present, no unknown keys, non-empty, at most 40 characters (counted in code points), and no line breaks or control characters. Typed variables are checked too: `numeric` is digits only, `alphanumeric` is letters, digits and spaces, plus `email`, `url` (a single URL), and `cbn` (must be in `whitelistedCallbackNumbers`).
* **CTA whitelisting:** every URL in the rendered message (static text and variables) must be in `dlt.whitelistedUrls`. Links to IP addresses are always refused, and subdomains are matched separately. With `shortUrl: true`, MSG91 rewrites every link to `https://m.9m.io/<HEADER>/…`, so that prefix must be whitelisted instead. Short URLs are refused for numeric (promotional) headers.
* **Promotional window:** `promotional` and `service_explicit` sends are only allowed 10:00–21:00 IST (evaluated at `scheduleAt` or now). The issue carries `nextAllowedAt` (UTC). With `dlt.outsideWindow = 'schedule'`, the send is scheduled at that time instead.
* **Schedule:** must be in the future and at most 3 weeks ahead (MSG91 errors 307, 606, 608). It is sent as `schtime` in IST (`YYYY-MM-DD HH:MM:SS`).
* **Phone numbers:** normalised to `91XXXXXXXXXX`; Indian mobiles must start with 6–9. Duplicates in one request are refused, because MSG91 rejects identical content to the same number within 10 s (error 311).
* **Reference → CRQID:** the reference is reduced to alphanumerics, at most 52 characters. MSG91 echoes it as `CRQID` in webhooks; the result returns the value actually sent.

`validateTemplateSend(input)` runs the same checks and returns `{ ok, issues, warnings, payload }` without throwing, for the automation editor's test panel. `estimateSegments(text)` gives the encoding and number of parts (GSM-7 160/153, Unicode 70/67).

## Errors, retries, idempotency

All errors are `Msg91Error` (subclasses `Msg91ConfigError`, `Msg91ValidationError`) with:

* `code` (stable), `retryable`, `status` (HTTP), `providerCode` (MSG91 numeric code);
* `delivery`: `not_sent` (safe to retry if `retryable`), `unknown` (the request may have reached MSG91: reconcile via webhook or `getDeliveryLogs` before resending), or `n/a` (not a send);
* `retryAfterMs` when a `Retry-After` header was given.

| MSG91 code(s) | `code` | retryable |
|---|---|---|
| 201, 207, HTTP 401/403 | `auth_failed` | no |
| 208, 418 | `ip_not_allowed` | no |
| 101, 202, 604 | `invalid_recipient` | no |
| 203 | `invalid_sender` | no |
| 204 | `permission_denied` | no |
| 211, 400 | `template_invalid` | no |
| 401 (body code, not HTTP) | `template_not_approved` | no |
| 402 | `content_blocked` | no |
| 403 | `template_disabled` | no |
| 301 | `insufficient_balance` | no |
| 302, 303, 421 | `account_inactive` | no |
| 307, 606, 608 | `invalid_schedule` | no |
| 310 | `message_too_long` | no |
| 311 | `duplicate_message` | no (the first one went out) |
| 407 | `international_blocked` | no |
| 603 | `sender_blacklisted` | no |
| 209, 210, 306, 602 | `route_unavailable` | yes (later) |
| 506, 601 | `provider_error` | yes |
| HTTP 429 | `rate_limited` | yes |
| HTTP 5xx | `provider_unavailable` | yes |
| timeout / network | `timeout` / `network_error` | yes |

**Retry policy.** MSG91 has **no idempotency key**, so the client never retries a send that might have been processed.

* **Reads** (`listTemplates`, `getTemplateVersions`, `getDeliveryLogs`) are retried on network errors, timeouts, 429 and 5xx: up to `maxRetries`, with exponential backoff and jitter, honouring `Retry-After`.
* **Sends and OTP calls** are retried only on 429 and on connections that never opened (`ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, connect timeout).
* A 5xx or timeout on a send surfaces as `delivery: 'unknown'`.

Each attempt has its own `AbortSignal.timeout(timeoutMs)`, combined with the caller's `signal`. A caller abort is never retried.

The reference is passed as `CRQID` so a send can be correlated with its webhooks and logs. It is not a deduplication key: MSG91's only deduplication is the 10-second rule behind error 311.

MSG91 often answers **HTTP 200 with `type: "error"`**, so success is decided by the response body. A wrong or expired OTP is a normal result (`verifyOtp` → `{ verified: false, reason: 'mismatch' | 'expired' | 'already_verified' | 'too_many_attempts' | … }`), not an exception.

## Webhooks

### Setup (MSG91 → SMS → Webhook (New) → Create Webhook)

1. Create one webhook for **On Report Received** (delivery reports). Optionally create another for **On Request Received**; MSG91 needs a separate webhook per event type. The SendOTP reports page has its own webhook too.
2. Set the URL to the platform endpoint for this connection, e.g. `https://api.<host>/webhooks/msg91/<connectionId>`.
3. Keep the default JSON payload with all fields (requestId, telNum, status, deliveryTime, requestedAt, CRQID, DLT_TE_ID, failureReason, smsLength, credit, …).
4. Under **Headers**, add `x-phoenix-webhook-token: <webhook.secret>`.
5. Legacy webhooks (SMS → Webhook, versions v2/v3/v4) cannot send custom headers. If one must be used, append `?token=<secret>` to its URL and call `verifyWebhook(..., { allowQueryToken: true, url: req.originalUrl })`. Prefer Webhook (New).

### Verification scheme

Header: `x-phoenix-webhook-token` (configurable). Check: a constant-time comparison of the header value with the configured secret (both SHA-256 hashed, then `crypto.timingSafeEqual`, so length differences don't leak).

* **No signature or timestamp:** MSG91 does not sign webhooks (no HMAC, no timestamp header) and defines no tolerance window, so the only proof of origin is the shared secret header (plus TLS).
* **Raw body:** `rawBody` must be the exact received bytes (string or Buffer, non-empty, at most 256 KB). It is not part of any signature, but requiring it keeps the adapter interface uniform and blocks empty or oversized bodies.
* **Rotation:** pass `[current, previous]` as `secret`. Every candidate is compared, so timing doesn't reveal which one matched.
* **Replays:** MSG91 retries a webhook **up to 4 times if the endpoint does not answer within 8 s**, so the same payload arrives more than once. `parseWebhook` therefore returns a deterministic `eventId` (`msg91:<requestId>:<mobile>:<status>`, or a SHA-256 of the payload when there is no request id). Store it with a unique constraint and ignore repeats.
* **Response:** answer 2xx quickly (enqueue, then process).

`deriveWebhookToken(masterKey, scope)` = base64url(HMAC-SHA256(masterKey, `"msg91-webhook:v1:" + scope`)). It lets one stored master key produce a different header value for each connection. The test vectors in `webhook.test.js` were computed with `node:crypto`; the HMAC primitive is cross-checked against RFC 4231 test case 2. MSG91 publishes no official signature examples, because it has no signature scheme.

### Payloads and normalised events

`parseWebhook(body)` accepts a raw string or Buffer (JSON or `application/x-www-form-urlencoded`) or an already-parsed object. It handles:

| Format | Shape | Notes |
|---|---|---|
| `webhook_new` | flat JSON per recipient: `telNum`, `status`, `eventName`, `deliveryTime`, `credit`, `smsLength`, … | Times carry `+05:30`. `credit` is the charge and `smsLength` the number of parts. |
| `otp` | flat JSON with `flowID`, `otpRetry`, `verified`, `telecomCircle`, … | SendOTP reports. |
| `v2` | form field `data` = JSON string array of `{ requestId, senderId, report: [{ number, status, desc, date, amount, credit, CRQID, failedReason }] }` | One event per `report` entry. `amount` is the charge and `credit` the parts. |
| `v3` | flat JSON `{ number, status, desc, date, amount, credit, requestId, CRQID }` | none |
| `v4` | `[{ event, data: [{ description, ts, meta, INMSID }] }]` (CleverTap) | No request id or number. |

Each event has the shape `{ provider, eventId, type, status, final, providerStatusCode, providerStatus, format, requestId, providerMessageId (requestId:mobile), to, reference (CRQID), uuid, clientId, senderId, dltTemplateId, templateId, route, occurredAt, requestedAt (UTC ISO), failure: { reason, category, permanent } | null, segments, cost: { amountMinor, currency, exact } | null, raw }`.

| MSG91 `status` | `status` / `type` | final |
|---|---|---|
| 0 | `sent` / `message.sent` | no |
| 1 | `delivered` / `message.delivered` | yes |
| 2 | `failed` / `message.failed` | yes |
| 9 (NDNC, promotional) | `rejected`, failure category `dnd` | yes |
| 16, 25 | `rejected` / `message.rejected` | yes |
| 17 (blocked number), 20 (country blocked) | `blocked` / `message.blocked` | yes |
| event name contains "click" | `clicked` / `message.clicked` | no |

Failure reasons from MSG91's list ("Absent Subscriber", "CTA not Whitelisted on DLT", "Preference not matched", …) are mapped by `classifyFailureReason` to `dnd`, `dlt`, `spam_or_duplicate`, `invalid_number`, `blackout_time`, `subscriber_unavailable`, `network` or `unknown`. `permanent: true` means resending the same message to the same number will not help; use it to flag bad numbers or templates.

Timestamps without an offset (`2025-07-09 11:29:46`) are read as IST. Output is always UTC ISO. Money is integer minor units: `"0.25"` becomes `{ amountMinor: 25, currency: 'INR' }`, and sub-paise values are rounded half-up with `exact: false`. Unparseable bodies throw `Msg91Error('invalid_webhook_payload')`. Acknowledge them with 2xx and log them, so MSG91 does not retry forever.

Delivery reports are not sent while a message is Pending, only once the operator reports a final status. MSG91 sends no webhook for API failures with codes 301, 203 and 211; those are returned synchronously.

## Rate limits

MSG91 publishes no numeric API rate limits. Its 429 article says the per-second rate limiting "currently [applies] only to the MSG91 panel; API integrations remain unaffected, unless specified otherwise", and recommends retrying with delays. The client handles 429 anyway: it retries with backoff, honours `Retry-After`, and surfaces `rate_limited` with `retryAfterMs` when the wait is longer than `retryMaxDelayMs`. Bulk sends should go through the platform queue, in chunks of at most `maxRecipientsPerRequest`.

## Sandbox / test mode

MSG91 has **no sandbox**. A new account stays in **demo** status until KYC is done. While in demo, every SMS is replaced with "You have received this SMS as per your testing…" and real credits are still used.

For development and CI, use `mode: 'dry_run'`: every validation runs, nothing is sent, the result's `requestId` is `dryrun_<hash>`, and `verifyOtp` accepts only `dryRunOtp`. Logs mask phone numbers (`91******3210`). The tests use an injected fake `fetch` and never touch the network.

## India-specific notes

* **DLT (TRAI TCCCPR 2018).** These must all be registered on an operator DLT portal (Jio TrueConnect, Airtel, Vi VILPower, SmartPing/Videocon, Tata, BSNL): the Principal Entity (PE), the headers and every content template. Each variable is written `{#var#}`. Template approval takes about 2–4 business days, and the brand name must appear in the text.
* **PE–TM chain binding** has been mandatory since 11 Dec 2024. Add MSG91's company, "Walkover Web Solutions Pvt. Ltd" (TM id 1302157225275643280), as Telemarketer on the DLT portal. Without it, SMS are rejected.
* **Categories and DND scrubbing.**
  * Service Implicit (transactional-like admissions and fee messages) reaches DND numbers at any time.
  * Promotional and Service Explicit reach non-DND numbers only 10:00–21:00. DND numbers need uploaded digital consent.
  * TRAI is phasing out Service Explicit into Promotional.
  * Prefer **Service Implicit** for counselling reminders, fee dues and OTPs.
* **Header suffixes.** Since 6 May 2025, operators append `-P`, `-S`, `-T` or `-G` to headers (e.g. `AD-PHXEDU-S`). No API change is needed.
* **CTA whitelisting.** Every URL, APK, OTT or WhatsApp link and every callback number must be whitelisted on one DLT portal. Static URLs contain no `?`; dynamic URLs end with `?`; APK links end with `.apk`. IP-based URLs are not allowed and subdomains are registered separately. Messages with non-whitelisted CTAs are **rejected** by operators.
* **Promotional consent.** Keep opt-in records (CRM or database evidence, under 6 months old); MSG91 can demand them within 24 h of a complaint. This matters for B2C families.
* **Privacy (DPDP Act 2023).** Phone numbers are personal data. The client logs masked numbers only and never logs OTPs. Webhook `raw` payloads contain full numbers, so store them under the same controls as contact data.
* **Time zone.** IST is UTC+05:30 all year, with no DST.

## Wrapping it in the adapter (wave 2)

* `createMsg91Client(connection.config, { fetch, now, logger })` once per connection, cached by connection id and config version.
* Map `send({ to, templateKey, variables, idempotencyKey })` to `sendTemplate({ template: templateKey, to, variables, reference: idempotencyKey })`. Store `requestId` and the returned `recipients[].reference` (CRQID) and `providerMessageId`.
* Map errors by `code`, `retryable` and `delivery`. On `delivery: 'unknown'`, do not resend automatically: wait for the webhook, or poll `getDeliveryLogs({ requestId })`.
* Webhook route: read the raw body, call `client.verifyWebhook(raw, req.headers)`, then `client.parseWebhook(raw)`. Dedupe on `eventId`, update the message by `providerMessageId` (or `reference`), and reply 2xx within 8 s.
* `validateTemplateSend` backs the "test" panel; `checkCredentials` backs "test connection".

## Sources (all read 2026-11-05)

* Send SMS (Flow) API: https://docs.msg91.com/sms/send-sms.md and the OpenAPI file `send-sms.openapi.yml`. Body fields, CRQID/UUID/clientId metadata, variables are case-sensitive (`##var1##` → `var1`).
* SMS logs / templates: https://docs.msg91.com/sms/llms.txt (`sms-logs`, `list-sms-templates`, `get-template-versions`, `add-flow` OpenAPI).
* SendOTP / Verify / Resend: https://docs.msg91.com/otp/sendotp.md, https://docs.msg91.com/otp/verify-otp.md, `resend-otp.openapi.yml`.
* API error codes: https://msg91.com/help/api/what-are-the-reason-for-error-codes-received-under-the-api-failed
* Real-time response: https://msg91.com/help/api/What-is-a-Real-Time-Response-and-How-Does-It-Work-
* Webhook (New) overview (8 s timeout, up to 4 retries): https://msg91.com/help/webhook-new
* SMS delivery webhook (New): https://msg91.com/help/webhook-new/how-to-receive-sms-delivery-reports-via-webhook-new
* SendOTP webhook: https://msg91.com/help/webhook-new/how-to-receive-otp-delivery-reports-via-webhook
* Legacy webhooks v2/v3/v4 and status table: https://msg91.com/help/webhooks/how-can-i-get-the-delivery-reports-on-my-webhook-url
* Failure reasons: https://msg91.com/help/delivery-report/what-are-the-reasons-behind-a-failed-message
* DLT: https://msg91.com/help/dlt-registration-in-india/dlt-content-template-faqs, …/variable-tagging-on-dlt-sms-templates, …/dlt-template-scrubbing-filtering-rules, …/cta-whitelisting-faqs, …/cta-whitelisting-solution-for-redirecting-urls, …/pe-tm-chain-binding-on-dlt, …/dlt-consent-process
* 429 rate limit: https://msg91.com/help/all-about-the-429-rate-limit-error
* Demo accounts: https://msg91.com/help/text-sms/my-account-status-is-in-demo-what-can-i-do-to-make-my-account-live
* Short URL: https://msg91.com/help/url-shortener/how-to-use-and-check-report-of-short-url
* Promotional consent: https://msg91.com/help/more/promotional-sms-to-customers

## Unconfirmed / assumptions

* **No webhook signing.** No MSG91 page documents one, and none mentions source IPs for webhooks. If MSG91 adds one, extend `verifyWebhook`.
* **Event names in Webhook (New).** Only `delivered` is shown; `failed` and `rejected` are inferred. The names for click, template, request and "API failed" events are unknown, so the client classifies them by keyword and falls back to the numeric status.
* **`sender` in the Flow body.** The current Send SMS spec does not list it; MSG91's own webhook page example sends it. The client sends the template's header as `sender`; the header bound to the MSG91 template may take precedence.
* **`schtime` time zone.** Not stated; IST is assumed.
* **Flow API error body.** Whether errors include a numeric `code` field is not documented. The client reads `code`/`errorCode`, then a leading 3-digit number in `message`, then message keywords.
* **Maximum recipients per Flow request.** Not documented; the default of 500 is a conservative choice.
* **Resend OTP authentication.** The spec lists `authkey` as a query parameter; this client sends it as a header, as the other v5 endpoints document.
* **Verify OTP messages.** "already verified" and "max attempts" are not in the docs, so those reasons are matched by keyword.
* **SMS logs.** Where the `requestId` filter goes (query parameter assumed) and the shape of the rows are not documented. `rows` falls back to `data`.
* **`realTimeResponse`.** The effect on the response body is not documented.
* **Money and time fields.** `credit` in Webhook (New) is taken to be money in the wallet currency, and `amount` in v2/v3 likewise. Naive timestamps are taken to be IST. In MSG91's OTP webhook sample, `deliveryTime` is exactly 5:30 after `requestedAt` while both end in `Z`, which suggests an IST time mislabelled as UTC. The client parses times as labelled.
* **Sender ID character rules.** Alphabetic versus alphanumeric headers vary by DLT portal.
* **DLT template id length.** It is always 19 digits in the examples, but no spec says so.
* **Variable length and count.** The 40-character limit comes from MSG91's FAQ (some DLTs are said to use 30). The FAQ's "1–2 variables per template" is not enforced, because real approved templates use more.
* **`alphanumeric` tag and spaces.** Whether this tag allows spaces is not specified; the client allows them.
* **Webhook retry spacing.** The interval between MSG91's up-to-4 retries is not documented.
