# SendGrid (Twilio SendGrid) email provider

Code: `apps/api/src/integrations/providers/sendgrid/` · Tests: `apps/api/test/providers/sendgrid/` · Adapter kind: `messaging.email`

This module talks to SendGrid. It has no dependencies beyond `zod` and `node:crypto`, and it is not wired into the app yet. Wave 2 wraps it in the adapter interface.

## Module map

| File | What it does |
|---|---|
| `index.js` | `createSendgridClient(config, { fetch, now, logger, sleep, random })`, `CAPABILITIES`, and re-exports of every pure helper |
| `config.js` | zod schema `sendgridConfigSchema`, `parseSendgridConfig`, `describeConfig` (safe to show; never prints the key) |
| `mail.js` | `buildMailSendBody(message, config)`: turns a normalised message into the v3 `/mail/send` JSON and enforces SendGrid's limits locally |
| `http.js` | Bearer auth, `AbortSignal.timeout`, retries with exponential backoff and jitter, rate-limit headers, typed errors |
| `errors.js` | `SendgridError` with `code`, `status`, `retryable`, `outcomeUnknown`, `retryAfterMs`, `providerErrors`, `issues`; `redactSecrets` |
| `webhook.js` | `verifyWebhook(rawBody, headers, publicKey, { toleranceSeconds, now })`, used for both the Event Webhook and a signed Inbound Parse |
| `events.js` | `parseWebhook(body, { messageIdArg })` turns the payload into `NormalisedEvent[]` |
| `inbound.js` | `parseInboundEmail(rawBody, headersOrContentType)` turns the payload into an `InboundEmail` (handles both parsed and raw modes) |
| `multipart.js`, `mime.js` | A byte-safe multipart/form-data parser, RFC 2047 header decoding, address lists, and a small MIME walker |
| `unsubscribe.js` | RFC 8058 one-click helpers (list headers, POST detection, HMAC tokens). Nothing in it is specific to SendGrid |

## Capabilities

| Capability | Status | Notes |
|---|---|---|
| Send (v3 Mail Send) | yes | `POST /v3/mail/send` returns **202 Accepted**. The provider id is in the `X-Message-Id` response header |
| Dynamic templates | yes | `templateId` must start with `d-`; `templateData` goes into `dynamic_template_data` (Handlebars). Legacy templates are not supported |
| Personalizations | yes | Up to 1,000 per request. Each one can have its own `messageId`, `templateData`, `customArgs`, `headers`, `sendAt` and `unsubscribe` |
| Categories | yes | Config `defaultCategories` plus per-message categories, de-duplicated. At most 10, ASCII only, 255 characters each |
| custom_args | yes | `custom_args[messageIdArg]` (default `phoenix_message_id`) always carries **our** message id. Events report it back |
| Reply-to | yes | `replyTo` or `replyToList` (one or the other), with config `defaultReplyTo` as the fallback |
| Attachments | yes | Pass a Buffer/Uint8Array (we base64 it) or a base64 string. Inline attachments need `contentId` |
| Scheduling | yes | `sendAt` (Date, ISO string with offset, or unix seconds), at most 72 hours ahead. `createBatchId()` gives a `batchId` that can be cancelled later |
| Unsubscribe groups (ASM) | yes | `asm: { groupId?, groupsToDisplay? }`; `groupId` falls back to config `asmGroupId`. Opt-in for each message |
| One-click unsubscribe (RFC 8058) | yes | `unsubscribe: { url, mailto? }` adds `List-Unsubscribe` and `List-Unsubscribe-Post`, and turns SendGrid's subscription tracking off for that message unless `tracking.subscription` is set |
| Open/click tracking | yes | `tracking: { opens, clicks }` |
| Sandbox | yes | Config `sandboxMode`, `message.sandbox`, or `client.validate(msg)`. SendGrid returns **200**, delivers nothing and sends no events. We return `status: 'validated'` |
| Idempotency keys | **no** | Mail Send has none. See "Retries and duplicates" |
| Event Webhook | yes | Signed with ECDSA P-256. Events: processed, deferred, delivered, bounce (hard) / blocked (soft), dropped, open, click, spamreport, unsubscribe, group_unsubscribe, group_resubscribe, account_status_change |
| Inbound Parse | yes | multipart/form-data in default ("parsed") mode and in raw MIME mode. It can be signed with the same scheme through a security policy |
| Regions | global, eu | `https://api.sendgrid.com` and `https://api.eu.sendgrid.com` (EU regional subusers on Pro plans and above) |
| Connection test | yes | `testConnection()` calls `GET /v3/scopes` and reports `canSend` when the `mail.send` scope is present |

