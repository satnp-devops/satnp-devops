# Integration framework

Phase 3 of docs/ARCHITECTURE.md (section 16: "per-company connections, credentials stored encrypted, health checks"; section 18: API keys in the `Authorization` header). Every outside service the CRM talks to sits behind an **adapter** of a **kind**. Each company has **connections** to providers, and feature code asks for "this company's WhatsApp", never for a vendor. A **mock** of every kind works with no accounts, so the whole app runs locally.

| Where | What |
| --- | --- |
| `apps/api/src/integrations/index.js` | The public API. Feature code imports only from here. |
| `integrations/framework/kinds/*.js` | The interfaces: methods, input and output zod schemas, webhook events, and a sample call per kind. |
| `integrations/framework/catalog.js` | Providers per kind: their connection-form fields and how their adapter is built. |
| `integrations/framework/mocks/*.js` | The mock adapters. |
| `integrations/framework/stubs.js` | The stub every real provider uses until its adapter ships. |
| `integrations/framework/resolve.js` | `getAdapter()` and the resolution rules. |
| `integrations/framework/shape.js` | The runtime shape check and the input/output guard. |
| `integrations/framework/credentials.js` | AES-256-GCM credential encryption, bound to the connection id. |
| `integrations/framework/identities.js` | Channel identities: normalisation, validation, and the registry loader intake uses. |
| `integrations/providers/<vendor>/` | Low-level HTTP clients for each vendor (already written; see docs/providers/). Adapters wrap these. |
| `modules/integrations/` | REST API: connections, channel identities, the sandbox outbox. |
| `modules/integrations/apiKeys/` | API keys: REST API, the `Authorization: Bearer` middleware, and the pure key logic. |
| `apps/web/src/app/(app)/settings/integrations/` | Settings › Integrations. |

Tables (migration `20261106002000_integrations.js`): `integration_connections`, `integration_connection_companies`, `channel_identities`, `integration_sandbox_messages`, `api_keys`.

## Providers chosen

The architecture names no providers. These are the choices, India first and international where needed:

| Kind | Key | Providers (provider key) | Vendor client |
| --- | --- | --- | --- |
| WhatsApp | `messaging.whatsapp` | WhatsApp Cloud API by Meta (`whatsapp_cloud`) | to be written (Graph API) |
| Email | `messaging.email` | SendGrid (`sendgrid`) | `providers/sendgrid` |
| SMS | `messaging.sms` | MSG91 with DLT templates (`msg91`) | `providers/msg91` |
| Calls | `calling` | Exotel (`exotel`) | `providers/exotel` |
| Meetings | `meetings` | Zoom (`zoom`), Google Meet (`google_meet`) | `providers/zoom`, `providers/google` |
| Calendars | `calendar` | Google Calendar (`google_calendar`), Microsoft 365 (`microsoft_365`) | `providers/google`, `providers/msgraph` |
| Payments | `payments` | Razorpay for INR (`razorpay`), Stripe for international (`stripe`) | `providers/razorpay`, `providers/stripe` |
| E-sign | `esign` | Digio (`digio`) | `providers/digio` |
| AI model | `ai` | Anthropic Claude (`anthropic`) | to be written (Messages API) |
| File storage | `storage` | Azure Blob Storage (`azure_blob`); local disk in development (the mock) | `providers/azblob` |

Every kind also has the provider `mock`. Real providers are **stubs** for now. You can create a connection for one: its credentials are validated against its fields and stored encrypted. But every call throws `integration_not_implemented` (HTTP 501), its health check fails with "not implemented yet", and its webhooks are refused (`verifyWebhook` returns `{ ok: false, reason: 'not_implemented' }`). Feature engineers replace the stubs next wave (see "Adding a provider").

## The interfaces

An adapter is a plain object:

```js
{ kind: 'messaging.email', provider: 'sendgrid', mock: false,
  healthCheck(), ...the kind's methods,
  verifyWebhook(), parseWebhook(), webhookChallenge()   // kinds the provider calls back
}
```

