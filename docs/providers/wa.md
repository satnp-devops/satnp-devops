# WhatsApp Cloud API (Meta) provider

Code: `apps/api/src/integrations/providers/wa/` · Tests: `apps/api/test/providers/wa/` · Adapter kind: `messaging.whatsapp`

A client for Meta's WhatsApp Cloud API with no dependencies beyond zod. It sends template and free-form messages, verifies and normalises webhooks, manages templates for the templates settings screen, and handles media. Facts below were checked against Meta's documentation on 2026-11-05 (see [Sources](#sources)). Anything not confirmed there is listed under [Unconfirmed](#unconfirmed).

## Module map

| File | What it holds |
|---|---|
| `index.js` | Public exports, `WA_ADAPTER_KIND`, `WA_CAPABILITIES` |
| `client.js` | `createWaClient(config, { fetch, now, logger, sleep, random })` |
| `config.js` | zod schema `waConfigSchema`, `parseWaConfig`, `describeConfig` (safe to log) |
| `http.js` | Transport: timeouts (`AbortSignal.timeout`), retries, backoff, logging without secrets |
| `errors.js` | `WaError`, `ERROR_CODES` table, `classifyError`, `redact` |
| `payloads.js` | Pure request builders, `normalizePhone`, `formatMoney`, media limits |
| `webhook.js` | `verifyWebhook`, `verifySubscription`, `parseWebhook`, `signWebhook` (all pure) |

## Capabilities

| Capability | Client method | Endpoint |
|---|---|---|
| Send template (named or positional variables, media/location header, URL and quick-reply buttons) | `sendTemplate` | `POST /{phone-number-id}/messages` |
| Send free-form text, media, reaction, interactive (24-hour window only) | `sendText`, `sendMedia`, `sendReaction`, `sendInteractive` | same |
| Mark as read, with optional typing indicator | `markRead` | same, `status: "read"` |
| List, get, create, edit, delete templates | `listTemplates`, `getTemplate`, `createTemplate`, `editTemplate`, `deleteTemplate` | `/{waba-id}/message_templates`, `/{template-id}` |
| Upload, look up, download, delete media | `uploadMedia`, `getMedia`, `downloadMedia`, `deleteMedia` | `/{phone-number-id}/media`, `/{media-id}` |
| Test connection | `checkConnection` | `GET /{phone-number-id}?fields=...` |
| Webhook GET verification | `verifySubscription(query, verifyToken)` | |
| Webhook POST signature | `verifyWebhook(rawBody, headers, secret)` | |
| Normalised webhook events | `parseWebhook(body)` | |

Every send returns `{ provider, messageId, recipientWaId, messageStatus, acceptedAt }`. Meta accepting a message does not mean it was delivered; delivery arrives later as `message.status` events.

Send inputs take `to` (any common phone format; normalised to `+E.164`, which Meta recommends because a number without `+` gets the business number's country code prepended) or `recipient` (a business-scoped user ID). They also take `callbackData`, which Meta echoes back as `biz_opaque_callback_data` on status webhooks; put the outbox row id there. `replyTo` takes a wamid and sends a contextual reply.

Template variables:

```js
await wa.sendTemplate({
  to: '98765 43210',                    // with defaultCountryCode '91' -> +919876543210
  name: 'admission_followup',
  language: 'en_IN',
  variables: {
    header: { type: 'image', id: '1037543291543636' },        // or { link }, text, document, location
    body: { student_name: 'Asha', fee_due: { amountMinor: 1250000, currency: 'INR' } }, // -> "₹12,500.00"
    buttons: [{ type: 'url', index: 0, text: 'APP-2027-0042' }, { type: 'quick_reply', index: 1, payload: 'CALL_ME' }],
  },
  callbackData: outboxId,
});
```

Positional templates take `body: ['Asha', '10:30 AM']`. Pass `components` instead of `variables` to send raw Cloud API components. URL-button values are percent-encoded for you, as Meta requires; pass `encoded: true` if the value is already encoded. Money is always integer minor units plus an ISO currency, and is rendered as text with `en-IN` grouping. Format times in IST before passing them. The client itself never converts time zones, and every time it returns is UTC ISO 8601.

## Config fields

Validated by `waConfigSchema` (zod). Validation errors name the field and never echo its value.

| Field | Required | Where to get it |
|---|---|---|
| `accessToken` | yes | Business Settings > Users > System users > Generate token, with `whatsapp_business_messaging` (sending, media) and `whatsapp_business_management` (templates). System user tokens are long-lived. Tech providers use a Business Integration System User token instead. |
| `phoneNumberId` | yes | App Dashboard > WhatsApp > API Setup, or WhatsApp Manager > Phone numbers. This is the numeric id, not the phone number. |
| `wabaId` | for templates | App Dashboard > WhatsApp > API Setup ("WhatsApp Business Account ID"). Meta's 2026 docs also call it the **Messaging account** id. |
| `appSecret` | for webhooks | App Dashboard > App settings > Basic > App secret. Signs `X-Hub-Signature-256`, and `appsecret_proof` when that is enabled. |
| `previousAppSecret` | no | The old secret, accepted only for webhook verification during a rotation. Remove it after rotating. |
| `verifyToken` | for webhooks | A random string you choose (use 32 or more characters). Type the same value into App Dashboard > WhatsApp > Configuration > Verify token. |
| `messagingAccountId` | rarely | Only when the token can message for more than one Messaging account on the same number. Sent as `messaging_account_id`. |
| `graphVersion` | no | Default `v26.0`. Pin a version per connection; any `vNN.N` is accepted. |
| `appSecretProof` | no | `true` when the app has "Require app secret" turned on. Adds `appsecret_proof = hex(HMAC-SHA256(accessToken, appSecret))`. |
| `defaultCountryCode` | no | `'91'` for Indian connections, so that `98765 43210` and `098765 43210` resolve to `+919876543210`. |
| `timeoutMs` (15000), `maxRetries` (2), `retryBaseMs` (500), `maxRetryDelayMs` (10000) | no | Transport tuning. |
| `mediaHosts` (`lookaside.fbsbx.com`, `graph.facebook.com`), `maxMediaBytes` (100 MB) | no | `downloadMedia` sends the bearer token only to these HTTPS hosts and stops reading at the size limit. |
| `baseUrl` | no | Defaults to `https://graph.facebook.com`. Override only for a local stub (`http://127.0.0.1` is allowed). |

Secrets live only in the client's closure. `client.info` is safe to log. Logs carry the operation, method, path (ids only, never the query string), status, attempt, duration, Meta error code and `fbtrace_id`. They never include the token, app secret, `appsecret_proof`, phone numbers or message text. Graph error text is scrubbed of configured secrets and of anything that looks like an access token (`EAA…`).

## Webhooks

### Setup

1. Expose `GET` and `POST` on one HTTPS URL (self-signed certificates are not accepted), for example `/webhooks/whatsapp/:connectionId`.
2. Enter it under App Dashboard > WhatsApp > Configuration > Callback URL, along with the verify token. Apps created with the "Connect with customers through WhatsApp" use case have this under Use cases > Customize > Configuration.
3. Subscribe to `messages` (inbound messages and statuses) and `message_template_status_update`. Other fields are parsed as `kind: 'other'`.
4. The app must be in **Live** mode. Some webhooks are not sent in Dev mode.

### GET verification

Meta sends `?hub.mode=subscribe&hub.challenge=<random>&hub.verify_token=<yours>`. `verifySubscription(req.query, verifyToken)` checks the mode and compares the token in constant time (both sides SHA-256 hashed, then `timingSafeEqual`). When it returns `{ ok: true, challenge }`, reply `200` with the challenge as `text/plain`. Otherwise reply `403`. The challenge is echoed only if it is printable ASCII with no HTML characters, because it is reflected into the response body.

### POST signature (exact scheme)

- Header: `X-Hub-Signature-256: sha256=<64 hex chars>`.
- Value: `HMAC-SHA256(key = app secret, message = raw request body bytes)`, hex encoded.
- Comparison: the header must match `^sha256=[0-9a-fA-F]{64}$`, then `crypto.timingSafeEqual` on the 32-byte digests. Every configured secret (current and previous) is checked.
- **Use the raw bytes.** Meta's payloads can contain `\uXXXX` escapes, so re-serialising `req.body` changes the bytes and the signature fails. The test suite proves this. In Express, mount `express.raw({ type: 'application/json', limit: '3mb' })` on this route. Payloads can be up to 3 MB.
- Timestamp tolerance: **Meta defines none**, and it retries failed deliveries for up to 7 days. Replay protection is therefore deduplication on `eventId`. `verifyWebhook(..., { maxAgeSeconds })` adds an opt-in staleness check against the newest timestamp in the payload. Do not set it below 7 days unless you are willing to drop legitimate retries.
- Reply `200` quickly: Meta asks for a median under 250 ms and fewer than 1% of replies over 1 s. Store the event, then process it from a queue. Anything other than 200 triggers retries, and every subscribed app receives them.
- There is also mTLS and an IP list (AS32934). mTLS is the better option of the two because Meta's IPs change.

Signature test vectors (computed with `node:crypto`, cross-checked with WebCrypto in `webhook.test.js`). Meta's docs show only a bare example hash, with no body and secret to check it against.

| Secret | Body | `X-Hub-Signature-256` |
|---|---|---|
| `Jefe` | `what do ya want for nothing?` (RFC 4231 case 2) | `sha256=5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843` |
| `test_app_secret_not_real_0001` | `{"object":"whatsapp_business_account","entry":[]}` | `sha256=cce1a3656fcd8469c854909d9f6608bed70fe1b6246f5158c03fef751c38d736` |
| `test_app_secret_not_real_0000` | same body | `sha256=a032b42bd30247a64183a939bcbc5619a6146bf9ddf17bda5cad319a0e563285` |

### Normalised events (`parseWebhook`)

`parseWebhook` accepts the parsed object or the raw body. It never throws on unexpected shapes; it throws only on input that is not JSON. Every event has `provider: 'whatsapp'`, `eventId`, `occurredAt` (UTC ISO), `field`, `wabaId`, `phoneNumberId` and `displayPhoneNumber`.

| `kind` | `eventId` | Main fields |
|---|---|---|
| `message.received` | the wamid (`messages[].id`) | `from { phone, waId, userId, name, username }`, `type`, `text`, `media { kind, id, mimeType, sha256, caption, filename }`, `reply { kind: button / button_reply / list_reply / nfm_reply, id, title }`, `location`, `reaction`, `context`, `referral` (Click to WhatsApp ad, including `ctwaClid`), `errors` |
| `message.status` | `<wamid>:<status>` | `status` (sent, delivered, read, failed, played), `recipient { phone, waId, userId, groupId }`, `callbackData`, `pricing { billable, model, type, category }`, `conversation`, `errors` (classified like API errors) |
| `template.status` | `template:<id>:<EVENT>:<entry.time>` | `templateId`, `name`, `language`, `status` (APPROVED, REJECTED, PAUSED, DISABLED, ...), `reason`, `category`, `rejection` |
| `error` | hash of the payload | change-level `errors` |
| `other` | `other:<field>:<hash>` | `value` (raw) for fields not modelled yet |

Store events idempotently on `(provider, eventId)`. Status events can arrive out of order. `read` can arrive without `delivered`, which Meta skips when both happen at once. From v24.0, `conversation` is omitted, and `pricing` appears on only one of the sent or delivered statuses.

**Usernames and BSUIDs (2026):** Meta began sending business-scoped user IDs (`user_id`, `from_user_id`, `recipient_user_id`) in April 2026, and usernames are rolling out. A user who adopts a username may arrive with **no phone number** (`from.phone === null`, `from.userId = 'IN.1349…'`). The CRM's contact matching must accept a BSUID as an identity, and the client can send to it with `recipient`. Authentication-category messages cannot be sent to a BSUID.

## Errors and retries

Every failure is a `WaError` with `kind`, `retryable`, `ambiguous`, `code` (Meta's code), `httpStatus`, `retryAfterMs`, `details` and `fbtraceId`.

| Kind | Examples | Retry? |
|---|---|---|
| `rate_limited` | 4, 80007 (app/WABA call limits), 130429 (throughput), 131056 (pair limit) | yes, after `retryAfterMs` |
| `transient` | 2, 131000, 131016, 133004, 131057 (maintenance), any `is_transient: true` | yes |
| `network`, `timeout` | fetch failed, `AbortSignal.timeout` | yes |
| `window_closed` | 131047 (no user message in 24 h) | no: send a template |
| `recipient` | 131026 (not on WhatsApp / old app), 130403 (blocked us), 131050 (opted out of marketing), 131049 (held for ecosystem health; retryable after 24 h) | no, except 131049 later |
| `template` | 132000 (parameter count), 132001 (missing / wrong language), 132012, 132015 (paused), 132016 (disabled), 2388xxx (creation) | no |
| `auth`, `permission` | 0, 190, 3, 10, 200–299 | no: reconnect |
| `policy`, `account` | 368, 131031, 131042 (payment), 131048 (spam limit), 133010 (number not registered) | no: alert an admin |
| `invalid_request`, `not_found`, `media`, `config`, `aborted`, `unknown` | 100, 131008, 131009, 131051, 131052, 131053 | no |

**Idempotency:** the Cloud API has no idempotency key (none is documented on the Messages API). The client therefore follows these rules:

- **Safe calls** (GET, DELETE, mark-as-read, media upload) retry any retryable error, including timeouts, with full-jitter exponential backoff (`retryBaseMs × 2^n`, capped at `maxRetryDelayMs`).
- **Sends and template creation** retry only when Meta rejected the call before processing it: the throttling codes 4, 80007, 130429 and 131056, plus maintenance codes. For 131056, Meta recommends waiting 4^X seconds (1 s, 4 s, 16 s, ...).
- For a send, a timeout, network error or 5xx comes back as `retryable: true, ambiguous: true`. The outbox decides what to do. The recommended approach is to wait for a status webhook carrying the same `callbackData` before re-sending, or to accept a rare duplicate for low-stakes messages.
- When a wait is longer than `maxRetryDelayMs` (for example, code 4 suggests 60 s), the client does not sleep. It throws with `retryAfterMs`, so the queue can reschedule the job.

Errors also arrive asynchronously in `statuses[].errors`. Watch both channels.

## Rate limits

- **Throughput:** 80 messages per second per business number by default, upgraded automatically to 1,000 mps for eligible numbers. Numbers shared with the WhatsApp Business app are fixed at 20 mps. Going over returns error `130429`.
- **Pair rate limit:** 1 message every 6 s to the same user (about 10 per minute). Bursts of up to 45 borrow from future quota. Going over returns `131056`.
- **Messaging limits** (business-initiated, outside the service window, unique users per rolling 24 h, set at the **business portfolio** level): 250, then 2,000, 10,000, 100,000 and unlimited. The `messaging_limit_tier` field is deprecated; read `whatsapp_business_manager_messaging_limit` instead.
- **Management API:** 200 requests per hour per app per Messaging account, or 5,000 per hour for active accounts with a registered number. This covers `/message_templates` and `/phone_numbers`.
- **Templates:** up to 100 creations per hour per account. 250 templates per account for unverified portfolios, 6,000 for verified ones. An approved template can be edited up to 10 times in 30 days (at most once per 24 hours). A deleted approved name cannot be reused for 30 days.
- **Webhooks:** plan for about 3× outbound volume in status callbacks.

## Sandbox / test mode

- Getting started with Cloud API automatically creates a **test WhatsApp account, test Messaging account and test business phone number**. They have relaxed messaging limits and need no payment method for template sends. In development, recipients must be added as test numbers in API Setup. This last point is from long-standing guidance and was not re-verified (see Unconfirmed).
- The App Dashboard Configuration panel can send **test webhook payloads** to your endpoint.
- Locally, sign payloads with `signWebhook(body, appSecret)` to simulate Meta, and point `baseUrl` at a stub on `127.0.0.1`. All tests use a fake `fetch` and never touch the network.

## India-specific notes

- **Phone numbers:** always send `+91` plus 10 digits. Without the `+`, Meta prepends the *business* number's country code, so an Indian business sending `(631) 555-1234` reaches `+91631…`. Set `defaultCountryCode: '91'` and keep CRM numbers in E.164.
- **Billing currency:** billing localisation for India launched on 2026-01-01. Businesses whose Sold-To country is India must migrate **every Messaging account to INR by 2026-12-31**. From 2027-01-01, Meta stops delivering for non-INR accounts of eligible customers. Use the Currency Migration API or Billing Hub. **This affects Phoenix directly, so check every connection's currency.**
- **Pricing (per-message since 2025-07-01, changed again 2026-10-01):** marketing, utility and authentication templates are charged per delivered message at India rates (INR rate card CSV, with volume tiers for utility and authentication). **Since 2026-10-01, service (free-form) messages are charged again** after a free tier of 1,000 per business number per month. Utility templates sent inside an open service window are now charged too. Without a payment method, service messages beyond the free tier are not delivered. Click to WhatsApp ad replies open a free entry point window (up to 7 days per the 2026 pricing page) in which nothing is charged. In status webhooks, `pricing.type` is `regular` (charged), `free_customer_service` or `free_entry_point`. The client does not hard-code rates: pull the INR CSV from Meta's pricing page.
- **Authentication-international:** a business whose primary location is India pays the authentication-international rate for OTPs to +91 users only if it has been made eligible for that rate. Webhooks then show `authentication-international`.
- **Template languages** for Indian audiences: `en`, `en_IN`, `hi`, `bn`, `bn_IN`, `gu`, `kn`, `ml`, `mr`, `pa`, `ta`, `te`, `ur`. Each language is a separate template under the same name and counts toward the template limit.
- **Opt-in** is required by WhatsApp policy before sending templates, and the opt-in must name the business. Also record consent under the DPDP Act 2023 (lawful-purpose consent, withdrawal). A user tapping a "Stop promotions" quick reply should set the CRM's marketing opt-out. Meta also enforces opt-out itself (`131050`).
- **Marketing frequency:** Indian users receive many marketing messages, and Meta may hold some for ecosystem health (`131049`). Do not retry these for at least 24 h. Prefer utility templates for admission and fee reminders, which really are utility.
- **WhatsApp Payments (India)** exists (`payment_configuration_update` webhook) but is out of scope here.

## Wrapping it in the adapter (wave 2)

- Build the client once per connection: `createWaClient(decryptedConfig, { fetch, now, logger: logger.child({ connectionId }) })`.
- Map adapter calls one to one: `send({ channel: 'whatsapp', template | text | media })` goes to `sendTemplate`, `sendText` or `sendMedia`. The adapter's outbox id goes in `callbackData`.
- Map `WaError.retryable` and `ambiguous` onto the framework's retryable and permanent error types. Use `retryAfterMs` for queue delays.
- Webhook route: raw body, then `client.verifyWebhook`, then `parseWebhook`, then upsert events by `eventId`, then reply 200. Resolve the connection from `phoneNumberId` (or a `:connectionId` route param).
- Templates screen: `listTemplates` (cursor paging), then `createTemplate`, with `template.status` events updating rows.

## Not covered yet

- The Resumable Upload API, which provides the `header_handle` needed when *creating* templates with media headers (sending media headers works).
- Flows, catalog/commerce messages, calling, groups API, Marketing Messages API (`marketing_lite`), Payments, business profile, phone registration/2FA, embedded signup / onboarding, webhook overrides.
- Template archive/unarchive and bulk delete by `hsm_ids`.
- Parsing `message_template_quality_update`, `template_category_update`, `account_update` and `account_alerts` into typed events (they come through as `other`).
- Reading the `X-Business-Use-Case-Usage` header for proactive throttling.

## Unconfirmed

- The **Graph API v27.0** release date. Meta's 2026 WhatsApp examples use v27.0 and the changelog page says it is the latest, but the versions table stops at v26.0 (2026-07-29). The default here is v26.0.
- **Media header send shape** (`{ type: 'image', image: { id | link } }`) and the **quick-reply button parameter** (`{ type: 'payload', payload }`). Both come from long-standing docs; the 2026 pages fetched show only creation syntax for these.
- **`biz_opaque_callback_data` max length of 512.** The status webhook docs confirm the field round-trips, but not its limit. The client enforces 512.
- **Media download host** (`lookaside.fbsbx.com`). It is observed in practice but not stated in the docs, so it is configurable through `mediaHosts`.
- Whether media URLs ever redirect. `downloadMedia` uses `redirect: 'error'` so the token can never be forwarded; if Meta starts redirecting, downloads fail closed with kind `network`.
- **Webhook `sha256` encoding.** Meta does not say whether it is hex or base64; `downloadMedia` accepts either.
- **`checkConnection` fields** `verified_name` and `quality_rating`. These are long-standing; only `throughput` was confirmed on the 2026 throughput page.
- **HTTP statuses for most error codes.** Meta lists them only for Marketing Messages API errors, so classification keys on `error.code` and uses HTTP status only as a fallback.
- **Test-number recipient allow-list** (up to 5 numbers in development). This was not on the fetched pages.
- The **free entry point window** length: the 2026 pricing page says "up to 7 days", while older docs said 72 hours. Check before relying on it.
- The old Messenger-era note that signatures are computed over the "escaped unicode" payload. Using the raw bytes makes this irrelevant.

## Sources

All pages read on 2026-11-05. Base: `https://developers.facebook.com/documentation/business-messaging/whatsapp/`.

- `webhooks/create-webhook-endpoint`: GET verification, `X-Hub-Signature-256`, 7-day retries, batching up to 1000
- `webhooks/overview`: fields, 3 MB payloads, retries and duplicates, mTLS and IPs, Live mode
- `webhooks/reference/messages/{status,text,image,interactive,button,reaction,location,unsupported,errors}`
- `webhooks/reference/message_template_status_update`
- `messages/send-messages`: request and response shapes, `+` number format with the India example, `messaging_account_id`, TTL, media caching
- `messages/mark-message-as-read`, `typing-indicators`
- `templates/overview`, `templates/template-management`, `templates/components` (URL encoding), `templates/supported-languages`
- `reference/whatsapp-business-account/message-template-api`, `reference/whatsapp-business-phone-number/message-api`
- `business-phone-numbers/media`: endpoints, 5-minute URLs, 30-day and 7-day ids, MIME types and sizes
- `throughput`, `messaging-limits`, `about-the-platform` (rate limits, pair limits, test resources)
- `pricing`, `pricing/authentication-international-rates`
- `business-scoped-user-ids`
- `access-tokens`
- `https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes`: error codes and retry guidance
- `https://developers.facebook.com/docs/graph-api/webhooks/getting-started`: signature scheme
- `https://developers.facebook.com/docs/graph-api/securing-requests`: `appsecret_proof`
- `https://developers.facebook.com/docs/graph-api/changelog/versions/`: version dates