### Client API (summary)

```js
const client = createSendgridClient(config, { fetch, now, logger });
await client.send({ messageId, to, subject, text, html, ... });   // { status, messageId, providerMessageId, sandbox, recipients, acceptedAt, statusCode, attempts, rateLimit }
await client.validate(message);                                  // the same call in sandbox mode
client.buildRequest(message);                                    // the exact JSON body, no I/O
await client.testConnection();                                   // { ok, canSend, scopes }
await client.getEventWebhookPublicKey(webhookId);                // { webhookId, publicKey }
await client.createBatchId();                                    // { batchId }
client.verifyWebhook(rawBody, headers);                          // { ok: true, timestamp } | { ok: false, reason }
client.parseWebhook(rawBody);                                    // NormalisedEvent[]
client.verifyInbound(rawBody, headers);                          // same scheme, inbound key
client.parseInbound(rawBody, headers);                           // InboundEmail
```

`NormalisedEvent` fields: `providerEventId` (`sg_event_id`, which SendGrid says to use for de-duplication, or `synthetic:<sha256>` when the event has none), `type` (our name: `delivered`, `opened`, `clicked`, `bounced`, `deferred`, `dropped`, `spam_reported`, `unsubscribed`, `group_unsubscribed`, `group_resubscribed`, `processed`, `account_status_changed`, or `unknown`), `providerType`, `messageId` (ours, from custom_args), `providerMessageId` (`sg_message_id`), `xMessageId`, `email`, `occurredAt` (ISO UTC), `categories`, `customArgs`, `bounce { kind: hard|soft, classification, reason, status }`, `reason`, `response`, `attempt`, `url`, `userAgent`, `ip`, `machineOpen`, `asmGroupId`, `accountStatus`, `suppressRecipient`, `raw`.

`InboundEmail` fields: `mode`, `dedupeKey` (the Message-ID, or a hash of the body), `from`, `to`, `cc`, `replyTo`, `subject`, `text`, `html`, `date`, `messageIdHeader`, `inReplyTo`, `references`, `envelope { from, to[] }`, `recipientTags` (the part after `+` in envelope recipients), `headers`, `attachments[] { filename, contentType, contentId, disposition, size, content: Buffer }`, `spam { score, report }`, `spf`, `dkim`, `senderIp`, `charsets`.

## Config fields

All secrets come from this object only. They are never logged, and `describeConfig` shows only whether each one is set.