Every method is `async (input) => output`, with one object in and one object out. Inputs and outputs are zod schemas in `kinds/*.js`; that file is the reference, and this table is a summary. Money is integer minor units plus an ISO 4217 currency. Times are ISO 8601 instants. Phone numbers are E.164. `reference` is our own id for the call (a deal, invoice or booking id). Mocks derive their ids from it, and providers that support idempotency keys use it as one, so retries are safe.

| Kind | Methods | Webhook events |
| --- | --- | --- |
| `messaging.whatsapp` | `sendTemplate({ to, template: { name, language, bodyVariables?, ... }, reference? })`, `sendText({ to, text, previewUrl?, reference? })` (only inside the 24-hour window; otherwise the provider refuses with `details.reason: 'outside_window'`), `listTemplates()`. Sends return `{ providerMessageId, status, acceptedAt }`. | `message.received`, `message.status`, `template.status` |
| `messaging.email` | `send({ to, cc?, bcc?, from?, replyTo?, subject, text? \| html? \| templateId + templateData?, attachments?, categories?, reference? })` returns `{ providerMessageId, status, acceptedAt }` | `email.delivered`, `email.bounced`, `email.opened`, `email.clicked`, `email.spam_reported`, `email.unsubscribed`, `email.received` |
| `messaging.sms` | `send({ to, templateId, variables?, senderId?, reference? })`, registered DLT templates only | `sms.delivered`, `sms.failed` |
| `calling` | `startCall({ agentPhone, customerPhone, callerId?, record?, reference? })`, `getCall({ providerCallId })`, `getRecording({ providerCallId })` | `call.incoming`, `call.answered`, `call.completed`, `call.missed` |
| `meetings` | `createMeeting({ topic, startAt, durationMinutes, timeZone, hostEmail?, attendees?, reference? })` returns `{ providerMeetingId, joinUrl, hostUrl, passcode, startAt }`; `cancelMeeting({ providerMeetingId })`; `getAttendance({ providerMeetingId })` returns `{ participants: [{ name, email, joinedAt, leftAt, seconds }], totalSeconds, endedAt }` | `meeting.started`, `meeting.ended`, `participant.joined`, `participant.left`, `recording.ready` |
| `calendar` | `listBusy({ calendarId, from, to })`, `createEvent({ calendarId, title, startAt, endAt, timeZone, attendees?, conference?, reference? })`, `updateEvent(...)`, `deleteEvent({ calendarId, providerEventId })` | `calendar.changed` |
| `payments` | `createPaymentLink({ amountMinor, currency, description, customer, reference, expiresAt?, notes? })`, `getPayment({ providerPaymentId })`, `refund({ providerPaymentId, amountMinor?, reason?, reference })` (`reference` is the idempotency key), `createSubscription({ planRef, customer, startAt?, totalCount?, reference })`, `cancelSubscription({ providerSubscriptionId, atPeriodEnd? })` | `payment.captured`, `payment.failed`, `payment_link.paid`, `payment_link.expired`, `refund.processed`, `refund.failed`, `subscription.activated`, `subscription.charged`, `subscription.halted`, `subscription.cancelled` |
| `esign` | `createSigningRequest({ document: { fileName, contentBase64 }, signers, reference, expiresInDays?, message? })`, `getSigningRequest`, `downloadSigned`, `cancelSigningRequest` | `esign.signed`, `esign.completed`, `esign.declined`, `esign.expired` |
| `ai` | `complete({ purpose, system?, messages, maxTokens, responseFormat?: 'text' \| 'json', jsonSchema?, model?, reference? })` returns `{ text, json, model, stopReason, usage }` | none |
| `storage` | `putObject({ key, body, contentType, fileName? })`, `getObject({ key })`, `deleteObject({ key })`, `getSignedUrl({ key, expiresInSeconds, fileName?, inline? })` | none |

