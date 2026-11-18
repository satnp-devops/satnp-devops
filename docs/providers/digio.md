# Digio e-sign (DigiSign)

Client module: `apps/api/src/integrations/providers/digio/`
Tests: `apps/api/test/providers/digio/` (fake fetch, no network)
Adapter kind: `esign`

Digio is an Indian e-sign provider. It supports Aadhaar eSign (OTP, biometric or face, issued
through a licensed eSign Service Provider), electronic signatures (drawn, typed or OTP-backed)
and USB-token DSC signing. The platform uses it for admission agreements (B2C, signed by a
parent or guardian) and software contracts (B2B, signed by institute signatories).

## Capabilities

| Capability | Supported | How |
|---|---|---|
| Upload a PDF for signing | Yes | `POST /v2/client/document/uploadpdf` (base64 in JSON, default) or `POST /v2/client/document/upload` (multipart) |
| Signers: identifier, name, reason, sign type | Yes | `signers[]`: identifier is an email or a 10-digit mobile number. Sign types: `aadhaar` (default), `electronic`, `dsc` |
| Signing order | Yes | `sequential: true` with signers in array order. The client sorts by `order` |
| Expiry | Yes | `expire_in_days`, 1 to 90 days, Digio's default is 10 |
| Signing link | Yes | `authentication_url` per signer (`include_authentication_url: true`), or a link built by the client in the redirect-approach format |
| Status fetch | Yes | `GET /v2/client/document/{id}` |
| Signed PDF download | Yes | `GET /v2/client/document/download?document_id={id}` |
| Audit trail PDF | Yes | `GET /v2/client/document/{id}/v2/audit_log` |
| Cancel | Yes | `POST /v2/client/document/{id}/cancel` |
| SDK access token | Yes | `POST /user/auth/generate_token` (only needed for Digio's JS and mobile SDKs) |
| Idempotency | Yes | Digio's `callback` field: "Unique ID … for idempotency … same callback Id … will be considered duplicate request and information about previous document will be returned" |
| Webhooks | Yes | `doc.signed`, `doc.sign.failed`, `doc.sign.rejected`, authenticated with an HMAC-SHA256 `X-Digio-Checksum` header |
| Expiry or cancel webhooks | Not documented | Poll `getDocument()` for `expired` or `cancelled` |
| Money amounts | Not applicable | E-sign calls carry no amounts. E-stamp duty is configured as dashboard tags, not amounts |

## Module API

```js
import { createDigioClient } from '../integrations/providers/digio/index.js';

const digio = createDigioClient(
  { environment: 'sandbox', clientId, clientSecret, webhookSecret },
  { fetch, now, logger }, // all optional; global fetch, Date.now and a no-op logger by default
);

const doc = await digio.createSignRequest({
  document: { fileName: 'admission-agreement.pdf', contentBase64 },   // or content: Uint8Array
  signers: [
    { identifier: 'parent@example.in', name: 'Asha Verma', reason: 'Admission agreement',
      signType: 'aadhaar', order: 1, onBehalfOf: { name: 'Kabir Verma', relationship: 'parent' } },
    { identifier: '9876543210', name: 'Admissions Desk', signType: 'electronic', signatureMode: 'slate', order: 2 },
  ],
  expiresInDays: 7,                  // or expiresAt (ISO); 1..90 days
  idempotencyKey: 'esign_01J...',    // sent as Digio `callback`; makes the create retry-safe
  message: 'Please sign',            // Digio `comment`
  transport: 'json',                 // or 'multipart'
  providerOptions: { display_on_page: 'last' }, // any other Digio field, passed through
});
doc.signers[0].signUrl;              // Digio authentication_url
digio.getSigningUrl({ documentId: doc.id, identifier: 'parent@example.in', redirectUrl });
await digio.getDocument(doc.id);
await digio.downloadSignedDocument(doc.id);   // { bytes, contentType, fileName, size }
await digio.downloadAuditTrail(doc.id);
await digio.cancelSignRequest(doc.id);
digio.verifyWebhook(rawBody, req.headers);    // { ok: true } | { ok: false, reason }
digio.parseWebhook(rawBody);                  // normalised event
```

The module also exports these pure helpers, which need no client: `verifyWebhook(rawBody, headers,
secret, { toleranceSeconds?, now? })`, `parseWebhook(body, { includeRaw? })`,
`computeWebhookChecksum`, `buildSigningUrl`, `parseSigningRedirect`, `parseDigioTime`,
`isDigioWebhookIp`, `normalizeDocument`, `DIGIO_ENVIRONMENTS`, `DIGIO_CAPABILITIES` and `DigioError`.

### Normalised document

```js
{ provider: 'digio', id: 'DID…', status: 'draft'|'pending'|'completed'|'expired'|'failed'|'cancelled'|'unknown',
  providerStatus, fileName, createdAt, updatedAt, expiresAt, pageCount, cancelReason, allSigned,
  signers: [{ identifier, name, status: 'pending'|'waiting'|'signed'|'expired'|'cancelled'|'removed'|'failed'|'skipped'|'unknown',
              providerStatus, signType, signatureMode, reason, signUrl, expiresAt, updatedAt,
              signedName, nameMatchScore }],
  accessToken: { id, entityId, validUntil, createdAt } | null }
```

All times are ISO-8601 UTC. Digio's REST responses use `yyyy-mm-dd hh:mm:ss` in IST, and
webhooks use epoch milliseconds. `parseDigioTime` converts both.

### Normalised webhook event

```js
{ provider: 'digio', id: 'WHN…',            // Digio notification id: dedupe on this
  type: 'esign.document.completed' | 'esign.signer.signed' | 'esign.signer.failed' | 'esign.signer.rejected' | 'unknown',
  providerEvent: 'doc.signed', occurredAt, entities, documentId, documentStatus, completed,
  signer: { identifier, status, … } | null, document: <normalised document> | null,
  error: { code, message } | null,           // doc.sign.failed, e.g. ESP errors
  validation: { overallResult, rules: [{ ruleId, result, failedFields }] } | null }  // doc.sign.rejected
```

`doc.signed` fires when a signer signs. When `agreement_status` is `completed` or
`others.has_all_signed` is true, the event type becomes `esign.document.completed`. Aadhaar
demographics (photo hash, gender, postcode, birth year, Aadhaar suffix) and the actual or
expected values compared by verification rules are dropped. Pass `{ includeRaw: true }` only
when you have to store the raw body.

### Errors

Every failure is a `DigioError` with these fields: `code`, `retryable`, `status`, `providerCode`
(Digio's `code`, for example `REQUEST_VALIDATION_FAILED` or `1128`) and `providerReference`
(Digio's `details`, for example `EX2329…`, to quote to Digio support).

| code | When | Retryable |
|---|---|---|
| `config_invalid` | Config failed validation. Issues name the fields, never the values | no |
| `validation` | Our input is invalid. Nothing is sent to Digio | no |
| `minor_signer` | A signer is marked as a minor or has a date of birth under 18 | no |
| `auth` / `forbidden` | HTTP 401 / 403 (`UNAUTHORIZED_ACCESS`) | no |
| `not_found` | 404, or Digio codes 1016, 1006, 1078, 1094 | no |
| `conflict` | Wrong state: 1021, 1047, 1055, 1082, 1107, 1108, 1152, 1155, or 409 | no |
| `duplicate_request` | 1128 "Duplicate request received" | no |
| `insufficient_credits` | 1015, 1073 | no |
| `bad_request` | Any other 4xx | no |
| `rate_limited` | 429 (Retry-After honoured) | yes |
| `provider_unavailable` | 5xx, 408, 425, or Digio codes 1001, 1017, 1199, 1205, 1208 | yes |
| `timeout` / `network` | Per-attempt timeout, or a socket or DNS failure | yes |
| `aborted` | The caller's AbortSignal fired | no |
| `invalid_response` | Non-JSON response, a document without an id, or a download that isn't a PDF | no |

Retries use exponential backoff with full jitter (base 500 ms, cap 8 s, `maxRetries` 2 by
default) and apply only to safe calls:

- GET calls (status, download, audit trail).
- Create, only when it carries an `idempotencyKey`.

Cancel and token generation are never retried. After a network error on a cancel, call
`getDocument()` to find out whether it went through. Each attempt has its own
`AbortSignal.timeout(timeoutMs)`, combined with the caller's signal.

Secrets (client secret, the Basic header value, webhook secrets) are replaced with
`[redacted]` in error messages and details. The logger only receives `{ provider, op, method,
path, status, code, providerCode, attempt, retrying, ms }`, never headers or bodies.

## Config fields

| Field | Required | Default | Where to get it |
|---|---|---|---|
| `environment` | no | `sandbox` | `sandbox` or `production`. Each environment has its own credentials, webhooks and secret |
| `clientId` | yes | none | Enterprise dashboard: sandbox https://ext-enterprise.digio.in, production https://enterprise.digio.in. API credentials are issued by Digio when the account is set up (ask your Digio account manager if they aren't shown) |
| `clientSecret` | yes | none | Issued with the client id. Used as the Basic-auth password |
| `webhookSecret` | for webhooks | none | Dashboard > Profile > Webhooks > the webhook group's "Group secret". Pass an array to accept several during rotation or across several groups |
| `apiBaseUrl` / `appBaseUrl` | no | per environment | Overrides for proxies or tests (https only) |
| `timeoutMs` | no | 30000 | Per attempt |
| `maxRetries`, `retryBaseDelayMs`, `retryMaxDelayMs` | no | 2, 500, 8000 | |
| `maxDocumentBytes` | no | 10 MiB | Our own guard. Digio rejects oversize files with error 1037 but doesn't publish the limit |
| `defaultExpiryDays` | no | 10 | 1 to 90 |
| `notifySigners` | no | false | When true, Digio emails, SMSes or WhatsApps signers itself (`notify_signers` + `send_sign_link`). When false, the CRM sends the links |
| `notificationChannel` | no | `SMS` | `SMS`, `WHATSAPP`, `EMAIL` or `ALL` (`customer_notification_mode`) |
| `redirectUrl`, `logoUrl` | no | none | Defaults for `getSigningUrl()` |
| `retryCreateWithIdempotencyKey` | no | true | Set to false to never resend a create |

Hosts (https://documentation.digio.in/digienvironments/):

| | Sandbox | Production |
|---|---|---|
| REST API | `https://ext.digio.in:444` | `https://api.digio.in` |
| Signing pages | `https://ext.digio.in` | `https://app.digio.in` |
| Dashboard | `https://ext-enterprise.digio.in` | `https://enterprise.digio.in` |
| Webhook source IPs | `35.154.20.28` | `13.126.198.236`, `52.66.66.81` |

Authentication is HTTP Basic (the OpenAPI security scheme `api_auth: http basic`):
`Authorization: Basic base64(clientId:clientSecret)`.

## Signing links

There are two ways to get a signing link:

1. **`signUrl` from the API.** The client always sends `include_authentication_url: true`.
   Digio then returns `authentication_url` for each signer. Prefer this link.
2. **The redirect approach** (documentation.digio.in/sdk/redirect_url/redirect_url_sdk/), which
   `getSigningUrl()` builds:
   `{app}/#/gateway/login/{documentId}/{anyRandomTxnId}/{signerIdentifier}?redirect_url={encoded}&logo={encoded}`.
   After signing, Digio redirects to
   `redirect_url?status=success&digio_doc_id=…&message=Signing Success`.
   That query is **not signed**. `parseSigningRedirect()` marks it `trusted: false`, so confirm
   the outcome with `getDocument()` or the webhook before acting on it.

## Webhooks

**Setup:**

1. Log in to the enterprise dashboard, open Profile > Webhooks and choose "Configure Webhook".
   The first time, this creates the Default group.
2. Create a webhook group, or edit the existing one. Set the group URL to the platform's
   endpoint and set a group secret.
3. Activate the DigiSign events: `doc.signed`, `doc.sign.failed`, `doc.sign.rejected`.
4. Set up sandbox and production separately. They are independent accounts with separate
   endpoints and secrets.

**Verification scheme (exact):**

- Header: `X-Digio-Checksum` (case-insensitive).
- Value: lowercase or uppercase hex of `HMAC-SHA256(key = webhook secret, message = raw request body bytes)`.
  The FAQ says: "HmacSHA256 hex string of payload can be generated using the secret key and
  compared with the checksum provided in X-Digio-Checksum header."
- The client decodes the hex and compares bytes with `crypto.timingSafeEqual`. It checks every
  configured secret, with no early exit.
- The client rejects these cases:
  - A missing header, or a duplicated header.
  - A value that isn't 64 hex characters (for example a `sha256=` prefix or base64).
  - A missing secret.
  - A body passed as an already-parsed object. Re-serialising changes the bytes, so mount the
    route with `express.raw({ type: 'application/json' })` and pass the bytes.
- Timestamp: Digio sends **no signed timestamp header and defines no tolerance**. The body's
  `created_at` (epoch ms) is covered by the HMAC. `toleranceSeconds` can optionally check it,
  allowing 5 minutes of future skew. Keep it at or above 90000 seconds (25 hours) if you use it,
  because Digio retries failed deliveries for 24 hours and queues events while a webhook is
  disabled. The main replay defence is deduping on the event `id`.
- Optional extra check: `isDigioWebhookIp(remoteIp, environment)` against the published source
  IPs. Use it only when the real client IP is known (behind a proxy, configure `trust proxy`).

**Delivery behaviour** (from Digio's webhook FAQ):

- Delivery is at-least-once. `id` is the unique notification id to dedupe on.
- Only a `200` within **10 seconds** counts as success.
- Failed deliveries are retried after 5, 10, 15 and 30 minutes, then hourly for up to 24 hours.
  After 24 hours of failures the webhook account is disabled and Digio sends an email. You
  re-enable it in the dashboard, and queued events are then delivered.
- The queue is per account or group. One failing event blocks the events behind it, so always
  return 200 quickly: verify, persist, enqueue, then acknowledge. Return 200 even for unknown
  documents.
- Average delivery delay is about 5 seconds in production and about 5 minutes in sandbox.
- Ignore unknown fields. Other Digio products (NACH and others) can share a group; their events
  are parsed as `type: 'unknown'`.

**Test vectors** (computed with node:crypto; see `webhook.test.js`):

| Secret | Body | X-Digio-Checksum |
|---|---|---|
| `Jefe` | `what do ya want for nothing?` | `5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843` (RFC 4231 case 2) |
| `whsec_phoenix_test_0001` | the `doc.sign.failed` body `BODY_A` in the test | `a898c95e6a36d906f758c2c75aefa7b1f0d9293acfcbcdd6538e8b56613d32a3` |

Digio publishes no checksum examples of its own. The FAQ links to generic HMAC examples
(github.com/danharper/hmac-examples).

## Rate limits

Digio's public documentation doesn't publish API rate limits. The client treats `429` as
`rate_limited` (retryable, honouring `Retry-After`) and backs off. Ask Digio for the account's
limits before bulk sends, such as an admission-season campaign. Error 1128 ("Duplicate request
received … retry after 10 minutes") implies a duplicate-detection window.

## Sandbox and test mode

- The sandbox has its own hosts, credentials, dashboard, webhook endpoint and secret.
- Sandbox is "mainly for functional testing", and its webhooks arrive about 5 minutes late.
- Digio's sandbox host for the JS SDK is `https://ext.digio.in/sdk/v11/digio.js`, and for
  production it is `https://app.digio.in/sdk/v11/digio.js`. This client doesn't need the SDK.
- Local development: use a public tunnel or a request-bin endpoint for sandbox webhooks. Use
  `computeWebhookChecksum()` to sign test payloads.

## India-specific notes

- **Minors cannot sign.** Under the Indian Contract Act 1872 (s.11) a minor (under 18, Indian
  Majority Act 1875) can't enter a contract. For B2C admissions the parent or legal guardian is
  the signer.
  - The client rejects a signer with `isMinor: true`, or with a `dateOfBirth` under 18 on the
    IST calendar date, as `minor_signer`.
  - Use `onBehalfOf: { name, relationship: 'parent' | 'guardian' }`. It adds "Signing as parent
    of <student>" to the signing reason.
  - The date of birth is never sent to Digio.
- **Aadhaar eSign** is legally valid under the IT Act 2000 (Second Schedule) and needs a mobile
  number linked to the signer's Aadhaar for OTP. Digio errors 110, 111 and 112 cover a missing
  mobile or email. Use `fallback_sign_types` (via `providerOptions`) to let a signer switch to
  `electronic` if Aadhaar fails.
- **Aadhaar data.** Webhooks include Aadhaar-derived details (last digits, photo hash, gender,
  postcode, birth year). The normaliser drops them. Keep `includeRaw` off unless storage of that
  data has been reviewed under the Aadhaar Act and DPDP Act 2023.
- **Name match.** `nameMatchScore` (Digio's `name_validation_score`, 0 to 100) compares the
  Aadhaar name with the name we sent. It is useful for flagging a guardian or signatory mismatch.
- **Mobile identifiers** are sent as 10 digits starting 6 to 9. The client strips `+91`, `91`
  and `0` prefixes and separators.
- **IST.** Digio's REST times are IST wall-clock times. Expiry `expire_on` is 23:59:59 IST of the
  last day.
- **E-stamping** (stamp duty) is available through `estamp_request` tags configured in the
  dashboard. It isn't wrapped here; pass it through `providerOptions`.
- **DSC** signing needs the signer's USB token, Digio's desktop "Smart Client" and Java. It
  suits B2B institute signatories, not parents.

## Notes for the adapter (wave 2)

- `createSignRequest`, `getDocument`, `cancelSignRequest`, `downloadSignedDocument`,
  `downloadAuditTrail` and `getSigningUrl` map one-to-one onto an esign adapter. Pass the
  platform's request id as `idempotencyKey`.
- The webhook route:
  1. Read the raw body.
  2. Run `client.verifyWebhook(raw, headers)`. If the result isn't `ok`, respond 401.
  3. Run `parseWebhook(raw)` and dedupe on `id`.
  4. Enqueue and respond 200.
  5. On `esign.document.completed`, download the signed PDF in the worker.
- There are no expiry or cancel webhooks, so schedule a `getDocument()` poll at `expiresAt`.

## Sources

All sources were downloaded or read on 2026-11-05:

- Digio OpenAPI spec (Digio Apis, OpenAPI 3.0.1), operations `uploadPdfFile`, `uploadFile`,
  `getDocumentObject`, `downloadDocument`, `cancelSignRequest`, `getDocumentAuditLogV2` and
  `generateGatewayToken`, rendered at
  https://documentation.digio.in/digisign/api_integration/create_sign_request/ and
  https://documentation.digio.in/digisign/additional_api/.
- https://documentation.digio.in/digienvironments/ (hosts, webhook IPs, credentials).
- https://documentation.digio.in/digisign/access_digi_sign/ (dashboard URLs).
- https://documentation.digio.in/digisign/api_integration/webhooks/ (events, sample payloads).
- https://documentation.digio.in/webhooks/, https://documentation.digio.in/webhooks/structure/
  and https://documentation.digio.in/webhooks/faq/ (X-Digio-Checksum, retries, timeouts, IPs,
  groups).
- https://documentation.digio.in/sdk/redirect_url/redirect_url_sdk/ (signing-link format,
  redirect parameters).
- https://documentation.digio.in/sdk/web/web/ (SDK callback fields, SDK hosts).
- https://documentation.digio.in/digisign/error_codes/ (numeric error codes).
- https://documentation.digio.in/digisign/types_of_sign/ (Aadhaar, electronic, DSC).
- RFC 4231 (HMAC-SHA256 test vectors).

## Unconfirmed

- Basic-auth mapping. The username is the client id and the password is the client secret.
  Digio's spec only declares `http basic` and "use client id/client secret".
- Checksum hex case. We accept either case.
- The checksum is computed over the exact raw bytes Digio sends, with no canonicalisation. The
  FAQ only says "payload".
- The HTTP status codes Digio uses for its numeric error codes (the spec shows 400 and 403
  examples only). The mapping relies on `code` where present.
- Exact `callback` dedupe behaviour. The spec says a duplicate returns the previous document,
  while error 1128 suggests a 10-minute duplicate window.
- Multipart `request` part encoding. We send it as a JSON part (`Content-Type: application/json`,
  no filename). Digio's spec only lists `request` as an object. The JSON transport is the
  default because it is unambiguous.
- Sign order. The order comes from the array order when `sequential: true`. The `signers[].index`
  field exists but is undocumented, so it isn't sent.
- Mobile identifier format. Digio's samples use 10-digit numbers; whether `+91…` is also
  accepted isn't documented.
- Whether `authentication_url` is always returned for every signer type.
- Whether the redirect-approach URL needs the identifier URL-encoded. The docs' sample leaves
  `@` raw, so the client inserts validated identifiers as-is.
- File size limit, page limits, maximum number of signers and API rate limits aren't published.
- Whether download returns a partially signed PDF before completion, and whether it may
  redirect. The client follows redirects for downloads only.
- Event list: no webhook events for expiry, cancel or viewing are documented for DigiSign.
- Signer and document status values beyond the spec enums. `cancelled` at document level is
  inferred from `cancel_reason` and signer status values.
- Timezone of `generate_token` timestamps (assumed IST like the other REST times).
- `aadhaar_with_dependents`, `electronic_with_dependents`, `nesl_aadhaar_sign` and
  `document_review` sign types and modes appear in the spec without descriptions, so they aren't
  exposed. They may relate to signing for dependents; ask Digio before using them for guardian
  flows.
- The legal and regulatory notes summarise Indian law for engineers. They aren't legal advice;
  have counsel confirm the guardian-signing wording for admission agreements.