| Field | Required | Default | Where to get it |
|---|---|---|---|
| `apiKey` | yes | | SendGrid app → Settings → API Keys → Create. A *Restricted Access* key with **Mail Send** is enough for sending. Add *Mail Settings* / Event Webhook read access for `getEventWebhookPublicKey`, and *API Keys* read for `/v3/scopes` (see Unconfirmed). The key is shown only once |
| `defaultFrom` `{ email, name? }` | yes | | A verified Sender Identity or an address on an authenticated domain (Settings → Sender Authentication) |
| `defaultReplyTo` | no | | Any mailbox, for example the admissions desk |
| `region` | no | `global` | `eu` only for EU regional subusers |
| `baseUrl` | no | | Overrides the host, for proxies and tests |
| `eventWebhookPublicKey` | to verify events | | Settings → Mail Settings → Event Webhooks → edit the webhook → Security features → enable *Signed Event Webhook* → copy the *Verification Key*. You can also call `getEventWebhookPublicKey(id)` |
| `inboundParsePublicKey` | to verify inbound | | The `policy.signature.public_key` returned by `POST /v3/user/webhooks/security/policies` (`{ "signature": { "enabled": true } }`), after you attach the policy to the parse setting |
| `webhookToleranceSeconds` | no | `null` (off) | Our own replay window. SendGrid defines none (see below) |
| `sandboxMode` | no | `false` | Set it to `true` in dev and staging connections |
| `timeoutMs` | no | `10000` | |
| `maxRetries` | no | `2` | Retries after the first attempt |
| `onBehalfOf` | no | | A subuser username. Sent as the `on-behalf-of` header on management calls only (scopes, webhook key, batch id), not on mail send |
| `ipPoolName` | no | | Dedicated-IP plans only |
| `asmGroupId` | no | | Marketing → Unsubscribe Groups (`id`) |
| `messageIdArg` | no | `phoenix_message_id` | The custom_args key that carries our id |
| `defaultCategories` | no | `[]` | For example `['phoenix', 'admissions']` |

The one-click token helper takes its own `secret` argument of 32 or more characters. That secret belongs in the platform config and is not part of this schema.

## Retries and duplicates