Every adapter also has `healthCheck()`, which returns `{ ok, message, details? }`. It checks that the credentials work and has no side effects.

### Errors

Adapters throw only `IntegrationError` (an `AppError`, so a route that lets one bubble up answers in the platform's error format):

| `code` | HTTP | Meaning |
| --- | --- | --- |
| `integration_not_connected` | 409 | The company has no usable connection of this kind (and mocks are off). |
| `integration_unavailable` | 409 | The named connection is disabled, disconnected, of another kind, or not the company's. |
| `integration_not_implemented` | 501 | The provider is a stub. |
| `integration_invalid_input` | 422 | The call broke the kind's input schema. `details` is `[{ path: 'input.to', message }]`. |
| `integration_provider_error` | 502 | The provider (or a mock told to fail) failed. Check `retryable` before retrying. `details.reason` is set when known (`not_found`, `outside_window`, `amount_exceeds_payment`, ...). |
| `integration_mocks_disabled` | 409 | A mock connection was used while mocks are off. |

Anything else an adapter throws becomes `integration_provider_error`. The original error stays on `error.cause` for logs, and its message is never shown to people, because vendor errors can echo credentials.

### The runtime shape check

Every adapter is checked when it is built (`assertAdapterShape`): `kind`, `provider`, `mock`, and each required method must be present, or it throws. Every call then goes through `guardAdapter`:

- Inputs are parsed against the kind's schema (defaults filled, unknown keys refused) before the provider sees them.
- Outside production, outputs are checked too, so an adapter that drifts from its interface fails loudly in development and tests.

`test/integrations/adapters.test.js` builds every provider in the catalogue and checks it against its kind.

## Using an adapter from feature code

```js
import { getAdapter, isIntegrationError } from '../../integrations/index.js';

// companyId must already be scoped to the request: getAdapter does no permission checks.
const whatsapp = await getAdapter({ companyId: deal.company_id, kind: 'messaging.whatsapp' });
const sent = await whatsapp.sendTemplate({
  to: '+919876543210',
  template: { name: 'booking_link', language: 'en', bodyVariables: ['Priya', link] },
  reference: deal.id,
});
// whatsapp.connection → { id, name, provider, kind, companyId, fallback }: store connection.id with what you sent.
```

Options: `connectionId` (use exactly that connection, for example the WhatsApp number a conversation is on), `trx`, `now` (a clock for tests), and `log`.

**Resolution rules** (`chooseConnection` in `resolve.js`, unit-tested in `test/integrations/resolve.test.js`):

1. When `connectionId` is given, that connection must be linked to the company, of this kind, active, and not a mock while mocks are off. Otherwise the call throws `integration_unavailable` or `integration_mocks_disabled`. There is no fallback to another connection.
2. Otherwise the company's **default** connection for the kind is used, if it is active.
3. Otherwise its **oldest active** connection of the kind.
4. Otherwise, **when mocks are allowed**, the built-in mock. Nothing is stored; `connection.fallback` is `true`, and a warning is logged once per company and kind.
5. Otherwise it throws `integration_not_connected`. **Production never falls back to a mock silently.**

Mock connections count as usable only while mocks are allowed. With mocks off, a company whose only WhatsApp connection is a mock gets `integration_not_connected`.

**Mocks allowed?** The env var `INTEGRATIONS_MOCKS` takes `auto` (the default: on unless `NODE_ENV=production`), `on`, or `off`. With mocks off, mock providers disappear from the catalogue, can't be connected, and the dev file route answers 404.

Run calls that reach providers (sends, AI calls) in background jobs, not inside a request's database transaction. Mocks record their sandbox row outside the caller's transaction ("sent" stays sent), like a real provider would.

## Connections

A connection is one provider account: kind, provider, name, non-secret `config`, encrypted credentials, status (`active` or `disabled`), health (`unknown`, `healthy` or `failing`, plus the last check time, message and error).

- **Owner.** A company, or the group for a connection several companies share (the group WhatsApp helpline). A company connection is used only by that company. A group connection lists the companies that use it (`integration_connection_companies`).
- **Default.** Each company has at most one default per kind, enforced by a unique index. A new connection becomes the default where the company has none; `makeDefault: true` or `POST /connections/:id/default` changes it. A disabled or disconnected connection is nobody's default.
- **Credentials.** `credentials_enc` is one AES-256-GCM ciphertext (`lib/crypto.js`, key `APP_ENCRYPTION_KEY`) of `{ v, c: connectionId, s: secrets }`. Decryption refuses a value whose connection id doesn't match its row, so copying one company's credentials onto another connection fails. The API never returns secrets, only hints (`"••••3f9a"` for values of 16 characters or more). Audit entries list which secret fields changed, never their values. Changing config or credentials resets health to `unknown`.
- **Disconnect** wipes the credentials, unlinks the companies and detaches channels. The row stays for history.
- **Health checks.** `POST /connections/:id/test` runs `healthCheck()` and stores the result. A change of health emits `integration_connection.health_changed`. A scheduled health sweep belongs to the jobs wave.

Permissions: `integrations.view` (see), `integrations.manage` (connect, change, disconnect). Group admins and company admins get both; marketing gets view. A connection is visible to people with view at its owner or at a company that uses it. Only managers of the **owner** can change it. Managers of a company that uses it can test it, try it, and make it their default. Anything else answers 404.

### Endpoints (`/api/v1`)

| Method and path | Permission | |
| --- | --- | --- |
| `GET /integrations/kinds` | signed in | Kinds, providers and their form fields (mocks only when allowed), identity types |
| `GET /integrations/connections?unitId=&kind=` | view | Connections in the working scope (a company: its own plus shared ones it uses; the group: all) |
| `POST /integrations/connections` | manage at the owner | `{ unitId, kind, provider, name, config, credentials, companyIds?, makeDefault? }` returns 201 |
| `GET` / `PATCH` / `DELETE /integrations/connections/:id` | view / manage | PATCH takes partial `config` and `credentials` (null clears an optional field; a field left out keeps its value), plus `status` and `companyIds` |
| `POST /integrations/connections/:id/default` | manage at that company | `{ companyId }` |
| `POST /integrations/connections/:id/test` | manage | Runs the health check |
| `POST /integrations/connections/:id/try` | manage | Mock connections only: makes the kind's sample call, which lands in the sandbox |
| `GET /integrations/identities?unitId=&type=&connectionId=` | view | Channel identities |
| `POST /integrations/identities`, `PATCH` / `DELETE /integrations/identities/:id` | manage | See below |
| `GET /integrations/sandbox?unitId=&kind=&connectionId=&cursor=` | view | The sandbox outbox, newest first, keyset-paginated |
| `DELETE /integrations/sandbox?unitId=` | manage | Clears it for the companies you manage in scope |
| `GET /integrations/local-files/:connectionId/*path` | public, signed link | Downloads from the local-disk storage mock (404 when mocks are off) |
| `GET /api-keys?unitId=&status=active\|all`, `GET /api-keys/scopes?unitId=`, `POST /api-keys`, `DELETE /api-keys/:id` | `api_keys.manage` | See "API keys" |

Events: `integration_connection.created`, `.updated`, `.default_changed`, `.health_changed`, `.disconnected`; `channel_identity.created`, `.updated`, `.archived`; `api_key.created`, `.revoked`. Every write is audited.

## Channel identities

The numbers, inboxes, forms, pages and links enquiries arrive on (`channel_identities`). Each is either **owned** by one company (`company_id`, optionally pinned to a product line) or **shared** by two or more (`shared`, `company_ids`). Types are the intake channel types (`core/intake/enquiry.js` `CHANNEL_TYPES`):

- `whatsapp`, `phone_call` and `missed_call` must normalise to E.164.
- `email` must be an address.
- Web types (`website_form`, `landing_page`, ...) match on host and path prefix.
- `partner_referral` is a link prefix.

Values are normalised with `core/intake/routing.js` `normalizeIdentity` and unique per group, so `+91 98765 43210` and `+919876543210` clash. An identity may name the connection that carries it: a WhatsApp number on a WhatsApp connection, an inbox on an email connection, a number on a calls connection. That connection must serve every company the identity routes to.

Company managers register their company's channels. Shared channels need `integrations.manage` at the group.

**Intake (next wave)** routes with the registry, as INTAKE_CORE.md describes:

```js
import { loadChannelIdentities } from '../../integrations/index.js';
const identities = await loadChannelIdentities(groupId);   // [{ id, type, identity, companyId?, productLineId?, shared, companyIds?, connectionId? }]
const result = route({ channel, identities, enquiry, classify, thresholds });
```

## Mock behaviour

Mocks are deterministic, so tests can assert on them:

- Ids are hashes of the connection id and the call (our `reference` when given), so the same call gets the same answer. Times come from the injected clock.
- Nothing random is used, except storage etags, which change on every write as they do on Azure.
- Every outbound call is recorded in `integration_sandbox_messages`, which is the **sandbox outbox** on Settings › Integrations. Recipients are masked for people without `contacts.view_pii`, and the full payload is shown only to people who have it.
- Large values are summarised (bytes, base64 and long strings).

Per kind:

| Kind | Mock behaviour |
| --- | --- |
| WhatsApp | `listTemplates` returns `booking_link`, `demo_reminder`, `payment_reminder` and `welcome_family` (en approved, hi pending). Sends are `accepted`. The mock does not enforce the 24-hour window; the messaging module must. |
| Email, SMS | Sends are `accepted` and recorded with subject or template and body. |
| Calls | Status is `queued`. Call duration is a hash of the call id (60 to 900 s). A finished call has a recording when `record` was on. |
| Meetings | Join links are `https://meet.mock.phoenix.invalid/...` and passcodes are stable. `getAttendance` gives each attendee a fixed share of the meeting (20 to 100 %, from their email), so attendance thresholds can be tested. |
| Calendars | Busy times come from the mock's own created events. |
| Payments | A link's payment id is `pay_` plus its link id, and is captured. Refunds are idempotent by `reference` and capped at what is left (`amount_exceeds_payment`). Subscriptions come back `created` with an approval link (`authUrl`), as with a mandate. |
| E-sign | Requests count as signed 60 s after creation (on the injected clock). `downloadSigned` returns a small PDF. |
| AI | `complete` returns `[mock <purpose>] You said: "..."`. With `responseFormat: 'json'` it returns a value that fits `jsonSchema`: first enum value, minimum numbers, every property. |
| Storage | Files live on local disk under `INTEGRATIONS_LOCAL_STORAGE_DIR` (default `.data/storage`), in a folder per connection. Signed links point at `/api/v1/integrations/local-files/...`, with an HMAC signature and expiry like an Azure SAS. |

**Failure simulation:** a mock connection's "Behaviour" setting (`config.simulate`) can be:

- `healthy` (the default)
- `failing_sends`: every call throws a retryable `integration_provider_error`
- `failing_health`: the health check fails, but calls still work

**Mock webhooks:** a JSON body `{ events: [{ id, type, occurredAt, reference?, data }] }`, signed as `x-phoenix-mock-signature: sha256=<hex HMAC-SHA256 of the raw body>`. The secret is the connection's `webhookSecret` credential, or one derived from the platform key and connection id. `buildMockWebhookRequest({ connectionId, events })` builds a signed request for tests. A `GET` request with `?challenge=x` echoes `x`.

**Seed data** (`db/seeds/20_integrations.js`):

- A mock connection of every kind for Pi Vector, SatnPaper and Excel, each the company's default.
- A group "Group WhatsApp (mock)" shared by SatnPaper and Pi Vector (not a default).
- Channel identities: each company's WhatsApp number, inbox, call number, website form, Facebook page and partner link prefix, plus the shared helpline `+919000019999`.

## What adapters must expose for webhooks

The webhooks service (docs/platform/WEBHOOKS_AND_JOBS.md) owns the route, the queue and de-duplication. Adapters only answer three questions about the provider's HTTP request. It arrives as `{ method, headers (lower-case), query, rawBody (the exact bytes), url? }`:

- `verifyWebhook(request)` returns `{ ok: true }` or `{ ok: false, reason }`. It checks the signature over **rawBody**, never re-serialised JSON:
  - Meta `X-Hub-Signature-256` with the app secret
  - Razorpay `X-Razorpay-Signature`
  - `Stripe-Signature` with tolerance
  - SendGrid's signed Event Webhook (ECDSA public key)
  - Zoom `x-zm-signature`
  - a shared token for providers that only offer one (MSG91, Exotel, Google channel tokens; `deriveConnectionSecret` makes a stable per-connection token)

  It compares in constant time and **never throws** for a bad request.
- `parseWebhook(request)` returns `{ events: [{ eventId, type, occurredAt, reference?, data }] }`, normalised to the kind's event names in the table above. `eventId` is the provider's event id, or a stable hash when there is none. The webhooks service de-duplicates on `(connection, eventId)`. It throws `integration_invalid_input` for a body it can't read.
- `webhookChallenge(request)` returns `{ status, contentType, body }` for subscription handshakes (Meta `hub.challenge`, Zoom `endpoint.url_validation`, Microsoft Graph `validationToken`), otherwise `null`.

The suggested route shape is `POST /api/v1/webhooks/:connectionId`. The CSRF guard already exempts `/webhooks/`, and API-key auth leaves those paths alone. Load the connection, build its adapter with `adapterForConnection(row)`, then call challenge, verify, parse, enqueue, and answer 200 quickly.

## API keys

Machine access for websites, scripts and partner systems:

- **Create.** `POST /api-keys { unitId, name, scopes, expiresAt? }`. The unit is the group or a company. Scopes are exact permission keys from the registry that **the creator holds there**: no `*`, `module.*` or `:own`, and never `api_keys.*`, so a key can't mint keys. The response carries `secret` (`phx_` plus 43 base64url characters) **once**.
- **Storage.** The database keeps `sha256(secret)` (a fast hash is enough for 256 random bits), the first 12 characters as a visible prefix, the scopes, the creator, the optional expiry, the last use (time and IP, updated at most once a minute) and revocation.
- **Use.** Send `Authorization: Bearer phx_...`. The middleware (`apiKeys/auth.js`, mounted after `loadSession` in `app.js`) turns the request into a **service principal**:
  - `req.auth.user` is the key's service user, a `users` row with status `disabled` and no password, which can never sign in. It makes `created_by` and audit rows point at the key.
  - `req.auth.apiKey` is `{ id, name, unitId, scopes }`.
  - `req.access` is an access context with **one assignment carrying exactly the scopes at the key's unit**, so `can()`, `canSee()`, `rootsFor()` and the CRM scope helpers behave as for a person with that role there.
  - Records of other companies are 404. Writes need a write scope.
- **CSRF.** A request with any `Authorization` header never uses the session cookie: the CSRF guard exempts such requests, so the cookie must not count. Writes need no `X-Phoenix-Client` header.
  - Because of this, do not put HTTP Basic auth (a staging password on a reverse proxy) in front of `/api`: browsers would send its `Authorization` header with every call and the web app would be signed out. Protect staging with an IP allow-list or the proxy's own cookie instead.
- **Refusals.** A bad, unknown, revoked or expired key, or a key at an archived unit, is 401. Account endpoints (`/auth/...`) are 403.
- **Rate limit.** `API_KEY_RATE_LIMIT` requests a minute per key (default 600; Redis fixed window) answer 429 beyond that.
- **Audit.** Writes made with a key are audited with `actor_type = 'api_key'` and the service user as actor. Creating and revoking keys is audited and emits events.
- **Revoke.** `DELETE /api-keys/:id` takes effect immediately: the 60-second lookup cache is cleared.

The OpenAPI document lists the `apiKey` bearer scheme on every operation except `/auth/...`.

## Adding a provider

1. **Write the adapter** in `integrations/adapters/<kind>/<provider>.js` (or next to its client): `export function create<Name>Adapter(ctx)`. It returns `{ kind, provider, mock: false, healthCheck, ...methods, ...webhook methods }`. `ctx` gives `config`, `credentials` (decrypted), `connection` (`{ id, groupId, companyId, ... }`), `now`, `log` and `derivedSecret(purpose)`. Wrap the vendor client from `integrations/providers/<vendor>/` and map its errors to `IntegrationError` (set `retryable` and `details.reason`).
2. **Register it in `catalog.js`.** Set `create: (ctx) => create<Name>Adapter(ctx)` and `implemented: true`. Add the fields its connection form needs: `{ key, label, input, secret?, required?, placeholder?, help?, options?, pattern?, default? }`. The fields drive both the API validation and the web form (`components/DynamicField`), so no frontend change is needed. Secret fields are encrypted and never returned.
3. **Test it.**
   - `adapters.test.js` already checks its shape.
   - Add contract tests against recorded vendor responses (see `test/providers/`).
   - Add webhook verification tests with real signed samples.
4. **Document it.** Add its setup to `docs/providers/<vendor>.md`: where to find each credential, and the webhook URL to configure.

**Adding a kind:** define it in `kinds/<area>.js` with `defineKind({ key, label, description, methods: { name: { description, input, output } }, webhooks?, sample })`, add it to `KIND_LIST`, write its mock in `mocks/`, and register the mock in `MOCK_FACTORIES`. If its connections carry channels, add it to `KIND_IDENTITY_TYPES`. Add an icon in `apps/web/src/lib/integrations/display.ts`.

## Platform email (invitations and password resets)

`integrations/mail` stays as it was. It sends group-level mail before anyone is signed in, through `MAIL_PROVIDER` (`console` locally). A company's own email goes through the `messaging.email` kind. Moving platform mail onto a group-level email connection is a later step.

## Environment

| Variable | Default | |
| --- | --- | --- |
| `INTEGRATIONS_MOCKS` | `auto` | `auto` (on unless production), `on` or `off` |
| `INTEGRATIONS_LOCAL_STORAGE_DIR` | `.data/storage` | Folder of the local-disk storage mock |
| `API_KEY_RATE_LIMIT` | `600` | Requests per minute per API key |
| `APP_ENCRYPTION_KEY` | (phase 1) | Also encrypts connection credentials. Rotating it means re-entering credentials. |

## Tests

- `test/integrations/credentials.test.js`: encryption round trips, connection binding, tampering, hints.
- `test/integrations/adapters.test.js`: every provider's shape, the guard, stubs, every mock's sample call, webhook signatures, payment refunds.
- `test/integrations/resolve.test.js`: the `getAdapter` resolution rules.
- `test/integrations/apiKeys.test.js`: key format and hashing, the Bearer parser, scope rules, the access context.
- `test/integration/integrations.test.js` (`INTEGRATION=1`):
  - connections CRUD and scoping as the owner, `admin.satnpaper`, `admin.pivector`, `ritika` and `kabir`
  - encrypted storage
  - `getAdapter` against stored connections
  - the sandbox
  - channel identities
  - API keys: Bearer reads, writes needing scopes, other companies 404, cookie ignored, rate limit, revocation, audit actor