- **Mail send is not idempotent.** SendGrid has no idempotency key. The client retries `/mail/send` only when SendGrid certainly did not act on it: an HTTP **429**, using `Retry-After` or `X-RateLimit-Reset` (waits up to 30 s inside the call; for longer waits it returns `rate_limited` with `retryAfterMs`), and connection failures before any bytes were sent (`ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, `ENETUNREACH`, `EHOSTUNREACH`, `UND_ERR_CONNECT_TIMEOUT`).
- A timeout, connection reset or **5xx** on mail send throws an error with `retryable: true` and **`outcomeUnknown: true`**. The email may already be queued. The outbox should either wait for an Event Webhook event carrying our `messageId` before retrying, or accept that a retry can send the email twice.
- GETs (`/v3/scopes`, the webhook key) are retried on 429, 5xx, timeout and network errors. Backoff is 500 ms × 2^(attempt−1), with 50–100% jitter, capped at 8 s.
- Error codes: `validation` (400, or rejected by our own checks before sending; then `issues[]` lists field paths), `auth` (401), `forbidden` (403), `not_found` (404), `payload_too_large` (413), `rate_limited` (429), `provider_error` (5xx), `timeout`, `network`, `config`, `invalid_payload` (a bad webhook body). `permanent === !retryable`.

## Webhooks

### Event Webhook setup

1. Settings → Mail Settings → Event Webhooks → Create. Set the Post URL to our HTTPS endpoint (TLS 1.2+). SendGrid **does not follow redirects**.
2. Select the events: Processed, Delivered, Deferred, Bounced, Dropped, Opened, Clicked, Spam Report, Unsubscribe, Group Unsubscribe, Group Resubscribe.
3. Security features → enable **Signed Event Webhook** and copy the verification key into `eventWebhookPublicKey`. OAuth 2.0 (client credentials, with a bearer token in `Authorization`) is also available and can be used together with signing. This client does not implement it.
4. Use "Test Your Integration" to send sample events.

Delivery: events are batched and posted about every 30 s, or when a batch reaches 768 KB. Any response other than 2xx is retried at increasing intervals for **up to 24 hours**. Duplicates happen, so de-duplicate on `sg_event_id`. Return 2xx quickly and process the events asynchronously.

### Verification scheme (implemented exactly)

| | |
|---|---|
| Signature header | `X-Twilio-Email-Event-Webhook-Signature`: base64 of a DER (ASN.1) ECDSA signature |
| Timestamp header | `X-Twilio-Email-Event-Webhook-Timestamp`: unix seconds, used exactly as sent |
| Signed bytes | `timestamp header value` + `raw request body bytes`. Hash the body **before** any JSON or multipart parsing. Re-serialised JSON, or a body with its trailing `\r\n` removed, fails |
| Algorithm | ECDSA P-256 (prime256v1) with SHA-256, checked with `crypto.verify('sha256', data, { key, dsaEncoding: 'der' }, sig)` |
| Key | The verification key: base64 DER SubjectPublicKeyInfo (`MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE…`). PEM is also accepted. Keys that are not P-256 are rejected |
| Tolerance | **SendGrid defines none.** `webhookToleranceSeconds` (off by default) rejects timestamps older or newer than now ± N seconds |
| Comparison | The check is ECDSA verification inside OpenSSL; there is no byte comparison of secrets in our code. The HMAC unsubscribe token uses `timingSafeEqual` |
| Failure reasons | `missing_signature`, `missing_timestamp`, `invalid_timestamp`, `timestamp_out_of_tolerance`, `invalid_public_key`, `malformed_signature`, `signature_mismatch`, `invalid_body` |

Test vectors: `webhook.test.js` checks the two official vectors from the sendgrid-nodejs `eventwebhook.spec.js` (single and multi-event, including the `\r\n` line endings) and the official negative cases. It also checks a fixed vector we generated with `node:crypto` and freshly signed requests (valid, tampered body, tampered timestamp, expired).

Express note: mount the webhook route with `express.raw({ type: '*/*', limit: '5mb' })` (or `40mb` for inbound) **before** `express.json()`, so that `req.body` is the raw Buffer.

### Inbound Parse setup

1. Point an MX record for a subdomain (for example `in.phoenix.example`) at `mx.sendgrid.net`. The domain must be authenticated in SendGrid.
2. Settings → Inbound Parse → Add Host & URL. You can tick "POST the raw, full MIME message"; the parser handles both modes.
3. Optional signing: create a security policy (`POST /v3/user/webhooks/security/policies` with `{"name":"…","signature":{"enabled":true}}`), attach it with `PATCH /v3/user/webhooks/parse/settings/{hostname}` `{ "security_policy": "<id>" }`, and store `signature.public_key` in `inboundParsePublicKey`. Requests then carry the same two `X-Twilio-Email-Event-Webhook-*` headers, signed over the raw multipart body.
4. A non-2xx response (documented as 5xx) is retried for up to **3 days**, after which the message is dropped silently. Use `dedupeKey`.
5. Limits: the total message size is 30 MB. The local parts `abuse`, `postmaster` and `unsubscribe` cannot be used. Redirects are not followed.

Routing replies: send from or with reply-to `reply+<token>@in.phoenix.example`. The `recipientTags` field gives the `<token>` from the SMTP envelope. Prefer this over trusting `In-Reply-To`, which the sender controls.

## Rate limits and size limits

- v3 Mail Send: up to **10,000 requests per second** (v3 Mail Send FAQ). Other endpoints use per-endpoint limits shown in `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` (unix seconds), and return 429 when exceeded. The client exposes these as `result.rateLimit`.
- Per request: at most 1,000 recipients in total, 1,000 personalizations and 1,000 `reply_to_list` entries. The email including attachments must be under 30 MB. custom_args must total under 10,000 bytes (the errors page says 50,000 bytes per personalization; we enforce the stricter figure). At most 10 categories, 255 characters each, ASCII and unique. `send_at` at most 72 h ahead.
- Header rules: values are strings with no CR/LF (we also check this to stop header injection). These are reserved: `x-sg-id`, `x-sg-eid`, `received`, `dkim-signature`, `Content-Type`, `Content-Transfer-Encoding`, `To`, `From`, `Subject`, `Reply-To`, `CC`, `BCC`.
- Content order: `text/plain` first, then `text/html`. The builder always does this.
- Plan quotas (daily or monthly email counts) depend on the account and are not enforced here.

## Sandbox and test mode

- `mail_settings.sandbox_mode.enable = true` makes SendGrid validate the request shape and return **200 OK** instead of 202. It delivers nothing, generates **no Event Webhook or Activity events**, and uses no credits. Template content is not validated.
- Use `sandboxMode: true` on dev and staging connections, and `client.validate(msg)` for a "send test" button that never delivers.
- Webhooks can be tested end to end with "Test Your Integration" on the webhook settings page, or by replaying a captured request. Unit tests need no network.

## One-click unsubscribe (RFC 8058)

- `message.unsubscribe = { url: 'https://…/u/<token>', mailto? }` produces `List-Unsubscribe: <mailto:…>, <https://…>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. Per-recipient URLs go on each personalization.
- `createUnsubscribeToken({ c: contactId, t: topic }, secret)` creates a token and `verifyUnsubscribeToken` checks it. The token is HMAC-SHA256 and base64url, and its payload is ids only, no PII.
- The endpoint must accept a `POST` without cookies or auth and must not redirect. Use `isOneClickUnsubscribePost(rawBody, contentType)` to recognise one, in both urlencoded and multipart form. A `GET` (from a link scanner) must not unsubscribe without a confirmation step.
- RFC 8058 requires a DKIM signature that covers both headers. SendGrid signs with the authenticated domain, so set up Domain Authentication for every From domain.
- SendGrid's own subscription tracking also inserts `List-Unsubscribe` and `List-Unsubscribe-Post`. When we supply our own, the builder sets `subscription_tracking.enable = false`. Gmail and Yahoo expect a working one-click unsubscribe on bulk mail.

## India-specific notes

- **Data location:** SendGrid offers only `global` (US) and `eu` hosts; there is no India region. Recipient addresses and email content are processed outside India. Under the DPDP Act 2023 (s.16), transfers abroad are allowed unless the government restricts a destination country. Record SendGrid as a processor in the privacy notice and have legal review it (not provider documentation).
- **No PII in custom_args or categories.** SendGrid stores them as non-PII, may keep them long-term (even after the account closes) and cannot redact them. Put only opaque ids there (`phoenix_message_id`, `company_id`), never names, phone numbers or Aadhaar/PAN data.
- **Categories must be ASCII.** Use `admissions`, not `प्रवेश`. Subjects, names, bodies and template data can be any UTF-8 (Hindi and other Indian scripts are fine). Inbound parse decodes RFC 2047 words and the `charsets` field.
- **Times:** `send_at` is unix seconds (UTC). Convert IST (UTC+05:30) schedules before calling, for example `new Date('2026-11-07T10:00:00+05:30')`. All timestamps we return are ISO UTC.
- **Money in emails:** pass amounts to templates as integer minor units with an ISO currency (`{ amountMinor: 1250000, currency: 'INR' }`) and format them (₹12,500.00) in the template layer. The client never handles amounts.
- **DLT/TRAI** rules apply to SMS, not email. Email has no template registration in India.
- Billing is in USD. Whether GST is charged on SendGrid invoices to Indian businesses is not covered here (see Unconfirmed).

## Sources (official, read 2026-11-05)

All pages are under `https://www.twilio.com/docs/sendgrid/`. The page's own `dateModified` is in brackets.

- `api-reference/mail-send/mail-send` [2025-09-25]: endpoint, hosts (global/EU), headers, request schema, response codes 202/400/401/403/404/405/413/500
- `api-reference/mail-send` (overview, limitations) [2026-08-14]: 1,000 recipients, 30 MB, custom args under 10,000 bytes, 1,000 reply_to_list
- `api-reference/mail-send/errors` [2026-10-21]: header, category, custom_args (50,000 bytes) and content-order rules
- `for-developers/sending-email/v3-mail-send-faq` [no date in page; downloaded 2026-11-05]: 10,000 requests/s
- `api-reference/how-to-use-the-sendgrid-v3-api/rate-limits` [downloaded 2026-11-05]: X-RateLimit-* headers, 429
- `for-developers/sending-email/sandbox-mode` [2026-07-17]: 200 OK, no events, no credits
- `for-developers/sending-email/unique-arguments` [2025-12-04] and `categories` [2026-07-17]: non-PII storage, string values
- `glossary/x-message-id`, `glossary/message-id` [downloaded 2026-11-05]: X-Message-Id is used to correlate events
- `for-developers/tracking-events/getting-started-event-webhook-security-features` [2026-07-23]: ECDSA, headers, raw bytes, OAuth
- `for-developers/tracking-events/event` [2026-07-09]: event types, properties, bounce vs blocked
- `for-developers/tracking-events/twilio-sendgrid-event-webhook-overview` [2026-07-23]: 30 s / 768 KB batching, 24 h retries, sg_event_id de-duplication, no redirects
- `api-reference/webhooks/get-signed-event-webhooks-public-key` [downloaded 2026-11-05]: `GET /v3/user/webhooks/event/settings/signed/{id}`, `on-behalf-of`
- `api-reference/api-key-permissions/retrieve-a-list-of-scopes-for-which-this-user-has-access` [2024-11-15]: `GET /v3/scopes`
- `for-developers/parsing-email/setting-up-the-inbound-parse-webhook` [2026-10-08] and `inbound-email` [downloaded 2026-11-05]: fields, raw mode, 3-day retries, 30 MB
- `for-developers/parsing-email/securing-your-parse-webhooks` [2026-10-07] and `api-reference/settings-inbound-parse/create-a-parse-webhook-security-policy` [2026-07-02]: signed Inbound Parse
- `ui/sending-email/list-unsubscribe` [2026-07-21]: List-Unsubscribe and subscription tracking
- sendgrid-nodejs `packages/eventwebhook/src/eventwebhook.js` and `eventwebhook.spec.js` (GitHub, downloaded 2026-11-05): reference implementation and test vectors
- RFC 8058 (January 2017): one-click unsubscribe

## Unconfirmed

These could not be confirmed from the official docs:

1. Whether a **retried** Event Webhook POST carries a new timestamp and signature or the original ones. This is why the timestamp tolerance is off by default. Turn it on (for example 25 h) only after seeing retries in production.
2. Whether `X-Message-Id` is returned for **sandbox** (200) responses. The client returns `providerMessageId: null` when it is missing.
3. That the part of `sg_message_id` before the first `.` equals the `X-Message-Id` from send. The official examples show this pattern but no page states it. We correlate on our own `custom_args` id, and `xMessageId` is only a convenience.
4. Exactly which top-level event keys are custom args. SendGrid posts custom_args as top-level keys, so we treat every undocumented string key as a custom arg. A new SendGrid field could appear in `customArgs`.
5. Which header wins when a message sets its own `List-Unsubscribe` and subscription tracking or an ASM group is also on. We switch subscription tracking off; ASM together with our header is untested.
6. The custom_args size limit: the overview says under 10,000 bytes and the errors page says 50,000 bytes per personalization. We enforce 10,000.
7. That the `on-behalf-of` header works on `/v3/mail/send` (it is not listed on that page). We send it only on management calls.
8. The API key permission needed for `GET /v3/scopes`. The docs suggest any valid key can call it; this has not been tested.
9. The exact Inbound Parse retry trigger: the docs say 5xx responses are retried, while also saying any non-2xx counts as a failed delivery. Return 2xx once stored and 5xx only for temporary failures.
10. Whether a `cc` form field is always present in parsed mode. The docs list `to`/`from`/`cc`/`subject` as decoded headers but not `cc` as a field, so we fall back to the `Cc` header.
11. Whether GST is charged on SendGrid invoices to Indian businesses, and what the invoicing entity is. This needs finance or legal input.
